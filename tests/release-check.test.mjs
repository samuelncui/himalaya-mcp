import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkRelease } from '../scripts/release-check.mjs';

const options = {
  packageName: 'synthetic-adapter',
  adapterVersion: '0.1.2',
  eventName: 'schedule',
};
const upstream = { tag_name: 'v2.2.1', draft: false, prerelease: false };
const published = { name: options.packageName, version: '2.2.1-adapter.0.1.1' };
const reader =
  (native = upstream, pkg = published) =>
  async (url) =>
    url.startsWith('https://api.github.com/') ? native : pkg;

test('unchanged Himalaya skips even when the adapter source version is newer', async () => {
  const result = await checkRelease(options, reader());
  assert.equal(result.needed, false);
  assert.equal(result.version, '2.2.1');
  assert.equal(result.candidateVersion, '2.2.1-adapter.0.1.2');
});

test('new Himalaya and a missing npm package require generation', async () => {
  assert.equal(
    (await checkRelease(options, reader({ ...upstream, tag_name: 'v2.2.2' }))).needed,
    true,
  );
  assert.equal((await checkRelease(options, reader(upstream, null))).needed, true);
});

test('manual force runs unchanged Himalaya but schedule cannot force', async () => {
  const forced = { ...options, forceRelease: true };
  assert.equal(
    (await checkRelease({ ...forced, eventName: 'workflow_dispatch' }, reader())).needed,
    true,
  );
  await assert.rejects(checkRelease(forced, reader()), /explicit manual dispatch/);
});

test('selected release is fixed and upstream/registry failures remain explicit', async () => {
  const urls = [];
  await checkRelease({ ...options, upstreamVersion: '2.2.1' }, async (url) => {
    urls.push(url);
    return reader()(url);
  });
  assert(urls[0].endsWith('/tags/v2.2.1'));
  for (const native of [
    null,
    { ...upstream, draft: true },
    { ...upstream, prerelease: true },
    { ...upstream, tag_name: 'v2.2.1-beta' },
  ])
    await assert.rejects(checkRelease(options, reader(native)));
  await assert.rejects(
    checkRelease({ ...options, upstreamVersion: '2.2.0' }, reader()),
    /does not match/,
  );
  await assert.rejects(
    checkRelease(options, async () => {
      throw new Error('HTTP 403');
    }),
    /HTTP 403/,
  );
});

test('malformed adapter latest, corrupt identity and rollbacks fail even with force', async () => {
  for (const pkg of [
    { ...published, name: 'wrong' },
    { ...published, version: '0.0.0-stage' },
    { ...published, version: '1.0.0' },
    { ...published, version: '2.2.1-adapter.0.1.1-beta' },
    { ...published, version: '2.2.2-adapter.0.1.0' },
  ])
    await assert.rejects(
      checkRelease(
        { ...options, forceRelease: true, eventName: 'workflow_dispatch' },
        reader(upstream, pkg),
      ),
    );
});

test('release check imports and runs with no node_modules or build environment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'himalaya-release-check-'));
  try {
    await mkdir(join(dir, 'scripts'));
    for (const file of ['release-check.mjs', 'release.mjs'])
      await copyFile(new URL('../scripts/' + file, import.meta.url), join(dir, 'scripts', file));
    const code = `import { checkRelease } from './scripts/release-check.mjs'; const result = await checkRelease(${JSON.stringify(options)}, async url => url.includes('api.github.com') ? ${JSON.stringify(upstream)} : ${JSON.stringify(published)}); if(result.needed) process.exit(1);`;
    execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: dir,
      stdio: 'pipe',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
