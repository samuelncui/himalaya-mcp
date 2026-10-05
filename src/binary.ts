import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import * as tls from 'node:tls';
import { promisify } from 'node:util';
import { list } from 'tar';
import { AdapterError, type BinaryAsset, type Catalog, type Manifest } from './types.js';

const execFileAsync = promisify(execFile);
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_BINARY_BYTES = 128 * 1024 * 1024;

export interface BinaryOptions {
  binary?: string;
  cacheDir?: string;
  allowDownload?: boolean;
  catalog?: Catalog;
  /** Dependency injection for local archive fixtures; never exposed as a tool argument. */
  fetch?: typeof globalThis.fetch;
}

export interface BinaryInfo {
  path: string;
  version: string;
  features: string[];
  source: 'download' | 'cache' | 'custom';
  verified: boolean;
  sha256: string;
}

export interface BinaryInspection {
  ok: boolean;
  binary?: BinaryInfo;
  code?: string;
  message?: string;
  nextStep?: string;
}

/** Local metadata only: no download, directory creation, configuration or account commands. */
export async function inspectBinary(
  manifest: Manifest,
  options: BinaryOptions = {},
): Promise<BinaryInspection> {
  try {
    return { ok: true, binary: await inspectLocal(manifest, options) };
  } catch (error) {
    const failure = binaryError(error);
    return {
      ok: false,
      code: failure.code,
      message: failure.message,
      ...(failure.nextStep === undefined ? {} : { nextStep: failure.nextStep }),
    };
  }
}

