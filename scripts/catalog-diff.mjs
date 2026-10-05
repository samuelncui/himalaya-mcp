#!/usr/bin/env node
/** Compare the preceding published release without executing package code. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';
import { gunzipSync } from 'node:zlib';
import * as tls from 'node:tls';
import { Parser } from 'tar';
import { compareReleaseVersions, releaseVersion } from './release.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registry = 'https://registry.npmjs.org/';
const metadataLimit = 4 * 1024 * 1024;
const archiveLimit = 32 * 1024 * 1024;
const expandedLimit = 128 * 1024 * 1024;
const catalogLimit = 16 * 1024 * 1024;
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') =>
  createHash(algorithm).update(bytes).digest(encoding);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value) => Array.isArray(value) && value.every((part) => typeof part === 'string');

function validateCatalog(catalog) {
  if (
    !object(catalog) ||
    catalog.schemaVersion !== 1 ||
    !object(catalog.native) ||
    typeof catalog.native.version !== 'string' ||
    !catalog.native.version ||
    typeof catalog.native.revision !== 'string' ||
    !catalog.native.revision ||
    !strings(catalog.native.features) ||
    !Array.isArray(catalog.commands)
  ) {
    throw new Error('Invalid catalog schema or upstream identity.');
  }
  const paths = new Set();
  for (const command of catalog.commands) {
    if (
      !object(command) ||
      !strings(command.path) ||
      !strings(command.aliases) ||
      typeof command.help !== 'string' ||
      !Array.isArray(command.args)
    ) {
      throw new Error('Invalid catalog command definition.');
    }
    const path = JSON.stringify(command.path);
    if (paths.has(path)) throw new Error(`Duplicate catalog command path: ${path}`);
    paths.add(path);
    const ids = new Set();
    for (const arg of command.args) {
      if (!object(arg) || typeof arg.id !== 'string' || !arg.id || ids.has(arg.id)) {
        throw new Error(`Invalid or duplicate catalog argument at ${path}.`);
      }
      ids.add(arg.id);
    }
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

function changedFields(before, after) {
  return Object.fromEntries(
    [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .sort()
      .filter(
        (key) => JSON.stringify(canonical(before[key])) !== JSON.stringify(canonical(after[key])),
      )
      .map((key) => [key, { before: before[key], after: after[key] }]),
  );
}

function compareItems(before, after, key, compare) {
  const old = new Map(before.map((item) => [key(item), item]));
  const next = new Map(after.map((item) => [key(item), item]));
  const added = after.filter((item) => !old.has(key(item)));
  const removed = before.filter((item) => !next.has(key(item)));
  const modified = after
    .filter((item) => old.has(key(item)))
    .map((item) => compare(old.get(key(item)), item))
    .filter(Boolean);
  return { added, removed, modified };
}

export function compareCatalogs(previous, current) {
  validateCatalog(current);
  if (previous !== null) validateCatalog(previous);
  const commands = compareItems(
    previous?.commands ?? [],
    current.commands,
    (command) => JSON.stringify(command.path),
    (before, after) => {
      const metadata = (command) => {
        const result = { ...command, argumentOrder: command.args.map((arg) => arg.id) };
        delete result.path;
        delete result.args;
        return result;
      };
      const fields = changedFields(metadata(before), metadata(after));
      const args = compareItems(
        before.args,
        after.args,
        (arg) => arg.id,
        (a, b) => {
          const changes = changedFields(a, b);
          return Object.keys(changes).length ? { id: b.id, fields: changes } : undefined;
        },
      );
      return Object.keys(fields).length ||
        args.added.length ||
        args.removed.length ||
        args.modified.length
        ? { path: after.path, fields, args }
        : undefined;
    },
  );
  const summary = {
    commands: Object.fromEntries(
      Object.entries(commands).map(([kind, items]) => [kind, items.length]),
    ),
    args: {
      added: commands.added.reduce((total, command) => total + command.args.length, 0),
      removed: commands.removed.reduce((total, command) => total + command.args.length, 0),
      modified: 0,
    },
  };
  for (const command of commands.modified) {
    for (const kind of ['added', 'removed', 'modified'])
      summary.args[kind] += command.args[kind].length;
  }
  return {
    status: previous === null ? 'initial' : 'compared',
    native: changedFields(previous?.native ?? {}, current.native),
    summary,
    commands,
  };
}

async function readBounded(response, limit, label) {
  if (Number(response.headers.get('content-length')) > limit)
    throw new Error(`${label} exceeds its size limit.`);
  if (!response.body) throw new Error(`${label} has no response body.`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error(`${label} exceeds its size limit.`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${label} is not valid UTF-8 JSON.`);
  }
}

async function catalogFromArchive(archive) {
  const expanded = gunzipSync(archive, { maxOutputLength: expandedLimit });
  const chunks = [];
  let seen = 0;
  await new Promise((accept, reject) => {
    const parser = new Parser({
      strict: true,
      filter: (path) => path === 'package/dist/catalog.json',
      onReadEntry(entry) {
        if (entry.type !== 'File' || ++seen !== 1 || entry.size > catalogLimit) {
          parser.abort(new Error('Published catalog must be one regular file within 16 MiB.'));
          return;
        }
        entry.on('data', (chunk) => chunks.push(chunk));
        entry.on('error', reject);
        entry.resume();
      },
    });
    parser.once('error', reject);
    parser.once('finish', accept);
    parser.end(expanded);
  });
  if (seen !== 1) throw new Error('Published package has no dist/catalog.json.');
  const bytes = Buffer.concat(chunks);
  const catalog = parseJson(bytes, 'Published catalog');
  validateCatalog(catalog);
  return { catalog, catalogSha256: hash(bytes) };
}

function supportedVersion(version) {
  try {
    const parts = version.split('-adapter.');
    if (parts.length !== 2 || releaseVersion(parts[0], parts[1]) !== version) throw new Error();
  } catch {
    throw new Error(`Unsupported npm release version: ${version}.`);
  }
}

export async function publishedCatalog(packageName, fetchImpl = fetch, target) {
  if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9_.-]*$/.test(packageName))
    throw new Error('Invalid npm package name.');
  const request = (url) =>
    fetchImpl(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: 'application/vnd.npm.install-v1+json',
        'User-Agent': 'himalaya-mcp-catalog-diff',
      },
    });
  const response = await request(registry + encodeURIComponent(packageName));
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new Error(`npm package metadata request failed: HTTP ${response.status}.`);
  const metadata = parseJson(
    await readBounded(response, metadataLimit, 'npm metadata'),
    'npm metadata',
  );
  if (
    !object(metadata) ||
    metadata.name !== packageName ||
    !object(metadata.versions) ||
    !Object.keys(metadata.versions).length
  ) {
    throw new Error('Existing npm package has no valid version metadata.');
  }
  const versions = Object.keys(metadata.versions);
  for (const version of versions) {
    supportedVersion(version);
    const entry = metadata.versions[version];
    if (!object(entry) || entry.name !== packageName || entry.version !== version) {
      throw new Error(`Invalid npm version metadata: ${version}.`);
    }
  }
  let packageVersion;
  if (target !== undefined) {
    supportedVersion(target);
    for (const version of versions) {
      if (
        compareReleaseVersions(version, target) < 0 &&
        (packageVersion === undefined || compareReleaseVersions(version, packageVersion) > 0)
      ) {
        packageVersion = version;
      }
    }
    if (packageVersion === undefined) {
      console.error(`No earlier npm release before ${target}; catalog comparison is initial.`);
      return undefined;
    }
  } else {
    packageVersion = metadata['dist-tags']?.latest;
    if (typeof packageVersion !== 'string' || !Object.hasOwn(metadata.versions, packageVersion)) {
      throw new Error('Existing npm package has no valid latest version metadata.');
    }
  }
  const latest = metadata.versions[packageVersion];
  const integrity = latest.dist?.integrity;
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) {
    throw new Error('Selected npm package requires SHA512 archive integrity.');
  }
  const url = new URL(latest.dist.tarball);
  if (url.origin !== 'https://registry.npmjs.org' || url.username || url.password || url.hash) {
    throw new Error('Published archive must come from the official HTTPS npm registry.');
  }
  const downloaded = await request(url.href);
  if (!downloaded.ok)
    throw new Error(`Published npm archive request failed: HTTP ${downloaded.status}.`);
  const archive = await readBounded(downloaded, archiveLimit, 'npm archive');
  if (`sha512-${hash(archive, 'sha512', 'base64')}` !== integrity)
    throw new Error('Published npm archive SHA512 integrity mismatch.');
  return { packageVersion, integrity, ...(await catalogFromArchive(archive)) };
}

export function catalogDiffReport(packageName, candidateBytes, previous) {
  const candidate = parseJson(candidateBytes, 'Candidate catalog');
  return {
    schemaVersion: 1,
    packageName: packageName,
    previous: previous
      ? {
          packageVersion: previous.packageVersion,
          integrity: previous.integrity,
          catalogSha256: previous.catalogSha256,
          version: previous.catalog.native.version,
          revision: previous.catalog.native.revision,
        }
      : null,
    current: {
      catalogSha256: hash(candidateBytes),
      version: candidate.native.version,
      revision: candidate.native.revision,
    },
    ...compareCatalogs(previous?.catalog ?? null, candidate),
  };
}

export async function generateCatalogDiff() {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    throw new Error('TLS verification must remain enabled.');
  if (
    typeof tls.getCACertificates === 'function' &&
    typeof tls.setDefaultCACertificates === 'function'
  ) {
    tls.setDefaultCACertificates([
      ...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]),
    ]);
  }
  const directory = join(root, 'build', 'generated');
  const [candidateBytes, packageJson] = await Promise.all([
    readFile(join(directory, 'catalog.json')),
    readFile(join(root, 'package.json')).then((bytes) => parseJson(bytes, 'Package metadata')),
  ]);
  if (candidateBytes.length > catalogLimit) throw new Error('Candidate catalog exceeds 16 MiB.');
  const candidate = parseJson(candidateBytes, 'Candidate catalog');
  validateCatalog(candidate);
  const target = releaseVersion(candidate.native.version, packageJson.version);
  const previous = await publishedCatalog(packageJson.name, fetch, target);
  const report = catalogDiffReport(packageJson.name, candidateBytes, previous);
  await mkdir(directory, { recursive: true });
  const output = join(directory, 'catalog-diff.json');
  const temporary = `${output}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
  await rename(temporary, output);
  console.error(
    `Catalog diff ${report.status}: ${report.summary.commands.added} added, ${report.summary.commands.removed} removed, ${report.summary.commands.modified} modified paths.`,
  );
  for (const command of report.commands.removed)
    console.error(`Removed native path: ${command.path.join(' ') || '<root>'}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/catalog-diff.mjs');
  generateCatalogDiff().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
