#!/usr/bin/env node
/** Release-only tooling. Publisher jobs use built-ins and never execute the package. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, appendFile, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as tls from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = join(root, 'build', 'release');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const digest = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const writeJson = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const shaPattern = /^[a-f0-9]{64}$/;
const revisionPattern = /^[a-f0-9]{40}$/;
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export async function runCommand(program, args, options = {}) {
  const child = promisify(execFile)(program, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: options.timeout ?? 300_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  child.child.stdin?.end(options.input);
  try {
    return { ...(await child), code: 0 };
  } catch (error) {
    if (options.allowFailure && typeof error.code === 'number')
      return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    throw new Error(program + ' failed: ' + (error.stderr ?? error.message).slice(-4000));
  }
}

/** npm.cmd is not directly executable on Windows. Invoke its installed JS entry without a shell. */
export async function runNpm(args, options = {}) {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(dirname(process.execPath)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const path of candidates.filter((value) => value?.endsWith('npm-cli.js'))) {
    try {
      await access(path);
    } catch {
      continue;
    }
    return runCommand(process.execPath, [path, ...args], options);
  }
  throw new Error(
    'Cannot locate npm-cli.js beside Node. Use a standard Node/npm installation or run through npm.',
  );
}

export function releaseVersion(upstream, adapter) {
  if (!versionPattern.test(upstream) || !versionPattern.test(adapter))
    throw new Error('Release inputs must be stable major.minor.patch versions.');
  return upstream + '-adapter.' + adapter;
}

export function compareReleaseVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)-adapter\.(\d+)\.(\d+)\.(\d+)$/.exec(value);
    if (!match)
      throw new Error(
        'Unexpected registry version ' + value + '; do not automatically replace its latest tag.',
      );
    return match.slice(1).map(BigInt);
  };
  const a = parse(left),
    b = parse(right);
  for (let index = 0; index < a.length; index++)
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}

export async function checkSource() {
  const status = await runCommand('git', ['status', '--porcelain', '--untracked-files=normal']);
  if (status.stdout.trim())
    throw new Error(
      'Release source must be a clean committed checkout. Generated outputs belong under ignored build/dist directories.',
    );
  const revision = (await runCommand('git', ['rev-parse', 'HEAD'])).stdout.trim();
  if (!revisionPattern.test(revision))
    throw new Error('Release needs a full committed adapter revision.');
  return revision;
}

function repositoryOf(packageJson) {
  const value =
    typeof packageJson.repository === 'string'
      ? packageJson.repository
      : packageJson.repository?.url;
  const url = new URL(String(value).replace(/^git\+/, ''));
  const repository = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
  )
    throw new Error('Package repository must be its HTTPS GitHub repository.');
  return repository;
}

function validateUpstream(lock) {
  const targets = ['darwin/arm64', 'darwin/x64', 'linux/arm64', 'linux/x64', 'win32/x64'];
  if (
    lock.schemaVersion !== 1 ||
    !versionPattern.test(lock.version) ||
    lock.tag !== 'v' + lock.version ||
    !revisionPattern.test(lock.revision) ||
    !shaPattern.test(lock.sourceArchiveSha256) ||
    !shaPattern.test(lock.cargoLockSha256) ||
    !Array.isArray(lock.features) ||
    lock.features.some(
      (feature) => typeof feature !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(feature),
    ) ||
    new Set(lock.features).size !== lock.features.length
  )
    throw new Error('Upstream source lock is invalid.');
  if (
    lock.assets?.length !== targets.length ||
    !targets.every(
      (target) =>
        lock.assets.filter((asset) => asset.platform + '/' + asset.arch === target).length === 1,
    )
  )
    throw new Error('All five supported official platform assets must be present.');
  for (const asset of lock.assets) {
    if (
      !shaPattern.test(asset.archiveSha256) ||
      !shaPattern.test(asset.binarySha256) ||
      !/^[A-Za-z0-9._-]+\.tgz$/.test(asset.name) ||
      asset.url !==
        'https://github.com/pimalaya/himalaya/releases/download/' + lock.tag + '/' + asset.name
    )
      throw new Error('Official asset provenance is invalid.');
  }
}

