import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { toolName } from '../src/catalog.js';
import { Runtime, type RuntimeOptions } from '../src/runtime.js';
import { startHttp } from '../src/mcp.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  AdapterError,
  type CallInput,
  type CliArg,
  type IoRole,
  type OpenAIFile,
  type Profiles,
} from '../src/types.js';
import { argument, catalog, command, manifest } from './fixtures.js';

const PRELUDE = `
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const argv = process.argv.slice(2);
const options = Object.fromEntries(argv.filter(x => x.startsWith('--') && x.includes('='))
  .map(x => { const i = x.indexOf('='); return [x.slice(2, i), x.slice(i + 1)]; }));
const stdin = Buffer.concat(await Array.fromAsync(process.stdin));
`;

async function fixture(
  t: TestContext,
  source: string,
  args: CliArg[] = [],
  roles: Record<string, IoRole> = {},
  timeoutMs = 2_000,
  options: Partial<RuntimeOptions> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'himalaya-mcp-test-'));
  const script = join(directory, 'synthetic.mjs');
  const workspaces = join(directory, 'calls');
  await writeFile(script, PRELUDE + source);
  const cmd = command(args, [script]);
  const profiles: Profiles = { schemaVersion: 1, rules: [{ commands: ['**'], args: roles }] };
  const runtime = new Runtime({
    catalog: catalog([cmd]),
    manifest,
    profiles,
    binaryPath: process.execPath,
    workspaceRoot: workspaces,
    timeoutMs,
    ...options,
  });
  t.after(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { runtime, name: toolName(cmd), directory, script, workspaces };
}

test('native arguments, stdin, errors and exit status are forwarded without shell or retry', async (t) => {
  const ctx = await fixture(
    t,
    `process.stdout.write(JSON.stringify({ argv, stdin: stdin.toString() })); process.stderr.write('synthetic native error'); process.exitCode = 7;`,
    [argument('header', { action: 'Append' })],
  );
  const result = await ctx.runtime.callTool(ctx.name, {
    params: { header: ['X-Value: $(literal)', 'Subject: `literal`'] },
  });
  assert.equal(result.exitCode, 7);
  assert.equal(result.stderr, 'synthetic native error');
  assert.deepEqual(JSON.parse(result.stdout), {
    argv: ['--header=X-Value: $(literal)', '--header=Subject: `literal`'],
    stdin: '',
  });
  assert.deepEqual(result.files, []);
});

test('binary stdout and registered output resources preserve bytes', async (t) => {
  const ctx = await fixture(
    t,
    `await writeFile(options.output, Buffer.from([0, 255, 254, 13, 10])); process.stdout.write(Buffer.from([0, 255, 254, 65]));`,
    [argument('output', { valueType: 'path' })],
    { output: 'outputFile' },
  );
  const input = Buffer.from([0, 255, 254, 13, 10]);
  const result = await ctx.runtime.callTool(ctx.name, {
    params: { output: 'mail.bin' },
  });
  assert.equal(result.stdout, '');
  assert.equal(result.stdoutBase64, Buffer.from([0, 255, 254, 65]).toString('base64'));
  assert.equal(result.files[0]?.name, 'mail.bin');
  const contents = await ctx.runtime.readResource(result.files[0]!.uri);
  assert.equal(contents.contents[0]?.blob, input.toString('base64'));
  assert.equal(ctx.runtime.listResources().length, 1);
  await assert.rejects(ctx.runtime.readResource('file:///etc/passwd'), /Unknown or expired/);
  await ctx.runtime.close();
  assert.deepEqual(await readdir(ctx.workspaces), []);
});

