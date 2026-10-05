import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import {
  buildTools,
  commandProfile,
  fileParameters,
  matchesCommand,
  serialize,
  toolName,
} from './catalog.js';
import { downloadFile, validateFileReference } from './file-input.js';
import { enforcePolicy, loadPolicy } from './policy.js';
import {
  AdapterError,
  type Artifact,
  type CallInput,
  type Catalog,
  type CliCommand,
  type IoRole,
  type Manifest,
  type OpenAIFile,
  type Profiles,
  type RunResult,
} from './types.js';

const INPUT_LIMIT = 32 * 1024 * 1024;
const OUTPUT_LIMIT = 32 * 1024 * 1024;
const ARTIFACT_LIMIT = 64 * 1024 * 1024;
const ARTIFACT_TTL = 60 * 60 * 1000;

export interface RuntimeOptions {
  catalog: Catalog;
  manifest: Manifest;
  profiles: Profiles;
  binaryPath: string;
  configPath?: string;
  policyPath?: string;
  workspaceRoot?: string;
  timeoutMs?: number;
  fileDownloader?: typeof downloadFile;
  configuredBackends?: ReadonlySet<string>;
}

interface StoredArtifact extends Artifact {
  path: string;
  expires: number;
}

function inside(path: string, root: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
  );
}

/** Factual profiles identify native path_parser uses of shellexpand::full. */
function expandShellPath(value: string, env: NodeJS.ProcessEnv): string | undefined {
  let unresolved = false;
  const expanded = value.replace(
    /\$(\$|\{[^}]*\}|[\p{Alphabetic}\p{Number}_]+)/gu,
    (match, token: string) => {
      if (token === '$') return '$';
      const braced = token.startsWith('{');
      const expression = braced ? token.slice(1, -1) : token;
      const split = braced ? expression.indexOf(':-') : -1;
      const name = split > 0 ? expression.slice(0, split) : expression;
      const key =
        process.platform === 'win32'
          ? Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase())
          : name;
      const found = key === undefined || !Object.hasOwn(env, key) ? undefined : env[key];
      if (found !== undefined) return found; // An explicitly empty value is still set.
      if (split > 0) return expression.slice(split + 2); // Defaults are not recursively expanded.
      unresolved = true;
      return match;
    },
  );
  if (unresolved) return undefined; // Native path_parser fails; MessageArg treats it as inline.
  if (!value.startsWith('~')) return expanded; // A variable-provided '~' stays literal.
  return expanded.replace(process.platform === 'win32' ? /^~(?=$|[/\\])/ : /^~(?=$|\/)/, () =>
    homedir(),
  );
}

/** Bind a checked path to the shell-expanding native config/MessageArg parser exactly once. */
function expandedNativePath(value: string): string {
  return (process.platform === 'win32' ? value.replaceAll('\\', '/') : value).replaceAll(
    '$',
    () => '$$',
  );
}

function nativeMessageFile(value: string): string {
  const path = expandedNativePath(value);
  if (/\\[rn]/.test(path))
    throw new AdapterError(
      'parameter_binding',
      'The native message parser cannot preserve this workspace path.',
      'Use a workspace directory without literal backslash-r or backslash-n sequences.',
    );
  return path;
}

async function safePath(
  value: string,
  cwd: string,
  uploads: string,
  role: IoRole,
): Promise<string> {
  // Ordinary PathBuf arguments are literal. Expanding them would change native semantics.
  const candidate = resolve(cwd, value);
  if (!inside(candidate, cwd))
    throw new AdapterError(
      'file_boundary',
      'File arguments must stay inside this call workspace.',
      'Pass the declared top-level file object; host configuration is selected at server startup.',
    );
  let ancestor = candidate;
  for (;;) {
    try {
      const canonical = await realpath(ancestor);
      if (!inside(canonical, cwd))
        throw new AdapterError('file_boundary', 'A symbolic link escapes the call workspace.');
      break;
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (ancestor === cwd) throw error;
      ancestor = dirname(ancestor);
    }
  }
  if (['outputFile', 'outputDirectory'].includes(role) && inside(candidate, uploads))
    throw new AdapterError('file_boundary', 'Outputs cannot overwrite uploaded input files.');
  if (role === 'inputFile') {
    const info = await stat(candidate).catch(() => undefined);
    if (!info?.isFile()) throw new AdapterError('input_file', 'The input path is not a file.');
  }
  return candidate;
}

