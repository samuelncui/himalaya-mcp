import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTools, fileParameters, matchesCommand, serialize } from '../src/catalog.js';
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

test('ordinary positionals preserve option-like values after the delimiter', () => {
  const cmd = command([
    argument('account', {}),
    argument('mailbox', { long: null, index: 1 }),
    argument('target', { long: null, index: 2 }),
  ]);
  assert.deepEqual(
    serialize(cmd, { account: 'selected', mailbox: '-Projects', target: '--account=intruder' }),
    ['synthetic', '--account=selected', '--', '-Projects', '--account=intruder'],
  );
  const ids = command([
    argument('id', { long: null, index: 1, action: 'Append', maxValues: null }),
  ]);
  assert.deepEqual(serialize(ids, { id: ['-one', '--', '--account=intruder'] }), [
    'synthetic',
    '--',
    '-one',
    '--',
    '--account=intruder',
  ]);
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
  assert.throws(
    () => serialize(cmd, { mailbox: '--account=intruder', 'message-raw': ['body'] }),
    /does not permit values beginning with '-'/,
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

test('input-file fields and OpenAI metadata follow factual roles and native multiplicity', () => {
  const cmd = command([
    argument('attach', { action: 'Append', valueType: 'path' }),
    argument('body_file', { valueType: 'path' }),
    argument('output', { valueType: 'path' }),
    argument('unclassified', { valueType: 'path' }),
  ]);
  const io = {
    schemaVersion: 1 as const,
    rules: [
      {
        commands: ['**'],
        args: {
          attach: 'inputFile' as const,
          body_file: 'inputFile' as const,
          output: 'outputFile' as const,
        },
      },
    ],
  };
  const tool = buildTools(catalog([cmd]), io)[0]!;
  assert.deepEqual(tool._meta, { 'openai/fileParams': ['attach', 'body_file'] });
  const attach = tool.inputSchema.properties.attach as {
    type: string;
    items: {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
  };
  const body = tool.inputSchema.properties.body_file as {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: boolean;
  };
  assert.equal(attach.type, 'array');
  assert.equal(body.type, 'object');
  for (const shape of [attach.items, body]) {
    assert.deepEqual(Object.keys(shape.properties), [
      'download_url',
      'file_id',
      'mime_type',
      'file_name',
    ]);
    assert.deepEqual(shape.required, ['download_url', 'file_id']);
    assert.equal(shape.additionalProperties, false);
  }
  assert.equal(tool.inputSchema.properties.output, undefined);
  assert.equal(tool.inputSchema.properties.unclassified, undefined);
  assert.equal((tool.inputSchema as Record<string, unknown>).required, undefined);
  const native = tool.inputSchema.properties.params as {
    properties: Record<string, { type: string }>;
    additionalProperties: boolean;
  };
  assert.equal(native.properties.attach, undefined);
  assert.equal(native.properties.body_file, undefined);
  assert.equal(native.properties.output!.type, 'string');
  assert.equal(native.properties.unclassified!.type, 'string');
  assert.equal(native.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['attach', 'body_file', 'params']);
  assert.deepEqual(
    fileParameters(cmd, io).map(({ argument, multiple, nativeArray }) => ({
      id: argument.id,
      multiple,
      nativeArray,
    })),
    [
      { id: 'attach', multiple: true, nativeArray: true },
      { id: 'body_file', multiple: false, nativeArray: false },
    ],
  );
  assert.ok(tool.description.indexOf('File inputs:') < tool.description.indexOf(cmd.help));
  assert.ok(tool.description.includes('attach (file-object array)'));
});

test('a string-or-file variadic raw argument binds one top-level file object', () => {
  const cmd = command([
    argument('message-raw', {
      action: 'Append',
      long: null,
      index: 1,
      maxValues: null,
      last: true,
    }),
  ]);
  const io = {
    schemaVersion: 1 as const,
    rules: [{ commands: ['**'], args: { 'message-raw': 'inlineOrFile' as const } }],
  };
  const tool = buildTools(catalog([cmd]), io)[0]!;
  assert.equal((tool.inputSchema.properties['message-raw'] as { type: string }).type, 'object');
  assert.deepEqual(tool._meta, { 'openai/fileParams': ['message-raw'] });
  const native = tool.inputSchema.properties.params as { properties: Record<string, unknown> };
  assert.equal(native.properties['message-raw'], undefined);
  assert.ok(tool.description.includes('message-raw (file object)'));
  assert.deepEqual(
    fileParameters(cmd, io).map(({ multiple, nativeArray }) => ({ multiple, nativeArray })),
    [{ multiple: false, nativeArray: true }],
  );
});

test('commands without declared input files expose only params and no file metadata', () => {
  const tool = buildTools(
    catalog([command([argument('path', { valueType: 'path' })])]),
    profiles,
  )[0]!;
  assert.equal(tool._meta, undefined);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['params']);
  assert.ok(tool.description.includes('no generated input-file field'));
  assert.ok(tool.description.includes("server's common instructions"));
  assert.ok(tool.description.includes('local-file and pipe examples are not MCP input channels'));
  assert.ok(!tool.description.includes('file:<name>'));
  assert.ok(!tool.description.includes('re-upload'));
});

test('new commands and input file IDs inherit the same generic schema generation', () => {
  const cmd = command(
    [argument('future_document', { action: 'Append', valueType: 'path' })],
    ['future', 'command'],
  );
  const io = {
    schemaVersion: 1 as const,
    rules: [{ commands: ['future **'], args: { future_document: 'inputFile' as const } }],
  };
  const tool = buildTools(catalog([cmd]), io)[0]!;
  assert.equal(tool.name, 'himalaya_future_command');
  assert.deepEqual(tool._meta, { 'openai/fileParams': ['future_document'] });
  assert.equal((tool.inputSchema.properties.future_document as { type: string }).type, 'array');
});

test('ambiguous file schema collisions and grouped occurrences fail explicitly', () => {
  const collision = {
    schemaVersion: 1 as const,
    rules: [{ commands: ['**'], args: { params: 'inputFile' as const } }],
  };
  assert.throws(
    () => buildTools(catalog([command([argument('params')])]), collision),
    /collides with another input/,
  );
  const io = {
    schemaVersion: 1 as const,
    rules: [{ commands: ['**'], args: { document: 'inputFile' as const } }],
  };
  assert.throws(
    () => buildTools(catalog([command([argument('document'), argument('document')])]), io),
    /collides with another input/,
  );
  assert.throws(
    () =>
      buildTools(
        catalog([
          command([argument('document', { action: 'Append', minValues: 2, maxValues: 2 })]),
        ]),
        io,
      ),
    /unsupported grouped arrays/,
  );
});
