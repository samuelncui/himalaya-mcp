import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { toolName } from '../src/catalog.js';
import { Runtime, type RuntimeOptions } from '../src/runtime.js';
import { type CliArg, type IoRole, type Profiles } from '../src/types.js';
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
    stdin: 'Subject: synthetic\r\n\r\nbody\r\n',
  });
  assert.equal(result.exitCode, 7);
  assert.equal(result.stderr, 'synthetic native error');
  assert.deepEqual(JSON.parse(result.stdout), {
    argv: ['--header=X-Value: $(literal)', '--header=Subject: `literal`'],
    stdin: 'Subject: synthetic\r\n\r\nbody\r\n',
  });
  assert.deepEqual(result.files, []);
});

test('binary stdin/stdout and registered output resources preserve bytes', async (t) => {
  const ctx = await fixture(
    t,
    `await writeFile(options.output, stdin); process.stdout.write(Buffer.from([0, 255, 254, 65]));`,
    [argument('output', { valueType: 'path' })],
    { output: 'outputFile' },
  );
  const input = Buffer.from([0, 255, 254, 13, 10]);
  const result = await ctx.runtime.callTool(ctx.name, {
    params: { output: 'mail.bin' },
    stdinBase64: input.toString('base64'),
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

test('uploaded files and string-or-file values share the generic file boundary', async (t) => {
  const ctx = await fixture(
    t,
    `const last = argv.at(-1); process.stdout.write(JSON.stringify({ attach: (await readFile(options.attach)).toString('base64'), raw: (await readFile(last)).toString('base64') }));`,
    [
      argument('attach', { action: 'Append', valueType: 'path' }),
      argument('message-raw', {
        index: 1,
        long: null,
        action: 'Append',
        maxValues: null,
        last: true,
      }),
    ],
    { attach: 'inputFile', 'message-raw': 'inlineOrFile' },
  );
  const mime = Buffer.from(
    'Subject: synthetic\r\nContent-Type: multipart/mixed; boundary="x"\r\n\r\n--x--\r\n',
  );
  const attachment = Buffer.from([0, 255, 42]);
  const result = await ctx.runtime.callTool(ctx.name, {
    params: { attach: ['file:report $(literal).bin'], 'message-raw': ['file:mail.eml'] },
    files: [
      { name: 'report $(literal).bin', base64: attachment.toString('base64') },
      { name: 'mail.eml', base64: mime.toString('base64') },
    ],
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    attach: attachment.toString('base64'),
    raw: mime.toString('base64'),
  });
  assert.deepEqual(result.files, []);
  const hostFile = join(ctx.directory, 'host-secret.eml');
  await writeFile(hostFile, 'synthetic private value');
  await assert.rejects(
    ctx.runtime.callTool(ctx.name, { params: { 'message-raw': [hostFile] } }),
    /inside this call workspace/,
  );
  if (process.platform !== 'win32') {
    const newlinePath = join(ctx.directory, 'host\nprivate.eml');
    await writeFile(newlinePath, 'synthetic private value');
    await assert.rejects(
      ctx.runtime.callTool(ctx.name, { params: { 'message-raw': [newlinePath] } }),
      /inside this call workspace/,
    );
  }
  await assert.rejects(
    ctx.runtime.callTool(ctx.name, { params: { attach: ['../host-secret.eml'] } }),
    /inside this call workspace/,
  );
  await assert.rejects(
    ctx.runtime.callTool(ctx.name, { files: [{ name: '../escape', base64: '' }] }),
    /unique basenames/,
  );
  await assert.rejects(
    ctx.runtime.callTool(ctx.name, { stdin: 'x', stdinBase64: 'eA==' }),
    /mutually exclusive/,
  );
  await assert.rejects(
    ctx.runtime.callTool(ctx.name, { stdinBase64: 'not base64' }),
    /canonical base64/,
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
  for (const value of ['../outside', '/outside', 'C:\\outside', '$HOME', '~'])
    await assert.rejects(
      ctx.runtime.callTool(ctx.name, { params: { maildir_source_path: value } }),
      /relative to the configured account root/,
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
