import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { ReadResourceResult, Resource } from '@modelcontextprotocol/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Ajv } from 'ajv';
import { startHttp, type McpRuntime } from '../src/mcp.js';
import { OperationRuntime } from '../src/operations.js';
import {
  AdapterError,
  type CallInput,
  type McpCallResult,
  type OperationListResponse,
  type OperationRecord,
  type OperationResponse,
  type RunResult,
  type ToolDefinition,
} from '../src/types.js';

const NAME = 'himalaya_synthetic';
const STATUS = 'himalaya_mcp_operation_status';
const LIST = 'himalaya_mcp_operations_list';
const definition: ToolDefinition = {
  name: NAME,
  description: 'Synthetic native Help.',
  inputSchema: {
    type: 'object',
    properties: { params: { type: 'object' }, attach: { type: 'array' } },
    required: ['params'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  _meta: { 'openai/fileParams': ['attach'] },
};

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeRuntime implements McpRuntime {
  calls: { name: string; input: CallInput }[] = [];
  closes = 0;
  executions = 0;
  beforeFailure: unknown;
  afterFailure: unknown;
  beforeAction: (() => Promise<void>) | undefined;
  gate: ReturnType<typeof deferred> | undefined;
  started = deferred();
  result: RunResult = { exitCode: 0, stdout: 'synthetic result', stderr: '', files: [] };
  tools(): ToolDefinition[] {
    return [definition];
  }
  async callTool(
    name: string,
    input: CallInput,
    beforeExecute?: () => Promise<void>,
  ): Promise<RunResult> {
    this.calls.push({ name, input });
    if (this.beforeFailure) throw this.beforeFailure;
    await this.beforeAction?.();
    await beforeExecute?.();
    this.executions++;
    this.started.resolve();
    await this.gate?.promise;
    if (this.afterFailure) throw this.afterFailure;
    return this.result;
  }
  listResources(): Resource[] {
    return [];
  }
  async readResource(): Promise<ReadResourceResult> {
    return { contents: [] };
  }
  async close(): Promise<void> {
    this.closes++;
    this.gate?.resolve();
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function receipt(value: McpCallResult): OperationResponse {
  assert.ok('operation' in value);
  return value;
}

async function context(
  t: TestContext,
  replyWaitMs = 1000,
): Promise<{ native: FakeRuntime; runtime: OperationRuntime; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'himalaya-operations-'));
  const native = new FakeRuntime();
  const runtime = new OperationRuntime(native, { directory, replyWaitMs });
  t.after(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  await runtime.ready();
  return { native, runtime, directory };
}

async function completed(runtime: OperationRuntime, id: string): Promise<OperationResponse> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = receipt(await runtime.callTool(STATUS, { id }));
    if (result.operation.state !== 'accepted' && result.operation.state !== 'executing')
      return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('synthetic operation did not finish');
}

function stored(
  requestId: string,
  state: OperationRecord['state'],
  time = new Date().toISOString(),
): OperationRecord {
  return {
    id: hash(requestId),
    tool: NAME,
    state,
    createdAt: time,
    updatedAt: time,
    inputSha256: hash(`{"input":{},"tool":"${NAME}"}`),
  };
}

async function writeRecords(directory: string, records: OperationRecord[]): Promise<void> {
  for (const record of records)
    await writeFile(join(directory, `${record.id}.json`), JSON.stringify(record), { mode: 0o600 });
}

test('native tool schemas require request IDs without losing generated file metadata', async (t) => {
  const { runtime } = await context(t);
  const tools = await runtime.tools();
  const native = tools.find((tool) => tool.name === NAME)!;
  assert.deepEqual(native._meta, definition._meta);
  assert.deepEqual(native.inputSchema.required, ['params', 'request_id']);
  assert.deepEqual(native.inputSchema.properties.request_id, {
    type: 'string',
    minLength: 8,
    maxLength: 128,
    pattern: '^[A-Za-z0-9_-]+$',
    description: 'Stable unique ID for this intended operation, reused only with identical inputs.',
  });
  assert.equal(definition.inputSchema.properties.request_id, undefined);
  for (const name of [STATUS, LIST]) {
    const tool = tools.find((item) => item.name === name)!;
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
  }
  assert.equal(
    tools.find((tool) => tool.name === LIST)!.inputSchema.properties.request_id,
    undefined,
  );
  const status = tools.find((tool) => tool.name === STATUS)!;
  const validate = new Ajv().compile(status.inputSchema);
  for (const input of [
    { id: 'a'.repeat(64) },
    { request_id: 'A0_b-cDe' },
    { request_id: 'x'.repeat(128), include_result: false },
    { id: 'a'.repeat(64), include_result: true },
  ])
    assert.equal(validate(input), true, JSON.stringify(validate.errors));
  for (const input of [
    {},
    { id: 'a'.repeat(64), request_id: 'valid-request' },
    { request_id: 'short' },
    { request_id: 'x'.repeat(129) },
    { id: 'A'.repeat(64) },
    { id: 'a'.repeat(64), include_result: 'false' },
    { request_id: 'valid-request', tool: NAME },
  ])
    assert.equal(validate(input), false, JSON.stringify(input));
});

test('success persists metadata only and duplicate input order does not execute again', async (t) => {
  const { native, runtime, directory } = await context(t);
  const first = receipt(
    await runtime.callTool(NAME, {
      request_id: 'secret-request-001',
      params: { body: 'private synthetic body', account: 'fixture' },
      attach: [
        { file_id: 'private-file', download_url: 'https://example.invalid/file?private=token' },
      ],
    }),
  );
  assert.equal(first.operation.state, 'succeeded');
  assert.deepEqual(first.result, native.result);
  assert.ok(first.summary.includes('not delivery to the recipient'));
  assert.equal(first.operation.id, hash('secret-request-001'));
  assert.equal(native.calls[0]!.input.request_id, undefined);
  const duplicate = receipt(
    await runtime.callTool(NAME, {
      attach: [
        { download_url: 'https://example.invalid/file?private=token', file_id: 'private-file' },
      ],
      params: { account: 'fixture', body: 'private synthetic body' },
      request_id: 'secret-request-001',
    }),
  );
  assert.deepEqual(duplicate, first);
  assert.equal(native.executions, 1);
  const content = await readFile(join(directory, `${first.operation.id}.json`), 'utf8');
  for (const secret of [
    'private synthetic body',
    'private-file',
    'private=token',
    'secret-request-001',
    native.result.stdout,
  ])
    assert.ok(!content.includes(secret));
  assert.deepEqual(JSON.parse(content), first.operation);
  if (typeof process.getuid === 'function') {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, `${first.operation.id}.json`))).mode & 0o777, 0o600);
  }
});