function sameFeatures(left, right) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
  );
}

export async function prepare(version = process.env.UPSTREAM_VERSION || undefined) {
  const revision = await checkSource();
  if (version !== undefined && !versionPattern.test(version))
    throw new Error(
      'UPSTREAM_VERSION must be a stable major.minor.patch version, or empty for latest.',
    );
  const packageJson = await json(join(root, 'package.json'));
  const repository = repositoryOf(packageJson);
  if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9_.-]*$/.test(packageJson.name))
    throw new Error('Invalid npm package name.');
  const args = [
    'scripts/upstream.mjs',
    'resolve',
    ...(version === undefined ? ['--latest'] : ['--version', version]),
  ];
  await runCommand(process.execPath, args, { timeout: 600_000 });
  const upstreamBytes = await readFile(join(root, 'build', 'generated', 'upstream.lock.json'));
  const upstream = JSON.parse(upstreamBytes);
  validateUpstream(upstream);
  await mkdir(directory, { recursive: true });
  const plan = {
    schemaVersion: 1,
    repository,
    package: {
      name: packageJson.name,
      version: releaseVersion(upstream.version, packageJson.version),
    },
    adapter: {
      version: packageJson.version,
      revision,
      dependencyLockSha256: digest(await readFile(join(root, 'package-lock.json'))),
    },
    upstreamLockSha256: digest(upstreamBytes),
    upstream,
  };
  await writeJson(join(directory, 'plan.json'), plan);
  console.log(
    'Prepared ' +
      plan.package.name +
      '@' +
      plan.package.version +
      ' from adapter ' +
      revision +
      ' and upstream ' +
      upstream.revision +
      '.',
  );
  return plan;
}

/** CI-only archive diagnostics. No extraction or runtime/publisher dependency on tar. */
export async function packageEvidence(file) {
  const archive = await readFile(file);
  if (archive.length > 32 * 1024 * 1024) throw new Error('Diagnostic package exceeds 32 MiB.');
  const expanded = gunzipSync(archive, { maxOutputLength: 128 * 1024 * 1024 });
  const { Parser } = await import('tar');
  const entries = [];
  let order = 0;
  await new Promise((accept, reject) => {
    const parser = new Parser({
      strict: true,
      onReadEntry(entry) {
        const index = order++;
        const content = createHash('sha256');
        let size = 0;
        entry.on('data', (bytes) => {
          size += bytes.length;
          content.update(bytes);
        });
        entry.once('error', reject);
        entry.once('end', () =>
          entries.push({
            order: index,
            path: entry.path,
            type: entry.type,
            size,
            mode: entry.mode,
            mtime: entry.mtime?.toISOString() ?? null,
            uid: entry.uid ?? null,
            gid: entry.gid ?? null,
            uname: entry.uname ?? null,
            gname: entry.gname ?? null,
            sha256: content.digest('hex'),
          }),
        );
        entry.resume();
      },
    });
    parser.once('error', reject);
    parser.once('finish', accept);
    parser.end(expanded);
  });
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return {
    archiveSha256: digest(archive),
    tarSha256: digest(expanded),
    gzipHeader: archive.subarray(0, 10).toString('hex'),
    entries,
  };
}

async function packArchive(stage, destination) {
  await mkdir(destination, { recursive: true });
  const packing = await runNpm(
    ['pack', '--json', '--ignore-scripts', '--pack-destination', destination],
    { cwd: stage },
  );
  const packed = JSON.parse(packing.stdout);
  if (packed.length !== 1 || !/^[A-Za-z0-9_.-]+\.tgz$/.test(packed[0].filename))
    throw new Error('npm did not produce one expected package archive.');
  const emitted = join(destination, packed[0].filename);
  const packagePath = join(destination, 'package.tgz');
  await copyFile(emitted, packagePath);
  if (emitted !== packagePath) await rm(emitted);
  const toolchain = {
    node: process.versions.node,
    npm: (await runNpm(['--version'])).stdout.trim(),
    zlib: process.versions.zlib,
  };
  console.log(
    'Package evidence: ' + JSON.stringify({ toolchain, ...(await packageEvidence(packagePath)) }),
  );
  return packagePath;
}

