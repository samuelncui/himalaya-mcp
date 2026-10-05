import { createHash } from 'node:crypto';
import {
  AdapterError,
  type Catalog,
  type CliArg,
  type CliCommand,
  type IoRole,
  type Profiles,
  type ToolDefinition,
} from './types.js';

export function matchesCommand(pattern: string, path: string[]): boolean {
  const parts = pattern.trim() ? pattern.trim().split(/\s+/) : [];
  const visit = (p: number, c: number): boolean => {
    if (p === parts.length) return c === path.length;
    if (parts[p] === '**') return visit(p + 1, c) || (c < path.length && visit(p, c + 1));
    return c < path.length && (parts[p] === '*' || parts[p] === path[c]) && visit(p + 1, c + 1);
  };
  return visit(0, 0);
}

export function commandProfile(command: CliCommand, profiles: Profiles): Profiles['rules'][number] {
  const result: Profiles['rules'][number] = { commands: [], args: {} };
  for (const rule of profiles.rules) {
    if (!rule.commands.some((pattern) => matchesCommand(pattern, command.path))) continue;
    Object.assign(result, rule, {
      args: { ...result.args, ...rule.args },
      pathExpansion: { ...result.pathExpansion, ...rule.pathExpansion },
    });
  }
  return result;
}

export function toolName(command: CliCommand): string {
  const raw = ['himalaya', ...command.path].join('_');
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  if (safe === raw && safe.length <= 120) return safe;
  return `${safe.slice(0, 110)}_${createHash('sha256').update(JSON.stringify(command.path)).digest('hex').slice(0, 12)}`;
}

function scalarSchema(arg: CliArg): Record<string, unknown> {
  if (arg.valueType === 'integer') {
    return { anyOf: [{ type: 'integer' }, { type: 'string', pattern: '^-?[0-9]+$' }] };
  }
  if (arg.valueType === 'number') return { type: 'number' };
  if (arg.valueType === 'boolean') return { type: 'boolean' };
  return { type: 'string', ...(arg.valueChoices.length ? { examples: arg.valueChoices } : {}) };
}

function argumentSchema(arg: CliArg, role?: IoRole): Record<string, unknown> {
  const description = [
    arg.help,
    arg.required ? 'Required by native syntax; conflicts and groups are checked by Himalaya.' : '',
    arg.defaultValues.length ? `Native default: ${arg.defaultValues.join(', ')}` : '',
    arg.valueChoices.length ? `Native choices: ${arg.valueChoices.join(', ')}` : '',
    role === 'config'
      ? 'Selected by --config at server startup; not accepted from tool calls.'
      : role === 'accountPath'
        ? 'Relative to the configured account root. Absolute paths and parent traversal are not accepted.'
        : arg.valueType === 'path'
          ? 'Call-scoped destination or native logical path only; native Help does not grant host filesystem access.'
          : '',
  ]
    .filter(Boolean)
    .join('\n');
  if (['SetTrue', 'SetFalse', 'Help', 'HelpShort', 'HelpLong', 'Version'].includes(arg.action)) {
    return { type: 'boolean', description };
  }
  if (arg.action === 'Count') return { type: 'integer', minimum: 0, maximum: 255, description };
  const item = scalarSchema(arg);
  if (arg.index !== null) {
    if (arg.maxValues !== 1 || arg.minValues === 0)
      return { ...valuesSchema(arg, item), description };
    return { ...item, description };
  }
  if (arg.action === 'Append') {
    if (arg.minValues === 1 && arg.maxValues === 1)
      return { type: 'array', items: item, description };
    return { type: 'array', items: valuesSchema(arg, item), description };
  }
  if (arg.maxValues !== 1 || arg.minValues === 0)
    return { ...valuesSchema(arg, item), description };
  return { ...item, description };
}

function valuesSchema(arg: CliArg, item: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'array',
    items: item,
    minItems: arg.minValues,
    ...(arg.maxValues === null ? {} : { maxItems: arg.maxValues }),
  };
}

export interface FileParameter {
  argument: CliArg;
  multiple: boolean;
  nativeArray: boolean;
}

/** Derive upload bindings from factual I/O roles, never from command or parameter names. */
export function fileParameters(command: CliCommand, profiles: Profiles): FileParameter[] {
  const profile = commandProfile(command, profiles);
  const fields: FileParameter[] = [];
  const seen = new Set<string>(['params']);
  for (const argument of command.args) {
    const role = profile.args?.[argument.id];
    if (role !== 'inputFile' && role !== 'inlineOrFile') continue;
    if (seen.has(argument.id))
      throw new AdapterError(
        'definition_file',
        `File field ${argument.id} collides with another input in ${command.path.join(' ')}.`,
        'Update the generator or factual profile; do not omit this command.',
      );
    seen.add(argument.id);
    const schema = argumentSchema(argument);
    const nativeArray = schema.type === 'array';
    if (nativeArray && (schema.items as Record<string, unknown>).type === 'array')
      throw new AdapterError(
        'definition_file',
        `File field ${argument.id} in ${command.path.join(' ')} has unsupported grouped arrays.`,
        'Extend the generic file binding before publishing this CLI definition.',
      );
    fields.push({ argument, nativeArray, multiple: role !== 'inlineOrFile' && nativeArray });
  }
  return fields;
}

