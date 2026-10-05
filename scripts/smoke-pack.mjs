/** Verify the distributable, then exercise exactly that archive on this platform. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { t as listTar } from 'tar';

const root = resolve(import.meta.dirname, '..');

function run(program, args) {
  return new Promise((accept, reject) => {
    const child = spawn(program, args, {
      cwd: root,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (bytes) => {
      stdout += bytes.toString();
    });
    child.stderr.on('data', (bytes) => {
      stderr += bytes.toString();
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? accept(stdout)
        : reject(new Error(`Package command failed (${code}): ${stderr}`)),
    );
  });
}

export async function verifyPackage(archive) {
  const paths = [],
    contents = new Map();
  await listTar({
    file: archive,
    strict: true,
    onReadEntry(entry) {
      assert(
        ['File', 'Directory'].includes(entry.type),
        `Unexpected archive entry type ${entry.type}`,
      );
      assert(
        entry.path.startsWith('package/') && !entry.path.split('/').includes('..'),
        'Unsafe package path',
      );
      paths.push(entry.path);
      if (
        [
          'package/package.json',
          'package/dist/manifest.json',
          'package/dist/catalog.json',
          'package/dist/cli.js',
        ].includes(entry.path)
      ) {
        const chunks = [];
        entry.on('data', (chunk) => chunks.push(chunk));
        entry.on('end', () => contents.set(entry.path, Buffer.concat(chunks).toString()));
      }
    },
  });
  for (const path of paths) {
    assert(
      /^package\/(?:package\.json|README\.md|SECURITY\.md|CONTRIBUTING\.md|LICENSE|THIRD_PARTY_NOTICES\.md|dist\/|examples\/|docs\/)/.test(
        path,
      ),
      `Non-runtime source included in npm package: ${path}`,
    );
    assert(
      !/\.(?:node|exe|dll|so|dylib|rs|py|ts)$/.test(path),
      `Native/helper/source file included: ${path}`,
    );
    if (path.startsWith('package/dist/') && !path.endsWith('/'))
      assert(
        /^package\/dist\/(?:cli\.js(?:\.LEGAL\.txt)?|(?:catalog|manifest|profiles|upstream\.lock|release)\.json)$/.test(
          path,
        ),
        `Unexpected runtime artifact: ${path}`,
      );
  }
  const pkg = JSON.parse(contents.get('package/package.json'));
  assert.equal(pkg.name, 'himalaya-mcp');
  assert.equal(pkg.bin['himalaya-mcp'], 'dist/cli.js');
  for (const field of ['dependencies', 'optionalDependencies'])
    assert.equal(
      Object.keys(pkg[field] ?? {}).length,
      0,
      `Published ${field} would require an install-time dependency`,
    );
  for (const script of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack'])
    assert.equal(pkg.scripts?.[script], undefined, `Unexpected install/build lifecycle ${script}`);
  assert(
    contents.get('package/dist/cli.js')?.startsWith('#!/usr/bin/env node\n'),
    'Missing executable JS entry point',
  );
  const manifest = JSON.parse(contents.get('package/dist/manifest.json'));
  const catalog = JSON.parse(contents.get('package/dist/catalog.json'));
  assert.equal(pkg.version, manifest.packageVersion, 'Package/manifest version mismatch');
  assert.equal(
    catalog.native.version,
    manifest.himalaya.version,
    'Native definition version mismatch',
  );
  for (const name of [
    'package/dist/upstream.lock.json',
    'package/dist/profiles.json',
    'package/LICENSE',
    'package/THIRD_PARTY_NOTICES.md',
  ])
    assert(paths.includes(name), `Missing packaged metadata: ${name}`);
  return {
    packageVersion: pkg.version,
    nativeVersion: catalog.native.version,
    files: paths.length,
  };
}

let archive;
if (process.argv.length > 2) {
  assert.equal(process.argv[2], '--package', 'Use --package <archive> or npm run smoke:pack');
  assert.equal(process.argv.length, 4, 'Expected exactly one archive path');
  archive = resolve(process.argv[3]);
} else {
  const destination = resolve(root, 'build', 'pack');
  await mkdir(destination, { recursive: true });
  const args = ['pack', '--ignore-scripts', '--json', '--pack-destination', destination];
  const result = process.env.npm_execpath
    ? await run(process.execPath, [process.env.npm_execpath, ...args])
    : await run('npm', args);
  archive = resolve(destination, JSON.parse(result)[0].filename);
}
await readFile(archive); // Fail before any install or native execution if the artifact is absent.
const report = await verifyPackage(archive);
console.error(
  `Package structure verified: ${JSON.stringify(report)}; no native helper, install build, or runtime dependency.`,
);
const { platformSmoke } = await import(
  pathToFileURL(resolve(root, 'scripts', 'platform-smoke.mjs')).href
);
await platformSmoke({ archive });