/** Locate an explicitly selected executable, or install a pinned official asset in a private cache. */
export async function ensureBinary(
  manifest: Manifest,
  options: BinaryOptions = {},
): Promise<BinaryInfo> {
  try {
    return await inspectLocal(manifest, options);
  } catch (error) {
    const failure = binaryError(error);
    if (
      options.binary !== undefined ||
      options.allowDownload === false ||
      failure.code !== 'binary_missing'
    )
      throw failure;
  }

  const asset = selectAsset(manifest);
  validateAsset(manifest, asset);
  const cacheRoot = cacheDirectory(options.cacheDir);
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  await checkPrivateDirectory(cacheRoot);
  const stage = await mkdtemp(join(cacheRoot, '.download-'));
  const target = cachePath(manifest, asset, cacheRoot);
  try {
    const archive = join(stage, 'archive.tgz');
    await downloadArchive(asset, archive, options.fetch ?? globalThis.fetch);
    const executable = join(stage, executableName());
    await extractExecutable(archive, executable);
    const sha256 = await hashExecutable(executable);
    if (sha256 !== asset.binarySha256)
      throw new AdapterError(
        'binary_digest_mismatch',
        'Downloaded Himalaya executable does not match the pinned SHA-256.',
        'Retry with a verified release of this package; do not execute this file.',
      );
    await chmod(executable, 0o500);
    await readMetadata(executable, manifest, options.catalog);
    await rm(archive);
    try {
      // The entire directory appears atomically. Concurrent installers have isolated staging directories.
      await rename(stage, target.directory);
    } catch (error) {
      if (
        !hasCode(error, 'EEXIST', 'ENOTEMPTY') &&
        !(process.platform === 'win32' && hasCode(error, 'EPERM', 'EACCES'))
      )
        throw error;
      return await inspectLocal(manifest, options);
    }
    return { ...(await inspectLocal(manifest, options)), source: 'download' };
  } catch (error) {
    throw binaryError(error);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function inspectLocal(manifest: Manifest, options: BinaryOptions): Promise<BinaryInfo> {
  let path: string;
  let source: BinaryInfo['source'];
  let asset: BinaryAsset | undefined;
  if (options.binary !== undefined) {
    if (options.binary.trim() === '')
      throw new AdapterError(
        'binary_path_invalid',
        '--binary requires an executable path.',
        'Provide an absolute path to a compatible Himalaya binary.',
      );
    try {
      // An explicitly selected Homebrew/system symlink is allowed; the target remains user-selected.
      path = await realpath(resolve(options.binary));
    } catch (error) {
      if (hasCode(error, 'ENOENT')) throw missingBinary();
      throw error;
    }
    source = 'custom';
  } else {
    asset = selectAsset(manifest);
    validateAsset(manifest, asset);
    const cacheRoot = cacheDirectory(options.cacheDir);
    const target = cachePath(manifest, asset, cacheRoot);
    await checkPrivateDirectory(cacheRoot);
    await checkPrivateDirectory(target.directory);
    path = target.binary;
    source = 'cache';
  }
  const sha256 = await hashExecutable(path, source === 'cache');
  if (asset !== undefined && sha256 !== asset.binarySha256) {
    throw new AdapterError(
      'binary_digest_mismatch',
      'Cached Himalaya executable does not match the pinned SHA-256.',
      'Remove this damaged cache entry and restart; the launcher will download a fresh official asset.',
    );
  }
  const metadata = await readMetadata(path, manifest, options.catalog);
  return {
    path,
    ...metadata,
    source,
    verified: manifest.assets.some((candidate) => candidate.binarySha256 === sha256),
    sha256,
  };
}

function selectAsset(manifest: Manifest): BinaryAsset {
  const assets = manifest.assets.filter(
    (asset) => asset.platform === process.platform && asset.arch === process.arch,
  );
  if (assets.length === 0)
    throw new AdapterError(
      'unsupported_platform',
      'No official Himalaya asset is pinned for ' + process.platform + '/' + process.arch + '.',
      'Use --binary with a compatible executable; this launcher does not compile or choose an emulated architecture.',
    );
  if (assets.length !== 1)
    throw new AdapterError(
      'manifest_invalid',
      'Release manifest has ambiguous platform assets.',
      'Install a release with a valid generated manifest.',
    );
  return assets[0]!;
}

function validateAsset(manifest: Manifest, asset: BinaryAsset): void {
  const expectedUrl =
    'https://github.com/pimalaya/himalaya/releases/download/' +
    encodeURIComponent(manifest.himalaya.tag) +
    '/' +
    encodeURIComponent(asset.name);
  if (
    !/^[0-9a-f]{64}$/.test(asset.archiveSha256) ||
    !/^[0-9a-f]{64}$/.test(asset.binarySha256) ||
    !/^[a-zA-Z0-9._-]+\.tgz$/.test(asset.name) ||
    asset.url !== expectedUrl ||
    manifest.himalaya.tag !== 'v' + manifest.himalaya.version
  ) {
    throw new AdapterError(
      'manifest_invalid',
      'Asset URL or digests are not a pinned official Himalaya release.',
      'Install a release with a valid generated manifest.',
    );
  }
}

function cacheDirectory(configured?: string): string {
  if (configured !== undefined) return resolve(configured);
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'himalaya-mcp');
  if (process.platform === 'win32')
    return join(
      process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
      'himalaya-mcp',
      'Cache',
    );
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'himalaya-mcp');
}

function cachePath(
  manifest: Manifest,
  asset: BinaryAsset,
  root: string,
): { directory: string; binary: string } {
  // A digest is the complete cache identity; version strings never become filesystem paths.
  const directory = join(root, asset.binarySha256);
  if (manifest.himalaya.version === '')
    throw new AdapterError('manifest_invalid', 'Missing pinned Himalaya version.');
  return { directory, binary: join(directory, executableName()) };
}

function executableName(): string {
  return process.platform === 'win32' ? 'himalaya.exe' : 'himalaya';
}

async function checkPrivateDirectory(path: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) throw missingBinary();
    throw error;
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
  ) {
    throw new AdapterError(
      'cache_permissions',
      'Binary cache must be a private directory owned by the current user, without symlinks.',
      'Choose a private --cache-dir; on Unix its directories must have mode 0700.',
    );
  }
}