/** Keep the baseline artifact filename independent of the reviewed adapter version. */
export async function packBaseline() {
  return packArchive(root, join(root, 'build', 'pack'));
}

/** A fresh job assembles reviewed JS plus data-only generation outputs; tracked package.json never changes. */
export async function assemble() {
  const plan = await json(join(directory, 'plan.json'));
  validateUpstream(plan.upstream);
  if ((await checkSource()) !== plan.adapter.revision)
    throw new Error('Adapter checkout differs from the prepared source revision.');
  const packageJson = await json(join(root, 'package.json'));
  if (
    repositoryOf(packageJson) !== plan.repository ||
    packageJson.name !== plan.package.name ||
    releaseVersion(plan.upstream.version, packageJson.version) !== plan.package.version ||
    digest(await readFile(join(root, 'package-lock.json'))) !== plan.adapter.dependencyLockSha256
  )
    throw new Error('Prepared adapter identity differs from the clean packaging checkout.');
  const generated = join(root, 'build', 'generated');
  if (digest(await readFile(join(generated, 'upstream.lock.json'))) !== plan.upstreamLockSha256)
    throw new Error('Upstream lock changed after preparation.');
  const manifest = await json(join(root, 'dist', 'manifest.json'));
  const catalogBytes = await readFile(join(root, 'dist', 'catalog.json'));
  const catalog = JSON.parse(catalogBytes);
  const report = await json(join(generated, 'verification.json'));
  const syntax = await json(join(generated, 'syntax-report.json'));
  const catalogDiff = await json(join(generated, 'catalog-diff.json'));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.packageVersion !== packageJson.version ||
    manifest.himalaya.version !== plan.upstream.version ||
    manifest.himalaya.tag !== plan.upstream.tag ||
    manifest.himalaya.revision !== plan.upstream.revision ||
    !sameFeatures(manifest.himalaya.features, plan.upstream.features) ||
    JSON.stringify(manifest.assets) !== JSON.stringify(plan.upstream.assets) ||
    catalog.native.version !== plan.upstream.version ||
    catalog.native.revision !== plan.upstream.revision ||
    !sameFeatures(catalog.native.features, plan.upstream.features) ||
    manifest.catalogSha256 !== digest(catalogBytes)
  )
    throw new Error(
      'Generated catalog and manifest differ from the prepared upstream identity/features/assets.',
    );
  const declared = catalog.commands.filter((command) => !command.frameworkGenerated);
  const testedAsset = plan.upstream.assets.find(
    (asset) => asset.platform + '/' + asset.arch === report.host,
  );
  if (
    report.schemaVersion !== 1 ||
    report.version !== plan.upstream.version ||
    report.revision !== plan.upstream.revision ||
    report.catalogSha256 !== manifest.catalogSha256 ||
    report.binarySha256 !== testedAsset?.binarySha256 ||
    report.commands !== catalog.commands.length ||
    report.upstreamDeclaredPaths !== declared.length ||
    report.officialHelpChecks !== declared.length ||
    report.frameworkGeneratedNodes !== catalog.commands.length - declared.length ||
    report.runnableCommands !== catalog.commands.filter((command) => command.runnable).length ||
    !Number.isInteger(report.argumentCases) ||
    report.argumentCases < 1
  )
    throw new Error(
      'Complete native Help coverage or parser verification does not match the generated catalog.',
    );
  if (
    syntax.schemaVersion !== 1 ||
    !Array.isArray(syntax.unsupported) ||
    syntax.unsupported.length !== 0
  )
    throw new Error(
      'Unsupported CLI syntax blocks release; fix the generic generator or serializer.',
    );
  if (
    catalogDiff.schemaVersion !== 1 ||
    !['initial', 'compared'].includes(catalogDiff.status) ||
    catalogDiff.current.catalogSha256 !== manifest.catalogSha256 ||
    catalogDiff.current.version !== plan.upstream.version ||
    catalogDiff.current.revision !== plan.upstream.revision
  )
    throw new Error('CLI change report does not refer to this generated native catalog.');
  const stage = join(root, 'build', 'release-package');
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  for (const file of [
    'dist',
    'README.md',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'examples',
    'docs',
    'SECURITY.md',
    'CONTRIBUTING.md',
  ])
    await cp(join(root, file), join(stage, file), { recursive: true });
  const stagedPackage = { ...packageJson, version: plan.package.version };
  for (const key of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'devDependencies',
    'scripts',
  ])
    delete stagedPackage[key];
  // Bundled libraries need no install hooks, compiler or runtime dependency installation.
  await writeJson(join(stage, 'package.json'), stagedPackage);
  await writeJson(join(stage, 'dist', 'manifest.json'), {
    ...manifest,
    packageVersion: plan.package.version,
  });
  const provenance = {
    ...plan,
    catalogSha256: manifest.catalogSha256,
    profilesSha256: digest(await readFile(join(stage, 'dist', 'profiles.json'))),
    bundleSha256: digest(await readFile(join(stage, 'dist', 'cli.js'))),
  };
  await writeJson(join(stage, 'dist', 'release.json'), provenance);
  const packagePath = await packArchive(stage, directory);
  for (const name of ['verification.json', 'syntax-report.json', 'catalog-diff.json'])
    await copyFile(join(generated, name), join(directory, name));
  const source = join(root, 'build', 'downloads', 'source-' + plan.upstream.revision + '.tgz');
  const cargo = join(root, 'build', 'upstream', plan.upstream.revision, 'Cargo.lock');
  if (
    digest(await readFile(source)) !== plan.upstream.sourceArchiveSha256 ||
    digest(await readFile(cargo)) !== plan.upstream.cargoLockSha256
  )
    throw new Error('Original upstream source/Cargo.lock does not match the pinned provenance.');
  await copyFile(source, join(directory, 'himalaya-source.tgz'));
  await copyFile(cargo, join(directory, 'Cargo.lock'));
  const bytes = await readFile(packagePath);
  const lock = {
    ...provenance,
    artifact: {
      filename: 'package.tgz',
      sha256: digest(bytes),
      integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
    },
    verification: {
      filename: 'verification.json',
      sha256: digest(await readFile(join(directory, 'verification.json'))),
    },
    catalogDiff: {
      filename: 'catalog-diff.json',
      sha256: digest(await readFile(join(directory, 'catalog-diff.json'))),
    },
    syntax: {
      filename: 'syntax-report.json',
      sha256: digest(await readFile(join(directory, 'syntax-report.json'))),
    },
  };
  await writeJson(join(directory, 'release.lock.json'), lock);
  console.log('Assembled ' + lock.package.version + ' (SHA-256 ' + lock.artifact.sha256 + ').');
  return lock;
}