test('nested output resources use portable names while preserving native file bytes', async (t) => {
  const ctx = await fixture(
    t,
    `await mkdir(options.output, { recursive: true }); await writeFile(options.output + '/mail.bin', Buffer.from([0, 255, 13, 10]));`,
    [argument('output', { valueType: 'path' })],
    { output: 'outputDirectory' },
  );
  const input = Buffer.from([0, 255, 13, 10]);
  const result = await ctx.runtime.callTool(ctx.name, {
    params: { output: 'nested' },
  });
  assert.equal(result.files[0]?.name, 'nested/mail.bin');
  assert.equal(ctx.runtime.listResources()[0]?.name, 'nested/mail.bin');
  assert(result.files[0]!.uri.endsWith('/nested%2Fmail.bin'));
  const resource = await ctx.runtime.readResource(result.files[0]!.uri);
  assert.equal(resource.contents[0]?.blob, input.toString('base64'));
});

const remoteFile: OpenAIFile = {
  download_url: 'https://files.example.invalid/original?synthetic-capability=private',
  file_id: 'synthetic-id',
  file_name: '原图 $(literal).bin',
};

test('file-object fields bind scalar, repeated and raw-message inputs through the shared boundary', async (t) => {
  const bytes = Buffer.from([0, 255, 13, 10, 128]);
  const fetched: OpenAIFile[] = [];
  const ctx = await fixture(
    t,
    `const attachments = argv.filter(x => x.startsWith('--attach=')).map(x => x.slice(9)); process.stdout.write(JSON.stringify({ attachments: await Promise.all(attachments.map(async p => (await readFile(p)).toString('base64'))), body: (await readFile(options.body_file)).toString('base64'), raw: (await readFile(argv.at(-1).replaceAll('$$', '$'))).toString('base64') }));`,
    [
      argument('attach', { action: 'Append', valueType: 'path' }),
      argument('body_file', { valueType: 'path' }),
      argument('message-raw', {
        index: 1,
        long: null,
        action: 'Append',
        maxValues: null,
        last: true,
      }),
    ],
    { attach: 'inputFile', body_file: 'inputFile', 'message-raw': 'inlineOrFile' },
    2000,
    {
      fileDownloader: async (file) => {
        fetched.push(file);
        return bytes;
      },
    },
  );
  const second = { ...remoteFile, file_id: 'second-id', file_name: 'second.bin' };
  const result = await ctx.runtime.callTool(ctx.name, {
    attach: [remoteFile, second, remoteFile],
    body_file: remoteFile,
    'message-raw': remoteFile,
  });
  assert.deepEqual(fetched, [remoteFile, second]);
  assert.deepEqual(JSON.parse(result.stdout), {
    attachments: Array(3).fill(bytes.toString('base64')),
    body: bytes.toString('base64'),
    raw: bytes.toString('base64'),
  });
  assert.deepEqual(result.files, []);
  assert.deepEqual(ctx.runtime.listResources(), []);
  assert.deepEqual(await readdir(ctx.workspaces), []);
});

test('ambiguous, malformed and conflicting inputs fail before any download', async (t) => {
  let downloads = 0;
  const ctx = await fixture(
    t,
    `throw new Error('native must not execute');`,
    [argument('attach', { action: 'Append', valueType: 'path' })],
    { attach: 'inputFile' },
    2000,
    {
      fileDownloader: async () => {
        downloads++;
        return Buffer.from('original');
      },
    },
  );
  for (const input of [
    { attach: remoteFile },
    { attach: [remoteFile], params: { attach: ['file:other.bin'] } },
    { attach: [{ ...remoteFile, file_name: '../escape' }] },
    { attach: [remoteFile, { ...remoteFile, file_id: 'different-id' }] },
    { attach: [remoteFile], files: [{ name: remoteFile.file_name!, base64: 'eA==' }] },
    { attach: [remoteFile], params: { unknown: 'bad' } },
    { unknown_file_field: remoteFile },
  ] satisfies CallInput[])
    await assert.rejects(ctx.runtime.callTool(ctx.name, input), AdapterError);
  assert.equal(downloads, 0);
});

