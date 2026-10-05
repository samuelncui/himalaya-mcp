import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { ReadResourceResult, Resource } from '@modelcontextprotocol/server';
import { loadBundle, parseOptions, runCli } from '../src/cli.js';
import { createMcpServer, startHttp, startStdio, type McpRuntime } from '../src/mcp.js';
import {
  AdapterError,
  type CallInput,
  type Catalog,
  type Manifest,
  type RunResult,
  type ToolDefinition,
} from '../src/types.js';

const tool: ToolDefinition = {
  name: 'himalaya_message_send',
  description: 'Send a native message.\n\nUsage: himalaya message send [OPTIONS] [RAW-MESSAGE]',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      params: {
        type: 'object',
        properties: { account: { type: 'string' } },
        additionalProperties: false,
      },
      stdin: { type: 'string' },
      stdinBase64: { type: 'string' },
      files: { type: 'array' },
    },
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
};

class SyntheticRuntime implements McpRuntime {
  calls: { name: string; input: CallInput }[] = [];
  closes = 0;
  failure: unknown;
  result: RunResult = {
    exitCode: 0,
    stdout: 'native output\n',
    stderr: '',
    files: [
      {
        name: 'message.eml',
        uri: 'himalaya-mcp://artifacts/synthetic/message.eml',
        mimeType: 'message/rfc822',
        size: 4,
      },
    ],
  };
  tools(): ToolDefinition[] {
    return [tool];
  }
  async callTool(name: string, input: CallInput): Promise<RunResult> {
    if (this.failure) throw this.failure;
    if (name !== tool.name) throw new AdapterError('tool_unknown', 'Unknown generated tool.');
    this.calls.push({ name, input });
    return this.result;
  }
  listResources(): Resource[] {
    return [{ uri: this.result.files[0]!.uri, name: 'message.eml', mimeType: 'message/rfc822' }];
  }
  async readResource(uri: string): Promise<ReadResourceResult> {
    if (uri !== this.result.files[0]!.uri)
      throw new AdapterError('artifact_missing', 'Unknown artifact URI.');
    return {
      contents: [
        { uri, mimeType: 'message/rfc822', blob: Buffer.from([0, 10, 255, 13]).toString('base64') },
      ],
    };
  }
  async close(): Promise<void> {
    this.closes++;
  }
}

async function memoryClient(
  runtime: SyntheticRuntime,
): Promise<{ client: Client; close(): Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(runtime, '0.1.0-test');
  const client = new Client({ name: 'synthetic-client', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

test('MCP preserves generated Help, schemas, annotations, and the complete registry', async (t) => {
  const connection = await memoryClient(new SyntheticRuntime());
  t.after(() => connection.close());
  assert.deepEqual((await connection.client.listTools()).tools, [tool]);
});

test('MCP passes structured parameters and binary inputs intact and returns native status', async (t) => {
  const runtime = new SyntheticRuntime();
  const connection = await memoryClient(runtime);
  t.after(() => connection.close());
  const input: CallInput = {
    params: { account: 'x; $(printf untouched) `unchanged` "quotes"\n中文' },
    stdinBase64: Buffer.from([0, 13, 10, 255]).toString('base64'),
    files: [{ name: 'attachment.bin', base64: Buffer.from([255, 0, 1]).toString('base64') }],
  };
  const result = await connection.client.callTool({ name: tool.name, arguments: { ...input } });
  assert.deepEqual(runtime.calls, [{ name: tool.name, input }]);
  assert.deepEqual(result.structuredContent, runtime.result);
  assert.equal(result.isError, false);
  assert.deepEqual(
    JSON.parse(result.content[0]!.type === 'text' ? result.content[0]!.text : ''),
    runtime.result,
  );
  runtime.result = { exitCode: 1, stdout: '', stderr: 'native failure', files: [] };
  assert.equal((await connection.client.callTool({ name: tool.name })).isError, true);
  runtime.result = { exitCode: null, stdout: '', stderr: '', files: [], timedOut: true };
  assert.equal((await connection.client.callTool({ name: tool.name })).isError, true);
});

test('only deliberate adapter errors reach the MCP caller', async (t) => {
  const runtime = new SyntheticRuntime();
  const connection = await memoryClient(runtime);
  t.after(() => connection.close());
  runtime.failure = new AdapterError(
    'policy_denied',
    'Blocked by your policy.',
    'Edit your policy personally.',
  );
  let result = await connection.client.callTool({ name: tool.name });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /policy_denied/);
  runtime.failure = new Error('synthetic-private-value-must-not-leak');
  result = await connection.client.callTool({ name: tool.name });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /internal_error/);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private-value/);
});

