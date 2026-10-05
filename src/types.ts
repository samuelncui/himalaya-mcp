/** This contract is emitted from upstream definitions; no command registry lives here. */
export interface CliArg {
  id: string;
  long: string | null;
  short: string | null;
  aliases: string[];
  shortAliases: string[];
  action: string;
  index: number | null;
  minValues: number;
  maxValues: number | null;
  valueDelimiter: string | null;
  requireEquals: boolean;
  valueTerminator: string | null;
  hidden: boolean;
  last: boolean;
  trailing: boolean;
  allowHyphenValues: boolean;
  global: boolean;
  required: boolean;
  defaultValues: string[];
  env: string | null;
  help: string;
  valueType: 'string' | 'integer' | 'number' | 'path' | 'boolean';
  valueChoices: string[];
}

export interface CliCommand {
  path: string[];
  aliases: string[];
  hidden: boolean;
  about: string;
  help: string;
  args: CliArg[];
  runnable: boolean;
  frameworkGenerated?: boolean;
}

export interface Catalog {
  schemaVersion: 1;
  native: { name: string; version: string; revision: string; features: string[] };
  commands: CliCommand[];
}

export interface BinaryAsset {
  platform: string;
  arch: string;
  name: string;
  url: string;
  archiveSha256: string;
  binarySha256: string;
}

export interface Manifest {
  schemaVersion: 1;
  packageVersion: string;
  himalaya: { version: string; tag: string; revision: string; features: string[] };
  catalogSha256: string;
  assets: BinaryAsset[];
}

export interface CallInput {
  params?: Record<string, unknown>;
  stdin?: string;
  stdinBase64?: string;
  files?: { name: string; base64: string }[];
}

export interface Artifact {
  name: string;
  uri: string;
  mimeType: string;
  size: number;
}

export type IoRole =
  | 'inputFile'
  | 'outputFile'
  | 'outputDirectory'
  | 'inlineOrFile'
  | 'path'
  | 'accountPath'
  | 'config';

export interface Profiles {
  schemaVersion: 1;
  rules: {
    commands: string[];
    readOnly?: boolean;
    idempotent?: boolean;
    destructive?: boolean;
    interactive?: boolean;
    args?: Record<string, IoRole>;
    pathExpansion?: Record<string, 'shell'>;
  }[];
}

export interface Policy {
  schemaVersion: 1;
  deny: {
    command: string;
    reason: string;
    when?: Record<string, string | boolean | number | (string | boolean | number)[]>;
  }[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; additionalProperties: false };
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stdoutBase64?: string;
  stderr: string;
  files: Artifact[];
  timedOut?: boolean;
}

export class AdapterError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly nextStep?: string,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}