test('the explicit user policy is checked before file download and remains editable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'himalaya-mcp-file-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const policyPath = join(directory, 'policy.yaml');
  await writeFile(
    policyPath,
    'schemaVersion: 1\ndeny:\n  - command: "**"\n    reason: User exclusion\n',
  );
  let downloads = 0;
  const ctx = await fixture(
    t,
    `process.stdout.write(await readFile(options.attach));`,
    [argument('attach', { action: 'Append', valueType: 'path' })],
    { attach: 'inputFile' },
    2000,
    {
      policyPath,
      fileDownloader: async () => {
        downloads++;
        return Buffer.from('original');
      },
    },
  );
  await assert.rejects(ctx.runtime.callTool(ctx.name, { attach: [remoteFile] }), {
    code: 'policy_denied',
  });
  assert.equal(downloads, 0);
  await writeFile(policyPath, 'schemaVersion: 1\ndeny: []\n');
  assert.equal((await ctx.runtime.callTool(ctx.name, { attach: [remoteFile] })).stdout, 'original');
  assert.equal(downloads, 1);
});

test('one failed import prevents native execution and removes previously imported bytes', async (t) => {
  let downloads = 0;
  const ctx = await fixture(
    t,
    `throw new Error('native must not execute');`,
    [argument('attach', { action: 'Append', valueType: 'path' })],
    { attach: 'inputFile' },
    2000,
    {
      fileDownloader: async () => {
        if (++downloads === 2) throw new AdapterError('file_download', 'Synthetic failed import');
        return Buffer.from('original');
      },
    },
  );
  await assert.rejects(
    ctx.runtime.callTool(ctx.name, {
      attach: [remoteFile, { ...remoteFile, file_id: 'second-id', file_name: 'second.bin' }],
    }),
    { code: 'file_download' },
  );
  assert.equal(downloads, 2);
  assert.deepEqual(await readdir(ctx.workspaces), []);
});

test('downloads share one aggregate input budget', async (t) => {
  const budgets: number[] = [];
  const ctx = await fixture(
    t,
    `throw new Error('native must not execute');`,
    [argument('attach', { action: 'Append', valueType: 'path' })],
    { attach: 'inputFile' },
    2000,
    {
      fileDownloader: async (_file, limit) => {
        budgets.push(limit);
        return Buffer.alloc(budgets.length === 1 ? 32 * 1024 * 1024 - 1 : 2);
      },
    },
  );
  await assert.rejects(
    ctx.runtime.callTool(ctx.name, {
      attach: [remoteFile, { ...remoteFile, file_id: 'second-id', file_name: 'second.bin' }],
    }),
    { code: 'input_limit' },
  );
  assert.deepEqual(budgets, [32 * 1024 * 1024, 1]);
  assert.deepEqual(await readdir(ctx.workspaces), []);
});

test('closing cancels pending file imports and waits for private workspace cleanup', async (t) => {
  let started!: () => void;
  const importing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const ctx = await fixture(
    t,
    `throw new Error('native must not execute');`,
    [argument('attach', { action: 'Append', valueType: 'path' })],
    { attach: 'inputFile' },
    2000,
    {
      fileDownloader: (_file, _limit, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          started();
        }),
    },
  );
  const pending = ctx.runtime.callTool(ctx.name, { attach: [remoteFile] });
  const rejected = assert.rejects(pending, { code: 'runtime_closed' });
  await importing;
  await ctx.runtime.close();
  await rejected;
  assert.deepEqual(await readdir(ctx.workspaces), []);
});

