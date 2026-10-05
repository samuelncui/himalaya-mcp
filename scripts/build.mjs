import { build } from 'esbuild';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '..');
const generated = resolve(root, process.env.HIMALAYA_GENERATED_DIR ?? 'build/generated');
await rm(resolve(root, 'dist'), { recursive: true, force: true });
await mkdir(resolve(root, 'dist'), { recursive: true });
await build({
  entryPoints: [resolve(root, 'src/cli.ts')],
  outfile: resolve(root, 'dist/cli.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'linked',
  banner: {
    js: 'import { createRequire as __himalayaCreateRequire } from "node:module"; const require = __himalayaCreateRequire(import.meta.url);',
  },
});
for (const name of ['catalog.json', 'manifest.json', 'upstream.lock.json'])
  await copyFile(resolve(generated, name), resolve(root, 'dist', name));
const profile = parse(await readFile(resolve(root, 'profiles/himalaya.yaml'), 'utf8'));
await writeFile(resolve(root, 'dist/profiles.json'), `${JSON.stringify(profile, null, 2)}\n`);
// No runtime dependencies: all libraries are in the generated JavaScript.
// Source/development dependencies and Rust tooling are not published.
