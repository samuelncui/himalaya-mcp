import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { c as createTar } from 'tar';
import { parse } from 'yaml';
import {
  packageEvidence,
  verifyRegistryPublication,
  verifyReleaseTag,
} from '../scripts/release.mjs';

const root = resolve(import.meta.dirname, '..');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const publicArchive = Buffer.from('Synthetic release archive.');

const lock = {
  repository: 'fixture/adapter',
  package: { name: 'synthetic-adapter', version: '2.2.1-adapter.0.1.1' },
  upstream: { version: '2.2.1' },
  adapter: { revision: '1'.repeat(40) },
  artifact: { integrity: 'sha512-' + createHash('sha512').update(publicArchive).digest('base64') },
};
const registryEntry = {
  version: lock.package.version,
  dist: {
    integrity: lock.artifact.integrity,
    tarball: 'https://registry.npmjs.org/synthetic-adapter/-/synthetic-adapter.tgz',
  },
};
const archiveOptions = { readArchive: async () => publicArchive };

test('publication acceptance checks integrity and both authoritative npm tags', async () => {
  const read = async () => registryEntry;
  await verifyRegistryPublication(lock, read, archiveOptions);
  for (const tag of ['latest', 'himalaya-2.2.1'])
    await assert.rejects(
      verifyRegistryPublication(
        lock,
        async (url) => (url.endsWith('/' + tag) ? { version: '2.2.0-adapter.0.1.0' } : read(url)),
        archiveOptions,
      ),
      /tags do not yet select/,
    );
  await assert.rejects(
    verifyRegistryPublication(lock, async (url) => ({
      ...(await read(url)),
      dist: { integrity: 'different' },
    })),
    /integrity differs/,
  );
});

test('publication waits for version, tags and archive visibility without repeating a write', async () => {
  for (const pending of ['version', 'latest', 'native', 'archive']) {
    let time = 0;
    const sleeps = [];
    const read = async (url) => {
      if (!time && pending === 'version' && url.endsWith(lock.package.version)) return undefined;
      if (
        !time &&
        ((pending === 'latest' && url.endsWith('/latest')) ||
          (pending === 'native' && url.endsWith('/himalaya-2.2.1')))
      )
        return { version: '2.2.0-adapter.0.1.0' };
      return registryEntry;
    };
    await verifyRegistryPublication(lock, read, {
      timeoutMs: 50,
      intervalMs: 10,
      now: () => time,
      sleep: async (ms) => {
        sleeps.push(ms);
        time += ms;
      },
      readArchive: async () => (!time && pending === 'archive' ? undefined : publicArchive),
    });
    assert.deepEqual(sleeps, [10], pending);
  }
});

test('publication mismatches, untrusted archives and read errors fail without waiting', async () => {
  const failOnSleep = async () => assert.fail('This error must not be retried');
  const options = { timeoutMs: 50, sleep: failOnSleep, ...archiveOptions };
  await assert.rejects(
    verifyRegistryPublication(
      lock,
      async () => ({ ...registryEntry, dist: { integrity: 'wrong' } }),
      options,
    ),
    /registry integrity differs/,
  );
  await assert.rejects(
    verifyRegistryPublication(lock, async () => registryEntry, {
      ...options,
      readArchive: async () => Buffer.from('different bytes'),
    }),
    /archive integrity differs/,
  );
  await assert.rejects(
    verifyRegistryPublication(
      lock,
      async () => ({
        ...registryEntry,
        dist: { ...registryEntry.dist, tarball: 'https://untrusted.example/archive.tgz' },
      }),
      options,
    ),
    /official HTTPS/,
  );
  await assert.rejects(
    verifyRegistryPublication(
      lock,
      async () => {
        throw new Error('HTTP 403');
      },
      options,
    ),
    /HTTP 403/,
  );
});

test('publication visibility timeout preserves the sealed artifact recovery instructions', async () => {
  let time = 0;
  const sleeps = [];
  await assert.rejects(
    verifyRegistryPublication(lock, async () => undefined, {
      timeoutMs: 50,
      intervalMs: 30,
      now: () => time,
      sleep: async (ms) => {
        sleeps.push(ms);
        time += ms;
      },
    }),
    /rerun the original failed job with its sealed artifact/,
  );
  assert.deepEqual(sleeps, [30, 20]);
});

test('release acceptance resolves lightweight and annotated Git tags to the sealed commit', async () => {
  await verifyReleaseTag(lock, async () => ({
    object: { type: 'commit', sha: lock.adapter.revision },
  }));
  const annotated = '2'.repeat(40);
  await verifyReleaseTag(lock, async (url) => ({
    object: url.endsWith('/tags/' + annotated)
      ? { type: 'commit', sha: lock.adapter.revision }
      : { type: 'tag', sha: annotated },
  }));
  await assert.rejects(
    verifyReleaseTag(lock, async () => ({ object: { type: 'commit', sha: '3'.repeat(40) } })),
    /does not point to the sealed/,
  );
  await assert.rejects(
    verifyReleaseTag(lock, async () => ({ object: { type: 'tag', sha: annotated } })),
    /cyclic/,
  );
  await verifyReleaseTag(lock, async () => undefined, true);
  await assert.rejects(
    verifyReleaseTag(lock, async () => undefined),
    /does not point to the sealed/,
  );
});

