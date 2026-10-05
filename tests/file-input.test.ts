import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import https, { type RequestOptions } from 'node:https';
import { PassThrough, Readable } from 'node:stream';
import test, { type TestContext } from 'node:test';
import {
  downloadFile,
  downloadUrl,
  isPublicAddress,
  validateFileReference,
} from '../src/file-input.js';
import { AdapterError, type OpenAIFile } from '../src/types.js';

const file: OpenAIFile = {
  download_url: 'https://files.example.invalid/photo?synthetic-secret=redact',
  file_id: 'synthetic-file',
  file_name: 'photo.jpeg',
};

function response(bytes: Buffer, statusCode = 200, headers = {}): IncomingMessage {
  return Object.assign(Readable.from([bytes]), {
    statusCode,
    headers,
    complete: true,
  }) as IncomingMessage;
}

/** Replace only network I/O; exercise the real URL, DNS, pinning and body checks. */
function network(t: TestContext, responses: IncomingMessage[]) {
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  const requests: { url: URL; options: RequestOptions & { autoSelectFamily?: boolean } }[] = [];
  const mockRequest = (
    url: URL,
    options: RequestOptions,
    callback: (value: IncomingMessage) => void,
  ) => {
    requests.push({ url, options });
    const result = responses.shift();
    assert.ok(result, 'Unexpected network request');
    const req = new EventEmitter();
    const abort = () => {
      const error = new Error('synthetic network abort');
      result.destroy(error);
      req.emit('error', error);
    };
    result.once('close', () => options.signal?.removeEventListener('abort', abort));
    Object.assign(req, {
      end: () =>
        queueMicrotask(() => {
          options.signal?.addEventListener('abort', abort, { once: true });
          callback(result);
        }),
    });
    return req as ClientRequest;
  };
  t.mock.method(https, 'request', mockRequest as unknown as typeof https.request);
  return requests;
}

test('file URLs reject private/special destinations and redact capabilities', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])
    assert.equal(isPublicAddress(address), true, address);
  for (const address of [
    'not an address',
    '0.0.0.0',
    '10.1.2.3',
    '100.64.1.2',
    '127.0.0.1',
    '169.254.169.254',
    '172.31.0.1',
    '192.168.1.1',
    '192.0.2.1',
    '198.18.0.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:8.8.8.8',
    '::ffff:127.0.0.1',
    '64:ff9b::808:808',
    '2001:db8::1',
    '2002:808:808::1',
  ])
    assert.equal(isPublicAddress(address), false, address);
  for (const url of [
    'not-a-url?synthetic-secret',
    'http://example.com/?synthetic-secret',
    'https://user:synthetic-secret@example.com/',
    'https://example.com:444/?synthetic-secret',
    'https://example.com/#synthetic-secret',
    'https://127.1/?synthetic-secret',
    'https://2130706433/?synthetic-secret',
    'https://[::1]/?synthetic-secret',
  ])
    assert.throws(
      () => downloadUrl(url),
      (error: unknown) => {
        assert.ok(error instanceof AdapterError);
        assert.doesNotMatch(error.message, /synthetic-secret/);
        return true;
      },
    );
  assert.equal(downloadUrl(file.download_url).hostname, 'files.example.invalid');
});

test('file references preserve safe names and reject IDs/paths instead of bytes', () => {
  assert.equal(validateFileReference(file).name, 'photo.jpeg');
  assert.equal(
    validateFileReference({ download_url: file.download_url, file_id: 'opaque-id' }).name,
    'opaque-id',
  );
  assert.equal(
    validateFileReference({ ...file, file_name: '原图 $(literal).jpeg' }).name,
    '原图 $(literal).jpeg',
  );
  for (const raw of [
    'file-id',
    '/mnt/data/photo.jpeg',
    null,
    [],
    {},
    { file_id: 'x' },
    { ...file, file_name: '../escape' },
    { ...file, file_name: 'dir\\escape' },
    { ...file, file_name: 'bad\nname' },
    { ...file, file_name: '' },
    { ...file, mime_type: 1 },
    { ...file, unrelated: 'value' },
  ])
    assert.throws(() => validateFileReference(raw), AdapterError);
});

test('downloads pin verified DNS while retaining the original TLS host and binary bytes', async (t) => {
  const bytes = Buffer.from([0, 255, 13, 10, 128, 42]);
  const requests = network(t, [response(bytes, 200, { 'content-length': String(bytes.length) })]);
  assert.deepEqual(await downloadFile(file, 100, new AbortController().signal), bytes);
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.url.href, file.download_url);
  assert.equal(request.options.rejectUnauthorized, true);
  assert.equal(request.options.agent, false);
  assert.equal(request.options.autoSelectFamily, false);
  assert.deepEqual(request.options.headers, { 'Accept-Encoding': 'identity' });
  let pinned: unknown[] = [];
  request.options.lookup!('files.example.invalid', {}, (...args: unknown[]) => {
    pinned = args;
  });
  assert.deepEqual(pinned, [null, '8.8.8.8', 4]);
});