function fileSchema(field: FileParameter): Record<string, unknown> {
  const item = {
    type: 'object',
    properties: {
      download_url: {
        type: 'string',
        description:
          'Temporary public HTTPS download URL supplied by the client; private network destinations are rejected.',
      },
      file_id: {
        type: 'string',
        description: 'Client file identifier; the server downloads through download_url.',
      },
      mime_type: { type: 'string', description: 'Optional client-declared MIME type.' },
      file_name: {
        type: 'string',
        description:
          'Original basename to preserve the filename and extension; otherwise file_id becomes the filename.',
      },
    },
    required: ['download_url', 'file_id'],
    additionalProperties: false,
  };
  const description = `Client file reference for native argument ${JSON.stringify(field.argument.id)}. Supply file_id and download_url together; the server imports the complete file and binds its native path automatically. This argument is not accepted under params.`;
  return field.multiple ? { type: 'array', items: item, description } : { ...item, description };
}

function fileInstructions(fields: FileParameter[]): string {
  const direct = fields.length
    ? `File inputs: ${fields.map(({ argument, multiple }) => `${argument.id} (${multiple ? 'file-object array' : 'file object'})`).join(', ')} are top-level fields, not params. Supply client file objects with file_id and download_url together; include file_name to preserve the original filename and extension. The server downloads and binds each complete file automatically.\n`
    : 'This command has no generated input-file field.\n';
  return `${direct}Use params for other structured native arguments. Follow the server's common instructions for file transfer, receipts and verification. Native Help below describes the CLI; its local-file and pipe examples are not MCP input channels.`;
}

export function buildTools(catalog: Catalog, profiles: Profiles): ToolDefinition[] {
  if (catalog.schemaVersion !== 1 || profiles.schemaVersion !== 1)
    throw new AdapterError('definition_version', 'Unsupported definition format.');
  const seen = new Set<string>();
  return catalog.commands
    .filter((command) => command.runnable)
    .map((command) => {
      const name = toolName(command);
      if (seen.has(name))
        throw new AdapterError('tool_collision', `Generated tool name collision: ${name}`);
      seen.add(name);
      const profile = commandProfile(command, profiles);
      const inputFiles = fileParameters(command, profiles);
      const fileIds = new Set(inputFiles.map(({ argument }) => argument.id));
      const properties = Object.fromEntries(
        command.args
          .filter((arg) => !fileIds.has(arg.id))
          .map((arg) => [arg.id, argumentSchema(arg, profile.args?.[arg.id])]),
      );
      const writesFiles = command.args.some((arg) =>
        ['outputFile', 'outputDirectory'].includes(profile.args?.[arg.id] ?? ''),
      );
      const readOnly = !writesFiles && (profile.readOnly ?? false);
      return {
        name,
        description: `${fileInstructions(inputFiles)}\n\n${command.help}`,
        ...(inputFiles.length
          ? { _meta: { 'openai/fileParams': inputFiles.map(({ argument }) => argument.id) } }
          : {}),
        inputSchema: {
          type: 'object',
          properties: {
            ...Object.fromEntries(
              inputFiles.map((field) => [field.argument.id, fileSchema(field)]),
            ),
            params: { type: 'object', properties, additionalProperties: false },
          },
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: profile.destructive ?? !readOnly,
          idempotentHint: !writesFiles && (profile.idempotent ?? false),
          openWorldHint: true,
        },
      };
    });
}

function scalar(arg: CliArg, value: unknown): string {
  if (arg.valueType === 'boolean') {
    if (typeof value !== 'boolean')
      throw new AdapterError('parameter_type', `${arg.id} must be a boolean.`);
    return String(value);
  }
  if (arg.valueType === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new AdapterError('parameter_type', `${arg.id} must be a finite number.`);
    return String(value);
  }
  if (arg.valueType === 'integer') {
    if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
    if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) return value;
    throw new AdapterError(
      'parameter_type',
      `${arg.id} must be a safe integer or a decimal string.`,
    );
  }
  if (typeof value !== 'string' || value.includes('\0'))
    throw new AdapterError('parameter_type', `${arg.id} must be a string without NUL bytes.`);
  if (arg.valueDelimiter && value.includes(arg.valueDelimiter)) {
    throw new AdapterError(
      'parameter_delimiter',
      `${arg.id} splits values on ${JSON.stringify(arg.valueDelimiter)}. Provide separate array values instead.`,
    );
  }
  return value;
}