async function hashExecutable(path: string, privateFile = false): Promise<string> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) throw missingBinary();
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BINARY_BYTES)
    throw new AdapterError(
      'binary_file_invalid',
      'Himalaya executable must be a regular file of at most 128 MiB.',
      'Select a compatible executable; cache entries must not be symbolic links.',
    );
  if (
    privateFile &&
    process.platform !== 'win32' &&
    ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
  )
    throw new AdapterError(
      'cache_permissions',
      'Cached executable is not private to the current user.',
      'Remove the damaged cache entry and restart.',
    );
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function readMetadata(
  path: string,
  manifest: Manifest,
  catalog?: Catalog,
): Promise<{ version: string; features: string[] }> {
  const versionText = await metadataCommand(path, '--version');
  const versionLine = versionText.split(/\r?\n/)[0] ?? '';
  const version = /^himalaya v?(\S+)/.exec(versionLine)?.[1];
  if (version !== manifest.himalaya.version)
    throw new AdapterError(
      'binary_version_mismatch',
      'Selected binary does not report the pinned Himalaya version ' +
        manifest.himalaya.version +
        '.',
      'Select the matching original binary or install a package generated for your Himalaya version.',
    );
  const features = [
    ...new Set([...versionLine.matchAll(/\+([a-zA-Z0-9_-]+)/g)].map((match) => match[1]!)),
  ].sort();
  if (!sameSet(features, manifest.himalaya.features))
    throw new AdapterError(
      'binary_features_mismatch',
      'Selected binary has different compiled features from this package.',
      'Use the pinned official asset, or generate a package for this binary feature set.',
    );
  if (catalog !== undefined) {
    if (
      catalog.native.version !== manifest.himalaya.version ||
      catalog.native.revision !== manifest.himalaya.revision ||
      !sameSet(catalog.native.features, manifest.himalaya.features)
    )
      throw new AdapterError(
        'catalog_mismatch',
        'Catalog and release manifest identify different native builds.',
        'Install a release with matching generated artifacts.',
      );
    const help = await metadataCommand(path, '--help');
    const section = /^Commands:\r?\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m.exec(help)?.[1] ?? '';
    const actual = [...section.matchAll(/^ {2}(\S+)(?:\s|$)/gm)].map((match) => match[1]!);
    const expected = catalog.commands
      .filter((command) => command.path.length === 1 && !command.hidden)
      .map((command) => command.path[0]!);
    const visible = actual.filter((command) => command !== 'help' || expected.includes('help'));
    if (!sameSet(visible, expected))
      throw new AdapterError(
        'binary_catalog_mismatch',
        'Public root commands differ from the generated catalog.',
        'Use the matching binary/catalog; full command compatibility is checked by release CI.',
      );
  }
  return { version, features };
}

async function metadataCommand(path: string, option: '--version' | '--help'): Promise<string> {
  try {
    const child = execFileAsync(path, [option], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1', CLICOLOR: '0', RUST_LOG: 'off' },
    });
    // Close stdin so metadata inspection cannot accidentally wait for a terminal or credentials.
    child.child.stdin?.end();
    return (await child).stdout;
  } catch {
    throw new AdapterError(
      'binary_execution_failed',
      'Himalaya metadata command failed or exceeded its time/output limit.',
      'Check execute permissions and provide a compatible original binary.',
    );
  }
}

