import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { enforcePolicy, loadPolicy } from '../src/policy.js';
import { argument, command } from './fixtures.js';

test('no policy does not load the project example or block sending', async () => {
  enforcePolicy(await loadPolicy(), command([], ['message', 'send']), {});
});

test('only the explicit user policy denies a canonical command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'himalaya-policy-'));
  try {
    const file = join(directory, 'policy.yaml');
    await writeFile(
      file,
      'schemaVersion: 1\ndeny:\n  - command: imap expunge\n    reason: Personal decision\n',
    );
    const policy = await loadPolicy(file);
    assert.throws(
      () => enforcePolicy(policy, command([], ['imap', 'expunge']), {}),
      /Personal decision/,
    );
    enforcePolicy(policy, command([], ['message', 'send']), {});
    await writeFile(file, 'schemaVersion: 1\ndeny: []\n');
    enforcePolicy(await loadPolicy(file), command([], ['imap', 'expunge']), {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('integer conditions cannot bypass policy with leading zeros or large IDs', () => {
  const cmd = command([argument('id', { valueType: 'integer' })]);
  assert.throws(
    () =>
      enforcePolicy(
        {
          schemaVersion: 1,
          deny: [{ command: 'synthetic', reason: 'blocked', when: { id: '9007199254740993' } }],
        },
        cmd,
        { id: '09007199254740993' },
      ),
    /blocked/,
  );
});

test('unknown, omitted, opaque, and environment-dependent values are not invented', () => {
  const deny = {
    schemaVersion: 1 as const,
    deny: [{ command: 'synthetic', reason: 'blocked', when: { value: true } }],
  };
  assert.throws(() => enforcePolicy(deny, command([]), { value: true }), /unknown parameter/);
  assert.throws(() => enforcePolicy(deny, command([argument('value')]), {}), /omitted/);
  assert.throws(
    () => enforcePolicy(deny, command([argument('value')]), { value: 'true' }),
    /normalization/,
  );
  assert.throws(
    () =>
      enforcePolicy(
        deny,
        command([argument('value', { action: 'SetTrue', env: 'UNTRUSTED_DEFAULT' })]),
        { value: false },
      ),
    /does not force/,
  );
});

test('conditional policy cannot infer defaults from empty or grouped native values', () => {
  const deny = {
    schemaVersion: 1 as const,
    deny: [{ command: 'synthetic', reason: 'blocked', when: { ids: 7 } }],
  };
  const cmd = command([
    argument('ids', { action: 'Append', valueType: 'integer', defaultValues: ['7'] }),
  ]);
  for (const ids of [[], [[]], [[7]]])
    assert.throws(() => enforcePolicy(deny, cmd, { ids }), /empty or grouped values/);
});

test('YAML custom tags, aliases, duplicate keys, and accidental schema changes fail', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'himalaya-policy-'));
  try {
    const file = join(directory, 'policy.yaml');
    for (const source of [
      'schemaVersion: 1\ndeny: []\ndeny: []',
      'schemaVersion: 1\ndeny: !run []',
      'schemaVersion: 1\ndeny: []\nallowShell: true',
    ]) {
      await writeFile(file, source);
      await assert.rejects(loadPolicy(file));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
