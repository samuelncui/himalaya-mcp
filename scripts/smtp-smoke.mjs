/** Real original-binary email verification, exclusively against a loopback sink. */
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

function smtpSink() {
  const messages = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    let pending = '',
      payload = [],
      receiving = false;
    let transaction = { from: '', recipients: [] };
    socket.write('220 localhost synthetic SMTP sink\r\n');
    socket.on('data', (bytes) => {
      pending += bytes.toString('latin1');
      if (pending.length > 8 * 1024 * 1024) {
        socket.destroy();
        return;
      }
      for (;;) {
        const end = pending.indexOf('\r\n');
        if (end < 0) return;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (receiving) {
          if (line !== '.') {
            payload.push(line.startsWith('..') ? line.slice(1) : line);
            continue;
          }
          messages.push({
            ...transaction,
            data: Buffer.from(payload.join('\r\n') + '\r\n', 'latin1'),
          });
          payload = [];
          receiving = false;
          socket.write('250 synthetic message captured locally\r\n');
        } else if (/^(EHLO|HELO) /i.test(line)) socket.write('250-localhost\r\n250 8BITMIME\r\n');
        else if (/^MAIL FROM:/i.test(line)) {
          transaction = { from: line, recipients: [] };
          socket.write('250 OK\r\n');
        } else if (/^RCPT TO:/i.test(line)) {
          transaction.recipients.push(line);
          socket.write('250 OK\r\n');
        } else if (/^DATA$/i.test(line)) {
          receiving = true;
          socket.write('354 send synthetic data\r\n');
        } else if (/^QUIT$/i.test(line)) socket.end('221 goodbye\r\n');
        else if (/^(RSET|NOOP)$/i.test(line)) socket.write('250 OK\r\n');
        else socket.write('502 command not implemented by the test sink\r\n');
      }
    });
  });
  return { server, sockets, messages };
}