test('concurrent duplicate requests share one background operation and arrays retain order', async (t) => {
  const { native, runtime } = await context(t, 0);
  native.gate = deferred();
  const input = { request_id: 'parallel-request', params: { header: ['one', 'two'] } };
  const [first, second] = await Promise.all([
    runtime.callTool(NAME, input),
    runtime.callTool(NAME, input),
  ]);
  assert.equal(receipt(first).operation.id, receipt(second).operation.id);
  await native.started.promise;
  assert.equal(native.executions, 1);
  await assert.rejects(
    runtime.callTool(NAME, { ...input, params: { header: ['two', 'one'] } }),
    (error: unknown) => error instanceof AdapterError && error.code === 'operation_conflict',
  );
  native.gate.resolve();
  assert.equal(
    (await completed(runtime, receipt(first).operation.id)).operation.state,
    'succeeded',
  );
});

test('slow calls return receipts and status/list recover an interrupted response without resubmission', async (t) => {
  const { native, runtime } = await context(t, 0);
  native.gate = deferred();
  const pending = receipt(
    await runtime.callTool(NAME, { request_id: 'lost-response-001', params: {} }),
  );
  assert.equal(pending.result, undefined);
  assert.ok(['accepted', 'executing'].includes(pending.operation.state));
  await native.started.promise;
  const recent = (await runtime.callTool(LIST, {})) as OperationListResponse;
  assert.equal(recent.operations[0]!.id, pending.operation.id);
  assert.equal(native.executions, 1);
  native.gate.resolve();
  const success = await completed(runtime, recent.operations[0]!.id);
  assert.equal(success.operation.state, 'succeeded');
  assert.deepEqual(success.result, native.result);
});

