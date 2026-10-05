#!/usr/bin/env node
/** Install the exact archive without lifecycle scripts or network dependencies; metadata + loopback mail only. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { runCommand, runNpm } from './release.mjs';
import { smtpSmoke } from './smtp-smoke.mjs';

const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function platformSmoke({ archive, expectedPlatform, expectedArch }) {
  if (expectedPlatform !== undefined)
    assert.equal(
      process.platform,
      expectedPlatform,
      'Runner must use its declared native platform',
    );
  if (expectedArch !== undefined)
    assert.equal(
      process.arch,
      expectedArch,
      'Runner must use its declared native architecture, without emulation',
    );
  const directory = await mkdtemp(join(tmpdir(), 'himalaya-mcp-platform-'));
  const cacheDir = join(directory, 'cache');
  let client, transport;
  try {
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'himalaya-mcp-platform-fixture', version: '0.0.0', private: true }),
    );
    await runNpm(
      [
        'install',
        '--offline',
        '--ignore-scripts',
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        '--save=false',
        resolve(archive),
      ],
      { cwd: directory },
    );
    const installed = join(directory, 'node_modules', 'himalaya-mcp');
    const packageJson = await json(join(installed, 'package.json'));
    assert.deepEqual(Object.keys(packageJson.dependencies ?? {}), []);
    assert.deepEqual(Object.keys(packageJson.optionalDependencies ?? {}), []);
    for (const name of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack'])
      assert.equal(packageJson.scripts?.[name], undefined, 'No user-side build/lifecycle: ' + name);
    const dependencies = (await readdir(join(directory, 'node_modules'))).filter(
      (name) => name !== '.bin' && name !== '.package-lock.json',
    );
    assert.deepEqual(
      dependencies,
      ['himalaya-mcp'],
      'Clean installation must not install runtime dependencies',
    );
    const cli = join(installed, 'dist', 'cli.js');
    await access(
      join(
        directory,
        'node_modules',
        '.bin',
        process.platform === 'win32' ? 'himalaya-mcp.cmd' : 'himalaya-mcp',
      ),
    );
    const manifest = await json(join(installed, 'dist', 'manifest.json'));
    const catalogBytes = await readFile(join(installed, 'dist', 'catalog.json'));
    const catalog = JSON.parse(catalogBytes);
    assert.equal(hash(catalogBytes), manifest.catalogSha256);
    assert.equal(manifest.packageVersion, packageJson.version);
    const asset = manifest.assets.find(
      (candidate) => candidate.platform === process.platform && candidate.arch === process.arch,
    );
    assert(asset, 'This platform must have an official pinned asset');
    const config = join(directory, 'metadata-only.toml');
    if (process.platform === 'win32')
      assert.match(
        config,
        /^[A-Za-z]:[\\/]/,
        'Windows smoke must exercise an actual drive-qualified config path',
      );
    await writeFile(config, '[accounts]\n', { mode: 0o600 });
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) => typeof value === 'string' && key.toLowerCase() !== 'himalaya_config',
      ),
    );
    environment.HIMALAYA_MCP_SMOKE_CACHE = cacheDir;
    const args = [
      '--config',
      config,
      '--cache-dir',
      cacheDir,
      '--workspace-dir',
      join(directory, 'calls'),
      '--operation-dir',
      join(directory, 'operations'),
    ];
    const description = JSON.parse(
      (
        await runCommand(process.execPath, [cli, 'describe', '--json'], {
          cwd: directory,
          env: environment,
        })
      ).stdout,
    );
    const launched = JSON.parse(
      (
        await runNpm(['exec', '--offline', '--', 'himalaya-mcp', 'describe', '--json'], {
          cwd: directory,
          env: environment,
        })
      ).stdout,
    );
    assert.deepEqual(
      launched,
      description,
      'The installed npm bin must launch the same bundled CLI',
    );
    assert.equal(
      description.tools.length,
      catalog.commands.filter((command) => command.runnable).length,
      'Every runnable CLI command must appear in describe',
    );
    const before = await runCommand(process.execPath, [cli, 'doctor', '--json', ...args], {
      cwd: directory,
      env: environment,
      allowFailure: true,
    });
    assert.equal(before.code, 1);
    assert.equal(JSON.parse(before.stdout).binary.code, 'binary_missing');
    await assert.rejects(
      lstat(cacheDir),
      { code: 'ENOENT' },
      'Doctor must not create or download a cache',
    );
    client = new Client({ name: 'himalaya-mcp-platform-check', version: '1' });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'serve', ...args],
      cwd: directory,
      env: environment,
      stderr: 'pipe',
      maxBufferSize: 16 * 1024 * 1024,
    });
    let logs = '';
    transport.stderr?.on('data', (bytes) => {
      logs = (logs + bytes.toString()).slice(-8000);
    });
    await client.connect(transport, { timeout: 90_000 });
    const listing = await client.listTools();
    for (const tool of listing.tools.filter(
      (tool) => !tool.name.startsWith('himalaya_mcp_operation'),
    )) {
      const generated = description.tools.find((candidate) => candidate.name === tool.name);
      assert(generated, 'Runtime cannot invent a native command');
      assert.deepEqual(tool.annotations, generated.annotations);
      assert.deepEqual(tool._meta, generated._meta);
      assert.deepEqual(tool.inputSchema.properties.params, generated.inputSchema.properties.params);
      for (const field of generated._meta?.['openai/fileParams'] ?? [])
        assert.deepEqual(
          tool.inputSchema.properties[field],
          generated.inputSchema.properties[field],
        );
      assert(tool.description.includes(generated.description));
      assert(tool.inputSchema.required.includes('request_id'));
    }
    assert(listing.tools.some((tool) => tool.name === 'himalaya_mcp_operation_status'));
    assert(
      !listing.tools.some((tool) => tool.name === 'himalaya_imap_message_send'),
      'Unconfigured backend must be absent',
    );
    const nativeCommand = catalog.commands.find(
      (command) => command.path.join(' ') === 'account list',
    );
    const help = nativeCommand.args.find((arg) =>
      ['Help', 'HelpShort', 'HelpLong'].includes(arg.action),
    );
    assert(help, 'Native Help must remain generically callable');
    const result = await client.callTool({
      name: 'himalaya_account_list',
      arguments: { request_id: 'platform-help-request', params: { [help.id]: true } },
    });
    assert.equal(result.isError, false, 'Generic native Help failed: ' + logs);
    assert.equal(result.structuredContent?.operation.state, 'succeeded');
    assert.equal(result.structuredContent?.result.exitCode, 0);
    assert.match(result.structuredContent?.result.stdout ?? '', /Usage: himalaya/);
    await client.close();
    client = undefined;
    transport = undefined;
    const check = async () => {
      const doctor = JSON.parse(
        (
          await runCommand(process.execPath, [cli, 'doctor', '--json', ...args], {
            cwd: directory,
            env: environment,
          })
        ).stdout,
      );
      assert.equal(doctor.ok, true);
      assert.equal(doctor.binary.binary.verified, true);
      assert.equal(doctor.binary.binary.source, 'cache');
      assert.equal(doctor.binary.binary.version, manifest.himalaya.version);
      assert.equal(doctor.binary.binary.sha256, asset.binarySha256);
      assert.equal(hash(await readFile(doctor.binary.binary.path)), asset.binarySha256);
      return doctor.binary.binary;
    };
    const first = await check();
    const nativeVersion = await runCommand(first.path, ['--version'], {
      cwd: directory,
      env: environment,
    });
    assert.match(
      nativeVersion.stdout,
      new RegExp('v' + manifest.himalaya.version.replaceAll('.', '\\.')),
    );
    const nativeHelp = await runCommand(first.path, ['--help'], {
      cwd: directory,
      env: environment,
    });
    assert.match(nativeHelp.stdout, /Usage: himalaya/);
    const second = await check();
    assert.equal(second.path, first.path, 'A second launch must reuse the verified cache');
    assert.deepEqual(
      await readdir(cacheDir),
      [asset.binarySha256],
      'Download staging files must be cleaned',
    );
    await smtpSmoke({ cli, catalog, environment, cacheDir });
    console.log(
      'Platform package verified: ' +
        JSON.stringify({
          platform: process.platform,
          arch: process.arch,
          packageVersion: packageJson.version,
          nativeVersion: manifest.himalaya.version,
          executableSha256: asset.binarySha256,
          tools: listing.tools.length,
          installation: 'offline/no lifecycle/no dependencies',
          checks: [
            'describe',
            'offline npm executable entry',
            'doctor without network/download',
            'official first download',
            'verified cache reuse',
            'native version/help',
            'MCP available schemas/receipts/native Help',
            'loopback complex MIME/envelope/Bcc/attachments',
            ...(process.platform === 'win32'
              ? ['native config drive path survives Clap delimiter parsing']
              : []),
          ],
        }),
    );
  } finally {
    await client?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const values = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index],
      value = process.argv[index + 1];
    if (
      !['--package', '--expected-platform', '--expected-arch'].includes(flag) ||
      !value ||
      values[flag] !== undefined
    )
      throw new Error(
        'Usage: node scripts/platform-smoke.mjs --package FILE [--expected-platform PLATFORM --expected-arch ARCH]',
      );
    values[flag] = value;
  }
  if (!values['--package']) throw new Error('--package is required.');
  platformSmoke({
    archive: values['--package'],
    expectedPlatform: values['--expected-platform'],
    expectedArch: values['--expected-arch'],
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
