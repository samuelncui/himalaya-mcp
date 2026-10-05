import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { Header } from 'tar';
import { catalogDiffReport, compareCatalogs, publishedCatalog } from '../scripts/catalog-diff.mjs';

const { Response } = globalThis;
const command = (name, args = []) => ({
  path: [name],
  aliases: [],
  help: `${name} help`,
  runnable: true,
  args,
});
const catalog = (commands) => ({
  schemaVersion: 1,
  native: { version: '2.2.1', revision: 'a'.repeat(40), features: [] },
  commands,
});
const catalogPath = 'package/dist/catalog.json';

function archive(entries) {
  const chunks = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '');
    const header = new Header({
      path: entry.path,
      type: entry.type ?? 'File',
      size: entry.size ?? body.length,
      mode: 0o644,
      linkpath: entry.linkpath,
    });
    header.encode();
    chunks.push(header.block, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function fetchArchive(bytes, overrides = {}) {
  const metadata = {
    name: 'himalaya-mcp',
    'dist-tags': { latest: '2.2.1-adapter.0.1.0' },
    versions: {
      '2.2.1-adapter.0.1.0': {
        name: 'himalaya-mcp',
        version: '2.2.1-adapter.0.1.0',
        dist: {
          tarball: 'https://registry.npmjs.org/himalaya-mcp/-/himalaya-mcp-2.2.1-adapter.0.1.0.tgz',
          integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
          ...overrides,
        },
      },
    },
  };
  return async (url) => (url.endsWith('.tgz') ? new Response(bytes) : Response.json(metadata));
}

test('initial report keeps all registered commands and definitions', () => {
  const current = catalog([
    command('send', [{ id: 'attach', aliases: ['file'], help: 'Attachments' }]),
  ]);
  const diff = compareCatalogs(null, current);
  assert.equal(diff.status, 'initial');
  assert.deepEqual(diff.commands.added, current.commands);
  assert.deepEqual(diff.summary, {
    commands: { added: 1, removed: 0, modified: 0 },
    args: { added: 1, removed: 0, modified: 0 },
  });
});

test('reports command, argument, alias, help and argument-order changes', () => {
  const before = catalog([
    command('removed'),
    { ...command('send', [{ id: 'to', help: 'Before' }, { id: 'removed' }]), aliases: ['s'] },
  ]);
  const after = catalog([
    command('added'),
    {
      ...command('send', [{ id: 'added' }, { id: 'to', help: 'After', aliases: ['recipient'] }]),
      aliases: ['mail'],
      help: 'Updated Help',
    },
  ]);
  const diff = compareCatalogs(before, after);
  assert.equal(diff.status, 'compared');
  assert.deepEqual(diff.summary, {
    commands: { added: 1, removed: 1, modified: 1 },
    args: { added: 1, removed: 1, modified: 1 },
  });
  assert.deepEqual(diff.commands.removed[0].path, ['removed']);
  const changed = diff.commands.modified[0];
  assert.deepEqual(changed.fields.aliases, { before: ['s'], after: ['mail'] });
  assert.deepEqual(changed.fields.help, { before: 'send help', after: 'Updated Help' });
  assert.deepEqual(changed.fields.argumentOrder.after, ['added', 'to']);
  assert.deepEqual(changed.args.modified[0].fields.help, { before: 'Before', after: 'After' });
  assert.deepEqual(changed.args.modified[0].fields.aliases.after, ['recipient']);
});

test('JSON object key ordering does not report a semantic change', () => {
  const a = catalog([command('send', [{ id: 'to', settings: { a: 1, b: 2 } }])]);
  const b = catalog([command('send', [{ settings: { b: 2, a: 1 }, id: 'to' }])]);
  assert.equal(compareCatalogs(a, b).commands.modified.length, 0);
});

test('invalid catalogs and duplicate command/argument identities fail', () => {
  assert.throws(() => compareCatalogs({}, catalog([])), /Invalid catalog/);
  assert.throws(
    () => compareCatalogs(null, catalog([command('send'), command('send')])),
    /Duplicate catalog command/,
  );
  assert.throws(
    () => compareCatalogs(null, catalog([command('send', [{ id: 'x' }, { id: 'x' }])])),
    /duplicate catalog argument/,
  );
});

test('only package metadata 404 is treated as initial', async () => {
  assert.equal(
    await publishedCatalog('himalaya-mcp', async () => new Response('', { status: 404 })),
    undefined,
  );
  await assert.rejects(
    publishedCatalog('himalaya-mcp', async () => new Response('', { status: 429 })),
    /HTTP 429/,
  );
  await assert.rejects(
    publishedCatalog('himalaya-mcp', async () => Response.json({ name: 'himalaya-mcp' })),
    /no valid.*version metadata/,
  );
  await assert.rejects(
    publishedCatalog('himalaya-mcp', async () => {
      throw new Error('network unavailable');
    }),
    /network unavailable/,
  );
});

test('reads only catalog JSON from a SHA512-verified archive', async () => {
  const current = catalog([command('send')]);
  const bytes = archive([
    { path: 'package/postinstall.js', body: 'throw new Error("MUST NOT EXECUTE")' },
    { path: catalogPath, body: JSON.stringify(current) },
  ]);
  const loaded = await publishedCatalog('himalaya-mcp', fetchArchive(bytes));
  assert.deepEqual(loaded.catalog, current);
  assert.equal(loaded.packageVersion, '2.2.1-adapter.0.1.0');
  assert.equal(
    loaded.catalogSha256,
    createHash('sha256').update(JSON.stringify(current)).digest('hex'),
  );
});

test('integrity, missing catalog, duplicate catalog and symlink failures are explicit', async () => {
  const valid = archive([{ path: catalogPath, body: JSON.stringify(catalog([])) }]);
  await assert.rejects(
    publishedCatalog(
      'himalaya-mcp',
      fetchArchive(valid, { integrity: 'sha512-' + Buffer.alloc(64).toString('base64') }),
    ),
    /integrity mismatch/,
  );
  await assert.rejects(
    publishedCatalog('himalaya-mcp', fetchArchive(valid, { integrity: undefined })),
    /requires SHA512/,
  );
  await assert.rejects(
    publishedCatalog(
      'himalaya-mcp',
      fetchArchive(valid, { tarball: 'https://example.com/fake.tgz' }),
    ),
    /official HTTPS npm/,
  );
  await assert.rejects(
    publishedCatalog(
      'himalaya-mcp',
      fetchArchive(archive([{ path: 'package/other.json', body: '{}' }])),
    ),
    /no dist\/catalog/,
  );
  await assert.rejects(
    publishedCatalog(
      'himalaya-mcp',
      fetchArchive(
        archive([
          { path: catalogPath, body: '{}' },
          { path: catalogPath, body: '{}' },
        ]),
      ),
    ),
    /one regular file/,
  );
  await assert.rejects(
    publishedCatalog(
      'himalaya-mcp',
      fetchArchive(
        archive([{ path: catalogPath, type: 'SymbolicLink', linkpath: '../../private' }]),
      ),
    ),
    /one regular file/,
  );
});

test('archive 404 and size limits never become an initial report', async () => {
  const valid = archive([{ path: catalogPath, body: JSON.stringify(catalog([])) }]);
  const metadataFetch = fetchArchive(valid);
  await assert.rejects(
    publishedCatalog('himalaya-mcp', async (url) =>
      url.endsWith('.tgz') ? new Response('', { status: 404 }) : metadataFetch(url),
    ),
    /archive request failed: HTTP 404/,
  );
  await assert.rejects(
    publishedCatalog(
      'himalaya-mcp',
      async () =>
        new Response('{}', { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } }),
    ),
    /size limit/,
  );
  await assert.rejects(
    publishedCatalog(
      'himalaya-mcp',
      fetchArchive(archive([{ path: catalogPath, size: 16 * 1024 * 1024 + 1 }])),
    ),
    /one regular file/,
  );
});