function text(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function mimeType(name: string): string {
  if (/\.eml$/i.test(name)) return 'message/rfc822';
  if (/\.json$/i.test(name)) return 'application/json';
  if (/\.txt$/i.test(name)) return 'text/plain';
  if (/\.pdf$/i.test(name)) return 'application/pdf';
  return 'application/octet-stream';
}

export class Runtime {
  private readonly definitions;
  private readonly commands = new Map<string, CliCommand>();
  private readonly processes = new Set<ChildProcess>();
  private readonly calls = new Set<Promise<RunResult>>();
  private readonly callWorkspaces = new Set<string>();
  private readonly artifacts = new Map<string, StoredArtifact>();
  private readonly workspaces = new Set<string>();
  private readonly root: string;
  private readonly downloadAbort = new AbortController();
  private readonly env: NodeJS.ProcessEnv;
  private configuredBackends: ReadonlySet<string> | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  private active = 0;
  private artifactBytes = 0;
  private readonly reapTimer: ReturnType<typeof setInterval>;

  constructor(private readonly options: RuntimeOptions) {
    const native = options.manifest.himalaya;
    if (
      options.catalog.native.version !== native.version ||
      options.catalog.native.revision !== native.revision ||
      [...options.catalog.native.features].sort().join() !== [...native.features].sort().join()
    )
      throw new AdapterError(
        'definition_mismatch',
        'Catalog and manifest do not refer to the same native build.',
      );
    this.definitions = buildTools(options.catalog, options.profiles);
    for (const command of options.catalog.commands.filter((command) => command.runnable))
      this.commands.set(toolName(command), command);
    this.root = resolve(
      options.workspaceRoot ?? join(tmpdir(), `himalaya-mcp-${process.getuid?.() ?? 'user'}`),
    );
    this.env = { ...process.env };
    this.configuredBackends = options.configuredBackends;
    this.reapTimer = setInterval(() => {
      void this.reap().catch(() =>
        process.stderr.write('Temporary artifact cleanup failed; retrying on the next sweep.\n'),
      );
    }, 60_000);
    this.reapTimer.unref();
  }

  async tools() {
    const policy = await loadPolicy(this.options.policyPath);
    return this.definitions.filter((tool) => {
      const command = this.commands.get(tool.name)!;
      const profile = commandProfile(command, this.options.profiles);
      return (
        !profile.interactive &&
        (!profile.requiresBackend ||
          this.configuredBackends === undefined ||
          this.configuredBackends.has(profile.requiresBackend)) &&
        !policy.deny.some(
          (rule) =>
            matchesCommand(rule.command, command.path) &&
            (!rule.when || !Object.keys(rule.when).length),
        )
      );
    });
  }

  /** Native configuration owns this metadata; no mailbox connection or secret resolution. */
  async discoverBackends(): Promise<void> {
    const command = [...this.commands.values()].find(
      (command) => command.path.join(' ') === 'account list',
    );
    if (!command)
      throw new AdapterError('backend_discovery', 'This catalog lacks native account metadata.');
    const result = await this.callTool(toolName(command), { params: { json: true } });
    let accounts: unknown;
    try {
      accounts = (JSON.parse(result.stdout) as { accounts?: unknown }).accounts;
    } catch {
      throw new AdapterError('backend_discovery', 'Native account metadata could not be read.');
    }
    if (
      result.exitCode !== 0 ||
      !Array.isArray(accounts) ||
      accounts.some(
        (account: unknown) =>
          !account ||
          typeof account !== 'object' ||
          typeof (account as { name?: unknown }).name !== 'string' ||
          !Array.isArray((account as { backends?: unknown }).backends) ||
          (account as { backends: unknown[] }).backends.some(
            (backend) => typeof backend !== 'string',
          ),
      )
    )
      throw new AdapterError(
        'backend_discovery',
        'Native account metadata is unavailable; check the native configuration.',
      );
    const backends = new Set(
      accounts.flatMap((account: { backends: string[] }) => account.backends),
    );
    for (const probe of this.commands.values()) {
      const profile = commandProfile(probe, this.options.profiles);
      if (
        !profile.capabilityProbe ||
        !profile.requiresBackend ||
        backends.has(profile.requiresBackend)
      )
        continue;
      for (const account of accounts as { name?: unknown }[]) {
        if (typeof account.name !== 'string')
          throw new AdapterError('backend_discovery', 'Invalid native account metadata.');
        let checked: RunResult;
        try {
          checked = await this.callTool(toolName(probe), {
            params: { json: true, account_name: account.name },
          });
        } catch (error) {
          if (error instanceof AdapterError && error.code === 'policy_denied') break;
          throw error;
        }
        if (checked.exitCode === 0) {
          backends.add(profile.requiresBackend);
          break;
        }
      }
    }
    this.configuredBackends = backends;
  }

  callTool(name: string, raw: CallInput, beforeExecute?: () => Promise<void>): Promise<RunResult> {
    if (this.closed)
      return Promise.reject(new AdapterError('runtime_closed', 'The server is closing.'));
    if (this.active >= 4)
      return Promise.reject(
        new AdapterError('runtime_busy', 'Four native calls are already running.'),
      );
    this.active++;
    const call = this.runTool(name, raw, beforeExecute);
    this.calls.add(call);
    const finished = () => {
      this.calls.delete(call);
      this.active--;
    };
    void call.then(finished, finished);
    return call;
  }

  private async runTool(
    name: string,
    raw: CallInput,
    beforeExecute?: () => Promise<void>,
  ): Promise<RunResult> {
    const command = this.commands.get(name);
    if (!command) throw new AdapterError('unknown_tool', `Unknown generated tool: ${name}`);
    const fileParams = fileParameters(command, this.options.profiles);
    const allowed = new Set(['params', ...fileParams.map(({ argument }) => argument.id)]);
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Object.keys(raw).some((key) => !allowed.has(key))
    )
      throw new AdapterError(
        'input_shape',
        'Use params and generated file-object fields only. File bytes, stdin, base64, local paths and raw argv are not input channels.',
      );
    if (
      raw.params !== undefined &&
      (!raw.params || typeof raw.params !== 'object' || Array.isArray(raw.params))
    )
      throw new AdapterError('input_shape', 'params must be an object.');
    const params = structuredClone(raw.params ?? {});
    const profile = commandProfile(command, this.options.profiles);
    // These checks require no files. Reject config changes and backend path escapes
    // before creating a workspace or downloading any supplied attachments.
    for (const arg of command.args) {
      const role = profile.args?.[arg.id];
      if (['inputFile', 'inlineOrFile'].includes(role ?? '') && Object.hasOwn(params, arg.id))
        throw new AdapterError(
          'input_file',
          `Use the top-level ${arg.id} file-object field; this file argument is not accepted in params.`,
        );
      if (role === 'config' && Object.hasOwn(params, arg.id))
        throw new AdapterError(
          'config_boundary',
          'Native configuration is selected by the server, not a tool argument.',
          'Set --config when starting himalaya-mcp.',
        );
      if (role !== 'accountPath') continue;
      const valid = (value: unknown): boolean =>
        Array.isArray(value)
          ? value.every(valid)
          : typeof value === 'string' &&
            !isAbsolute(value) &&
            !/^[A-Za-z]:|^\\\\|\0|[\r\n]/.test(value) &&
            !value.split(/[\\/]/).includes('..');
      if (params[arg.id] !== undefined && !valid(params[arg.id]))
        throw new AdapterError(
          'file_boundary',
          `${arg.id} must be relative to the configured account root without parent traversal.`,
        );
    }
    let inputBytes = 0;
    const names = new Set<string>();
    const downloads = new Map<string, OpenAIFile>();
    for (const { argument, multiple, nativeArray } of fileParams) {
      const value = raw[argument.id];
      if (value === undefined) continue;
      if (multiple !== Array.isArray(value))
        throw new AdapterError(
          'input_file',
          `${argument.id} requires ${multiple ? 'an array of file objects' : 'one file object'}.`,
        );
      const refs = (multiple ? (value as unknown[]) : [value]).map((source) => {
        const { name, file } = validateFileReference(source);
        const previous = downloads.get(name);
        if (
          names.has(name) &&
          (!previous ||
            previous.file_id !== file.file_id ||
            previous.download_url !== file.download_url)
        )
          throw new AdapterError(
            'input_file',
            'Different uploaded files must have unique basenames.',
          );
        names.add(name);
        downloads.set(name, file);
        return `file:${name}`;
      });
      params[argument.id] = nativeArray ? refs : refs[0];
    }
    serialize(command, params); // Validate canonical shapes before policy, network or allocation.
    // Read policy for each call so a user edit takes effect without replacing the process.
    enforcePolicy(await loadPolicy(this.options.policyPath), command, params);
    if (profile.interactive)
      throw new AdapterError(
        'interactive_required',
        'This native command requires a terminal and is not exposed by MCP.',
        'Use the original Himalaya CLI in a terminal.',
      );
    if (
      profile.requiresBackend &&
      this.configuredBackends !== undefined &&
      !this.configuredBackends.has(profile.requiresBackend)
    )
      throw new AdapterError(
        'backend_unavailable',
        'This instance has no native configuration for the required backend.',
      );
    if (this.closed) throw new AdapterError('runtime_closed', 'The server is closing.');
    let cwd: string | undefined;
    try {
      await this.reap();
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const rootInfo = await lstat(this.root);
      if (
        !rootInfo.isDirectory() ||
        rootInfo.isSymbolicLink() ||
        (process.getuid && rootInfo.uid !== process.getuid())
      )
        throw new AdapterError(
          'workspace_boundary',
          'Workspace root must be an owned ordinary directory.',
        );
      if (process.platform !== 'win32' && rootInfo.mode & 0o077)
        throw new AdapterError(
          'workspace_boundary',
          'Workspace root must have private permissions (0700).',
          'Use a dedicated private directory; the adapter will not change permissions on an existing shared directory.',
        );
      cwd = await mkdtemp(join(await realpath(this.root), 'call-'));
      this.callWorkspaces.add(cwd);
      const uploadRoot = join(cwd, 'uploads');
      await mkdir(uploadRoot, { mode: 0o700 });
      if (downloads.size) {
        const deadline = AbortSignal.timeout(30_000);
        const signal = AbortSignal.any([this.downloadAbort.signal, deadline]);
        try {
          for (const [name, file] of downloads) {
            const bytes = await (this.options.fileDownloader ?? downloadFile)(
              file,
              INPUT_LIMIT - inputBytes,
              signal,
            );
            if (signal.aborted) throw signal.reason;
            inputBytes += bytes.length;
            if (inputBytes > INPUT_LIMIT)
              throw new AdapterError('input_limit', 'Imported files exceed 32 MiB per call.');
            await writeFile(join(uploadRoot, name), bytes, { flag: 'wx', mode: 0o400 });
          }
        } catch (error) {
          if (this.closed) throw new AdapterError('runtime_closed', 'The server is closing.');
          if (deadline.aborted)
            throw new AdapterError(
              'file_timeout',
              'File imports exceeded their 30 second deadline.',
            );
          throw error;
        }
      }
      for (const arg of command.args) {
        const role = profile.args?.[arg.id] ?? (arg.valueType === 'path' ? 'path' : undefined);
        if (!role) continue;
        if (['config', 'accountPath'].includes(role)) continue;
        if (!Object.hasOwn(params, arg.id)) {
          if (role === 'outputDirectory') params[arg.id] = '.';
          else if (arg.defaultValues.length && arg.valueType === 'path') {
            throw new AdapterError(
              'file_default',
              `Supply ${arg.id} explicitly; its native path default is outside the call contract.`,
            );
          }
          continue;
        }
        const convert = async (value: unknown): Promise<unknown> => {
          if (Array.isArray(value)) return Promise.all(value.map(convert));
          if (typeof value !== 'string')
            throw new AdapterError('input_file', `${arg.id} must contain path strings.`);
          const expands = profile.pathExpansion?.[arg.id] === 'shell';
          let file: string;
          if (value.startsWith('file:')) {
            const upload = value.slice(5);
            if (!names.has(upload))
              throw new AdapterError('input_file', 'Unknown uploaded file reference.');
            file = join(uploadRoot, upload);
          } else {
            const expanded = expands ? expandShellPath(value, this.env) : value;
            if (expanded === undefined)
              throw new AdapterError(
                'input_file',
                `${arg.id} refers to an unset native path variable.`,
              );
            file = expanded;
          }
          const path = await safePath(
            file,
            cwd!,
            uploadRoot,
            role === 'inlineOrFile' ? 'inputFile' : role,
          );
          if (role === 'inlineOrFile') return nativeMessageFile(path);
          return expands ? expandedNativePath(path) : path;
        };
        params[arg.id] = await convert(params[arg.id]);
      }
      if (this.options.configPath) {
        const config = command.args.find((arg) => profile.args?.[arg.id] === 'config');
        if (!config)
          throw new AdapterError(
            'config_binding',
            'This definition has no declared native configuration argument.',
          );
        let file = resolve(this.options.configPath);
        if (config.valueDelimiter && file.includes(config.valueDelimiter)) {
          file = relative(cwd, file);
          if (file.includes(config.valueDelimiter))
            throw new AdapterError(
              'config_binding',
              'The native configuration delimiter prevents representing this file path.',
              'Put --workspace-dir on the same drive as --config; paths containing the native delimiter require a different filename.',
            );
        }
        file = expandedNativePath(file);
        params[config.id] = config.action === 'Append' ? [file] : file;
      }
      const argv = serialize(command, params);
      if (this.closed) throw new AdapterError('runtime_closed', 'The server is closing.');
      // Persist the execution boundary before starting an irreversible native operation.
      await beforeExecute?.();
      if (this.closed) throw new AdapterError('runtime_closed', 'The server is closing.');
      const result = await this.execute(argv, cwd);
      if (this.closed) throw new AdapterError('runtime_closed', 'The server is closing.');
      // Inputs never become retained resources, even when the command produced outputs.
      await rm(uploadRoot, { recursive: true, force: true });
      result.files = await this.collect(cwd, uploadRoot);
      if (result.files.length) this.workspaces.add(cwd);
      else await rm(cwd, { recursive: true, force: true });
      this.callWorkspaces.delete(cwd);
      cwd = undefined;
      return result;
    } finally {
      if (cwd) {
        await rm(cwd, { recursive: true, force: true });
        this.callWorkspaces.delete(cwd);
      }
    }
  }

  private execute(argv: string[], cwd: string): Promise<RunResult> {
    return new Promise((resolveResult, reject) => {
      const child = spawn(this.options.binaryPath, argv, {
        cwd,
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      this.processes.add(child);
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      let total = 0,
        overflow = false,
        timedOut = false,
        settled = false;
      const stop = () => this.stop(child);
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, this.options.timeoutMs ?? 120_000);
      const receive = (target: Buffer[], chunk: Buffer) => {
        total += chunk.length;
        if (total > OUTPUT_LIMIT) {
          overflow = true;
          stop();
          return;
        }
        target.push(chunk);
      };
      child.stdout.on('data', (chunk) => receive(stdout, chunk as Buffer));
      child.stderr.on('data', (chunk) => receive(stderr, chunk as Buffer));
      child.stdin.on('error', (error) => {
        if ((error as NodeJS.ErrnoException).code !== 'EPIPE') stop();
      });
      child.once('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.processes.delete(child);
        reject(new AdapterError('native_spawn', 'Failed to start the configured native binary.'));
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.processes.delete(child);
        if (overflow) {
          reject(
            new AdapterError(
              'output_limit',
              'Native output exceeded 32 MiB. The operation may already have completed; writes are not retried.',
            ),
          );
          return;
        }
        const bytes = Buffer.concat(stdout);
        const utf8 = text(bytes);
        resolveResult({
          exitCode: code,
          stdout: utf8 ?? '',
          ...(utf8 === undefined ? { stdoutBase64: bytes.toString('base64') } : {}),
          stderr: text(Buffer.concat(stderr)) ?? 'Native stderr contained non-UTF-8 bytes.',
          files: [],
          ...(timedOut ? { timedOut: true } : {}),
        });
      });
      child.stdin.end();
    });
  }

  private stop(child: ChildProcess): void {
    if (!child.pid) return;
    const signal = (kind: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid!, kind);
        else child.kill(kind);
      } catch {
        /* Already exited. */
      }
    };
    signal('SIGTERM');
    const escalation = setTimeout(() => signal('SIGKILL'), 500);
    escalation.unref();
  }

  private async collect(cwd: string, uploadRoot: string): Promise<Artifact[]> {
    const found: StoredArtifact[] = [];
    let bytes = 0;
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (path === uploadRoot) continue;
        if (entry.isSymbolicLink())
          throw new AdapterError('artifact_boundary', 'Native output contains a symbolic link.');
        if (entry.isDirectory()) {
          await visit(path);
          continue;
        }
        if (!entry.isFile())
          throw new AdapterError('artifact_boundary', 'Native output is not an ordinary file.');
        const info = await stat(path);
        bytes += info.size;
        if (info.size > OUTPUT_LIMIT || this.artifactBytes + bytes > ARTIFACT_LIMIT)
          throw new AdapterError(
            'artifact_limit',
            'Native file output exceeded the artifact limit; no partial files are returned.',
          );
        const name = relative(cwd, path).split(sep).join('/');
        found.push({
          name,
          path,
          uri: `himalaya-mcp://artifact/${randomUUID()}/${encodeURIComponent(name)}`,
          mimeType: mimeType(name),
          size: info.size,
          expires: Date.now() + ARTIFACT_TTL,
        });
      }
    };
    await visit(cwd);
    if (this.artifactBytes + bytes > ARTIFACT_LIMIT)
      throw new AdapterError(
        'artifact_limit',
        'Concurrent native file output exceeded the aggregate artifact limit; no partial files are returned.',
      );
    for (const artifact of found) this.artifacts.set(artifact.uri, artifact);
    this.artifactBytes += bytes;
    return found.map(({ name, uri, mimeType, size }) => ({ name, uri, mimeType, size }));
  }

  listResources() {
    return [...this.artifacts.values()]
      .filter((artifact) => artifact.expires > Date.now())
      .map(({ name, uri, mimeType, size }) => ({ name, uri, mimeType, size }));
  }

  async readResource(uri: string) {
    await this.reap();
    const artifact = this.artifacts.get(uri);
    if (!artifact) throw new AdapterError('resource_missing', 'Unknown or expired artifact.');
    await access(artifact.path, constants.R_OK);
    if ((await lstat(artifact.path)).isSymbolicLink())
      throw new AdapterError('artifact_boundary', 'Artifact was replaced with a symbolic link.');
    const bytes = await readFile(artifact.path);
    if (bytes.length > OUTPUT_LIMIT)
      throw new AdapterError('artifact_limit', 'Artifact exceeded the file limit.');
    return { contents: [{ uri, mimeType: artifact.mimeType, blob: bytes.toString('base64') }] };
  }

  private async reap(): Promise<void> {
    for (const [uri, artifact] of this.artifacts) {
      if (artifact.expires > Date.now()) continue;
      this.artifacts.delete(uri);
      this.artifactBytes -= artifact.size;
    }
    for (const cwd of this.workspaces) {
      if ([...this.artifacts.values()].some((artifact) => inside(artifact.path, cwd))) continue;
      await rm(cwd, { recursive: true, force: true });
      this.workspaces.delete(cwd);
    }
  }

  close(): Promise<void> {
    this.closed = true;
    clearInterval(this.reapTimer);
    this.downloadAbort.abort();
    this.closing ??= this.closeAll();
    return this.closing;
  }

  private async closeAll(): Promise<void> {
    for (const child of this.processes) this.stop(child);
    // Wait for complete calls, including allocation and cleanup before/after spawn.
    await Promise.allSettled([...this.calls]);
    await Promise.all(
      [...this.workspaces, ...this.callWorkspaces].map((cwd) =>
        rm(cwd, { recursive: true, force: true }),
      ),
    );
    this.workspaces.clear();
    this.callWorkspaces.clear();
    this.artifacts.clear();
    this.artifactBytes = 0;
  }
}
