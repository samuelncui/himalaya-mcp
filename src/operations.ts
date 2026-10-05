import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, readlink, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ReadResourceResult, Resource } from '@modelcontextprotocol/server';
import type { McpRuntime } from './mcp.js';
import {
  AdapterError,
  type CallInput,
  type McpCallResult,
  type OperationListResponse,
  type OperationRecord,
  type OperationResponse,
  type RunResult,
  type ToolDefinition,
} from './types.js';

const HISTORY_TTL = 24 * 60 * 60 * 1000;
const RESULT_TTL = 60 * 60 * 1000;
const HISTORY_LIMIT = 128;
const RESULT_LIMIT = 8;
const RESULT_BYTES = 64 * 1024 * 1024;
const ID = /^[a-f0-9]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;
const STATUS = 'himalaya_mcp_operation_status';
const LIST = 'himalaya_mcp_operations_list';
const PROCESS_NONCE = randomUUID();
const PROCESS_SCOPE: Promise<string | undefined> =
  process.platform === 'linux'
    ? Promise.all([
        readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
        readlink('/proc/self/ns/pid'),
      ])
        .then(([boot, namespace]) => `${boot.trim()}:${namespace}`)
        .catch(() => undefined)
    : Promise.resolve(undefined);

export interface OperationOptions {
  directory: string;
  replyWaitMs?: number;
}

interface Job {
  record: OperationRecord;
  started: boolean;
  done: Promise<void>;
}

interface CachedResult {
  result: RunResult;
  bytes: number;
  expires: number;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Object key order is irrelevant; native repeated argument order remains significant. */
function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  throw new AdapterError('operation_input', 'Operation inputs must be JSON values.');
}

function safeError(error: unknown): string {
  return error instanceof AdapterError && /^[A-Za-z0-9_-]{1,80}$/.test(error.code)
    ? error.code
    : 'internal_error';
}

function terminal(record: OperationRecord): boolean {
  return record.state !== 'accepted' && record.state !== 'executing';
}

function recordValid(value: unknown, id: string): value is OperationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = [
    'id',
    'tool',
    'state',
    'createdAt',
    'updatedAt',
    'inputSha256',
    'error',
    'exitCode',
    'timedOut',
  ];
  const timestamp = (input: unknown): boolean =>
    typeof input === 'string' &&
    Number.isFinite(Date.parse(input)) &&
    new Date(input).toISOString() === input;
  return (
    Object.keys(record).every((key) => allowed.includes(key)) &&
    record.id === id &&
    typeof record.tool === 'string' &&
    /^[A-Za-z0-9_-]{1,160}$/.test(record.tool) &&
    ['accepted', 'executing', 'succeeded', 'not_executed', 'unknown'].includes(
      String(record.state),
    ) &&
    timestamp(record.createdAt) &&
    timestamp(record.updatedAt) &&
    typeof record.inputSha256 === 'string' &&
    ID.test(record.inputSha256) &&
    (record.error === undefined ||
      (typeof record.error === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(record.error))) &&
    (record.exitCode === undefined ||
      record.exitCode === null ||
      (typeof record.exitCode === 'number' && Number.isInteger(record.exitCode))) &&
    (record.timedOut === undefined || typeof record.timedOut === 'boolean')
  );
}

