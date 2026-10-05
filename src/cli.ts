#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ensureBinary, inspectBinary } from './binary.js';
import { buildTools } from './catalog.js';
import { errorMessage, startHttp, startStdio, type RunningServer } from './mcp.js';
import { loadPolicy } from './policy.js';
import { Runtime } from './runtime.js';
import { AdapterError, type Catalog, type Manifest, type Profiles } from './types.js';

export interface CliOptions {
  command: 'serve' | 'doctor' | 'describe' | 'help' | 'version';
  json: boolean;
  transport: 'stdio' | 'http';
  host: string;
  port: number;
  binary?: string;
  config?: string;
  policy?: string;
  cacheDir?: string;
  workspaceDir?: string;
}

const HELP = `Usage: himalaya-mcp [serve | doctor | describe] [options]

serve     Start the MCP server (default).
doctor    Check published metadata, local binary, and explicit config/policy paths.
          Never downloads a binary or connects to an email account.
describe  List the generated MCP tools and native Help without running Himalaya.

Options:
  --transport stdio|http  Transport (default: stdio)
  --host ADDRESS         HTTP bind address (default: 127.0.0.1)
  --port NUMBER          HTTP port (default: 3000; 0 chooses a free port)
  --binary PATH          Use a compatible local Himalaya binary
  --config PATH          Fix the native Himalaya configuration for this instance
  --policy PATH          Load your optional dangerous-operation policy
  --cache-dir PATH       Binary download cache
  --workspace-dir PATH   Parent directory for private call workspaces
  --json                 JSON output for doctor or describe
  --help                 Show this Help
  --version              Show the adapter version

HTTP serves /mcp. It has no built-in user authentication; its deployment owns access.
MCP inputs use generated params plus optional stdin/stdinBase64/files, never shell argv.
`;

export function parseOptions(argv: string[]): CliOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        transport: { type: 'string' },
        host: { type: 'string' },
        port: { type: 'string' },
        binary: { type: 'string' },
        config: { type: 'string' },
        policy: { type: 'string' },
        'cache-dir': { type: 'string' },
        'workspace-dir': { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch {
    throw new AdapterError(
      'arguments_invalid',
      'Invalid command-line options.',
      'Run himalaya-mcp --help.',
    );
  }
  const { values, positionals } = parsed;
  const command = values.help ? 'help' : values.version ? 'version' : (positionals[0] ?? 'serve');
  if (
    positionals.length > 1 ||
    !['serve', 'doctor', 'describe', 'help', 'version'].includes(command)
  ) {
    throw new AdapterError(
      'arguments_invalid',
      'Expected serve, doctor, or describe.',
      'Run himalaya-mcp --help.',
    );
  }
  const transport = values.transport ?? 'stdio';
  if (transport !== 'stdio' && transport !== 'http') {
    throw new AdapterError('arguments_invalid', '--transport must be stdio or http.');
  }
  const portText = values.port ?? '3000';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isSafeInteger(port) || port > 65535) {
    throw new AdapterError('arguments_invalid', '--port must be an integer from 0 to 65535.');
  }
  const host = values.host ?? '127.0.0.1';
  if (!host || host.includes('\0'))
    throw new AdapterError('arguments_invalid', '--host must be a bind address.');
  if (values.json && command === 'serve') {
    throw new AdapterError('arguments_invalid', '--json is for doctor or describe.');
  }
  return {
    command: command as CliOptions['command'],
    json: values.json ?? false,
    transport,
    host,
    port,
    ...(values.binary === undefined ? {} : { binary: resolve(values.binary) }),
    ...(values.config === undefined ? {} : { config: resolve(values.config) }),
    ...(values.policy === undefined ? {} : { policy: resolve(values.policy) }),
    ...(values['cache-dir'] === undefined ? {} : { cacheDir: resolve(values['cache-dir']) }),
    ...(values['workspace-dir'] === undefined
      ? {}
      : { workspaceDir: resolve(values['workspace-dir']) }),
  };
}

export interface Bundle {
  catalog: Catalog;
  manifest: Manifest;
  profiles: Profiles;
}

/** All published metadata is adjacent to the bundle, independent of process.cwd(). */
export async function loadBundle(directory = new URL('./', import.meta.url)): Promise<Bundle> {
  try {
    const [rawCatalog, rawManifest, rawProfiles] = await Promise.all([
      readFile(new URL('catalog.json', directory), 'utf8'),
      readFile(new URL('manifest.json', directory), 'utf8'),
      readFile(new URL('profiles.json', directory), 'utf8'),
    ]);
    const catalog = JSON.parse(rawCatalog) as Catalog;
    const manifest = JSON.parse(rawManifest) as Manifest;
    const profiles = JSON.parse(rawProfiles) as Profiles;
    if (
      catalog.schemaVersion !== 1 ||
      manifest.schemaVersion !== 1 ||
      profiles.schemaVersion !== 1
    ) {
      throw new AdapterError('bundle_invalid', 'Unsupported published metadata schema.');
    }
    const hash = createHash('sha256').update(rawCatalog).digest('hex');
    const native = catalog.native;
    const expected = manifest.himalaya;
    if (
      hash !== manifest.catalogSha256 ||
      native.version !== expected.version ||
      native.revision !== expected.revision ||
      JSON.stringify([...native.features].sort()) !== JSON.stringify([...expected.features].sort())
    ) {
      throw new AdapterError(
        'catalog_mismatch',
        'The catalog does not match the release manifest.',
        'Reinstall this adapter release.',
      );
    }
    return { catalog, manifest, profiles };
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError(
      'bundle_invalid',
      'Cannot read the published catalog, manifest, or profiles.',
      'Reinstall this adapter release.',
    );
  }
}

