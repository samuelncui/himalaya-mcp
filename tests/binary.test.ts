import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { create, Header } from 'tar';
import { ensureBinary, inspectBinary, type BinaryOptions } from '../src/binary.js';
import { AdapterError, type Catalog, type CliCommand, type Manifest } from '../src/types.js';

const VERSION = '2.2.1';
const REVISION = '1'.repeat(40);
const FEATURES = ['smtp', 'imap'];
const posix = {
  skip:
    process.platform === 'win32'
      ? 'Synthetic shebang metadata fixtures require POSIX; real Windows exe is checked in platform CI.'
      : false,
};

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function command(path: string[], hidden = false): CliCommand {
  return {
    path,
    aliases: [],
    hidden,
    about: 'Synthetic command',
    help: 'Synthetic help',
    args: [],
    runnable: true,
  };
}

async function fixture(
  t: TestContext,
  overrides: { version?: string; features?: string[]; commands?: string[] } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'himalaya-mcp-binary-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const name = process.platform === 'win32' ? 'himalaya.exe' : 'himalaya';
  const path = join(root, name);
  const help =
    'Usage: himalaya [COMMAND]\n\nCommands:\n' +
    (overrides.commands ?? ['message', 'account'])
      .map((value) => '  ' + value + '  Synthetic Help\n')
      .join('') +
    '  help     Print help\n\nOptions:\n  -h, --help  Print help\n';
  const version =
    'himalaya v' +
    (overrides.version ?? VERSION) +
    ' ' +
    (overrides.features ?? FEATURES).map((value) => '+' + value).join(' ') +
    '\nbuild: synthetic\ngit: unknown, rev unknown\n';
  const bytes = Buffer.from(
    '#!' +
      process.execPath +
      '\nconst flag=process.argv[2];\nif(flag==="--version") process.stdout.write(' +
      JSON.stringify(version) +
      ');\nelse if(flag==="--help") process.stdout.write(' +
      JSON.stringify(help) +
      ');\nelse process.exit(79);\n',
  );
  await writeFile(path, bytes, { mode: 0o700 });
  const assetName = 'himalaya.fixture.tgz';
  const manifest: Manifest = {
    schemaVersion: 1,
    packageVersion: '0.1.0',
    himalaya: { version: VERSION, tag: 'v' + VERSION, revision: REVISION, features: FEATURES },
    catalogSha256: '2'.repeat(64),
    assets: [
      {
        platform: process.platform,
        arch: process.arch,
        name: assetName,
        url: 'https://github.com/pimalaya/himalaya/releases/download/v' + VERSION + '/' + assetName,
        archiveSha256: '3'.repeat(64),
        binarySha256: digest(bytes),
      },
    ],
  };
  const catalog: Catalog = {
    schemaVersion: 1,
    native: { name: 'himalaya', version: VERSION, revision: REVISION, features: FEATURES },
    commands: [
      command([]),
      command(['message']),
      command(['message', 'send']),
      command(['account']),
      command(['private'], true),
    ],
  };
  const cacheDir = join(root, 'cache');
  return { root, name, path, bytes, manifest, catalog, cacheDir };
}

async function archiveFor(
  f: Awaited<ReturnType<typeof fixture>>,
  files: string[] = [f.name],
  prefix?: string,
) {
  const archive = join(f.root, 'fixture.tgz');
  await create(
    {
      cwd: f.root,
      file: archive,
      gzip: true,
      portable: true,
      ...(prefix === undefined ? {} : { prefix }),
    },
    files,
  );
  const bytes = await readFile(archive);
  f.manifest.assets[0]!.archiveSha256 = digest(bytes);
  return bytes;
}

function fetchBytes(bytes: Uint8Array, count?: { value: number }): typeof globalThis.fetch {
  return async () => {
    if (count !== undefined) count.value++;
    return new Response(new Uint8Array(bytes));
  };
}

async function expectCode(operation: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    operation,
    (error: unknown) => error instanceof AdapterError && error.code === code,
  );
}

function downloadOptions(f: Awaited<ReturnType<typeof fixture>>, bytes: Uint8Array): BinaryOptions {
  return { cacheDir: f.cacheDir, catalog: f.catalog, fetch: fetchBytes(bytes) };
}

test(
  'explicit compatible binary is custom unless its content hash is a pinned asset',
  posix,
  async (t) => {
    const f = await fixture(t);
    const official = await ensureBinary(f.manifest, { binary: f.path, catalog: f.catalog });
    assert.equal(official.path, f.path);
    assert.equal(official.source, 'custom');
    assert.equal(official.verified, true);
    f.manifest.assets[0]!.binarySha256 = 'a'.repeat(64);
    const custom = await ensureBinary(f.manifest, { binary: f.path, catalog: f.catalog });
    assert.equal(custom.source, 'custom');
    assert.equal(custom.verified, false);
    assert.deepEqual(custom.features, ['imap', 'smtp']);
  },
);