function values(arg: CliArg, value: unknown): string[] {
  if (arg.minValues === 1 && arg.maxValues === 1) return [scalar(arg, value)];
  if (!Array.isArray(value))
    throw new AdapterError('parameter_type', `${arg.id} must be an array.`);
  if (value.length < arg.minValues || (arg.maxValues !== null && value.length > arg.maxValues)) {
    throw new AdapterError(
      'parameter_arity',
      `${arg.id} accepts ${arg.minValues}..${arg.maxValues ?? 'unbounded'} values.`,
    );
  }
  return value.map((item) => scalar(arg, item));
}

function option(arg: CliArg, group: string[]): string[] {
  const flag = arg.long ? `--${arg.long}` : arg.short ? `-${arg.short}` : undefined;
  if (!flag) throw new AdapterError('definition_argument', `No flag for ${arg.id}.`);
  if (!group.length) return [flag];
  if (group.length > 1 && arg.requireEquals) {
    throw new AdapterError(
      'definition_binding',
      `${arg.id} requires '=' and multiple values; this syntax needs a generator compatibility update.`,
    );
  }
  if (group.length > 1 && !arg.allowHyphenValues && group.some((value) => value.startsWith('-')))
    throw new AdapterError(
      'parameter_binding',
      `A value of ${arg.id} begins with '-'; native syntax would reinterpret it as an option.`,
    );
  if (arg.valueTerminator && group.includes(arg.valueTerminator))
    throw new AdapterError('parameter_binding', `${arg.id} contains its native terminator.`);
  const tokens = group.length === 1 ? [`${flag}=${group[0]}`] : [flag, ...group];
  return [...tokens, ...(arg.valueTerminator ? [arg.valueTerminator] : [])];
}

/** Returns the exact canonical path and arguments; it never accepts raw argv. */
export function serialize(command: CliCommand, params: Record<string, unknown> = {}): string[] {
  if (!params || Array.isArray(params) || typeof params !== 'object')
    throw new AdapterError('parameter_type', 'params must be an object.');
  const known = new Set(command.args.map((arg) => arg.id));
  for (const key of Object.keys(params))
    if (!known.has(key)) throw new AdapterError('unknown_parameter', `Unknown parameter: ${key}`);
  const flags: string[] = [];
  const positional: { arg: CliArg; values: string[] }[] = [];
  for (const arg of command.args) {
    if (!Object.hasOwn(params, arg.id)) continue;
    const value = params[arg.id];
    if (arg.index !== null) {
      positional.push({ arg, values: values(arg, value) });
      continue;
    }
    if (['SetTrue', 'SetFalse', 'Help', 'HelpShort', 'HelpLong', 'Version'].includes(arg.action)) {
      if (typeof value !== 'boolean')
        throw new AdapterError('parameter_type', `${arg.id} must be a boolean.`);
      if (value === (arg.action !== 'SetFalse')) flags.push(...option(arg, []));
    } else if (arg.action === 'Count') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255)
        throw new AdapterError('parameter_type', `${arg.id} must be an integer from 0 to 255.`);
      for (let n = 0; n < value; n++) flags.push(...option(arg, []));
    } else if (arg.action === 'Append') {
      if (!Array.isArray(value))
        throw new AdapterError('parameter_type', `${arg.id} must be an array of occurrences.`);
      for (const occurrence of value) flags.push(...option(arg, values(arg, occurrence)));
    } else if (arg.action === 'Set') {
      flags.push(...option(arg, values(arg, value)));
    } else {
      throw new AdapterError(
        'definition_action',
        `Unsupported native action ${arg.action}.`,
        'Update the generator; do not use a raw argv fallback.',
      );
    }
  }
  positional.sort((a, b) => (a.arg.index ?? 0) - (b.arg.index ?? 0));
  const hasLast = command.args.some((arg) => arg.last);
  let omitted = false;
  const ordinary: string[] = [];
  const tail: string[] = [];
  for (const arg of command.args
    .filter((arg) => arg.index !== null)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))) {
    const provided = positional.find((position) => position.arg === arg);
    if (!provided) {
      if (!arg.last && !arg.trailing) omitted = true;
      continue;
    }
    if (!arg.last && !arg.trailing && omitted && provided.values.length)
      throw new AdapterError(
        'parameter_binding',
        `An earlier positional parameter was omitted before ${arg.id}.`,
      );
    if (arg.last) {
      tail.push('--', ...provided.values);
      continue;
    }
    if (hasLast && provided.values.some((value) => value.startsWith('-'))) {
      if (!arg.allowHyphenValues && !arg.trailing)
        throw new AdapterError(
          'parameter_binding',
          `${arg.id} does not permit values beginning with '-'.`,
        );
    }
    ordinary.push(...provided.values);
  }
  // A variable-length option must not consume later positionals. A last/raw
  // argument owns the delimiter, so its preceding positionals go before flags.
  if (hasLast) return [...command.path, ...ordinary, ...flags, ...tail];
  return [...command.path, ...flags, ...(ordinary.length ? ['--'] : []), ...ordinary];
}