test('a lost initial receipt is recovered directly by request ID without native inputs', async (t) => {
  const { native, runtime } = await context(t, 0);
  native.gate = deferred();
  const requestId = 'lost-initial-receipt';
  await runtime.callTool(NAME, { request_id: requestId, params: { body: 'synthetic message' } });
  await native.started.promise;
  const pending = receipt(
    await runtime.callTool(STATUS, { request_id: requestId, include_result: false }),
  );
  assert.ok(['accepted', 'executing'].includes(pending.operation.state));
  assert.equal(pending.operation.id, hash(requestId));
  assert.equal(pending.result, undefined);
  assert.equal(pending.resultUnavailable, undefined);
  native.gate.resolve();
  const success = await completed(runtime, pending.operation.id);
  const byRequest = receipt(await runtime.callTool(STATUS, { request_id: requestId }));
  const explicit = receipt(
    await runtime.callTool(STATUS, { request_id: requestId, include_result: true }),
  );
  assert.deepEqual(byRequest, success);
  assert.deepEqual(explicit, success);
  assert.equal(native.calls.length, 1);
  assert.equal(native.executions, 1);
});

test('metadata-only status omits large results without evicting or reporting them unavailable', async (t) => {
  const { native, runtime } = await context(t);
  native.result = {
    exitCode: 0,
    stdout: 'synthetic large output'.repeat(64 * 1024),
    stderr: '',
    files: [],
  };
  const requestId = 'large-metadata-only';
  const full = receipt(await runtime.callTool(NAME, { request_id: requestId }));
  for (const lookup of [{ id: full.operation.id }, { request_id: requestId }]) {
    const metadata = receipt(await runtime.callTool(STATUS, { ...lookup, include_result: false }));
    assert.deepEqual(metadata, { operation: full.operation, summary: full.summary });
    assert.ok(JSON.stringify(metadata).length < 1024);
  }
  assert.deepEqual(receipt(await runtime.callTool(STATUS, { id: full.operation.id })), full);
  assert.equal(native.calls.length, 1);
});

test('status query validates exclusive identifiers, flags, and unknown keys before native work', async (t) => {
  const { native, runtime } = await context(t);
  const id = 'a'.repeat(64);
  const requestId = 'query-original-001';
  const invalid: CallInput[] = [
    {},
    { include_result: false },
    { id, request_id: requestId },
    { id: undefined, request_id: requestId },
    { id: null },
    { id: 1 },
    { id: 'a'.repeat(63) },
    { id: 'a'.repeat(65) },
    { id: 'A'.repeat(64) },
    { request_id: undefined },
    { request_id: null },
    { request_id: 1 },
    { request_id: 'x'.repeat(7) },
    { request_id: 'x'.repeat(129) },
    { request_id: 'has space' },
    { request_id: '../record' },
    { request_id: 'line\nrequest' },
    { id, include_result: undefined },
    { id, include_result: 'false' },
    { id, include_result: null },
    { id, include_result: 0 },
    { id, include_result: 1 },
    { id, extra: true },
    { request_id: requestId, tool: NAME },
    { id, params: {} },
  ];
  for (const input of invalid) {
    await assert.rejects(
      runtime.callTool(STATUS, input),
      (error: unknown) => error instanceof AdapterError && error.code === 'operation_input',
    );
  }
  for (const lookup of [{ id }, { request_id: requestId, include_result: false }])
    await assert.rejects(runtime.callTool(STATUS, lookup), /missing or expired/);
  assert.equal(native.calls.length, 0);
  assert.deepEqual(((await runtime.callTool(LIST, {})) as OperationListResponse).operations, []);
});

