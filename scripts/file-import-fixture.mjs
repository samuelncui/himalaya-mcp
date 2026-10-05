/** Test-only HTTPS transport for packed CLI checks. Never included in the npm package. */
import dns from 'node:dns/promises';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const hostname = 'packed-file-fixture.example.invalid';
const lookup = dns.lookup;
const request = https.request;
dns.lookup = (host, ...args) =>
  host === hostname ? Promise.resolve([{ address: '8.8.8.8', family: 4 }]) : lookup(host, ...args);
https.request = (url, options, callback) => {
  if (url.hostname !== hostname) return request(url, options, callback);
  const req = new EventEmitter();
  req.end = () => {
    void (async () => {
      const inputs = JSON.parse(await readFile(process.env.HIMALAYA_MCP_TEST_INPUTS, 'utf8'));
      const bytes = Buffer.from(inputs[url.pathname], 'base64');
      const incoming = Object.assign(Readable.from([bytes]), {
        statusCode: 200,
        headers: { 'content-length': String(bytes.length) },
        complete: true,
      });
      callback(incoming);
    })().catch((error) => req.emit('error', error));
  };
  return req;
};
