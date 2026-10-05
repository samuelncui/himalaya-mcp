#!/usr/bin/env node
/** Read-only release decision before source generation or dependency installation. */
import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareReleaseVersions, getJson, releaseVersion } from './release.mjs';

export async function checkRelease(
  { packageName, adapterVersion, upstreamVersion, forceRelease = false, eventName },
  read = getJson,
) {
  if (forceRelease && eventName !== 'workflow_dispatch')
    throw new Error('Force release is available only through explicit manual dispatch.');
  releaseVersion(upstreamVersion || '0.0.0', adapterVersion);
  const endpoint = upstreamVersion ? 'tags/v' + upstreamVersion : 'latest';
  const upstream = await read(
    'https://api.github.com/repos/pimalaya/himalaya/releases/' + endpoint,
    true,
  );
  const version = upstream?.tag_name?.replace(/^v/, '');
  if (!upstream || upstream.draft || upstream.prerelease)
    throw new Error('Release check requires an official stable Himalaya release.');
  const candidateVersion = releaseVersion(version, adapterVersion);
  if (upstreamVersion && version !== upstreamVersion)
    throw new Error('Official release does not match the requested Himalaya version.');
  const published = await read(
    'https://registry.npmjs.org/' + encodeURIComponent(packageName) + '/latest',
  );
  if (published && (published.name !== packageName || typeof published.version !== 'string'))
    throw new Error('Published npm latest has invalid package identity.');
  const publishedVersion = published?.version;
  const parts = publishedVersion?.split('-adapter.');
  if (!published || parts.length === 1)
    return {
      needed: true,
      version,
      candidateVersion,
      publishedVersion,
      reason: 'No published adapter native-version baseline.',
    };
  if (parts.length !== 2 || releaseVersion(parts[0], parts[1]) !== publishedVersion)
    throw new Error('Published npm latest is not a supported adapter release.');
  if (compareReleaseVersions(candidateVersion, publishedVersion) < 0)
    throw new Error('Refusing to release an older version than npm latest.');
  const needed = forceRelease || version !== parts[0];
  return {
    needed,
    version,
    candidateVersion,
    publishedVersion,
    reason: forceRelease
      ? 'Explicit manual full release.'
      : needed
        ? 'Himalaya has a new version.'
        : 'Himalaya is unchanged; skip generation and publication.',
  };
}

async function main() {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const force = process.env.FORCE_RELEASE || 'false';
  if (!['true', 'false'].includes(force)) throw new Error('FORCE_RELEASE must be true or false.');
  const result = await checkRelease({
    packageName: pkg.name,
    adapterVersion: pkg.version,
    upstreamVersion: process.env.UPSTREAM_VERSION || undefined,
    forceRelease: force === 'true',
    eventName: process.env.GITHUB_EVENT_NAME,
  });
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `needed=${result.needed}\nversion=${result.version}\n`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