export async function verifyRelease(location = directory) {
  const lock = await json(join(location, 'release.lock.json'));
  validateUpstream(lock.upstream);
  if (
    lock.schemaVersion !== 1 ||
    !revisionPattern.test(lock.adapter?.revision) ||
    lock.package.version !== releaseVersion(lock.upstream.version, lock.adapter.version) ||
    lock.artifact.filename !== 'package.tgz' ||
    !shaPattern.test(lock.artifact.sha256) ||
    !shaPattern.test(lock.adapter.dependencyLockSha256) ||
    !shaPattern.test(lock.upstreamLockSha256) ||
    !shaPattern.test(lock.catalogSha256) ||
    !shaPattern.test(lock.profilesSha256) ||
    !shaPattern.test(lock.bundleSha256) ||
    lock.verification.filename !== 'verification.json' ||
    !shaPattern.test(lock.verification.sha256) ||
    lock.catalogDiff?.filename !== 'catalog-diff.json' ||
    !shaPattern.test(lock.catalogDiff.sha256) ||
    lock.syntax.filename !== 'syntax-report.json' ||
    !shaPattern.test(lock.syntax.sha256) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(lock.repository) ||
    !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9_.-]*$/.test(lock.package.name)
  )
    throw new Error('Release identity or artifact lock is invalid.');
  const bytes = await readFile(join(location, 'package.tgz'));
  if (
    digest(bytes) !== lock.artifact.sha256 ||
    'sha512-' + createHash('sha512').update(bytes).digest('base64') !== lock.artifact.integrity
  )
    throw new Error('Release package archive differs from its sealed digest.');
  for (const [filename, hash] of [
    ['himalaya-source.tgz', lock.upstream.sourceArchiveSha256],
    ['Cargo.lock', lock.upstream.cargoLockSha256],
    ['verification.json', lock.verification.sha256],
    ['syntax-report.json', lock.syntax.sha256],
    ['catalog-diff.json', lock.catalogDiff.sha256],
  ]) {
    if (digest(await readFile(join(location, filename))) !== hash)
      throw new Error('Release evidence changed: ' + filename);
  }
  return lock;
}