test('status request IDs accept the native length boundaries without creating another operation', async (t) => {
  const { native, runtime } = await context(t);
  for (const requestId of ['A0_b-cDe', 'x'.repeat(128)]) {
    const original = receipt(await runtime.callTool(NAME, { request_id: requestId }));
    const lookup = receipt(await runtime.callTool(STATUS, { request_id: requestId }));
    assert.deepEqual(lookup, original);
  }
  assert.equal(native.executions, 2);
  assert.equal(native.calls.length, 2);
});

test('pre-execution errors differ from uncertain errors after the durable execution barrier', async (t) => {
  const before = await context(t);
  before.native.beforeFailure = new AdapterError('input_file', 'private synthetic detail');
  const rejected = receipt(await before.runtime.callTool(NAME, { request_id: 'invalid-file-001' }));
  assert.equal(rejected.operation.state, 'not_executed');
  assert.equal(rejected.operation.error, 'input_file');
  assert.equal(before.native.executions, 0);
  assert.ok(rejected.resultUnavailable);
  assert.ok(
    !(await readFile(join(before.directory, `${rejected.operation.id}.json`), 'utf8')).includes(
      'private synthetic detail',
    ),
  );
  const after = await context(t);
  after.native.afterFailure = new Error('private result interrupted');
  const uncertain = receipt(await after.runtime.callTool(NAME, { request_id: 'interrupted-001' }));
  assert.equal(uncertain.operation.state, 'unknown');
  assert.equal(uncertain.operation.error, 'internal_error');
  assert.ok(uncertain.summary.includes('remote action may have completed'));
  assert.ok(uncertain.summary.includes('Do not retry'));
  assert.equal(after.native.executions, 1);
});

test('nonzero exits and timeouts remain uncertain and identical requests never retry them', async (t) => {
  const { native, runtime } = await context(t);
  for (const [requestId, output] of [
    ['nonzero-exit-001', { exitCode: 1, stdout: '', stderr: 'synthetic error', files: [] }],
    ['timedout-exit-001', { exitCode: null, stdout: '', stderr: '', files: [], timedOut: true }],
  ] as const) {
    native.result = { ...output, files: [] };
    const result = receipt(await runtime.callTool(NAME, { request_id: requestId }));
    assert.equal(result.operation.state, 'unknown');
    assert.equal(result.operation.exitCode, output.exitCode);
    await runtime.callTool(NAME, { request_id: requestId });
  }
  assert.equal(native.executions, 2);
});

test('invalid request IDs and lookup shapes do not launch native calls', async (t) => {
  const { native, runtime } = await context(t);
  for (const requestId of [undefined, 'short', '../not-valid', 'x'.repeat(129)])
    await assert.rejects(runtime.callTool(NAME, { request_id: requestId }), /require request_id/);
  await assert.rejects(runtime.callTool(STATUS, { id: '../record' }), /valid operation.id/);
  await assert.rejects(runtime.callTool(LIST, { anything: true }), /takes no arguments/);
  await assert.rejects(runtime.callTool(STATUS, { id: 'a'.repeat(64) }), /missing or expired/);
  assert.equal(native.calls.length, 0);
});

test('live ownership fails closed without altering another runtime history', async (t) => {
  const first = await context(t);
  const second = new OperationRuntime(new FakeRuntime(), { directory: first.directory });
  t.after(() => second.close());
  await assert.rejects(second.ready(), /live owner/);
  assert.equal(
    JSON.parse(await readFile(join(first.directory, 'owner.json'), 'utf8')).pid,
    process.pid,
  );
  const result = receipt(await first.runtime.callTool(NAME, { request_id: 'owner-first-001' }));
  assert.equal(result.operation.state, 'succeeded');
});