test('artifact resources preserve bytes and accept registered URIs only', async (t) => {
  const runtime = new SyntheticRuntime();
  const connection = await memoryClient(runtime);
  t.after(() => connection.close());
  assert.deepEqual((await connection.client.listResources()).resources, runtime.listResources());
  const uri = runtime.listResources()[0]!.uri;
  const result = await connection.client.readResource({ uri });
  assert.deepEqual(result, await runtime.readResource(uri));
  await assert.rejects(
    connection.client.readResource({ uri: 'file:///private/synthetic-secret' }),
    /artifact_missing/,
  );
});

test('stdio speaks only MCP and EOF closes native runtime once', { timeout: 5000 }, async () => {
  const runtime = new SyntheticRuntime();
  const input = new PassThrough();
  const output = new PassThrough();
  const handle = startStdio(runtime, { version: 'test', input, output });
  try {
    let reply = once(output, 'data');
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      })}\n`,
    );
    const [initialize] = await reply;
    assert.equal(JSON.parse(String(initialize)).id, 1);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    reply = once(output, 'data');
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    const [listing] = await reply;
    assert.deepEqual(JSON.parse(String(listing)).result.tools, [tool]);
    input.end();
    await handle.done;
    await handle.close();
    assert.equal(runtime.closes, 1);
  } finally {
    await handle.close();
    input.destroy();
    output.destroy();
  }
});

test(
  'HTTP works with the official client and rejects untrusted Host and Origin',
  { timeout: 10000 },
  async (t) => {
    const runtime = new SyntheticRuntime();
    const handle = await startHttp(runtime, { version: 'test', port: 0 });
    const client = new Client({ name: 'synthetic-http-client', version: '1' });
    t.after(async () => {
      await client.close();
      await handle.close();
    });
    assert.match(handle.url ?? '', /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url!)));
    assert.deepEqual((await client.listTools()).tools, [tool]);
    assert.equal(
      (await client.callTool({ name: tool.name, arguments: { stdin: 'synthetic mail' } })).isError,
      false,
    );
    // Per-request SDK factories must not close the shared runtime after each response.
    assert.equal(runtime.closes, 0);
    assert.equal(await httpStatus(handle.url!, { Host: 'evil.invalid' }), 403);
    assert.equal(
      (await fetch(handle.url!, { headers: { Origin: 'http://evil.invalid' } })).status,
      403,
    );
    assert.equal((await fetch(new URL('/', handle.url!))).status, 404);
    await handle.close();
    await handle.close();
    assert.equal(runtime.closes, 1);
  },
);

test('CLI defaults and transport arguments are local, explicit, and validated', () => {
  assert.deepEqual(parseOptions([]), {
    command: 'serve',
    json: false,
    transport: 'stdio',
    host: '127.0.0.1',
    port: 3000,
  });
  assert.equal(parseOptions(['doctor', '--json']).command, 'doctor');
  assert.equal(parseOptions(['serve', '--transport', 'http', '--port', '0']).port, 0);
  assert.equal(
    parseOptions(['describe', '--json', '--policy', './personal-policy.yaml']).policy,
    resolveFixturePath('personal-policy.yaml'),
  );
  for (const args of [
    ['--transport', 'shell'],
    ['--port', '-1'],
    ['--port', '65536'],
    ['--json'],
    ['unknown'],
    ['serve', 'extra'],
  ]) {
    assert.throws(() => parseOptions(args), AdapterError);
  }
});

function resolveFixturePath(name: string): string {
  return join(process.cwd(), name);
}

function httpStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      response.resume();
      response.on('end', () => {
        resolve(response.statusCode ?? 0);
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

test('bundle integrity includes the raw catalog and native revision/features', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'himalaya-mcp-bundle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalog: Catalog = {
    schemaVersion: 1,
    native: {
      name: 'himalaya',
      version: '2.2.1',
      revision: 'synthetic',
      features: ['imap', 'smtp'],
    },
    commands: [],
  };
  const rawCatalog = JSON.stringify(catalog);
  const manifest: Manifest = {
    schemaVersion: 1,
    packageVersion: '0.1.0-test',
    himalaya: {
      version: '2.2.1',
      tag: 'v2.2.1',
      revision: 'synthetic',
      features: ['smtp', 'imap'],
    },
    catalogSha256: createHash('sha256').update(rawCatalog).digest('hex'),
    assets: [],
  };
  await Promise.all([
    writeFile(join(directory, 'catalog.json'), rawCatalog),
    writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest)),
    writeFile(join(directory, 'profiles.json'), JSON.stringify({ schemaVersion: 1, rules: [] })),
  ]);
  const url = pathToFileURL(`${directory}/`);
  assert.deepEqual((await loadBundle(url)).catalog, catalog);
  await writeFile(join(directory, 'catalog.json'), `${rawCatalog}\n`);
  await assert.rejects(loadBundle(url), /does not match/);
  await writeFile(join(directory, 'catalog.json'), rawCatalog);
  manifest.himalaya.revision = 'other-revision';
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(loadBundle(url), /does not match/);
  assert.equal(await readFile(join(directory, 'catalog.json'), 'utf8'), rawCatalog);
});

test('doctor is local-only, does not create a cache, and never displays config contents', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'himalaya-mcp-doctor-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalog: Catalog = {
    schemaVersion: 1,
    native: { name: 'himalaya', version: '2.2.1', revision: 'synthetic', features: [] },
    commands: [],
  };
  const rawCatalog = JSON.stringify(catalog);
  const manifest: Manifest = {
    schemaVersion: 1,
    packageVersion: '0.1.0-test',
    himalaya: { version: '2.2.1', tag: 'v2.2.1', revision: 'synthetic', features: [] },
    catalogSha256: createHash('sha256').update(rawCatalog).digest('hex'),
    assets: [
      {
        platform: process.platform,
        arch: process.arch,
        name: 'himalaya-synthetic.tgz',
        url: 'https://github.com/pimalaya/himalaya/releases/download/v2.2.1/himalaya-synthetic.tgz',
        archiveSha256: '0'.repeat(64),
        binarySha256: '0'.repeat(64),
      },
    ],
  };
  const configPath = join(directory, 'config.toml');
  const policyPath = join(directory, 'policy.yaml');
  const cachePath = join(directory, 'uncreated-cache');
  await Promise.all([
    writeFile(join(directory, 'catalog.json'), rawCatalog),
    writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest)),
    writeFile(join(directory, 'profiles.json'), JSON.stringify({ schemaVersion: 1, rules: [] })),
    writeFile(configPath, 'synthetic-password = "never-display-config-body"\n'),
    writeFile(policyPath, 'schemaVersion: 1\ndeny: []\n'),
  ]);
  const chunks: string[] = [];
  const output = t.mock.method(process.stdout, 'write', (chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  const exitCode = await runCli(
    ['doctor', '--json', '--cache-dir', cachePath, '--config', configPath, '--policy', policyPath],
    pathToFileURL(`${directory}/`),
  );
  output.mock.restore();
  assert.equal(exitCode, 1);
  const text = chunks.join('');
  const report = JSON.parse(text) as {
    ok: boolean;
    binary: { code: string };
    config: { ok: boolean };
    policy: { ok: boolean };
  };
  assert.equal(report.ok, false);
  assert.equal(report.binary.code, 'binary_missing');
  assert.equal(report.config.ok, true);
  assert.equal(report.policy.ok, true);
  assert.doesNotMatch(text, /never-display-config-body/);
  await assert.rejects(stat(cachePath), { code: 'ENOENT' });
});

test(
  'EOF cleanup failure is reported without leaking the private exception',
  { timeout: 5000 },
  async () => {
    const runtime = new SyntheticRuntime();
    runtime.close = async () => {
      runtime.closes++;
      throw new Error('synthetic-private-cleanup-details');
    };
    const input = new PassThrough();
    const output = new PassThrough();
    const handle = startStdio(runtime, { version: 'test', input, output });
    input.end();
    try {
      await assert.rejects(handle.done, (error: unknown) => {
        assert.ok(error instanceof AdapterError);
        assert.equal(error.code, 'shutdown_failed');
        assert.doesNotMatch(error.message, /synthetic-private-cleanup/);
        return true;
      });
      await assert.rejects(handle.close(), AdapterError);
      assert.equal(runtime.closes, 1);
    } finally {
      input.destroy();
      output.destroy();
    }
  },
);