function assertTrustedWorkflow(lock, oidc = false) {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    !['schedule', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME) ||
    process.env.GITHUB_REPOSITORY !== lock.repository ||
    process.env.GITHUB_SHA !== lock.adapter.revision
  )
    throw new Error(
      'Publication requires this repository main workflow and its exact sealed source revision.',
    );
  if (
    oidc &&
    (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL ||
      !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ||
      process.env.NODE_AUTH_TOKEN ||
      process.env.NPM_TOKEN)
  )
    throw new Error(
      'Publisher needs GitHub OIDC and no long-lived npm token. Configure the npm trusted publisher first.',
    );
}

export async function getJson(url, github = false) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    throw new Error('TLS verification must remain enabled.');
  if (
    typeof tls.getCACertificates === 'function' &&
    typeof tls.setDefaultCACertificates === 'function'
  )
    tls.setDefaultCACertificates([
      ...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]),
    ]);
  const headers = { Accept: 'application/json', 'User-Agent': 'himalaya-mcp-release' };
  if (github && process.env.GITHUB_TOKEN)
    headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new Error('Release metadata request failed with HTTP ' + response.status + '.');
  return response.json();
}

async function registryArchive(url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new Error('Published archive request failed with HTTP ' + response.status + '.');
  const limit = 32 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit || !response.body)
    throw new Error('Published archive is missing or exceeds 32 MiB.');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('Published archive exceeds 32 MiB.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

/** Wait only for public visibility; never repeat npm publish or accept different bytes. */
export async function verifyRegistryPublication(
  lock,
  read = getJson,
  {
    timeoutMs = 0,
    intervalMs = 15_000,
    now = Date.now,
    sleep = delay,
    readArchive = registryArchive,
  } = {},
) {
  const base = 'https://registry.npmjs.org/' + encodeURIComponent(lock.package.name) + '/';
  const deadline = now() + timeoutMs;
  let waiting = false;
  for (;;) {
    const [published, latest, native] = await Promise.all([
      read(base + encodeURIComponent(lock.package.version)),
      read(base + 'latest'),
      read(base + 'himalaya-' + lock.upstream.version),
    ]);
    if (published && published.dist?.integrity !== lock.artifact.integrity)
      throw new Error('Published registry integrity differs from the sealed archive.');
    let pending = 'Published npm metadata or tags do not yet select the sealed version';
    if (
      published &&
      latest?.version === lock.package.version &&
      native?.version === lock.package.version
    ) {
      const url = new URL(published.dist.tarball);
      if (
        url.origin !== 'https://registry.npmjs.org' ||
        url.username ||
        url.password ||
        url.hash ||
        url.search
      )
        throw new Error('Published archive must come from the official HTTPS npm registry.');
      const archive = await readArchive(url.href);
      if (archive !== undefined) {
        const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64');
        if (integrity !== lock.artifact.integrity)
          throw new Error('Public npm archive integrity differs from the sealed archive.');
        return;
      }
      pending = 'Published npm archive is not yet publicly downloadable';
    }
    const remaining = deadline - now();
    if (remaining <= 0)
      throw new Error(
        pending +
          '. Upload may still be under npm review. Wait for visibility, then rerun the original failed job with its sealed artifact; do not repack or repeat publication manually.',
      );
    if (!waiting)
      console.log(
        'Waiting up to ' +
          Math.ceil(timeoutMs / 60_000) +
          ' minutes for npm metadata, tags and the integrity-verified public archive.',
      );
    waiting = true;
    await sleep(Math.min(intervalMs, remaining));
  }
}

/** target_commitish is release metadata; the Git ref owns the actual tag identity. */
export async function verifyReleaseTag(lock, read = getJson, allowMissing = false) {
  const base = 'https://api.github.com/repos/' + lock.repository + '/git/';
  const ref = await read(base + 'ref/tags/' + encodeURIComponent('v' + lock.package.version), true);
  if (!ref && allowMissing) return;
  let object = ref?.object;
  const visited = new Set();
  while (object?.type === 'tag') {
    if (!revisionPattern.test(object.sha) || visited.has(object.sha) || visited.size >= 8)
      throw new Error('GitHub release tag has invalid or cyclic annotated tag metadata.');
    visited.add(object.sha);
    object = (await read(base + 'tags/' + object.sha, true))?.object;
  }
  if (object?.type !== 'commit' || object.sha !== lock.adapter.revision)
    throw new Error(
      'GitHub release tag does not point to the sealed adapter commit; investigate before modifying the release.',
    );
}

export async function publish() {
  const lock = await verifyRelease();
  assertTrustedWorkflow(lock, true);
  const npmVersion = (await runNpm(['--version'])).stdout.trim();
  if (!/^11\./.test(npmVersion) || compareTriple(npmVersion, '11.21.0') < 0)
    throw new Error('OIDC publish/dist-tag requires the pinned npm 11.21.0+ CLI.');
  const repository = await getJson('https://api.github.com/repos/' + lock.repository, true);
  if (!repository || repository.private || repository.full_name !== lock.repository)
    throw new Error('Provenance publishing requires the configured public GitHub repository.');
  const name = encodeURIComponent(lock.package.name);
  const latest = await getJson('https://registry.npmjs.org/' + name + '/latest');
  if (latest && compareReleaseVersions(lock.package.version, latest.version) < 0)
    throw new Error(
      'Refusing to move latest backward. Rollbacks require an explicit owner dist-tag operation.',
    );
  const existing = await getJson(
    'https://registry.npmjs.org/' + name + '/' + encodeURIComponent(lock.package.version),
  );
  if (existing) {
    if (existing.dist?.integrity !== lock.artifact.integrity)
      throw new Error(
        'This immutable npm version contains different bytes. Bump the reviewed adapter version; never overwrite or publish a stale artifact.',
      );
    console.log(
      'Existing immutable npm version verified byte-for-byte. This reuse does not verify permission for a new OIDC npm publish.',
    );
    if (latest?.version !== lock.package.version)
      await runNpm([
        'dist-tag',
        'add',
        lock.package.name + '@' + lock.package.version,
        'latest',
        '--registry=https://registry.npmjs.org',
      ]);
  } else {
    await runNpm([
      'publish',
      join(directory, 'package.tgz'),
      '--tag',
      'latest',
      '--access',
      'public',
      '--ignore-scripts',
      '--provenance',
      '--registry=https://registry.npmjs.org',
    ]);
  }
  const nativeTag = 'himalaya-' + lock.upstream.version;
  const tagged = await getJson('https://registry.npmjs.org/' + name + '/' + nativeTag);
  if (tagged?.version !== lock.package.version)
    await runNpm([
      'dist-tag',
      'add',
      lock.package.name + '@' + lock.package.version,
      nativeTag,
      '--registry=https://registry.npmjs.org',
    ]);
  await verifyRegistryPublication(lock, getJson, { timeoutMs: 20 * 60_000 });
  console.log(
    'Published ' +
      lock.package.name +
      '@' +
      lock.package.version +
      ' with latest and himalaya-' +
      lock.upstream.version +
      '.',
  );
}

function compareTriple(left, right) {
  const a = left.split('.').map(Number),
    b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++)
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}

