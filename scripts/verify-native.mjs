/** Differential checks use only a CI parse helper and official --help/--version. */
import { strict as assert } from 'node:assert';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as bundle } from 'esbuild';
import Ajv from 'ajv';
import { parse as parseYaml } from 'yaml';
import { run, sha256 } from './upstream.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generated = join(root, 'build', 'generated');
const loadJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const normalizeHelp = (text) =>
  text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function expectedValues(arg, value) {
  if (arg.action === 'SetTrue') return [String(value)];
  if (arg.action === 'SetFalse') return [String(value)];
  if (arg.action === 'Count') return [String(value)];
  if (Array.isArray(value)) return value.flat().map(String);
  return [String(value)];
}

export async function verifyNative() {
  const [catalog, manifest, helper, cases, profiles] = await Promise.all([
    loadJson(join(generated, 'catalog.json')),
    loadJson(join(generated, 'manifest.json')),
    loadJson(join(generated, 'native-helper.json')),
    loadJson(join(root, 'generator', 'native-cases.json')),
    readFile(join(root, 'profiles', 'himalaya.yaml'), 'utf8').then(parseYaml),
  ]);
  assert.equal(
    sha256(await readFile(join(generated, 'catalog.json'))),
    manifest.catalogSha256,
    'catalog digest',
  );
  assert.equal(helper.revision, manifest.himalaya.revision, 'CI helper revision');
  assert.equal(catalog.native.revision, manifest.himalaya.revision, 'catalog revision');
  const environment = { ...process.env, NO_COLOR: '1' };
  for (const name of new Set(
    catalog.commands.flatMap((command) => command.args.map((arg) => arg.env).filter(Boolean)),
  )) {
    delete environment[name];
  }
  const asset = manifest.assets.find(
    (candidate) => candidate.platform === process.platform && candidate.arch === process.arch,
  );
  if (!asset)
    throw new Error(
      `No official binary for this verification host ${process.platform}/${process.arch}.`,
    );
  const native = join(
    root,
    'build',
    'assets',
    `${asset.platform}-${asset.arch}`,
    asset.platform === 'win32' ? 'himalaya.exe' : 'himalaya',
  );
  assert.equal(sha256(await readFile(native)), asset.binarySha256, 'original binary digest');
  const version = await run(native, ['--version'], { env: environment, timeout: 10_000 });
  assert(version.stdout.includes(`v${manifest.himalaya.version}`), 'original binary version');
  assert(version.stdout.includes(manifest.himalaya.revision), 'original binary source revision');

  const modulePath = join(root, 'build', 'native', 'runtime-serialize.mjs');
  await bundle({
    entryPoints: [join(root, 'src', 'catalog.ts')],
    outfile: modulePath,
    platform: 'node',
    format: 'esm',
    bundle: true,
    logLevel: 'silent',
  });
  const { serialize, buildTools, commandProfile } = await import(
    `${pathToFileURL(modulePath).href}?check=${Date.now()}`
  );
  const definitions = buildTools(catalog, profiles);

  const unsupported = [];
  const actions = new Set([
    'Set',
    'Append',
    'SetTrue',
    'SetFalse',
    'Count',
    'Help',
    'HelpShort',
    'HelpLong',
    'Version',
  ]);
  const ioRoles = new Set([
    'inputFile',
    'outputFile',
    'outputDirectory',
    'inlineOrFile',
    'path',
    'accountPath',
    'config',
  ]);
  for (const command of catalog.commands.filter((command) => !command.frameworkGenerated)) {
    const profile = commandProfile(command, profiles);
    for (const arg of command.args) {
      if (arg.valueType === 'path' && !ioRoles.has(profile.args?.[arg.id])) {
        unsupported.push({
          path: command.path,
          arg: arg.id,
          reason:
            'File semantic missing: native path parameter requires an explicit IoRole in profiles/himalaya.yaml',
        });
      }
      if (!actions.has(arg.action))
        unsupported.push({
          path: command.path,
          arg: arg.id,
          reason: `Unsupported native action ${arg.action}`,
        });
      if (arg.requireEquals && (arg.maxValues === null || arg.maxValues > 1)) {
        unsupported.push({
          path: command.path,
          arg: arg.id,
          reason: 'requireEquals with multiple values needs generic serializer support',
        });
      }
    }
  }
  await writeFile(
    join(generated, 'syntax-report.json'),
    `${JSON.stringify({ schemaVersion: 1, unsupported }, null, 2)}\n`,
  );
  assert.equal(
    unsupported.length,
    0,
    `Native syntax compatibility gap: ${JSON.stringify(unsupported)}`,
  );
  const keys = new Set();
  for (const command of catalog.commands) {
    const key = JSON.stringify(command.path);
    assert(!keys.has(key), `Duplicate registered path ${key}`);
    keys.add(key);
    assert(command.help.trim(), `Missing native help for ${key}`);
    if (!command.frameworkGenerated) {
      const actual = await run(native, [...command.path, '--help'], {
        env: environment,
        timeout: 10_000,
      });
      assert.equal(
        normalizeHelp(actual.stdout),
        normalizeHelp(command.help),
        `Native help mismatch: ${command.path.join(' ') || '<root>'}`,
      );
    } else {
      assert.equal(
        command.runnable,
        false,
        `Framework reflection node became an executable tool: ${key}`,
      );
    }
  }

  const fixture = join(root, 'build', 'native', 'fixtures');
  await mkdir(fixture, { recursive: true });
  await Promise.all(
    ['attachment.txt', 'attachment unicode.txt', 'body.txt', 'message.eml'].map((name) =>
      writeFile(join(fixture, name), 'Subject: synthetic\r\n\r\nSynthetic fixture only.\r\n'),
    ),
  );
  const ajv = new Ajv({ strict: false, allErrors: true });
  const requests = [];
  const expected = [];
  for (const test of cases) {
    const command = catalog.commands.find(
      (candidate) => JSON.stringify(candidate.path) === JSON.stringify(test.path),
    );
    assert(command, `Fixture command disappeared: ${test.path.join(' ')}`);
    const params = JSON.parse(
      JSON.stringify(test.params).replaceAll('$FIXTURE', fixture.replaceAll('\\', '\\\\')),
    );
    const definition = definitions.find(
      (candidate) => candidate.name === ['himalaya', ...test.path].join('_'),
    );
    assert(definition, `Missing generated tool for ${test.path.join(' ')}`);
    const validate = ajv.compile(definition.inputSchema);
    assert(
      validate({ params }),
      `${test.name}: generated schema rejected valid field shape: ${JSON.stringify(validate.errors)}`,
    );
    requests.push({ argv: serialize(command, params) });
    expected.push({ test, command, params });
  }
  // Verify every registered hidden/visible command alias without executing a command.
  const aliases = catalog.commands.flatMap((command) =>
    command.aliases.map((alias) => [...command.path.slice(0, -1), alias, '--help']),
  );
  requests.push(...aliases.map((argv) => ({ argv })));
  const parsed = await run(helper.path, ['parse'], {
    env: environment,
    timeout: 30_000,
    input: requests.map((request) => JSON.stringify(request)).join('\n') + '\n',
  });
  const results = parsed.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(results.length, requests.length, 'native JSONL response count');
  for (let index = 0; index < expected.length; index += 1) {
    const { test, command, params } = expected[index];
    const result = results[index];
    if (test.errorKind) {
      assert.equal(
        result.ok,
        false,
        `${test.name}: native parser unexpectedly accepted invalid input`,
      );
      assert.equal(result.errorKind, test.errorKind, test.name);
      continue;
    }
    assert.equal(result.ok, true, `${test.name}: ${result.error ?? 'native parse failed'}`);
    assert.deepEqual(result.path, command.path, `${test.name}: canonical command binding`);
    for (const [id, value] of Object.entries(params)) {
      const arg = command.args.find((candidate) => candidate.id === id);
      assert(arg, `${test.name}: unknown generated field ${id}`);
      assert.deepEqual(
        result.args[id]?.values ?? [],
        expectedValues(arg, value),
        `${test.name}: ${id} binding`,
      );
      if (
        !(arg.action === 'SetTrue' && value === false) &&
        !(arg.action === 'SetFalse' && value === true)
      ) {
        assert.equal(
          result.args[id]?.source,
          'CommandLine',
          `${test.name}: ${id} unexpectedly came from a default or environment`,
        );
      }
      if (
        arg.index === null &&
        arg.action === 'Append' &&
        (arg.minValues !== 1 || arg.maxValues !== 1)
      ) {
        assert.deepEqual(
          result.args[id]?.occurrences,
          value.map((group) => group.map(String)),
          `${test.name}: occurrence grouping`,
        );
      }
    }
    const supplied = new Set(Object.keys(params));
    for (const [id, value] of Object.entries(result.args)) {
      if (value.source === 'CommandLine')
        assert(supplied.has(id), `${test.name}: an unintended argument ${id} became active`);
    }
  }
  for (let index = expected.length; index < results.length; index += 1) {
    assert.equal(results[index].ok, false, 'alias help must stop during native parse');
    assert.equal(
      results[index].errorKind,
      'DisplayHelp',
      `Unrecognized registered alias ${requests[index].argv.join(' ')}`,
    );
  }
  const report = {
    schemaVersion: 1,
    host: `${process.platform}/${process.arch}`,
    version: manifest.himalaya.version,
    revision: manifest.himalaya.revision,
    commands: catalog.commands.length,
    runnableCommands: catalog.commands.filter((command) => command.runnable).length,
    upstreamDeclaredPaths: catalog.commands.filter((command) => !command.frameworkGenerated).length,
    frameworkGeneratedNodes: catalog.commands.filter((command) => command.frameworkGenerated)
      .length,
    officialHelpChecks: catalog.commands.filter((command) => !command.frameworkGenerated).length,
    aliasChecks: aliases.length,
    argumentCases: cases.length,
    binarySha256: asset.binarySha256,
    catalogSha256: manifest.catalogSha256,
  };
  await writeFile(join(generated, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.error(
    `Verified ${report.officialHelpChecks} original-binary help pages, ${report.aliasChecks} registered aliases, and ${report.argumentCases} field/schema/native-parser differential cases.`,
  );
  return report;
}