test('every redirect revalidates DNS and preserves relative HTTPS targets', async (t) => {
  const requests = network(t, [
    response(Buffer.alloc(0), 302, { location: '/original' }),
    response(Buffer.from('original')),
  ]);
  const lookup = t.mock.method(dns, 'lookup', async () => [{ address: '1.1.1.1', family: 4 }]);
  assert.equal(
    (await downloadFile(file, 100, new AbortController().signal)).toString(),
    'original',
  );
  assert.equal(requests[1]!.url.href, 'https://files.example.invalid/original');
  assert.equal(lookup.mock.callCount(), 2);
});

test('private redirects and mixed DNS answers never start an unsafe request', async (t) => {
  const requests = network(t, [
    response(Buffer.alloc(0), 307, { location: 'https://127.0.0.1/private' }),
  ]);
  await assert.rejects(downloadFile(file, 100, new AbortController().signal), {
    code: 'file_destination',
  });
  assert.equal(requests.length, 1);
  t.mock.method(dns, 'lookup', async () => [
    { address: '8.8.8.8', family: 4 },
    { address: '192.168.1.1', family: 4 },
  ]);
  await assert.rejects(downloadFile(file, 100, new AbortController().signal), {
    code: 'file_destination',
  });
  assert.equal(requests.length, 1);
});

test('redirect loops stop after three redirects', async (t) => {
  const requests = network(
    t,
    Array.from({ length: 4 }, () => response(Buffer.alloc(0), 302, { location: '/again' })),
  );
  await assert.rejects(downloadFile(file, 100, new AbortController().signal), {
    code: 'file_redirect',
  });
  assert.equal(requests.length, 4);
});

test('partial, encoded, oversized and incomplete responses fail without truncation', async (t) => {
  for (const [label, incoming, limit, code] of [
    ['partial status', response(Buffer.from('x'), 206), 100, 'file_download'],
    ['expired link', response(Buffer.from('private error page'), 403), 100, 'file_download'],
    [
      'encoding',
      response(Buffer.from('x'), 200, { 'content-encoding': 'gzip' }),
      100,
      'file_encoding',
    ],
    [
      'declared oversize',
      response(Buffer.from('x'), 200, { 'content-length': '101' }),
      100,
      'input_limit',
    ],
    ['streamed oversize', response(Buffer.alloc(101)), 100, 'input_limit'],
    [
      'length mismatch',
      response(Buffer.from('x'), 200, { 'content-length': '3' }),
      100,
      'file_download',
    ],
    [
      'invalid length',
      response(Buffer.from('x'), 200, { 'content-length': 'bad' }),
      100,
      'file_download',
    ],
    [
      'incomplete body',
      Object.assign(response(Buffer.from('x')), { complete: false }),
      100,
      'file_download',
    ],
  ] as const)
    await t.test(label, async (sub) => {
      network(sub, [incoming]);
      await assert.rejects(
        downloadFile(file, limit, new AbortController().signal),
        (error: unknown) => {
          assert.ok(error instanceof AdapterError);
          assert.equal(error.code, code);
          assert.doesNotMatch(error.message, /synthetic-secret|private error page/);
          return true;
        },
      );
    });
});

test('cancellation stops DNS waiting and a late lookup cannot start HTTPS', async (t) => {
  const requests = network(t, []);
  let finish!: (value: { address: string; family: number }[]) => void;
  t.mock.method(
    dns,
    'lookup',
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  const pending = downloadFile(file, 100, controller.signal);
  controller.abort();
  await assert.rejects(pending, { code: 'file_aborted' });
  finish([{ address: '8.8.8.8', family: 4 }]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 0);
});

test('cancellation interrupts a stalled body and remote exceptions remain private', async (t) => {
  const incoming = Object.assign(new PassThrough(), {
    statusCode: 200,
    headers: {},
    complete: false,
  }) as unknown as IncomingMessage;
  network(t, [incoming]);
  const controller = new AbortController();
  const pending = downloadFile(file, 100, controller.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { code: 'file_aborted' });
  assert.equal(incoming.destroyed, true);
  t.mock.method(dns, 'lookup', async () => {
    throw new Error(file.download_url);
  });
  await assert.rejects(downloadFile(file, 100, new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof AdapterError);
    assert.equal(error.code, 'file_download');
    assert.doesNotMatch(error.message, /synthetic-secret|files.example/);
    return true;
  });
});