test('restart converts abandoned accepted/executing to unknown and never replays inputs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'himalaya-restart-'));
  const requestIds = ['abandoned-accepted', 'abandoned-executing'];
  const original = requestIds.map((requestId, index) =>
    stored(requestId, index === 0 ? 'accepted' : 'executing'),
  );
  await writeRecords(directory, original);
  const native = new FakeRuntime();
  const runtime = new OperationRuntime(native, { directory });
  t.after(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  await runtime.ready();
  for (const [index, record] of original.entries()) {
    const restored = receipt(await runtime.callTool(STATUS, { id: record.id }));
    assert.equal(restored.operation.state, 'unknown');
    assert.equal(restored.operation.error, 'process_restart');
    assert.ok(restored.resultUnavailable);
    const byRequest = receipt(
      await runtime.callTool(STATUS, { request_id: requestIds[index]!, include_result: false }),
    );
    assert.deepEqual(byRequest, { operation: restored.operation, summary: restored.summary });
  }
  const replay = receipt(await runtime.callTool(NAME, { request_id: 'abandoned-accepted' }));
  assert.equal(replay.operation.state, 'unknown');
  assert.equal(native.calls.length, 0);
});

test('native output is bounded and expires while durable success stays queryable', async (t) => {
  const { runtime } = await context(t);
  const ids: string[] = [];
  for (let index = 0; index < 9; index++)
    ids.push(
      receipt(await runtime.callTool(NAME, { request_id: `output-cache-${index}` })).operation.id,
    );
  const evicted = receipt(await runtime.callTool(STATUS, { id: ids[0]! }));
  assert.equal(evicted.operation.state, 'succeeded');
  assert.equal(evicted.result, undefined);
  assert.ok(evicted.resultUnavailable);
  const last = receipt(await runtime.callTool(STATUS, { id: ids.at(-1)! }));
  assert.ok(last.result);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 2 * 60 * 60 * 1000);
  const expired = receipt(await runtime.callTool(STATUS, { id: ids.at(-1)! }));
  assert.equal(expired.operation.state, 'succeeded');
  assert.equal(expired.result, undefined);
  assert.ok(expired.resultUnavailable);
});

test('historical capacity prunes oldest terminal records and age expires metadata', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'himalaya-history-'));
  const now = Date.now();
  const records = Array.from({ length: 128 }, (_, index) =>
    stored(
      `history-record-${index}`,
      'succeeded',
      new Date(now - (128 - index) * 1000).toISOString(),
    ),
  );
  const expired = stored(
    'history-expired-001',
    'succeeded',
    new Date(now - 25 * 60 * 60 * 1000).toISOString(),
  );
  await writeRecords(directory, [...records, expired]);
  const runtime = new OperationRuntime(new FakeRuntime(), { directory });
  t.after(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  await runtime.ready();
  await assert.rejects(runtime.callTool(STATUS, { id: expired.id }), /missing or expired/);
  await runtime.callTool(NAME, { request_id: 'history-new-001' });
  const listed = (await runtime.callTool(LIST, {})) as OperationListResponse;
  assert.equal(listed.operations.length, 128);
  assert.ok(!listed.operations.some((item) => item.id === records[0]!.id));
  assert.equal(
    (await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length,
    128,
  );
});

test('shutdown settles in-flight work before releasing storage ownership', async (t) => {
  const { native, runtime, directory } = await context(t, 0);
  native.gate = deferred();
  const pending = receipt(await runtime.callTool(NAME, { request_id: 'shutdown-job-001' }));
  await native.started.promise;
  await runtime.close();
  assert.equal(native.closes, 1);
  assert.equal(
    JSON.parse(await readFile(join(directory, `${pending.operation.id}.json`), 'utf8')).state,
    'succeeded',
  );
  assert.ok(!(await readdir(directory)).includes('owner.json'));
  await runtime.close();
  assert.equal(native.closes, 1);
});

