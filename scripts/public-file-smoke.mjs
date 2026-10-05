#!/usr/bin/env node
/** Opt-in public HTTPS import check against a published package; preview only, no mail delivery. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { runNpm } from './release.mjs';

const FILE_URL =
  'https://raw.githubusercontent.com/pimalaya/himalaya/5b12b2a8c2c253b98f15c46610ad74cba2a182bc/screenshot.jpeg';
const FILE_SHA256 = 'a69cc670381e3b7d2626074c24557d627750aa2441a6d2a09128cc49a81fbaf5';

async function main() {
  const [option, version, ...extra] = process.argv.slice(2);
  assert(
    option === '--version' &&
      /^\d+\.\d+\.\d+-adapter\.\d+\.\d+\.\d+$/.test(version ?? '') &&
      !extra.length,
    'Usage: node scripts/public-file-smoke.mjs --version PUBLISHED_VERSION',
  );
  const directory = await mkdtemp(join(tmpdir(), 'himalaya-mcp-public-file-'));
  let client;
  try {
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'public-file-fixture', version: '0.0.0', private: true }),
    );
    await runNpm(
      [
        'install',
        '--ignore-scripts',
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        '--save=false',
        '--registry=https://registry.npmjs.org',
        'himalaya-mcp@' + version,
      ],
      { cwd: directory },
    );
    const installed = join(directory, 'node_modules', 'himalaya-mcp');
    const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    assert.equal(manifest.version, version);
    assert.deepEqual(manifest.dependencies ?? {}, {});
    const root = join(directory, 'maildir');
    for (const part of ['new', 'cur', 'tmp'])
      await mkdir(join(root, 'INBOX', part), { recursive: true });
    const config = join(directory, 'synthetic.toml');
    await writeFile(
      config,
      `[accounts.fixture]\ndefault = true\nemail = "sender@example.invalid"\nmaildir.root = ${JSON.stringify(root)}\n`,
      { mode: 0o600 },
    );
    const calls = join(directory, 'calls');
    const operations = join(directory, 'operations');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        join(installed, 'dist', 'cli.js'),
        'serve',
        '--config',
        config,
        '--workspace-dir',
        calls,
        '--operation-dir',
        operations,
        '--cache-dir',
        join(directory, 'cache'),
      ],
      cwd: directory,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key, value]) =>
            typeof value === 'string' &&
            !['himalaya_config', 'http_proxy', 'https_proxy', 'all_proxy', 'node_options'].includes(
              key.toLowerCase(),
            ),
        ),
      ),
      stderr: 'pipe',
    });
    client = new Client({ name: 'public-file-preview-check', version: '1' });
    await client.connect(transport, { timeout: 90_000 });
    assert(client.getInstructions()?.includes('Sent verification:'));
    const tools = (await client.listTools()).tools;
    const compose = tools.find((tool) => tool.name === 'himalaya_message_compose');
    assert(compose?._meta?.['openai/fileParams'].includes('attach'));
    const result = await client.callTool({
      name: compose.name,
      arguments: {
        request_id: 'public-file-preview-check',
        params: {
          account_name: 'fixture',
          to: ['target@example.invalid'],
          subject: 'Synthetic HTTPS file preview',
          body: 'Preview only; no SMTP backend is configured.',
        },
        attach: [
          {
            download_url: FILE_URL,
            file_id: 'public-test-screenshot',
            file_name: 'screenshot.jpeg',
            mime_type: 'image/jpeg',
          },
        ],
      },
    });
    assert.equal(result.isError, false);
    let receipt = result.structuredContent;
    const id = receipt?.operation?.id;
    assert.match(id, /^[a-f0-9]{64}$/);
    const deadline = Date.now() + 40_000;
    while (['accepted', 'executing'].includes(receipt.operation.state) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      receipt = (
        await client.callTool({ name: 'himalaya_mcp_operation_status', arguments: { id } })
      ).structuredContent;
    }
    assert.equal(receipt.operation.state, 'succeeded', JSON.stringify(receipt.operation));
    assert.equal(receipt.result?.exitCode, 0);
    const raw = receipt.result.stdout;
    const boundary = /boundary="?([^";\r\n]+)/i.exec(raw)?.[1];
    assert(boundary, 'Original Himalaya must emit multipart MIME');
    const attachment = raw
      .split('--' + boundary)
      .find((part) => /filename="?screenshot\.jpeg/i.test(part));
    assert(attachment, 'Original filename must be retained');
    const separator = /\r?\n\r?\n/.exec(attachment);
    assert(separator);
    const headers = attachment.slice(0, separator.index);
    assert.match(headers, /Content-Type:\s*image\/jpeg/i);
    assert.match(headers, /Content-Transfer-Encoding:\s*base64/i);
    const bytes = Buffer.from(
      attachment.slice(separator.index + separator[0].length).replace(/\s/g, ''),
      'base64',
    );
    assert.equal(createHash('sha256').update(bytes).digest('hex'), FILE_SHA256);
    assert.deepEqual(await readdir(calls), [], 'Input workspace must be removed after preview');
    const stored = await readFile(join(operations, id + '.json'), 'utf8');
    assert(!stored.includes(FILE_URL), 'Receipt storage must not retain the input URL');
    assert(
      !stored.includes('Synthetic HTTPS file preview'),
      'Receipt storage must not retain message text',
    );
    console.log(
      JSON.stringify({
        package: version,
        realHttps: true,
        originalBinary: true,
        attachmentSha256: FILE_SHA256,
        workspaceClean: true,
        delivered: false,
      }),
    );
  } finally {
    try {
      await client?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

await main();
