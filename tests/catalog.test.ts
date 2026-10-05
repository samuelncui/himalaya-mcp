import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTools, matchesCommand, serialize } from '../src/catalog.js';
import { argument, catalog, command, profiles } from './fixtures.js';

test('fixed command path, repeated values, equals binding, and no shell interpolation', () => {
  const cmd = command(
    [
      argument('header', { action: 'Append' }),
      argument('attach', { action: 'Append' }),
      argument('send', { action: 'SetTrue', minValues: 0, maxValues: 0 }),
    ],
    ['message', 'compose'],
  );
  assert.deepEqual(
    serialize(cmd, {
      header: ['Subject: $(not-a-shell)', 'X-Label: `literal`'],
      attach: ['a b.pdf', '-flag-like.txt'],
      send: true,
    }),
    [
      'message',
      'compose',
      '--header=Subject: $(not-a-shell)',
      '--header=X-Label: `literal`',
      '--attach=a b.pdf',
      '--attach=-flag-like.txt',
      '--send',
    ],
  );
  assert.throws(() => serialize(cmd, { argv: ['delete'] }), /Unknown parameter/);
});

test('ordinary positionals precede greedy options when last/raw owns --', () => {
  const cmd = command(
    [
      argument('mailbox', { long: null, index: 1 }),
      argument('flag', { action: 'Append', minValues: 0, maxValues: null }),
      argument('message-raw', {
        long: null,
        index: 2,
        action: 'Append',
        last: true,
        allowHyphenValues: true,
        maxValues: null,
      }),
    ],
    ['imap', 'append'],
  );
  assert.deepEqual(
    serialize(cmd, {
      mailbox: 'Drafts',
      flag: [['Seen']],
      'message-raw': ['Subject: test\n\nbody'],
    }),
    ['imap', 'append', 'Drafts', '--flag=Seen', '--', 'Subject: test\n\nbody'],
  );
  const schema = buildTools(catalog([cmd]), profiles)[0]!.inputSchema.properties.params as {
    properties: Record<string, { items?: { type?: string } }>;
  };
  assert.equal(schema.properties['message-raw']!.items?.type, 'string');
  assert.equal(schema.properties.flag!.items?.type, 'array');
});

test('delimiter separates a variadic option from positional arguments and trailing queries', () => {
  const cmd = command(
    [
      argument('flag', { action: 'Append', maxValues: null }),
      argument('sequence', { long: null, index: 1 }),
    ],
    ['imap', 'store'],
  );
  assert.deepEqual(serialize(cmd, { flag: [['Seen', 'Flagged']], sequence: '1:3' }), [
    'imap',
    'store',
    '--flag',
    'Seen',
    'Flagged',
    '--',
    '1:3',
  ]);
  const search = command([
    argument('query', {
      index: 1,
      long: null,
      action: 'Append',
      trailing: true,
      allowHyphenValues: true,
      minValues: 0,
      maxValues: null,
    }),
  ]);
  assert.deepEqual(serialize(search, { query: ['subject', '--literal-query'] }), [
    'synthetic',
    '--',
    'subject',
    '--literal-query',
  ]);
});

test('integer strings avoid loss of IDs beyond Number.MAX_SAFE_INTEGER', () => {
  const cmd = command([argument('id', { valueType: 'integer' })]);
  assert.deepEqual(serialize(cmd, { id: '18446744073709551615' }), [
    'synthetic',
    '--id=18446744073709551615',
  ]);
  assert.throws(() => serialize(cmd, { id: 18446744073709551615 }), /safe integer/);
});

test('unknown effects stay registered with conservative annotations and no hard required', () => {
  const cmd = command([argument('value', { required: true })], ['new-command']);
  const tool = buildTools(catalog([cmd]), profiles)[0]!;
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.destructiveHint, true);
  assert.equal((tool.inputSchema.properties.params as Record<string, unknown>).required, undefined);
  assert.ok(tool.description.includes(cmd.help));
});

test('static read-only annotations include optional native file writes', () => {
  const cmd = command([argument('log-file', { valueType: 'path' })], ['account', 'list']);
  const tool = buildTools(catalog([cmd]), {
    schemaVersion: 1,
    rules: [
      {
        commands: ['account list'],
        readOnly: true,
        idempotent: true,
        destructive: false,
        args: { 'log-file': 'outputFile' },
      },
    ],
  })[0]!;
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.idempotentHint, false);
  assert.equal(tool.annotations.destructiveHint, false);
});

test('glob rules cannot interpret regex or skip path segments accidentally', () => {
  assert.equal(matchesCommand('imap **', ['imap', 'append']), true);
  assert.equal(matchesCommand('imap *', ['imap', 'nested', 'delete']), false);
  assert.equal(matchesCommand('imap .*', ['imap', 'anything']), false);
});
