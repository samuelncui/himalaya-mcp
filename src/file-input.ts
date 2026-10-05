import dns from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import https, { type RequestOptions } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { basename } from 'node:path';
import { AdapterError, type OpenAIFile } from './types.js';

const privateV4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  privateV4.addSubnet(address, prefix, 'ipv4');
const publicV6 = new BlockList();
publicV6.addSubnet('2000::', 3, 'ipv6');
const specialV6 = new BlockList();
specialV6.addSubnet('2001::', 23, 'ipv6');
specialV6.addSubnet('2001:db8::', 32, 'ipv6');
specialV6.addSubnet('2002::', 16, 'ipv6');
specialV6.addSubnet('3fff::', 20, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !privateV4.check(address, 'ipv4')
    : family === 6 && publicV6.check(address, 'ipv6') && !specialV6.check(address, 'ipv6');
}

export function downloadUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AdapterError('file_url', 'Expected a public HTTPS file download URL.');
  }
  if (
    url.protocol !== 'https:' ||
    (url.port && url.port !== '443') ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new AdapterError(
      'file_url',
      'File URLs require HTTPS on port 443 without credentials or fragments.',
    );
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !isPublicAddress(host))
    throw new AdapterError(
      'file_destination',
      'File downloads cannot access private or special-use addresses.',
    );
  return url;
}

export function validateFileReference(raw: unknown): { name: string; file: OpenAIFile } {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).some(
      (key) => !['download_url', 'file_id', 'mime_type', 'file_name'].includes(key),
    )
  )
    throw new AdapterError('input_file', 'Expected a file object with download_url and file_id.');
  const file = raw as OpenAIFile;
  if (
    typeof file.download_url !== 'string' ||
    typeof file.file_id !== 'string' ||
    !file.file_id ||
    (file.mime_type !== undefined && typeof file.mime_type !== 'string') ||
    (file.file_name !== undefined && typeof file.file_name !== 'string')
  )
    throw new AdapterError(
      'input_file',
      'Expected file reference strings; download_url and file_id are required.',
    );
  const name = file.file_name ?? file.file_id;
  if (!name || name !== basename(name) || /[\\/\0\r\n]/.test(name) || ['.', '..'].includes(name))
    throw new AdapterError(
      'input_file',
      'File names must be ordinary basenames without path traversal.',
    );
  downloadUrl(file.download_url);
  return { name, file };
}

/** Abort DNS waiting without allowing a late result to start a request. */
async function addresses(host: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const ipFamily = isIP(host);
  if (ipFamily) return [{ address: host, family: ipFamily }];
  const result = await new Promise<LookupAddress[]>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void dns
      .lookup(host, { all: true, verbatim: true })
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener('abort', abort);
      });
  });
  signal.throwIfAborted();
  return result;
}

async function request(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const resolved = await addresses(host, signal);
  if (!resolved.length || resolved.some(({ address }) => !isPublicAddress(address)))
    throw new AdapterError(
      'file_destination',
      'File downloads require publicly routed DNS addresses.',
    );
  const selected = resolved.find(({ family }) => family === 4) ?? resolved[0]!;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const options: RequestOptions & { autoSelectFamily: false } = {
      method: 'GET',
      agent: false,
      autoSelectFamily: false,
      rejectUnauthorized: true,
      signal,
      headers: { 'Accept-Encoding': 'identity' },
      // Connect to exactly the verified address; TLS still authenticates the original host.
      lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
    };
    const req = https.request(url, options, resolve);
    req.once('error', reject);
    req.end();
  });
}

/** Import bytes only; no provider credentials, MIME handling, or filesystem access here. */
export async function downloadFile(
  file: OpenAIFile,
  limit: number,
  caller: AbortSignal,
): Promise<Buffer> {
  const deadline = AbortSignal.timeout(30_000);
  const signal = AbortSignal.any([caller, deadline]);
  let response: IncomingMessage | undefined;
  try {
    let url = downloadUrl(file.download_url);
    for (let redirects = 0; ; redirects++) {
      response = await request(url, signal);
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        response.destroy();
        if (!location || redirects === 3)
          throw new AdapterError(
            'file_redirect',
            'File download exceeded the redirect limit or omitted its destination.',
          );
        try {
          url = downloadUrl(new URL(location, url).href);
        } catch (error) {
          if (error instanceof AdapterError) throw error;
          throw new AdapterError('file_redirect', 'Invalid file download redirect.');
        }
        continue;
      }
      if (status !== 200)
        throw new AdapterError(
          'file_download',
          `File download returned HTTP ${status}; obtain a fresh file reference before retrying.`,
        );
      if (
        response.headers['content-encoding'] &&
        response.headers['content-encoding'] !== 'identity'
      )
        throw new AdapterError(
          'file_encoding',
          'File download must return unencoded original bytes.',
        );
      const length = response.headers['content-length'];
      const expected = length === undefined ? undefined : Number(length);
      if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(expected)))
        throw new AdapterError('file_download', 'Invalid file download length.');
      if (expected !== undefined && expected > limit)
        throw new AdapterError('input_limit', 'Imported files exceed 32 MiB.');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response) {
        signal.throwIfAborted();
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > limit) throw new AdapterError('input_limit', 'Imported files exceed 32 MiB.');
        chunks.push(bytes);
      }
      if (response.complete === false || (expected !== undefined && size !== expected))
        throw new AdapterError(
          'file_download',
          'File download ended before the complete file was received.',
        );
      return Buffer.concat(chunks, size);
    }
  } catch (error) {
    if (caller.aborted)
      throw new AdapterError(
        'file_aborted',
        'File download was cancelled before native execution.',
      );
    if (deadline.aborted)
      throw new AdapterError('file_timeout', 'File download exceeded its 30 second deadline.');
    if (error instanceof AdapterError) throw error;
    throw new AdapterError(
      'file_download',
      'File download failed before native execution; obtain a fresh file reference.',
    );
  } finally {
    response?.destroy();
  }
}