async function checkFile(
  path: string | undefined,
): Promise<{ ok: boolean; source: string; message?: string }> {
  if (path === undefined) return { ok: true, source: 'not explicitly configured' };
  try {
    if (!(await stat(path)).isFile()) throw new Error('not a file');
    await access(path, constants.R_OK);
    return { ok: true, source: path };
  } catch {
    return { ok: false, source: path, message: 'Not a readable regular file.' };
  }
}

async function doctor(
  bundle: Bundle,
  options: CliOptions,
): Promise<Record<string, unknown> & { ok: boolean }> {
  const binaryOptions = {
    catalog: bundle.catalog,
    ...(options.binary === undefined ? {} : { binary: options.binary }),
    ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
  };
  const [binary, config, policy] = await Promise.all([
    inspectBinary(bundle.manifest, binaryOptions),
    checkFile(options.config),
    checkFile(options.policy),
  ]);
  if (policy.ok && options.policy !== undefined) {
    try {
      await loadPolicy(options.policy);
    } catch (error) {
      policy.ok = false;
      policy.message = errorMessage(error);
    }
  }
  return {
    ok: binary.ok && config.ok && policy.ok,
    adapterVersion: bundle.manifest.packageVersion,
    nativeVersion: bundle.catalog.native.version,
    catalog: { ok: true, sha256: bundle.manifest.catalogSha256 },
    binary,
    config: { ...config, checked: 'readability only; no account connection or credential read' },
    policy: {
      ...policy,
      checked: options.policy === undefined ? 'no policy loaded' : 'readability and policy syntax',
    },
  };
}

/** Exported for CLI tests; no command automatically accesses a mailbox. */
export async function runCli(argv: string[], directory?: URL): Promise<number> {
  let options: CliOptions | undefined;
  let runtime: Runtime | undefined;
  let running: RunningServer | undefined;
  try {
    options = parseOptions(argv);
    if (options.command === 'help') {
      process.stdout.write(HELP);
      return 0;
    }
    const bundle = await loadBundle(directory);
    if (options.command === 'version') {
      process.stdout.write(`${bundle.manifest.packageVersion}\n`);
      return 0;
    }
    if (options.command === 'describe') {
      const tools = buildTools(bundle.catalog, bundle.profiles);
      process.stdout.write(
        options.json
          ? `${JSON.stringify({ tools }, null, 2)}\n`
          : `${tools.map((tool) => `${tool.name}\n${tool.description}`).join('\n\n')}\n`,
      );
      return 0;
    }
    if (options.command === 'doctor') {
      const report = await doctor(bundle, options);
      process.stdout.write(
        options.json
          ? `${JSON.stringify(report, null, 2)}\n`
          : `Doctor ${report.ok ? 'passed' : 'found local setup problems'}.\n${JSON.stringify(report, null, 2)}\n`,
      );
      return report.ok ? 0 : 1;
    }
    await loadPolicy(options.policy);
    const binary = await ensureBinary(bundle.manifest, {
      catalog: bundle.catalog,
      ...(options.binary === undefined ? {} : { binary: options.binary }),
      ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
    });
    runtime = new Runtime({
      ...bundle,
      binaryPath: binary.path,
      ...(options.config === undefined ? {} : { configPath: options.config }),
      ...(options.policy === undefined ? {} : { policyPath: options.policy }),
      ...(options.workspaceDir === undefined ? {} : { workspaceRoot: options.workspaceDir }),
    });
    running =
      options.transport === 'http'
        ? await startHttp(runtime, {
            version: bundle.manifest.packageVersion,
            host: options.host,
            port: options.port,
          })
        : startStdio(runtime, { version: bundle.manifest.packageVersion });
    if (running.url) process.stderr.write(`Himalaya MCP listening at ${running.url}\n`);
    const stop = (): void => {
      void running?.close().catch(() => undefined);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await running.done;
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
    return 0;
  } catch (error) {
    const message = errorMessage(error);
    if (options?.json && options.command === 'doctor') {
      process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    } else {
      process.stderr.write(`${message}\n`);
    }
    return 1;
  } finally {
    // An owned server reports its closing failure through done, which the catch above handles.
    if (running) await running.close().catch(() => undefined);
    else if (runtime)
      await runtime.close().catch(() => {
        process.stderr.write('Native workspace cleanup failed.\n');
      });
  }
}

const invokedPath = process.argv[1];
if (invokedPath && realpathSync(invokedPath) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