export async function smtpSmoke({ cli, catalog, environment = process.env, cacheDir }) {
  const directory = await mkdtemp(join(tmpdir(), 'himalaya-mcp-smtp-'));
  const { server, sockets, messages } = smtpSink();
  let transport, client;
  try {
    await new Promise((accept, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', accept);
    });
    const config = join(directory, 'synthetic$HIMALAYA_MCP_FIXTURE_UNSET.toml');
    await writeFile(
      config,
      `[accounts.fixture]\ndefault = true\nemail = "sender@example.invalid"\nsmtp.server = "smtp://127.0.0.1:${server.address().port}"\nsmtp.starttls = false\nmessage.send.backend = "smtp"\n`,
      { mode: 0o600 },
    );
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        cli,
        '--config',
        config,
        '--workspace-dir',
        join(directory, 'calls'),
        '--cache-dir',
        cacheDir ?? environment.HIMALAYA_MCP_SMOKE_CACHE ?? join(directory, 'cache'),
      ],
      env: Object.fromEntries(
        Object.entries(environment).filter(
          ([key, value]) =>
            typeof value === 'string' &&
            !['all_proxy', 'https_proxy', 'http_proxy', 'himalaya_config'].includes(
              key.toLowerCase(),
            ),
        ),
      ),
      stderr: 'pipe',
    });
    let logs = '';
    transport.stderr?.on('data', (bytes) => {
      logs += bytes.toString();
    });
    client = new Client({ name: 'himalaya-mcp-synthetic-mail-check', version: '1.0.0' });
    await client.connect(transport);
    const call = async (path, args) => {
      const command = catalog.commands.find(
        (command) => command.runnable && command.path.join(' ') === path,
      );
      assert(command, `Missing registered email command: ${path}`);
      const result = await client.callTool({
        name: ['himalaya', ...command.path].join('_'),
        arguments: args,
      });
      assert.equal(
        result.isError,
        false,
        `${path} failed: ${JSON.stringify(result.content)} ${logs}`,
      );
      const output = result.structuredContent ?? JSON.parse(result.content[0].text);
      assert.equal(output.exitCode, 0, `Native ${path} status`);
      return output;
    };
    const attachment = Buffer.from([0, 255, 254, 65, 10, 42]);
    const encoded = attachment.toString('base64');
    const raw = [
      'From: sender@example.invalid',
      'To: visible@example.invalid',
      'Cc: copy@example.invalid',
      'Bcc: hidden@example.invalid',
      'Subject: Synthetic nested MIME',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="mixed"',
      '',
      '--mixed',
      'Content-Type: multipart/related; boundary="related"',
      '',
      '--related',
      'Content-Type: multipart/alternative; boundary="alternative"',
      '',
      '--alternative',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Synthetic plain body',
      '--alternative',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Synthetic HTML</p><img src="cid:synthetic-image">',
      '--alternative--',
      '--related',
      'Content-Type: image/png',
      'Content-ID: <synthetic-image>',
      'Content-Transfer-Encoding: base64',
      '',
      encoded,
      '--related--',
      '--mixed',
      'Content-Type: application/octet-stream',
      'Content-Disposition: attachment; filename="synthetic.bin"',
      'Content-Transfer-Encoding: base64',
      '',
      encoded,
      '--mixed--',
      '',
    ].join('\r\n');
    await call('smtp send', {
      params: {
        account_name: 'fixture',
        mail_from: 'sender@example.invalid',
        rcpt_to: ['visible@example.invalid', 'hidden@example.invalid'],
      },
      stdin: raw,
    });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].recipients.length, 2);
    for (const part of [
      'multipart/mixed',
      'multipart/alternative',
      'multipart/related',
      '<synthetic-image>',
      encoded,
    ])
      assert(messages[0].data.toString().includes(part), `MIME content lost: ${part}`);
    assert(
      messages[0].data.toString().includes('Bcc: hidden@example.invalid'),
      'Explicit smtp send must retain native keep_bcc semantics',
    );
    const uploadedName = 'synthetic${HIMALAYA_MCP_FIXTURE_UNSET}.eml';
    await call('message send', {
      params: { account_name: 'fixture', no_save: true, 'message-raw': ['file:' + uploadedName] },
      files: [{ name: uploadedName, base64: Buffer.from(raw).toString('base64') }],
    });
    assert.equal(messages.length, 2);
    assert.equal(messages[1].recipients.length, 3);
    assert(
      !/^Bcc:/im.test(messages[1].data.toString()),
      'Native shared send must strip Bcc after deriving the envelope',
    );
    await call('message compose', {
      params: {
        account_name: 'fixture',
        to: ['visible@example.invalid'],
        cc: ['copy@example.invalid'],
        bcc: ['hidden@example.invalid'],
        subject: 'Synthetic attachment',
        body: 'Synthetic body',
        attach: ['file:synthetic$HIMALAYA_MCP_FIXTURE_UNSET.bin'],
        no_save: true,
        send: true,
      },
      files: [{ name: 'synthetic$HIMALAYA_MCP_FIXTURE_UNSET.bin', base64: encoded }],
    });
    assert.equal(messages.length, 3);
    assert.equal(messages[2].recipients.length, 3);
    assert(
      messages[2].data.toString().includes(encoded),
      'Native composed attachment bytes missing',
    );
    assert(
      !/^Bcc:/im.test(messages[2].data.toString()),
      'Native composed Bcc must stay envelope-only',
    );
    await call('smtp send', {
      params: {
        account_name: 'fixture',
        mail_from: 'sender@example.invalid',
        rcpt_to: ['visible@example.invalid'],
        'message-raw': [
          'From: sender@example.invalid\r\nTo: visible@example.invalid\r\nSubject: Synthetic inline input\r\n\r\nLiteral ${HIMALAYA_MCP_FIXTURE_UNSET:-text} and $$ text\r\n',
        ],
      },
    });
    assert.equal(messages.length, 4);
    assert(
      messages[3].data
        .toString()
        .includes('Literal ${HIMALAYA_MCP_FIXTURE_UNSET:-text} and $$ text'),
    );
    const completion = await call('completion', {
      params: { shells: ['bash'], dir: 'generated$$literal', 'log-file': 'log$$literal.txt' },
    });
    assert(completion.files.some((file) => file.name.startsWith('generated$literal/')));
    assert(completion.files.some((file) => file.name === 'log$literal.txt'));
    console.error(
      'Verified original Himalaya via packed MCP: raw nested MIME, shared send/Bcc, composed binary attachment, and literal inline input; 4 deliveries captured only on loopback.',
    );
  } finally {
    await client?.close();
    await transport?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((accept) => server.close(accept));
    await rm(directory, { recursive: true, force: true });
  }
}