async function githubRequest(path, method, body, contentType = 'application/json') {
  const response = await fetch('https://api.github.com/' + path, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'himalaya-mcp-release',
      Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
      'Content-Type': contentType,
    },
    ...(body === undefined
      ? {}
      : { body: contentType === 'application/json' ? JSON.stringify(body) : body }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok)
    throw new Error(
      'GitHub release operation failed with HTTP ' +
        response.status +
        '. Rerun this exact workflow; npm versions remain immutable.',
    );
  return response.status === 204 ? undefined : response.json();
}

export async function githubRelease() {
  const lock = await verifyRelease();
  assertTrustedWorkflow(lock);
  if (!process.env.GITHUB_TOKEN)
    throw new Error('GitHub Release requires its isolated contents:write job token.');
  await verifyReleaseTag(lock, getJson, true);
  const tag = 'v' + lock.package.version;
  let release = await getJson(
    'https://api.github.com/repos/' + lock.repository + '/releases/tags/' + encodeURIComponent(tag),
    true,
  );
  if (release && (release.target_commitish !== lock.adapter.revision || release.tag_name !== tag))
    throw new Error(
      'Existing GitHub release has a different adapter commit; investigate before modifying it.',
    );
  if (!release)
    release = await githubRequest('repos/' + lock.repository + '/releases', 'POST', {
      tag_name: tag,
      target_commitish: lock.adapter.revision,
      name: lock.package.name + ' ' + lock.package.version,
      draft: true,
      prerelease: false,
      body:
        'Original Himalaya ' +
        lock.upstream.version +
        ' (' +
        lock.upstream.revision +
        ') through adapter ' +
        lock.adapter.version +
        ' (' +
        lock.adapter.revision +
        ').\n\nThe release lock preserves source, Cargo.lock, CLI catalog, and all five official platform digests. The npm package has no compiler, native parser helper or install hooks.',
    });
  const files = [
    'package.tgz',
    'release.lock.json',
    'himalaya-source.tgz',
    'Cargo.lock',
    'verification.json',
    'syntax-report.json',
    'catalog-diff.json',
  ];
  for (const filename of files) {
    const bytes = await readFile(join(directory, filename));
    const expected = 'sha256:' + digest(bytes);
    const existing = release.assets.find((asset) => asset.name === filename);
    if (existing) {
      if (existing.digest !== expected)
        throw new Error(
          'Existing GitHub release asset differs: ' +
            filename +
            '. Do not overwrite it automatically.',
        );
      continue;
    }
    const upload = new URL(release.upload_url.replace(/\{.*$/, ''));
    if (upload.protocol !== 'https:' || upload.hostname !== 'uploads.github.com')
      throw new Error('Unexpected GitHub release upload host.');
    upload.searchParams.set('name', filename);
    const response = await fetch(upload, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
        'User-Agent': 'himalaya-mcp-release',
        'Content-Type': 'application/octet-stream',
      },
      body: bytes,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok || (await response.json()).digest !== expected)
      throw new Error(
        'GitHub release asset upload was not verified: ' +
          filename +
          '. Rerun this exact workflow.',
      );
  }
  if (release.draft)
    release = await githubRequest('repos/' + lock.repository + '/releases/' + release.id, 'PATCH', {
      draft: false,
    });
  await verifyReleaseTag(lock);
  console.log('GitHub Release ready: ' + release.html_url);
}

async function main() {
  const [stage, ...args] = process.argv.slice(2);
  if (args.length && !(stage === 'prepare' && args.length === 2 && args[0] === '--version'))
    throw new Error(
      'Usage: node scripts/release.mjs <prepare [--version X.Y.Z]|assemble|verify|publish|github|pack-baseline|check-source>',
    );
  if (stage === 'prepare') await prepare(args[1]);
  else if (stage === 'assemble') await assemble();
  else if (stage === 'verify') await verifyRelease();
  else if (stage === 'publish') await publish();
  else if (stage === 'github') await githubRelease();
  else if (stage === 'pack-baseline') await packBaseline();
  else if (stage === 'check-source') await checkSource();
  else throw new Error('Unknown release stage.');
  if (process.env.GITHUB_STEP_SUMMARY && ['prepare', 'assemble'].includes(stage)) {
    const info = await json(
      join(directory, stage === 'prepare' ? 'plan.json' : 'release.lock.json'),
    );
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      '\nCandidate: ' + info.package.name + '@' + info.package.version + '\n',
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