test(
  'feature comparison uses sets and hidden catalog commands need not appear in root Help',
  posix,
  async (t) => {
    const f = await fixture(t, { features: ['imap', 'smtp'] });
    const info = await ensureBinary(f.manifest, { binary: f.path, catalog: f.catalog });
    assert.equal(info.version, VERSION);
    assert.equal(info.verified, true);
  },
);

test(
  'external version mismatch is reported locally and never triggers fallback download',
  posix,
  async (t) => {
    const f = await fixture(t, { version: '1.0.0' });
    let downloads = 0;
    const options: BinaryOptions = {
      binary: f.path,
      catalog: f.catalog,
      fetch: async () => {
        downloads++;
        throw new Error('Network forbidden');
      },
    };
    const inspection = await inspectBinary(f.manifest, options);
    assert.equal(inspection.ok, false);
    assert.equal(inspection.code, 'binary_version_mismatch');
    assert.equal(inspection.binary, undefined);
    await expectCode(ensureBinary(f.manifest, options), 'binary_version_mismatch');
    assert.equal(downloads, 0);
  },
);

test(
  'external feature mismatch and extra public commands fail without hiding or changing the catalog',
  posix,
  async (t) => {
    const wrongFeatures = await fixture(t, { features: ['imap'] });
    await expectCode(
      ensureBinary(wrongFeatures.manifest, {
        binary: wrongFeatures.path,
        catalog: wrongFeatures.catalog,
      }),
      'binary_features_mismatch',
    );
    const extra = await fixture(t, { commands: ['message', 'account', 'new-command'] });
    const original = structuredClone(extra.catalog);
    await expectCode(
      ensureBinary(extra.manifest, { binary: extra.path, catalog: extra.catalog }),
      'binary_catalog_mismatch',
    );
    assert.deepEqual(extra.catalog, original);
  },
);

test('explicit POSIX symlinks resolve without changing their target', posix, async (t) => {
  const f = await fixture(t);
  const link = join(f.root, 'selected-binary');
  await symlink(f.path, link);
  const info = await ensureBinary(f.manifest, { binary: link, catalog: f.catalog });
  assert.equal(info.path, f.path);
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.deepEqual(await readFile(f.path), f.bytes);
});

test('doctor and no-download startup create no cache and make no network requests', async (t) => {
  const f = await fixture(t);
  let downloads = 0;
  const options: BinaryOptions = {
    cacheDir: f.cacheDir,
    catalog: f.catalog,
    allowDownload: false,
    fetch: async () => {
      downloads++;
      throw new Error('Network forbidden');
    },
  };
  const result = await inspectBinary(f.manifest, options);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'binary_missing');
  assert.ok(result.nextStep);
  await expectCode(ensureBinary(f.manifest, options), 'binary_missing');
  await assert.rejects(lstat(f.cacheDir), { code: 'ENOENT' });
  assert.equal(downloads, 0);
});

test('unsupported default platform is explicit and does not select another architecture', async (t) => {
  const f = await fixture(t);
  f.manifest.assets = [];
  const result = await inspectBinary(f.manifest, { cacheDir: f.cacheDir });
  assert.equal(result.code, 'unsupported_platform');
  await expectCode(ensureBinary(f.manifest, { cacheDir: f.cacheDir }), 'unsupported_platform');
  await assert.rejects(lstat(f.cacheDir), { code: 'ENOENT' });
});

test(
  'downloads verify both digests, cache only the executable, and revalidate on subsequent launches',
  posix,
  async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.root, 'unrelated.txt'), 'Not an executable');
    const bytes = await archiveFor(f, [f.name, 'unrelated.txt']);
    const downloads = { value: 0 };
    const options: BinaryOptions = {
      cacheDir: f.cacheDir,
      catalog: f.catalog,
      fetch: fetchBytes(bytes, downloads),
    };
    const first = await ensureBinary(f.manifest, options);
    assert.equal(first.source, 'download');
    assert.equal(first.verified, true);
    assert.equal(first.sha256, f.manifest.assets[0]!.binarySha256);
    assert.deepEqual(await readdir(f.cacheDir), [first.sha256]);
    assert.deepEqual(await readdir(join(f.cacheDir, first.sha256)), [f.name]);
    assert.equal((await lstat(f.cacheDir)).mode & 0o777, 0o700);
    assert.equal((await lstat(first.path)).mode & 0o777, 0o500);
    const second = await ensureBinary(f.manifest, options);
    assert.equal(second.source, 'cache');
    assert.equal(second.path, first.path);
    assert.equal(downloads.value, 1);
    const inspected = await inspectBinary(f.manifest, options);
    assert.equal(inspected.ok, true);
    assert.equal(inspected.binary?.source, 'cache');
    assert.equal(downloads.value, 1);
  },
);