test('HTTP clients can upload bytes but cannot select host files or another call workspace', async (t) => {
  const ctx = await fixture(
    t,
    `process.stdout.write(await readFile(options.attach));`,
    [argument('attach', { valueType: 'path' })],
    { attach: 'inputFile' },
    2000,
    { fileDownloader: async () => Buffer.from('client-provided') },
  );
  const secret = join(ctx.directory, 'host-file.bin');
  await writeFile(secret, 'synthetic-private-content');
  const handle = await startHttp(ctx.runtime, { version: 'file-boundary-test', port: 0 });
  const client = new Client({ name: 'http-file-boundary-test', version: '1' });
  t.after(async () => {
    await client.close();
    await handle.close();
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(handle.url!)));
  for (const path of [
    secret,
    '../host-file.bin',
    '/mnt/data/photo.jpeg',
    'himalaya-mcp://artifacts/other/call.bin',
  ]) {
    const result = await client.callTool({
      name: ctx.name,
      arguments: { params: { attach: path } },
    });
    assert.equal(result.isError, true, path);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private-content/);
  }
  const result = await client.callTool({
    name: ctx.name,
    arguments: {
      attach: remoteFile,
    },
  });
  assert.equal(result.isError, false);
  assert.equal((result.structuredContent as Record<string, unknown>)?.stdout, 'client-provided');
});

test('uploaded inputs are removed immediately while output artifacts alone remain readable', async (t) => {
  const ctx = await fixture(
    t,
    `await writeFile(options.output, await readFile(options.attach));`,
    [argument('attach', { valueType: 'path' }), argument('output', { valueType: 'path' })],
    { attach: 'inputFile', output: 'outputFile' },
    2000,
    { fileDownloader: async () => Buffer.from('x') },
  );
  const result = await ctx.runtime.callTool(ctx.name, {
    params: { output: 'output.bin' },
    attach: remoteFile,
  });
  const [call] = await readdir(ctx.workspaces);
  assert.ok(call);
  assert.deepEqual(await readdir(join(ctx.workspaces, call)), ['output.bin']);
  assert.equal((await ctx.runtime.readResource(result.files[0]!.uri)).contents[0]?.blob, 'eA==');
  await ctx.runtime.close();
  assert.deepEqual(await readdir(ctx.workspaces), []);
});

test('expired output directories are swept without needing another MCP call', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1_000_000 });
  const ctx = await fixture(
    t,
    `await writeFile(options.output, 'output');`,
    [argument('output', { valueType: 'path' })],
    { output: 'outputFile' },
  );
  await ctx.runtime.callTool(ctx.name, { params: { output: 'output.txt' } });
  t.mock.timers.setTime(1_000_000 + 3_600_000);
  t.mock.timers.tick(60_000);
  // The timer's filesystem work is asynchronous; wait for the observed deletion.
  const until = performance.now() + 3000;
  while ((await readdir(ctx.workspaces)).length && performance.now() < until)
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(await readdir(ctx.workspaces), []);
  assert.deepEqual(ctx.runtime.listResources(), []);
});