test('first publication and rebuilding that version produce identical report bytes', async () => {
  const current = catalog([command('send')]);
  const candidateBytes = Buffer.from(JSON.stringify(current, null, 2) + '\n');
  const target = '2.2.1-adapter.0.1.0';
  const before = await publishedCatalog(
    'himalaya-mcp',
    async () => new Response('', { status: 404 }),
    target,
  );
  const bytes = archive([{ path: catalogPath, body: JSON.stringify(current) }]);
  const metadata = fetchArchive(bytes);
  let requests = 0;
  const after = await publishedCatalog(
    'himalaya-mcp',
    async (url) => {
      requests++;
      assert(
        !url.endsWith('.tgz'),
        'the current version must not be downloaded as its own baseline',
      );
      return metadata(url);
    },
    target,
  );
  assert.equal(requests, 1);
  assert.equal(before, undefined);
  assert.equal(after, undefined);
  assert.equal(
    JSON.stringify(catalogDiffReport('himalaya-mcp', candidateBytes, before), null, 2) + '\n',
    JSON.stringify(catalogDiffReport('himalaya-mcp', candidateBytes, after), null, 2) + '\n',
  );
});

test('selects the greatest prior native/adapter release independently of latest or target presence', async () => {
  const priorVersion = '2.2.1-adapter.0.1.0';
  const target = '2.2.1-adapter.0.2.0';
  const prior = catalog([command('old')]);
  const bytes = archive([{ path: catalogPath, body: JSON.stringify(prior) }]);
  const dist = {
    tarball: 'https://registry.npmjs.org/himalaya-mcp/-/himalaya-mcp-' + priorVersion + '.tgz',
    integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
  };
  const versions = [
    '2.2.0-adapter.9.9.9',
    '2.2.1-adapter.0.0.9',
    priorVersion,
    '2.2.1-adapter.0.3.0',
    '2.3.0-adapter.0.0.0',
  ];
  const fetcher = (includeTarget) => async (url) => {
    if (url.endsWith('.tgz')) {
      assert(url.endsWith(priorVersion + '.tgz'));
      return new Response(bytes);
    }
    return Response.json({
      name: 'himalaya-mcp',
      'dist-tags': { latest: includeTarget ? target : '2.3.0-adapter.0.0.0' },
      versions: Object.fromEntries(
        [...versions, ...(includeTarget ? [target] : [])].map((version) => [
          version,
          { name: 'himalaya-mcp', version, dist },
        ]),
      ),
    });
  };
  const before = await publishedCatalog('himalaya-mcp', fetcher(false), target);
  const after = await publishedCatalog('himalaya-mcp', fetcher(true), target);
  assert.equal(before.packageVersion, priorVersion);
  assert.deepEqual(after, before);
  const candidateBytes = Buffer.from(JSON.stringify(catalog([command('new')])));
  assert.equal(
    JSON.stringify(catalogDiffReport('himalaya-mcp', candidateBytes, before)),
    JSON.stringify(catalogDiffReport('himalaya-mcp', candidateBytes, after)),
  );
});

test('unsupported or corrupt registry versions fail even when they would not be selected', async () => {
  for (const version of ['1.0.0', '02.2.1-adapter.0.1.0', '2.2.1-adapter.0.1.0-beta']) {
    await assert.rejects(
      publishedCatalog(
        'himalaya-mcp',
        async () =>
          Response.json({
            name: 'himalaya-mcp',
            versions: { [version]: { name: 'himalaya-mcp', version } },
          }),
        '2.2.1-adapter.0.1.0',
      ),
      /Unsupported npm release version/,
    );
  }
  await assert.rejects(
    publishedCatalog(
      'himalaya-mcp',
      async () =>
        Response.json({
          name: 'himalaya-mcp',
          versions: {
            '2.2.1-adapter.0.1.0': { name: 'different-package', version: '2.2.1-adapter.0.1.0' },
          },
        }),
      '2.2.1-adapter.0.1.0',
    ),
    /Invalid npm version metadata/,
  );
});