test(
  'corrupted caches fail before metadata execution, do not silently redownload, and retain evidence',
  posix,
  async (t) => {
    const f = await fixture(t);
    const bytes = await archiveFor(f);
    const downloads = { value: 0 };
    const options: BinaryOptions = {
      cacheDir: f.cacheDir,
      catalog: f.catalog,
      fetch: fetchBytes(bytes, downloads),
    };
    const good = await ensureBinary(f.manifest, options);
    await chmod(good.path, 0o600);
    await writeFile(good.path, 'damaged');
    const result = await inspectBinary(f.manifest, options);
    assert.equal(result.code, 'binary_digest_mismatch');
    await expectCode(ensureBinary(f.manifest, options), 'binary_digest_mismatch');
    assert.equal(downloads.value, 1);
    assert.equal(await readFile(good.path, 'utf8'), 'damaged');
  },
);

test('managed cache directory and executable symlinks are rejected', posix, async (t) => {
  const f = await fixture(t);
  const bytes = await archiveFor(f);
  const info = await ensureBinary(f.manifest, downloadOptions(f, bytes));
  await unlink(info.path);
  await symlink(f.path, info.path);
  assert.equal(
    (await inspectBinary(f.manifest, { cacheDir: f.cacheDir })).code,
    'binary_file_invalid',
  );
  await rm(f.cacheDir, { recursive: true });
  await symlink(f.root, f.cacheDir);
  assert.equal(
    (await inspectBinary(f.manifest, { cacheDir: f.cacheDir })).code,
    'cache_permissions',
  );
});

test(
  'shared cache permissions are rejected rather than chmodding an existing user directory',
  posix,
  async (t) => {
    const f = await fixture(t);
    await mkdir(f.cacheDir, { mode: 0o755 });
    await chmod(f.cacheDir, 0o755);
    await expectCode(ensureBinary(f.manifest, { cacheDir: f.cacheDir }), 'cache_permissions');
    assert.equal((await lstat(f.cacheDir)).mode & 0o777, 0o755);
  },
);

test('archive digest mismatch never creates or publishes an executable', async (t) => {
  const f = await fixture(t);
  const bytes = await archiveFor(f);
  f.manifest.assets[0]!.archiveSha256 = 'a'.repeat(64);
  await expectCode(ensureBinary(f.manifest, downloadOptions(f, bytes)), 'archive_digest_mismatch');
  assert.deepEqual(await readdir(f.cacheDir), []);
});

test('binary digest mismatch never executes or publishes extracted bytes', async (t) => {
  const f = await fixture(t);
  const bytes = await archiveFor(f);
  f.manifest.assets[0]!.binarySha256 = 'a'.repeat(64);
  await expectCode(ensureBinary(f.manifest, downloadOptions(f, bytes)), 'binary_digest_mismatch');
  assert.deepEqual(await readdir(f.cacheDir), []);
});

test('root executable symlinks, duplicate executables and path-traversal names cannot be extracted', async (t) => {
  const linked = await fixture(t);
  // Encode a symlink entry directly so this archive check also runs without Windows symlink privileges.
  const header = new Header({
    path: linked.name,
    type: 'SymbolicLink',
    linkpath: 'payload',
    size: 0,
    mode: 0o700,
    uid: 1000,
    gid: 1000,
    uname: 'synthetic',
    gname: 'fixture',
  });
  header.encode();
  const linkedBytes = gzipSync(Buffer.concat([header.block!, Buffer.alloc(1024)]));
  linked.manifest.assets[0]!.archiveSha256 = digest(linkedBytes);
  await expectCode(
    ensureBinary(linked.manifest, downloadOptions(linked, linkedBytes)),
    'archive_invalid',
  );
  assert.deepEqual(await readdir(linked.cacheDir), []);

  const duplicate = await fixture(t);
  const duplicateBytes = await archiveFor(duplicate, [duplicate.name, duplicate.name]);
  await expectCode(
    ensureBinary(duplicate.manifest, downloadOptions(duplicate, duplicateBytes)),
    'archive_invalid',
  );
  assert.deepEqual(await readdir(duplicate.cacheDir), []);

  const traversal = await fixture(t);
  const traversalBytes = await archiveFor(traversal, [traversal.name], '../unwanted');
  await expectCode(
    ensureBinary(traversal.manifest, downloadOptions(traversal, traversalBytes)),
    'archive_invalid',
  );
  assert.deepEqual(await readdir(traversal.cacheDir), []);
  await assert.rejects(lstat(join(traversal.root, 'unwanted')), { code: 'ENOENT' });
});

