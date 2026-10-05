import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { matchesCommand } from './catalog.js';
import { AdapterError, type CliCommand, type Policy } from './types.js';

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function scalar(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

export async function loadPolicy(path?: string): Promise<Policy> {
  if (!path) return { schemaVersion: 1, deny: [] };
  const source = await readFile(path, 'utf8').catch(() => {
    throw new AdapterError(
      'policy_read',
      'Cannot read the configured user policy.',
      'Check --policy and its file permissions.',
    );
  });
  if (source.length > 1024 * 1024)
    throw new AdapterError('policy_invalid', 'Policy exceeds 1 MiB.');
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length || document.warnings.length)
    throw new AdapterError(
      'policy_invalid',
      'Policy must be plain YAML without duplicate keys or custom tags.',
    );
  let parsed: unknown;
  try {
    parsed = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new AdapterError('policy_invalid', 'Policy must not contain YAML aliases.');
  }
  if (
    !object(parsed) ||
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.deny) ||
    Object.keys(parsed).some((key) => !['schemaVersion', 'deny'].includes(key))
  )
    throw new AdapterError('policy_invalid', 'Policy requires schemaVersion: 1 and deny: [].');
  for (const rule of parsed.deny) {
    if (
      !object(rule) ||
      typeof rule.command !== 'string' ||
      typeof rule.reason !== 'string' ||
      !rule.reason.trim() ||
      Object.keys(rule).some((key) => !['command', 'reason', 'when'].includes(key))
    )
      throw new AdapterError(
        'policy_invalid',
        'Each deny rule requires command and a non-empty reason.',
      );
    if (rule.when !== undefined) {
      if (
        !object(rule.when) ||
        Object.values(rule.when).some(
          (value) => !(scalar(value) || (Array.isArray(value) && value.every(scalar))),
        )
      )
        throw new AdapterError(
          'policy_invalid',
          'when values must be finite scalars or scalar arrays.',
        );
    }
  }
  return parsed as unknown as Policy;
}

export function enforcePolicy(
  policy: Policy,
  command: CliCommand,
  params: Record<string, unknown>,
): void {
  for (const rule of policy.deny) {
    if (!matchesCommand(rule.command, command.path)) continue;
    let matches = true;
    for (const [id, expected] of Object.entries(rule.when ?? {})) {
      const arg = command.args.find((arg) => arg.id === id);
      if (!arg)
        throw new AdapterError(
          'policy_unresolved',
          `Policy references unknown parameter ${id} for ${command.path.join(' ')}.`,
        );
      if (!Object.hasOwn(params, id)) {
        throw new AdapterError(
          'policy_unresolved',
          `Policy depends on omitted ${id}; native defaults or environment may affect it.`,
          'Supply the parameter explicitly or use a command-level rule.',
        );
      }
      if (
        !['SetTrue', 'SetFalse', 'Count'].includes(arg.action) &&
        arg.valueType !== 'integer' &&
        arg.valueType !== 'boolean'
      ) {
        throw new AdapterError(
          'policy_unresolved',
          `Policy depends on native parser normalization of ${id}.`,
          'Use a command-level rule; do not assume an opaque native value is already normalized.',
        );
      }
      const supplied = params[id];
      if (
        (arg.action === 'SetTrue' && supplied === false) ||
        (arg.action === 'SetFalse' && supplied === true) ||
        (arg.action === 'Count' && supplied === 0)
      ) {
        if (
          arg.env ||
          (arg.defaultValues.length &&
            arg.defaultValues.some((value) => value !== String(supplied)))
        )
          throw new AdapterError(
            'policy_unresolved',
            `Omitting the native flag ${id} does not force the requested value.`,
          );
      }
      const actual = Array.isArray(params[id]) ? (params[id] as unknown[]) : [params[id]];
      if (!actual.length || actual.some(Array.isArray))
        throw new AdapterError(
          'policy_unresolved',
          `Policy depends on empty or grouped values of ${id}.`,
          'Use a command-level rule; native omission and occurrence defaults cannot be inferred.',
        );
      const candidates = Array.isArray(expected) ? expected : [expected];
      const equal = (value: unknown, candidate: unknown) => {
        if (arg.valueType === 'integer' || arg.action === 'Count') {
          try {
            return BigInt(String(value)) === BigInt(String(candidate));
          } catch {
            throw new AdapterError(
              'policy_unresolved',
              `Policy value for ${id} is not a native integer.`,
            );
          }
        }
        return value === candidate;
      };
      if (!actual.some((value) => candidates.some((candidate) => equal(value, candidate))))
        matches = false;
    }
    if (matches)
      throw new AdapterError(
        'policy_denied',
        `Blocked by user policy: ${rule.reason}`,
        'Edit your policy personally or perform the operation with the native CLI.',
      );
  }
}
