#!/usr/bin/env node
/** Source/binary provenance and generation only. No mailbox execution occurs here. */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, rm, cp, chmod } from 'node:fs/promises';
import { dirname, join, resolve, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(root, 'build');
const generated = join(build, 'generated');
const baselinePath = join(root, 'generator', 'baseline.json');
const platforms = [
  { platform: 'darwin', arch: 'arm64', name: 'himalaya.aarch64-darwin.tgz' },
  { platform: 'darwin', arch: 'x64', name: 'himalaya.x86_64-darwin.tgz' },
  { platform: 'linux', arch: 'arm64', name: 'himalaya.aarch64-linux.tgz' },
  { platform: 'linux', arch: 'x64', name: 'himalaya.x86_64-linux.tgz' },
  { platform: 'win32', arch: 'x64', name: 'himalaya.x86_64-windows.tgz' },
];

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

export function run(program, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(program, args, { cwd: root, ...options, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (data) => {
      stdout += data;
    });
    child.stderr?.on('data', (data) => {
      stderr += data;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`${program} exited ${code}: ${stderr.slice(-8000)}`));
      else accept({ stdout, stderr });
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}

async function get(url) {
  const headers = { 'User-Agent': 'himalaya-mcp-generator', Accept: 'application/vnd.github+json' };
  if (new URL(url).hostname === 'api.github.com' && process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return response;
}

async function download(url, path, expected) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (bytes && expected && sha256(bytes) !== expected) {
    throw new Error(`Cached file checksum mismatch: ${path}. Delete this file and retry.`);
  }
  if (!bytes) {
    bytes = Buffer.from(await (await get(url)).arrayBuffer());
    const digest = sha256(bytes);
    if (expected && digest !== expected)
      throw new Error(`Official archive checksum mismatch: ${url}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  return { bytes, digest: sha256(bytes) };
}

async function entries(file) {
  const tar = await import('tar');
  const names = [];
  await tar.t({
    file,
    strict: true,
    onReadEntry(entry) {
      const name = entry.path;
      if (
        name.includes('\\') ||
        posix.isAbsolute(name) ||
        /^[A-Za-z]:/.test(name) ||
        name.split('/').includes('..') ||
        !['File', 'Directory'].includes(entry.type)
      ) {
        throw new Error(`Unsupported or unsafe official archive entry: ${name} (${entry.type})`);
      }
      names.push({ name, type: entry.type });
    },
  });
  return names;
}

async function sourceTree(revision, expectedSourceDigest) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Expected a full upstream commit SHA.');
  const archive = join(build, 'downloads', `source-${revision}.tgz`);
  const source = await download(
    `https://codeload.github.com/pimalaya/himalaya/tar.gz/${revision}`,
    archive,
    expectedSourceDigest,
  );
  const directory = join(build, 'upstream', revision);
  await entries(archive);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const tar = await import('tar');
  await tar.x({ file: archive, cwd: directory, strip: 1, strict: true });
  return { directory, sourceArchiveSha256: source.digest };
}

function metadata(bytes, version) {
  const pattern =
    /v([\d.]+) ((?:\+[a-z0-9_-]+ ?)+)\nbuild: ([a-z0-9_]+) ([a-z0-9_]*) ([a-z0-9_]+)\ngit: ([^\0\r\n]{0,200}?), rev ([a-f0-9]{40}|unknown)/g;
  const values = [...bytes.toString('latin1').matchAll(pattern)]
    .filter((match) => match[1] === version)
    .map((match) => ({
      version: match[1],
      features: match[2]
        .trim()
        .split(' ')
        .map((value) => value.slice(1))
        .sort(),
      platform: match[3],
      arch: match[5],
      revision: match[7],
    }));
  const unique = [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
  if (unique.length !== 1)
    throw new Error(`Cannot uniquely identify official binary build metadata for ${version}.`);
  return unique[0];
}

async function binaryAsset(asset, releaseAsset, version, revision) {
  if (!/^sha256:[a-f0-9]{64}$/.test(releaseAsset.digest ?? '')) {
    throw new Error(
      `GitHub has no SHA256 digest for ${asset.name}; do not publish an unverified asset.`,
    );
  }
  const archiveSha256 = releaseAsset.digest.slice(7);
  const archive = join(build, 'downloads', version, asset.name);
  await download(releaseAsset.browser_download_url, archive, archiveSha256);
  const binaryName = asset.platform === 'win32' ? 'himalaya.exe' : 'himalaya';
  const files = (await entries(archive)).filter(
    (entry) => entry.type === 'File' && posix.basename(entry.name) === binaryName,
  );
  if (files.length !== 1) throw new Error(`${asset.name} must contain exactly one ${binaryName}.`);
  const directory = join(build, 'assets', `${asset.platform}-${asset.arch}`);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const tar = await import('tar');
  await tar.x({
    file: archive,
    cwd: directory,
    strip: files[0].name.split('/').length - 1,
    strict: true,
    filter: (name) => name === files[0].name,
  });
  const binary = join(directory, binaryName);
  await chmod(binary, 0o755);
  const bytes = await readFile(binary);
  const native = metadata(bytes, version);
  const expectedPlatform =
    asset.platform === 'win32' ? 'windows' : asset.platform === 'darwin' ? 'macos' : 'linux';
  const expectedArch = asset.arch === 'arm64' ? 'aarch64' : 'x86_64';
  if (
    native.revision !== revision ||
    native.platform !== expectedPlatform ||
    native.arch !== expectedArch
  ) {
    throw new Error(`Official ${asset.name} source/target mismatch: ${JSON.stringify(native)}.`);
  }
  return {
    ...asset,
    url: releaseAsset.browser_download_url,
    archiveSha256,
    binarySha256: sha256(bytes),
    features: native.features,
  };
}

async function resolveRevision(tag) {
  const response = await (
    await get(
      `https://api.github.com/repos/pimalaya/himalaya/git/ref/tags/${encodeURIComponent(tag)}`,
    )
  ).json();
  let object = response.object;
  for (let depth = 0; object.type === 'tag' && depth < 5; depth += 1) {
    object = (
      await (
        await get(`https://api.github.com/repos/pimalaya/himalaya/git/tags/${object.sha}`)
      ).json()
    ).object;
  }
  if (object.type !== 'commit' || !/^[a-f0-9]{40}$/.test(object.sha))
    throw new Error(`Cannot resolve ${tag} to a source commit.`);
  return object.sha;
}

export async function resolveUpstream(options = {}) {
  const baseline = await json(baselinePath);
  const endpoint = options.latest ? 'latest' : `tags/v${options.version ?? baseline.version}`;
  const release = await (
    await get(`https://api.github.com/repos/pimalaya/himalaya/releases/${endpoint}`)
  ).json();
  const tag = release.tag_name;
  const version = tag.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version))
    throw new Error(`Unsupported release tag: ${tag}`);
  const revision = await resolveRevision(tag);
  const isBaseline = version === baseline.version;
  if (isBaseline && (tag !== baseline.tag || revision !== baseline.revision)) {
    throw new Error('The official baseline tag no longer matches generator/baseline.json.');
  }
  const source = await sourceTree(revision);
  const cargoLockSha256 = sha256(await readFile(join(source.directory, 'Cargo.lock')));
  if (isBaseline && cargoLockSha256 !== baseline.cargoLockSha256)
    throw new Error('Baseline Cargo.lock checksum mismatch.');
  const cargo = await readFile(join(source.directory, 'Cargo.toml'), 'utf8');
  if (!new RegExp(`version\\s*=\\s*"${version.replaceAll('.', '\\.')}"`).test(cargo)) {
    throw new Error(`Cargo.toml version does not match ${tag}.`);
  }
  const resolved = await Promise.all(
    platforms.map((asset) => {
      const official = release.assets.find((candidate) => candidate.name === asset.name);
      if (!official) throw new Error(`Official release is missing ${asset.name}.`);
      return binaryAsset(asset, official, version, revision);
    }),
  );
  const features = resolved[0].features;
  if (resolved.some((asset) => !same(asset.features, features)))
    throw new Error('Official platform binaries have different Cargo features.');
  if (isBaseline && !same(features, [...baseline.features].sort()))
    throw new Error('Official binary features differ from the baseline.');
  const assets = resolved.map((asset) => {
    const value = { ...asset };
    delete value.features;
    return value;
  });
  const lock = {
    schemaVersion: 1,
    version,
    tag,
    revision,
    cargoLockSha256,
    sourceArchiveSha256: source.sourceArchiveSha256,
    features,
    assets,
  };
  await writeJson(options.output ?? join(generated, 'upstream.lock.json'), lock);
  console.error(
    `Resolved Himalaya ${version}: ${assets.length} official assets, archive and binary checksums verified.`,
  );
  return lock;
}

async function selectedLock(options) {
  if (options.lock) return json(resolve(root, options.lock));
  if (options.latest || options.version) return resolveUpstream(options);
  try {
    const cached = await json(join(generated, 'upstream.lock.json'));
    const baseline = await json(baselinePath);
    if (cached.version === baseline.version && cached.revision === baseline.revision) return cached;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return resolveUpstream(options);
}

export async function generate(options = {}) {
  const lock = await selectedLock(options);
  if (lock.schemaVersion !== 1 || lock.assets?.length !== platforms.length)
    throw new Error('The selected lock must include all five verified official assets.');
  await Promise.all(
    platforms.map(async (target) => {
      const asset = lock.assets.find(
        (candidate) =>
          candidate.platform === target.platform &&
          candidate.arch === target.arch &&
          candidate.name === target.name,
      );
      const url = `https://github.com/pimalaya/himalaya/releases/download/${lock.tag}/${target.name}`;
      if (
        !asset ||
        asset.url !== url ||
        !/^[a-f0-9]{64}$/.test(asset.archiveSha256) ||
        !/^[a-f0-9]{64}$/.test(asset.binarySha256)
      ) {
        throw new Error(`The selected lock has invalid official provenance for ${target.name}.`);
      }
      const checked = await binaryAsset(
        target,
        { browser_download_url: asset.url, digest: `sha256:${asset.archiveSha256}` },
        lock.version,
        lock.revision,
      );
      if (
        checked.binarySha256 !== asset.binarySha256 ||
        !same(checked.features, [...lock.features].sort())
      )
        throw new Error(`Selected binary checksum/features mismatch: ${target.name}`);
    }),
  );
  const source = await sourceTree(lock.revision, lock.sourceArchiveSha256);
  const actualLock = sha256(await readFile(join(source.directory, 'Cargo.lock')));
  if (actualLock !== lock.cargoLockSha256)
    throw new Error('Selected source Cargo.lock checksum mismatch.');
  const directory = join(build, 'native', 'source', lock.revision);
  await mkdir(dirname(directory), { recursive: true });
  await cp(source.directory, directory, { recursive: true, force: true });
  const entryPath = join(directory, 'src', 'main.rs');
  const original = await readFile(entryPath, 'utf8');
  const matches = [...original.matchAll(/\bfn main\s*\(\s*\)/g)];
  if (matches.length !== 1)
    throw new Error('Upstream entry point changed; update the generic generator integration.');
  const exporter = join(root, 'generator', 'entry.rs');
  const entry =
    original.replace(/\bfn main\s*\(\s*\)/, 'fn upstream_main()') +
    `\nmod mcp_catalog { include!(${JSON.stringify(exporter)}); }\nfn main() { mcp_catalog::entry(); }\n`;
  await writeFile(entryPath, entry);
  await mkdir(join(build, 'cargo'), { recursive: true });
  const environment = {
    ...process.env,
    CARGO_HOME: join(build, 'cargo'),
    CARGO_TARGET_DIR: join(build, 'native', 'target'),
    CARGO_PROFILE_DEV_DEBUG: '0',
    GIT_REV: lock.revision,
    GIT_DESCRIBE: lock.tag,
    RUSTFLAGS: process.env.RUSTFLAGS ?? '-Awarnings',
  };
  delete environment.HIMALAYA_CONFIG;
  const cargoArgs = [
    '--locked',
    '--manifest-path',
    join(directory, 'Cargo.toml'),
    '--no-default-features',
    '--features',
    lock.features.join(','),
    '--jobs',
    '2',
  ];
  await run('cargo', ['build', ...cargoArgs], {
    env: environment,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await run('cargo', ['test', ...cargoArgs, '--bin', 'himalaya', 'mcp_catalog::tests'], {
    env: environment,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const helper = join(
    build,
    'native',
    'target',
    'debug',
    process.platform === 'win32' ? 'himalaya.exe' : 'himalaya',
  );
  const result = await run(helper, ['describe'], { env: environment });
  const catalog = JSON.parse(result.stdout);
  if (
    catalog.native.version !== lock.version ||
    catalog.native.revision !== lock.revision ||
    !same(catalog.native.features, [...lock.features].sort())
  )
    throw new Error('Compiled CLI metadata does not match the selected official binaries.');
  await writeJson(join(generated, 'catalog.json'), catalog);
  const packageJson = await json(join(root, 'package.json'));
  const manifest = {
    schemaVersion: 1,
    packageVersion: packageJson.version,
    himalaya: {
      version: lock.version,
      tag: lock.tag,
      revision: lock.revision,
      features: lock.features,
    },
    catalogSha256: sha256(await readFile(join(generated, 'catalog.json'))),
    assets: lock.assets,
  };
  await writeJson(join(generated, 'manifest.json'), manifest);
  await writeJson(join(generated, 'native-helper.json'), {
    path: helper,
    revision: lock.revision,
    cargoLockSha256: actualLock,
  });
  console.error(
    `Generated ${catalog.commands.length} reflected nodes, ${catalog.commands.filter((command) => !command.frameworkGenerated).length} upstream-declared paths and ${catalog.commands.filter((command) => command.runnable).length} executable tools.`,
  );
  const { generateCatalogDiff } = await import('./catalog-diff.mjs');
  await generateCatalogDiff();
  return { catalog, manifest, helper };
}

export async function verify() {
  const { verifyNative } = await import('./verify-native.mjs');
  return verifyNative();
}

function options(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--latest') parsed.latest = true;
    else if (['--version', '--lock', '--output'].includes(option)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}.`);
      parsed[option.slice(2)] = value;
    } else throw new Error(`Unknown generator option: ${option}`);
  }
  if (parsed.latest && parsed.version) throw new Error('Choose --latest or --version, not both.');
  return parsed;
}

async function main() {
  const [stage, ...argv] = process.argv.slice(2);
  const input = options(argv);
  if (['verify', 'package'].includes(stage) && Object.keys(input).length)
    throw new Error(
      `${stage} uses the existing generated artifacts and accepts no selection options.`,
    );
  switch (stage) {
    case 'resolve':
      await resolveUpstream(input);
      break;
    case 'generate':
      await generate(input);
      break;
    case 'verify':
      await verify();
      break;
    case 'package':
      await run(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
      await mkdir(join(build, 'packages'), { recursive: true });
      await run(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['pack', '--pack-destination', join(build, 'packages')],
        { stdio: 'inherit' },
      );
      break;
    case 'update':
      await resolveUpstream({ ...input, latest: !input.version });
      await generate({ lock: join(generated, 'upstream.lock.json') });
      await verify();
      break;
    default:
      throw new Error(
        'Usage: node scripts/upstream.mjs <resolve|generate|verify|package|update> [--version VERSION|--latest] [--lock FILE]',
      );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