test(
  'shared and symlinked operation roots are rejected before native execution',
  { skip: typeof process.getuid !== 'function' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'himalaya-private-'));
    const shared = join(root, 'shared');
    const target = join(root, 'target');
    await writeFile(target, 'not a directory');
    await symlink(target, join(root, 'linked'));
    const sharedRuntime = new OperationRuntime(new FakeRuntime(), { directory: shared });
    await sharedRuntime.ready();
    await sharedRuntime.close();
    await chmod(shared, 0o755);
    const unsafe = new OperationRuntime(new FakeRuntime(), { directory: shared });
    const linked = new OperationRuntime(new FakeRuntime(), { directory: join(root, 'linked') });
    t.after(async () => {
      await unsafe.close();
      await linked.close();
      await rm(root, { recursive: true, force: true });
    });
    await assert.rejects(unsafe.ready(), /private/);
    await assert.rejects(linked.ready(), /private operation storage/);
  },
);

test(
  'a failed durable execution barrier prevents spawn and reports uncertain persistence',
  { skip: typeof process.getuid !== 'function' },
  async (t) => {
    const { native, runtime, directory } = await context(t);
    native.beforeAction = () => chmod(directory, 0o755);
    const result = receipt(await runtime.callTool(NAME, { request_id: 'storage-barrier-001' }));
    assert.equal(native.executions, 0);
    assert.equal(result.operation.state, 'unknown');
    assert.equal(result.operation.error, 'operation_store');
    await chmod(directory, 0o700);
    assert.equal(
      JSON.parse(await readFile(join(directory, `${result.operation.id}.json`), 'utf8')).state,
      'accepted',
    );
    const duplicate = receipt(await runtime.callTool(NAME, { request_id: 'storage-barrier-001' }));
    assert.equal(duplicate.operation.state, 'unknown');
    assert.equal(native.calls.length, 1);
  },
);

test('parallel stale-owner recovery permits one owner and preserves its lock', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'himalaya-owner-race-'));
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  assert.ok(child.pid);
  await once(child, 'exit');
  await writeFile(join(directory, 'owner.json'), JSON.stringify({ pid: child.pid }), {
    mode: 0o600,
  });
  const record = stored('stale-owner-record', 'executing');
  await writeRecords(directory, [record]);
  const first = new OperationRuntime(new FakeRuntime(), { directory });
  const second = new OperationRuntime(new FakeRuntime(), { directory });
  t.after(async () => {
    await first.close();
    await second.close();
    await rm(directory, { recursive: true, force: true });
  });
  const ready = await Promise.allSettled([first.ready(), second.ready()]);
  assert.equal(ready.filter((result) => result.status === 'fulfilled').length, 1);
  const winner = ready[0]!.status === 'fulfilled' ? first : second;
  assert.equal(JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8')).pid, process.pid);
  assert.equal(
    receipt(await winner.callTool(STATUS, { id: record.id })).operation.state,
    'unknown',
  );
  assert.ok(!(await readdir(directory)).includes('recovery.lock'));
});

test('orphan recovery guards require operator inspection and are never deleted automatically', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'himalaya-owner-guard-'));
  const guard = join(directory, 'recovery.lock');
  await writeFile(guard, JSON.stringify({ pid: 2147483647 }), { mode: 0o600 });
  const runtime = new OperationRuntime(new FakeRuntime(), { directory });
  t.after(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  await assert.rejects(runtime.ready(), /operator removes an orphan guard/);
  assert.equal(JSON.parse(await readFile(guard, 'utf8')).pid, 2147483647);
  assert.ok(!(await readdir(directory)).includes('owner.json'));
});

test('result byte budget evicts output without erasing success metadata', async (t) => {
  const { native, runtime } = await context(t);
  native.result = { exitCode: 0, stdout: 'x'.repeat(24 * 1024 * 1024), stderr: '', files: [] };
  const ids: string[] = [];
  for (let index = 0; index < 3; index++)
    ids.push(
      receipt(await runtime.callTool(NAME, { request_id: `large-result-${index}` })).operation.id,
    );
  const evicted = receipt(await runtime.callTool(STATUS, { id: ids[0]! }));
  assert.equal(evicted.operation.state, 'succeeded');
  assert.equal(evicted.result, undefined);
  assert.ok(evicted.resultUnavailable);
  assert.ok(receipt(await runtime.callTool(STATUS, { id: ids.at(-1)! })).result);
});