async function withArchive(check) {
  const directory = await mkdtemp(join(tmpdir(), 'himalaya-release-evidence-'));
  try {
    const file = join(directory, 'package', 'fixture.txt');
    const archive = join(directory, 'package.tgz');
    await mkdir(join(directory, 'package'));
    await writeFile(file, 'Synthetic package fixture only.\n', { mode: 0o644 });
    const pack = () =>
      createTar(
        {
          cwd: directory,
          file: archive,
          portable: true,
          gzip: true,
          mtime: new Date('1985-10-26T08:15:00Z'),
        },
        ['package'],
      );
    await pack();
    await check({ directory, file, archive, pack });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('release archive evidence distinguishes compression bytes from tar content', async () => {
  await withArchive(async ({ directory, archive }) => {
    const original = sha256(await readFile(archive));
    const first = await packageEvidence(archive);
    assert.equal(first.archiveSha256, original);
    assert.equal(
      sha256(await readFile(archive)),
      original,
      'Diagnostics must not rewrite the candidate',
    );
    const fixture = first.entries.find((entry) => entry.path === 'package/fixture.txt');
    assert.equal(fixture?.sha256, sha256('Synthetic package fixture only.\n'));
    assert.equal(fixture?.mtime, '1985-10-26T08:15:00.000Z');
    assert.equal(fixture?.type, 'File');
    assert.equal(fixture?.mode, 0o644);
    const bytes = Buffer.from(await readFile(archive));
    bytes[9] = bytes[9] === 255 ? 3 : 255; // gzip OS metadata does not change the tar payload or CRC.
    const variant = join(directory, 'header-variant.tgz');
    await writeFile(variant, bytes);
    const second = await packageEvidence(variant);
    assert.notEqual(second.archiveSha256, first.archiveSha256);
    assert.notEqual(second.gzipHeader, first.gzipHeader);
    assert.equal(second.tarSha256, first.tarSha256);
    assert.deepEqual(second.entries, first.entries);
  });
});

test('release archive evidence identifies an actual payload difference', async () => {
  await withArchive(async ({ file, archive, pack }) => {
    const before = await packageEvidence(archive);
    await writeFile(file, 'Changed synthetic payload.\n');
    await pack();
    const after = await packageEvidence(archive);
    assert.notEqual(after.archiveSha256, before.archiveSha256);
    assert.notEqual(after.tarSha256, before.tarSha256);
    const entry = (evidence) =>
      evidence.entries.find((item) => item.path === 'package/fixture.txt');
    assert.notEqual(entry(after)?.sha256, entry(before)?.sha256);
    assert.equal(entry(after)?.sha256, sha256('Changed synthetic payload.\n'));
  });
});

test('archive diagnostics reject malformed gzip instead of emitting partial evidence', async () => {
  await withArchive(async ({ directory }) => {
    const malformed = join(directory, 'malformed.tgz');
    await writeFile(malformed, 'Not a gzip archive.');
    await assert.rejects(packageEvidence(malformed));
  });
});

test('workflow reruns preserve immutable uploads and consume sealed IDs across attempts', async () => {
  for (const filename of ['ci.yml', 'upstream.yml']) {
    const workflow = parse(await readFile(join(root, '.github', 'workflows', filename), 'utf8'));
    const generation = workflow.jobs.generation;
    const packageJob = workflow.jobs.package;
    const upload = (step) => step.uses?.startsWith('actions/upload-artifact@');
    const download = (step) => step.uses?.startsWith('actions/download-artifact@');
    assert.equal(generation.outputs['artifact-id'], '${{ steps.definitions.outputs.artifact-id }}');
    const definitions = generation.steps.find((step) => step.id === 'definitions');
    assert(upload(definitions));
    const input = packageJob.steps.find(download);
    assert.equal(input.with['artifact-ids'], '${{ needs.generation.outputs.artifact-id }}');
    assert.equal(
      input.with.name,
      undefined,
      'A later attempt must consume the actual earlier successful generation ID',
    );
    assert.equal(input.with['merge-multiple'], true);
    assert.equal(packageJob.outputs['artifact-id'], '${{ steps.seal.outputs.artifact-id }}');
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps.filter(upload)) {
        assert(step.with.name.endsWith('-${{ github.run_attempt }}'));
        assert.notEqual(step.with.overwrite, true, 'Never delete the prior sealed artifact');
      }
    }
    for (const name of ['platforms', 'publish', 'github-release']) {
      const job = workflow.jobs[name];
      if (job)
        assert.equal(
          job.steps.find(download).with['artifact-ids'],
          '${{ needs.package.outputs.artifact-id }}',
        );
    }
    for (const job of [generation, packageJob]) {
      const node = job.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
      assert.equal(node.with['node-version'], '24.21.0');
      assert(job.steps.some((step) => step.run?.includes('npm@11.19.0')));
    }
    if (workflow.jobs.publish) {
      assert(workflow.jobs.publish.steps.some((step) => step.run?.includes('npm@11.21.0')));
      assert.equal(workflow.jobs.publish.permissions['id-token'], 'write');
      assert.equal(workflow.jobs.publish['timeout-minutes'], 30);
    }
    assert.notEqual(generation.permissions?.['id-token'], 'write');
    assert.notEqual(packageJob.permissions?.['id-token'], 'write');
  }
});