test('oversized download declarations, failed HTTP and invalid release URLs fail cleanly', async (t) => {
  const f = await fixture(t);
  await expectCode(
    ensureBinary(f.manifest, {
      cacheDir: f.cacheDir,
      fetch: async () =>
        new Response('synthetic', { headers: { 'content-length': String(64 * 1024 * 1024 + 1) } }),
    }),
    'archive_too_large',
  );
  assert.deepEqual(await readdir(f.cacheDir), []);
  await expectCode(
    ensureBinary(f.manifest, {
      cacheDir: f.cacheDir,
      fetch: async () => new Response('synthetic', { status: 404 }),
    }),
    'binary_download_failed',
  );
  assert.deepEqual(await readdir(f.cacheDir), []);
  f.manifest.assets[0]!.url = 'http://example.invalid/himalaya.tgz';
  await expectCode(ensureBinary(f.manifest, { cacheDir: f.cacheDir }), 'manifest_invalid');
});

test('TLS verification cannot be disabled for a download', async (t) => {
  const f = await fixture(t);
  const original = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    await expectCode(
      ensureBinary(f.manifest, { cacheDir: f.cacheDir }),
      'tls_verification_disabled',
    );
    assert.deepEqual(await readdir(f.cacheDir), []);
  } finally {
    if (original === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = original;
  }
});

test(
  'concurrent installers publish one verified cache directory and clean their own staging directories',
  { ...posix, timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    const bytes = await archiveFor(f);
    let count = 0;
    let release: (() => void) | undefined;
    const bothDownloading = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch: typeof globalThis.fetch = async () => {
      if (++count === 2) release!();
      await bothDownloading;
      return new Response(new Uint8Array(bytes));
    };
    const options: BinaryOptions = { cacheDir: f.cacheDir, catalog: f.catalog, fetch };
    const results = await Promise.all([
      ensureBinary(f.manifest, options),
      ensureBinary(f.manifest, options),
    ]);
    assert.equal(results[0]!.path, results[1]!.path);
    assert.equal(
      results.every((result) => result.verified),
      true,
    );
    assert.deepEqual(
      new Set(results.map((result) => result.source)),
      new Set(['download', 'cache']),
    );
    assert.deepEqual(await readdir(f.cacheDir), [f.manifest.assets[0]!.binarySha256]);
  },
);

test(
  'independent Node processes safely share the cache without sharing staging paths',
  { ...posix, timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const bytes = await archiveFor(f);
    const moduleUrl = new URL('../src/binary.js', import.meta.url).href;
    const script = [
      'import {ensureBinary} from ' + JSON.stringify(moduleUrl) + ';',
      'import {writeFile,readdir} from "node:fs/promises";',
      'import {setTimeout} from "node:timers/promises";',
      'const root=' + JSON.stringify(f.root) + ';',
      'const manifest=' + JSON.stringify(f.manifest) + ';',
      'const catalog=' + JSON.stringify(f.catalog) + ';',
      'const fetch=async()=>{',
      'await writeFile(root+"/worker-"+process.pid+".ready","ready",{flag:"wx"});',
      'for(let i=0;i<1000;i++){',
      'if((await readdir(root)).filter(name=>name.endsWith(".ready")).length===2) break;',
      'if(i===999) throw new Error("Second worker did not arrive");',
      'await setTimeout(10);}',
      'return new Response(new Uint8Array(Buffer.from(' +
        JSON.stringify(bytes.toString('base64')) +
        ',"base64")));};',
      'console.log(JSON.stringify(await ensureBinary(manifest,{catalog,cacheDir:' +
        JSON.stringify(f.cacheDir) +
        ',fetch})));',
    ].join('\n');
    const run = async () => {
      const promise = promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
        timeout: 20_000,
        maxBuffer: 64 * 1024,
        encoding: 'utf8',
      });
      promise.child.stdin?.end();
      return JSON.parse((await promise).stdout) as {
        path: string;
        source: string;
        verified: boolean;
      };
    };
    const results = await Promise.all([run(), run()]);
    assert.equal(results[0]!.path, results[1]!.path);
    assert.equal(
      results.every((result) => result.verified),
      true,
    );
    assert.deepEqual(
      new Set(results.map((result) => result.source)),
      new Set(['download', 'cache']),
    );
    assert.deepEqual(await readdir(f.cacheDir), [f.manifest.assets[0]!.binarySha256]);
  },
);