async function downloadArchive(
  asset: BinaryAsset,
  path: string,
  fetcher: typeof globalThis.fetch,
): Promise<void> {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    throw new AdapterError(
      'tls_verification_disabled',
      'Refusing to download with TLS certificate verification disabled.',
      'Restore TLS verification; configure Node system CA certificates or NODE_EXTRA_CA_CERTS if required.',
    );
  // Match OS trust without weakening TLS verification or dropping NODE_EXTRA_CA_CERTS.
  if (
    typeof tls.getCACertificates === 'function' &&
    typeof tls.setDefaultCACertificates === 'function'
  ) {
    tls.setDefaultCACertificates([
      ...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]),
    ]);
  }
  const file = await open(path, 'wx', 0o600);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetcher(asset.url, { signal: AbortSignal.timeout(60_000) });
    reader = response.body?.getReader();
    if (!response.ok || reader === undefined)
      throw new AdapterError(
        'binary_download_failed',
        'Official Himalaya asset download returned HTTP ' + response.status + '.',
        'Check network/proxy access and retry.',
      );
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) > MAX_ARCHIVE_BYTES)
      throw new AdapterError(
        'archive_too_large',
        'Himalaya archive exceeds the 64 MiB download limit.',
      );
    const hash = createHash('sha256');
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_ARCHIVE_BYTES)
        throw new AdapterError(
          'archive_too_large',
          'Himalaya archive exceeds the 64 MiB download limit.',
        );
      hash.update(chunk.value);
      await file.writeFile(chunk.value);
    }
    if (hash.digest('hex') !== asset.archiveSha256)
      throw new AdapterError(
        'archive_digest_mismatch',
        'Downloaded archive does not match the pinned SHA-256.',
        'Retry with a verified release of this package; the archive was not extracted.',
      );
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError(
      'binary_download_failed',
      'Official Himalaya asset download failed.',
      'Check network/proxy access and Node CA trust; use --use-system-ca or a trusted NODE_EXTRA_CA_CERTS file where supported. TLS verification must remain enabled.',
    );
  } finally {
    await reader?.cancel().catch(() => undefined);
    await file.close();
  }
}

async function extractExecutable(archive: string, destination: string): Promise<void> {
  const name = executableName();
  const chunks: Buffer[] = [];
  let matches = 0;
  let size = 0;
  let declaredTotal = 0;
  let invalid: string | undefined;
  // Parse only; tar never chooses an output path or materializes links, directories, or other files.
  try {
    await list({
      file: archive,
      strict: true,
      maxMetaEntrySize: 64 * 1024,
      maxDecompressionRatio: 16,
      onReadEntry(entry) {
        declaredTotal += entry.size;
        if (declaredTotal > 2 * MAX_BINARY_BYTES)
          invalid = 'Archive contents exceed their size limit.';
        if (entry.path !== name && entry.path !== './' + name) return;
        matches++;
        if (
          matches !== 1 ||
          (entry.type !== 'File' && entry.type !== 'OldFile') ||
          entry.size > MAX_BINARY_BYTES
        ) {
          invalid = 'Archive must contain exactly one regular root Himalaya executable.';
          return;
        }
        entry.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_BINARY_BYTES)
            invalid = 'Himalaya executable exceeds the 128 MiB size limit.';
          if (invalid === undefined) chunks.push(chunk);
        });
      },
    });
  } catch {
    throw new AdapterError(
      'archive_invalid',
      'Himalaya archive could not be safely parsed.',
      'Use a verified official release archive.',
    );
  }
  if (matches !== 1 || invalid !== undefined || size === 0)
    throw new AdapterError(
      'archive_invalid',
      invalid ?? 'Archive does not contain a regular root Himalaya executable.',
      'Use a verified official release archive.',
    );
  await writeFile(destination, Buffer.concat(chunks), { flag: 'wx', mode: 0o600 });
}

function sameSet(a: string[], b: string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function missingBinary(): AdapterError {
  return new AdapterError(
    'binary_missing',
    'Compatible Himalaya executable is not available locally.',
    'Start the MCP server to download the pinned asset, or supply --binary with a compatible executable.',
  );
}

function hasCode(error: unknown, ...codes: string[]): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    codes.includes(String(error.code))
  );
}

function binaryError(error: unknown): AdapterError {
  if (error instanceof AdapterError) return error;
  return new AdapterError(
    'binary_io_failed',
    'Himalaya executable or cache could not be inspected.',
    'Check the selected executable/cache path and filesystem permissions.',
  );
}