test('backend selectors and local entry IDs cannot turn HTTP calls into host file reads', async (t) => {
  let downloads = 0;
  const ctx = await fixture(
    t,
    `process.stdout.write(JSON.stringify(argv));`,
    [
      argument('mbox_source_path'),
      argument('mailbox'),
      argument('message_ids', { action: 'Append' }),
      argument('attach', { action: 'Append', valueType: 'path' }),
    ],
    {
      mbox_source_path: 'accountPath',
      mailbox: 'accountPath',
      message_ids: 'accountPath',
      attach: 'inputFile',
    },
    2000,
    {
      fileDownloader: async () => {
        downloads++;
        return Buffer.from('original');
      },
    },
  );
  const handle = await startHttp(ctx.runtime, { version: 'backend-boundary-test', port: 0 });
  const client = new Client({ name: 'http-backend-boundary-test', version: '1' });
  t.after(async () => {
    await client.close();
    await handle.close();
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(handle.url!)));
  for (const [id, value] of [
    ['mbox_source_path', '/etc/passwd'],
    ['mailbox', '../../outside'],
    ['message_ids', ['../../outside']],
    ['message_ids', ['/etc/passwd']],
    ['message_ids', ['C:\\private']],
    ['message_ids', ['..\\private']],
  ] as const) {
    const result = await client.callTool({
      name: ctx.name,
      arguments: { params: { [id]: value }, attach: [remoteFile] },
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /file_boundary/);
  }
  assert.equal(downloads, 0);
  const result = await client.callTool({
    name: ctx.name,
    arguments: { params: { message_ids: ['AAMkABc/opaque+id==', 'id$literal'] } },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(
    JSON.parse(String((result.structuredContent as Record<string, unknown>).stdout)),
    ['--message_ids=AAMkABc/opaque+id==', '--message_ids=id$literal'],
  );
});

test('omitted output directories stay in the call workspace', async (t) => {
  const ctx = await fixture(
    t,
    `await mkdir(options.dir, { recursive: true }); await writeFile(options.dir + '/attachment.bin', Buffer.from([255, 0]));`,
    [argument('dir', { valueType: 'path' })],
    { dir: 'outputDirectory' },
  );
  const result = await ctx.runtime.callTool(ctx.name, {});
  assert.equal(result.files[0]?.name, 'attachment.bin');
  assert.equal((await ctx.runtime.readResource(result.files[0]!.uri)).contents[0]?.blob, '/wA=');
});

test('declared shell-expanded outputs are checked after expansion and bound exactly once', async (t) => {
  const ctx = await fixture(
    t,
    `await writeFile(options.output.replaceAll('$$', '$'), 'synthetic');`,
    [argument('output', { valueType: 'path' })],
    {},
    2_000,
    {
      profiles: {
        schemaVersion: 1,
        rules: [
          { commands: ['**'], args: { output: 'outputFile' }, pathExpansion: { output: 'shell' } },
        ],
      },
    },
  );
  const result = await ctx.runtime.callTool(ctx.name, {
    params: { output: 'literal$$HIMALAYA_MCP_FIXTURE_UNSET.txt' },
  });
  assert.equal(result.files[0]?.name, 'literal$HIMALAYA_MCP_FIXTURE_UNSET.txt');
  const outside =
    process.platform === 'win32' ? ctx.directory.replaceAll('\\', '/') : ctx.directory;
  await assert.rejects(
    ctx.runtime.callTool(ctx.name, {
      params: { output: '${HIMALAYA_MCP_FIXTURE_UNSET:-' + outside + '}/outside.txt' },
    }),
    /inside this call workspace/,
  );
  await assert.rejects(
    ctx.runtime.callTool(ctx.name, { params: { output: '$HIMALAYA_MCP_FIXTURE_UNSET' } }),
    /unset native path variable/,
  );
});

test('account-relative paths retain native defaults and never become workspace paths', async (t) => {
  const ctx = await fixture(
    t,
    `process.stdout.write(JSON.stringify(argv));`,
    [
      argument('maildir_source_path', {
        long: 'maildir',
        valueType: 'path',
        defaultValues: ['Inbox'],
      }),
    ],
    { maildir_source_path: 'accountPath' },
  );
  assert.deepEqual(JSON.parse((await ctx.runtime.callTool(ctx.name, {})).stdout), []);
  assert.deepEqual(
    JSON.parse(
      (await ctx.runtime.callTool(ctx.name, { params: { maildir_source_path: '.Archive' } }))
        .stdout,
    ),
    ['--maildir=.Archive'],
  );
  for (const value of [
    '../outside',
    '/outside',
    'C:\\outside',
    '..\\outside',
    'bad\0name',
    'bad\nname',
  ])
    await assert.rejects(
      ctx.runtime.callTool(ctx.name, { params: { maildir_source_path: value } }),
      /relative to the configured account root/,
    );
  for (const value of ['$Projects', 'Archive~2026', '$HOME'])
    assert.deepEqual(
      JSON.parse(
        (await ctx.runtime.callTool(ctx.name, { params: { maildir_source_path: value } })).stdout,
      ),
      ['--maildir=' + value],
    );
});

test('config arguments cannot replace the server-owned native configuration', async (t) => {
  const ctx = await fixture(
    t,
    '',
    [argument('config_paths', { action: 'Append', long: 'config', valueType: 'path' })],
    { config_paths: 'config' },
  );
  await assert.rejects(
    ctx.runtime.callTool(ctx.name, { params: { config_paths: ['/some-config.toml'] } }),
    /selected by the server/,
  );
});

test('server-owned configuration uses the generated binding without splitting a Windows drive', async (t) => {
  const file = join(tmpdir(), 'synthetic-native-config.toml');
  const ctx = await fixture(
    t,
    `process.stdout.write(JSON.stringify(argv));`,
    [
      argument('config_paths', {
        action: 'Append',
        long: 'config',
        valueType: 'path',
        valueDelimiter: ':',
      }),
    ],
    { config_paths: 'config' },
    2_000,
    { configPath: file },
  );
  const result = await ctx.runtime.callTool(ctx.name, {});
  const argv = JSON.parse(result.stdout) as string[];
  assert.equal(argv.length, 1);
  const value = argv[0]!.replace(/^--config=/, '');
  assert.ok(value.length > 0 && !value.includes(':'));
  if (process.platform === 'win32') assert.ok(value.startsWith('..'));
  else assert.equal(value, file);
});

test(
  'native symlink outputs are rejected and removed rather than published',
  { skip: process.platform === 'win32' },
  async (t) => {
    const ctx = await fixture(
      t,
      `await (await import('node:fs/promises')).symlink(${JSON.stringify(process.execPath)}, 'escape');`,
    );
    await assert.rejects(ctx.runtime.callTool(ctx.name, {}), /symbolic link/);
    assert.deepEqual(await readdir(ctx.workspaces), []);
  },
);

test('a symlink workspace root is rejected', { skip: process.platform === 'win32' }, async (t) => {
  const ctx = await fixture(t, '');
  await symlink(ctx.directory, ctx.workspaces);
  await assert.rejects(ctx.runtime.callTool(ctx.name, {}), /owned ordinary directory/);
});

test('timeouts terminate the native call, keep its status, and do not retry writes', async (t) => {
  const ctx = await fixture(
    t,
    `process.stdout.write('started'); setTimeout(() => {}, 30_000);`,
    [],
    {},
    600,
  );
  const result = await ctx.runtime.callTool(ctx.name, {});
  assert.equal(result.timedOut, true);
  assert.equal(result.stdout, 'started');
  assert.ok(result.exitCode === null || result.exitCode !== 0);
});

test('closing during allocation waits for in-flight cleanup and prevents a later spawn', async (t) => {
  const ctx = await fixture(t, `process.stdout.write('should not run');`);
  const pending = ctx.runtime.callTool(ctx.name, {});
  const settled = assert.rejects(pending, /server is closing/);
  await ctx.runtime.close();
  await settled;
  assert.deepEqual(await readdir(ctx.workspaces).catch(() => []), []);
  await assert.rejects(ctx.runtime.callTool(ctx.name, {}), /server is closing/);
});

test('concurrent native file outputs cannot exceed the aggregate resource budget', async (t) => {
  const ctx = await fixture(
    t,
    `const bytes = Buffer.alloc(20 * 1024 * 1024); await writeFile('a.bin', bytes); await writeFile('b.bin', bytes); await mkdir('empty');`,
  );
  const results = await Promise.allSettled([
    ctx.runtime.callTool(ctx.name, {}),
    ctx.runtime.callTool(ctx.name, {}),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const failure = results.find((result) => result.status === 'rejected');
  assert.match(String(failure?.status === 'rejected' ? failure.reason : ''), /artifact limit/);
  assert.ok(
    ctx.runtime.listResources().reduce((total, file) => total + file.size, 0) <= 64 * 1024 * 1024,
  );
});

test('closing an active native call waits for termination and workspace removal', async (t) => {
  const ctx = await fixture(t, '');
  // Put the readiness marker in this test directory, not in a shared fixture path.
  const ready = join(ctx.directory, 'ready');
  await writeFile(
    ctx.script,
    PRELUDE +
      `await writeFile(${JSON.stringify(ready)}, String(process.pid)); setTimeout(() => {}, 30_000);`,
  );
  const pending = ctx.runtime.callTool(ctx.name, {});
  const settled = assert.rejects(pending, /server is closing/);
  for (let count = 0; count < 200 && !(await readFile(ready).catch(() => undefined)); count++)
    await new Promise((accept) => setTimeout(accept, 10));
  const pid = Number(await readFile(ready, 'utf8'));
  await ctx.runtime.close();
  await settled;
  assert.throws(() => process.kill(pid, 0));
  assert.deepEqual(await readdir(ctx.workspaces), []);
});

test('only configured, noninteractive, nonexcluded native tools are advertised', async (t) => {
  const ctx = await fixture(t, `process.stdout.write('ok');`, [], {}, 2000, {
    profiles: { schemaVersion: 1, rules: [{ commands: ['**'], requiresBackend: 'imap' }] },
    configuredBackends: new Set(),
  });
  assert.deepEqual(await ctx.runtime.tools(), []);
  await assert.rejects(ctx.runtime.callTool(ctx.name, {}), { code: 'backend_unavailable' });
  const terminal = await fixture(t, `throw new Error('must not run');`, [], {}, 2000, {
    profiles: { schemaVersion: 1, rules: [{ commands: ['**'], interactive: true }] },
  });
  assert.deepEqual(await terminal.runtime.tools(), []);
  await assert.rejects(terminal.runtime.callTool(terminal.name, {}), {
    code: 'interactive_required',
  });
  const policyPath = join(ctx.directory, 'dynamic-policy.yaml');
  await writeFile(
    policyPath,
    'schemaVersion: 1\ndeny:\n  - command: "**"\n    reason: user exclusion\n',
  );
  const filtered = await fixture(t, `process.stdout.write('ok');`, [argument('mode')], {}, 2000, {
    policyPath,
  });
  assert.deepEqual(await filtered.runtime.tools(), []);
  await writeFile(
    policyPath,
    'schemaVersion: 1\ndeny:\n  - command: "**"\n    when:\n      mode: "danger"\n    reason: conditional user exclusion\n',
  );
  assert.equal((await filtered.runtime.tools()).length, 1);
});

test('the durable execution barrier follows file import and prevents spawn on persistence failure', async (t) => {
  const events: string[] = [];
  const ctx = await fixture(
    t,
    `process.stdout.write('executed');`,
    [argument('attach', { valueType: 'path' })],
    { attach: 'inputFile' },
    2000,
    {
      fileDownloader: async () => {
        events.push('download');
        return Buffer.from('x');
      },
    },
  );
  await assert.rejects(
    ctx.runtime.callTool(ctx.name, { attach: remoteFile }, async () => {
      events.push('barrier');
      throw new AdapterError('operation_store', 'Synthetic persistence failure');
    }),
    { code: 'operation_store' },
  );
  assert.deepEqual(events, ['download', 'barrier']);
  assert.deepEqual(await readdir(ctx.workspaces), []);
  const result = await ctx.runtime.callTool(ctx.name, { attach: remoteFile }, async () => {
    events.push('barrier');
  });
  assert.equal(result.stdout, 'executed');
});

test('public input rejects former byte channels and raw-file parameters before execution', async (t) => {
  const ctx = await fixture(t, `throw new Error('must not run');`, [argument('message-raw')], {
    'message-raw': 'inlineOrFile',
  });
  for (const input of [
    { stdin: 'raw' },
    { stdinBase64: 'eA==' },
    { files: [] },
    { params: { 'message-raw': '/mnt/data/message.eml' } },
    { params: { 'message-raw': 'Subject: raw' } },
  ])
    await assert.rejects(ctx.runtime.callTool(ctx.name, input), AdapterError);
});