/** Public schema decoration is pure, shared by offline inspection and live tools/list. */
export function operationTools(tools: ToolDefinition[]): ToolDefinition[] {
  return [
    ...tools.map((tool) => {
      if (
        tool.name === STATUS ||
        tool.name === LIST ||
        Object.hasOwn(tool.inputSchema.properties, 'request_id')
      )
        throw new AdapterError(
          'operation_definition',
          'A native definition collides with operation tracking.',
        );
      return {
        ...tool,
        description: `Required request_id: reuse only with identical inputs while its receipt is retained (up to 24 hours / 128 records). Save operation.id; use himalaya_mcp_operation_status or himalaya_mcp_operations_list after an interrupted response.\n\n${tool.description}`,
        inputSchema: {
          ...tool.inputSchema,
          properties: {
            ...tool.inputSchema.properties,
            request_id: {
              type: 'string',
              minLength: 8,
              maxLength: 128,
              pattern: '^[A-Za-z0-9_-]+$',
              description:
                'Stable unique ID for this intended operation, reused only with identical inputs.',
            },
          },
          required: [...(tool.inputSchema.required ?? []), 'request_id'],
        },
      };
    }),
    {
      name: STATUS,
      description:
        'Read the durable receipt and any retained native output for operation.id. Succeeded is confirmed by native exit status, not recipient delivery; unknown and missing/expired history must not trigger a retry. A receipt can survive an interrupted client response; output may expire or be absent after restart.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
        required: ['id'],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: LIST,
      description:
        'List recent operation receipts when an interrupted response lost operation.id. Receipts contain tool name, times, state, and input hash; not message content or file URLs. Native exit 0 does not prove recipient delivery. Unknown or expired/missing history never justifies resending merely because a client response was lost.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  ];
}

/** Owns durable receipts and deduplication only; the native runtime owns all execution. */
export class OperationRuntime implements McpRuntime {
  private readonly directory: string;
  private readonly replyWaitMs: number;
  private readonly records = new Map<string, OperationRecord>();
  private readonly jobs = new Map<string, Job>();
  private readonly results = new Map<string, CachedResult>();
  private readonly initialization: Promise<void>;
  private mutation: Promise<void> = Promise.resolve();
  private resultBytes = 0;
  private owner = false;
  private closed = false;
  private closing: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly native: McpRuntime,
    options: OperationOptions,
  ) {
    this.directory = resolve(options.directory);
    this.replyWaitMs = options.replyWaitMs ?? 2000;
    if (!Number.isFinite(this.replyWaitMs) || this.replyWaitMs < 0)
      throw new AdapterError('operation_options', 'Operation reply wait must be nonnegative.');
    this.initialization = this.initialize();
    void this.initialization.catch(() => undefined);
  }

  ready(): Promise<void> {
    return this.initialization;
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.mutation.then(action, action);
    this.mutation = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async privatePath(path: string, directory = false): Promise<void> {
    const info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      (directory ? !info.isDirectory() : !info.isFile()) ||
      (typeof process.getuid === 'function' &&
        (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) ||
      (!directory && info.nlink !== 1)
    )
      throw new AdapterError(
        'operation_store',
        'Operation storage must be private, owned files without symbolic links.',
      );
  }

  private async syncDirectory(): Promise<void> {
    if (process.platform === 'win32') return;
    const handle = await open(this.directory, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async write(record: OperationRecord, exclusive = false): Promise<void> {
    await this.privatePath(this.directory, true);
    const path = join(this.directory, `${record.id}.json`);
    const temporary = exclusive ? path : join(this.directory, `.${record.id}.${randomUUID()}.tmp`);
    if (!exclusive) await this.privatePath(path);
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify(record), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      if (!exclusive) await rename(temporary, path);
      await this.syncDirectory();
    } finally {
      if (!exclusive) await rm(temporary, { force: true });
    }
  }

  private async createOwner(): Promise<void> {
    const handle = await open(
      join(this.directory, 'owner.json'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    this.owner = true;
    try {
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, nonce: PROCESS_NONCE, scope: await PROCESS_SCOPE }),
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.syncDirectory();
  }

  private async acquireOwner(): Promise<void> {
    const path = join(this.directory, 'owner.json');
    const recovery = join(this.directory, 'recovery.lock');
    try {
      await lstat(recovery);
      throw new AdapterError(
        'operation_owner',
        'Operation storage has a recovery guard. Stop all owners and inspect the private directory before an operator removes an orphan guard.',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await this.createOwner();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let guard;
    try {
      guard = await open(
        recovery,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new AdapterError(
          'operation_owner',
          'Another recovery owns operation storage; startup stopped without changing its guard.',
        );
      throw error;
    }
    try {
      await guard.writeFile(JSON.stringify({ pid: process.pid }));
      await guard.sync();
      await this.privatePath(path);
      const value = JSON.parse(await readFile(path, 'utf8')) as {
        pid?: unknown;
        nonce?: unknown;
        scope?: unknown;
      };
      if (
        typeof value.pid !== 'number' ||
        !Number.isSafeInteger(value.pid) ||
        value.pid <= 0 ||
        (value.nonce !== undefined && typeof value.nonce !== 'string') ||
        (value.scope !== undefined && typeof value.scope !== 'string')
      )
        throw new AdapterError('operation_owner', 'Operation storage has an invalid owner record.');
      const scope = await PROCESS_SCOPE;
      let stale =
        (value.pid === process.pid &&
          typeof value.nonce === 'string' &&
          value.nonce !== PROCESS_NONCE) ||
        (scope !== undefined && typeof value.scope === 'string' && value.scope !== scope);
      if (!stale) {
        try {
          process.kill(value.pid, 0);
        } catch (failure) {
          if ((failure as NodeJS.ErrnoException).code !== 'ESRCH')
            throw new AdapterError(
              'operation_owner',
              'Operation storage already has a live or unverifiable owner.',
            );
          stale = true;
        }
      }
      if (!stale)
        throw new AdapterError('operation_owner', 'Operation storage already has a live owner.');
      await rm(path);
      try {
        await this.createOwner();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new AdapterError(
            'operation_owner',
            'A new owner claimed operation storage; recovery stopped without removing it.',
          );
        throw error;
      }
    } finally {
      await guard.close();
      await rm(recovery);
    }
  }

  private async initialize(): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await this.privatePath(this.directory, true);
      await this.acquireOwner();
      for (const name of await readdir(this.directory)) {
        if (name === 'owner.json' || name === 'recovery.lock') continue;
        const path = join(this.directory, name);
        await this.privatePath(path);
        if (/^\.[a-f0-9]{64}\.[a-f0-9-]+\.tmp$/.test(name)) {
          await rm(path);
          continue;
        }
        if (!/^[a-f0-9]{64}\.json$/.test(name))
          throw new AdapterError(
            'operation_store',
            'Operation directory contains an unexpected file.',
          );
        const id = name.slice(0, -5);
        const record: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!recordValid(record, id))
          throw new AdapterError(
            'operation_store',
            'Operation history contains an invalid metadata record.',
          );
        if (!terminal(record)) {
          record.state = 'unknown';
          record.updatedAt = new Date().toISOString();
          record.error = 'process_restart';
          await this.write(record);
        }
        this.records.set(id, record);
      }
      await this.prune();
      this.timer = setInterval(() => {
        void this.serial(() => this.prune()).catch(() =>
          process.stderr.write('Operation history cleanup failed.\n'),
        );
      }, 60_000);
      this.timer.unref();
    } catch (error) {
      await this.releaseOwner().catch(() => undefined);
      throw error instanceof AdapterError
        ? error
        : new AdapterError('operation_store', 'Could not initialize private operation storage.');
    }
  }

  private async releaseOwner(): Promise<void> {
    if (!this.owner) return;
    await this.privatePath(join(this.directory, 'owner.json'));
    const owner = JSON.parse(await readFile(join(this.directory, 'owner.json'), 'utf8')) as {
      pid?: number;
      nonce?: string;
    };
    if (owner.pid !== process.pid || owner.nonce !== PROCESS_NONCE)
      throw new AdapterError('operation_owner', 'Operation storage owner changed unexpectedly.');
    await rm(join(this.directory, 'owner.json'));
    this.owner = false;
    await this.syncDirectory();
  }

  private dropResult(id: string): void {
    const result = this.results.get(id);
    if (result) this.resultBytes -= result.bytes;
    this.results.delete(id);
  }

  private async remove(record: OperationRecord): Promise<void> {
    await this.privatePath(join(this.directory, `${record.id}.json`));
    await rm(join(this.directory, `${record.id}.json`));
    this.records.delete(record.id);
    this.jobs.delete(record.id);
    this.dropResult(record.id);
  }

  private async prune(reserve = false): Promise<void> {
    const now = Date.now();
    for (const [id, result] of this.results) if (result.expires <= now) this.dropResult(id);
    for (const record of this.records.values())
      if (terminal(record) && Date.parse(record.updatedAt) + HISTORY_TTL <= now)
        await this.remove(record);
    const limit = reserve ? HISTORY_LIMIT - 1 : HISTORY_LIMIT;
    const completed = [...this.records.values()]
      .filter(terminal)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    while (this.records.size > limit && completed.length) await this.remove(completed.shift()!);
    if (this.records.size > limit)
      throw new AdapterError(
        'operation_capacity',
        'Operation history is full of active requests; no new operation was started.',
      );
  }

  async tools(): Promise<ToolDefinition[]> {
    await this.ready();
    if (this.closed) throw new AdapterError('runtime_closed', 'The server is closing.');
    const tools = await this.native.tools();
    return operationTools(tools);
  }

  private response(id: string): OperationResponse {
    const record = this.records.get(id);
    if (!record)
      throw new AdapterError('operation_missing', 'Operation receipt is missing or expired.');
    const result = this.results.get(id)?.result;
    return {
      operation: { ...record },
      summary:
        record.state === 'succeeded'
          ? 'Native execution exited 0. For sending, this confirms backend acceptance, not delivery to the recipient.'
          : record.state === 'unknown'
            ? 'Unknown: native execution or its durable final receipt is uncertain; the remote action may have completed. Do not retry. Reconcile through read-only mailbox checks.'
            : record.state === 'not_executed'
              ? 'Native execution did not start. No remote action was performed by this operation.'
              : 'The durable receipt is saved; native completion is pending. Query operation status instead of submitting another operation.',
      ...(result
        ? { result: structuredClone(result) }
        : terminal(record)
          ? {
              resultUnavailable:
                record.state === 'not_executed'
                  ? 'No native result exists: execution did not start.'
                  : 'Native output is not retained, expired, or was lost on restart; the durable operation summary remains authoritative.',
            }
          : {}),
    };
  }

  async callTool(name: string, raw: CallInput): Promise<McpCallResult> {
    await this.ready();
    if (this.closed) throw new AdapterError('runtime_closed', 'The server is closing.');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new AdapterError('operation_input', 'Tool arguments must be an object.');
    if (name === STATUS || name === LIST)
      return this.serial(async () => {
        await this.prune();
        if (name === LIST) {
          if (Object.keys(raw).length)
            throw new AdapterError('operation_input', 'Operation listing takes no arguments.');
          return {
            operations: [...this.records.values()]
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              .map((record) => ({ ...record })),
          } satisfies OperationListResponse;
        }
        if (Object.keys(raw).length !== 1 || typeof raw.id !== 'string' || !ID.test(raw.id))
          throw new AdapterError(
            'operation_input',
            'Operation status requires a valid operation.id.',
          );
        return this.response(raw.id);
      });
    if (typeof raw.request_id !== 'string' || !REQUEST_ID.test(raw.request_id))
      throw new AdapterError(
        'operation_request',
        'Native tools require request_id: 8..128 letters, digits, underscores, or hyphens.',
      );
    const { request_id: requestId, ...provided } = raw;
    let input: CallInput;
    let fingerprint: string;
    try {
      input = structuredClone(provided);
      fingerprint = digest(canonical({ tool: name, input }));
    } catch (error) {
      throw error instanceof AdapterError
        ? error
        : new AdapterError('operation_input', 'Could not fingerprint JSON tool arguments.');
    }
    const id = digest(requestId);
    const job = await this.serial(async () => {
      if (this.closed) throw new AdapterError('runtime_closed', 'The server is closing.');
      await this.prune();
      const existing = this.records.get(id);
      if (existing) {
        if (existing.inputSha256 !== fingerprint)
          throw new AdapterError(
            'operation_conflict',
            'request_id was already used for different inputs; nothing was executed.',
          );
        return this.jobs.get(id);
      }
      if (!(await this.native.tools()).some((tool) => tool.name === name))
        throw new AdapterError('unknown_tool', 'This native tool is not currently available.');
      await this.prune(true);
      const time = new Date().toISOString();
      const record: OperationRecord = {
        id,
        tool: name,
        state: 'accepted',
        createdAt: time,
        updatedAt: time,
        inputSha256: fingerprint,
      };
      try {
        await this.write(record, true);
      } catch {
        throw new AdapterError(
          'operation_store',
          'Could not persist the receipt; no native operation was started.',
        );
      }
      this.records.set(id, record);
      const created: Job = { record, started: false, done: Promise.resolve() };
      this.jobs.set(id, created);
      created.done = this.execute(created, name, input);
      return created;
    });
    if (job) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          job.done,
          new Promise<void>((resolveWait) => {
            timer = setTimeout(resolveWait, this.replyWaitMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return this.serial(async () => {
      await this.prune();
      return this.response(id);
    });
  }

  private async execute(job: Job, name: string, input: CallInput): Promise<void> {
    let result: RunResult | undefined;
    let error: string | undefined;
    try {
      const output = await this.native.callTool(name, input, async () =>
        this.serial(async () => {
          if (job.started)
            throw new AdapterError('operation_hook', 'Native execution was acknowledged twice.');
          const executing: OperationRecord = {
            ...job.record,
            state: 'executing',
            updatedAt: new Date().toISOString(),
          };
          await this.write(executing);
          job.record = executing;
          this.records.set(executing.id, executing);
          job.started = true;
        }),
      );
      if (!('exitCode' in output) || !job.started)
        throw new AdapterError(
          'operation_hook',
          'Native execution did not provide its required execution acknowledgement.',
        );
      result = output;
      if (result.exitCode !== 0 || result.timedOut)
        error = result.timedOut ? 'native_timeout' : 'native_exit';
    } catch (failure) {
      error = safeError(failure);
    }
    await this.serial(async () => {
      const record: OperationRecord = {
        ...job.record,
        state: job.started
          ? result?.exitCode === 0 && !result.timedOut
            ? 'succeeded'
            : 'unknown'
          : 'not_executed',
        updatedAt: new Date().toISOString(),
        ...(error ? { error } : {}),
        ...(result
          ? {
              exitCode: result.exitCode,
              ...(result.timedOut !== undefined ? { timedOut: result.timedOut } : {}),
            }
          : {}),
      };
      try {
        await this.write(record);
      } catch {
        record.state = 'unknown';
        record.error = 'operation_store';
      }
      job.record = record;
      this.records.set(record.id, record);
      if (result) {
        const bytes = Buffer.byteLength(JSON.stringify(result));
        if (bytes <= RESULT_BYTES) {
          this.results.set(record.id, { result, bytes, expires: Date.now() + RESULT_TTL });
          this.resultBytes += bytes;
          while (this.results.size > RESULT_LIMIT || this.resultBytes > RESULT_BYTES)
            this.dropResult(this.results.keys().next().value!);
        }
      }
    });
  }

  listResources(): Resource[] {
    return this.native.listResources();
  }
  readResource(uri: string): Promise<ReadResourceResult> {
    return this.native.readResource(uri);
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true;
      await this.ready().catch(() => undefined);
      if (this.timer) clearInterval(this.timer);
      await this.mutation;
      const closed = await Promise.allSettled([this.native.close()]);
      await Promise.allSettled([...this.jobs.values()].map((job) => job.done));
      await this.mutation;
      await this.releaseOwner();
      this.results.clear();
      this.resultBytes = 0;
      if (closed[0]?.status === 'rejected')
        throw new AdapterError('shutdown_failed', 'The native runtime did not close completely.');
    })();
    return this.closing;
  }
}