test('a prior process with the reused local PID is recovered by process nonce', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'himalaya-owner-nonce-'));
  await writeFile(
    join(directory, 'owner.json'),
    JSON.stringify({ pid: process.pid, nonce: 'prior-process-nonce' }),
    { mode: 0o600 },
  );
  const record = stored('nonce-prior-operation', 'executing');
  await writeRecords(directory, [record]);
  const native = new FakeRuntime();
  const runtime = new OperationRuntime(native, { directory });
  t.after(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  await runtime.ready();
  assert.equal(
    receipt(await runtime.callTool(STATUS, { id: record.id })).operation.state,
    'unknown',
  );
  assert.equal(native.executions, 0);
  assert.notEqual(
    JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8')).nonce,
    'prior-process-nonce',
  );
});

test(
  'Linux boot or PID namespace changes recover incomplete receipts conservatively',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'himalaya-owner-scope-'));
    await writeFile(
      join(directory, 'owner.json'),
      JSON.stringify({
        pid: process.ppid,
        nonce: 'previous-container',
        scope: 'previous-boot:pid:[previous-namespace]',
      }),
      { mode: 0o600 },
    );
    const record = stored('scope-prior-operation', 'accepted');
    await writeRecords(directory, [record]);
    const native = new FakeRuntime();
    const runtime = new OperationRuntime(native, { directory });
    t.after(async () => {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    });
    await runtime.ready();
    assert.equal(
      receipt(await runtime.callTool(STATUS, { id: record.id })).operation.state,
      'unknown',
    );
    assert.equal(native.executions, 0);
    const owner = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8'));
    assert.equal(owner.pid, process.pid);
    assert.match(owner.scope, /:pid:\[[0-9]+\]$/);
  },
);

test('HTTP client reconnect recovers by request ID after losing the entire initial reply', async (t) => {
  const { native, runtime } = await context(t, 2000);
  native.gate = deferred();
  let finish: ReturnType<typeof setTimeout> | undefined;
  native.beforeAction = async () => {
    finish = setTimeout(() => native.gate!.resolve(), 3000);
  };
  const server = await startHttp(runtime, { version: 'operations-test', port: 0 });
  const first = new Client({ name: 'first-http-client', version: '1' });
  const second = new Client({ name: 'reconnected-http-client', version: '1' });
  t.after(async () => {
    if (finish) clearTimeout(finish);
    await first.close();
    await second.close();
    await server.close();
  });
  await first.connect(new StreamableHTTPClientTransport(new URL(server.url!)));
  const arguments_ = { request_id: 'http-reconnect-001', params: {} };
  const initial = first.callTool({ name: NAME, arguments: arguments_ }).then(
    () => 'received',
    () => 'lost',
  );
  await native.started.promise;
  await first.close();
  assert.equal(await initial, 'lost');
  assert.equal(native.closes, 0);
  await second.connect(new StreamableHTTPClientTransport(new URL(server.url!)));
  let final: OperationResponse | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    const wire = await second.callTool({
      name: STATUS,
      arguments: { request_id: arguments_.request_id, include_result: false },
    });
    final = receipt(wire.structuredContent as unknown as McpCallResult);
    assert.equal(final.result, undefined);
    assert.equal(final.resultUnavailable, undefined);
    if (final.operation.state === 'succeeded') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(final);
  assert.equal(final.operation.state, 'succeeded');
  const withOutput = await second.callTool({ name: STATUS, arguments: { id: final.operation.id } });
  assert.deepEqual(
    receipt(withOutput.structuredContent as unknown as McpCallResult).result,
    native.result,
  );
  const duplicate = await second.callTool({ name: NAME, arguments: arguments_ });
  assert.equal(
    receipt(duplicate.structuredContent as unknown as McpCallResult).operation.id,
    final.operation.id,
  );
  assert.equal(native.executions, 1);
  assert.equal(native.calls.length, 1);
});
