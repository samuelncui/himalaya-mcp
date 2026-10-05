import type { Catalog, CliArg, CliCommand, Manifest, Profiles } from '../src/types.js';

export function argument(id: string, overrides: Partial<CliArg> = {}): CliArg {
  return {
    id,
    long: id,
    short: null,
    aliases: [],
    shortAliases: [],
    action: 'Set',
    index: null,
    minValues: 1,
    maxValues: 1,
    valueDelimiter: null,
    requireEquals: false,
    valueTerminator: null,
    hidden: false,
    last: false,
    trailing: false,
    allowHyphenValues: false,
    global: false,
    required: false,
    defaultValues: [],
    env: null,
    help: '',
    valueType: 'string',
    valueChoices: [],
    ...overrides,
  };
}

export function command(args: CliArg[], path = ['synthetic']): CliCommand {
  return {
    path,
    aliases: [],
    hidden: false,
    about: 'Synthetic command',
    help: 'Synthetic native help',
    args,
    runnable: true,
  };
}

export function catalog(commands: CliCommand[]): Catalog {
  return {
    schemaVersion: 1,
    native: { name: 'himalaya', version: '2.2.1', revision: 'synthetic', features: [] },
    commands,
  };
}

export const manifest: Manifest = {
  schemaVersion: 1,
  packageVersion: '0.1.0',
  himalaya: { version: '2.2.1', tag: 'v2.2.1', revision: 'synthetic', features: [] },
  catalogSha256: '',
  assets: [],
};
export const profiles: Profiles = { schemaVersion: 1, rules: [] };
