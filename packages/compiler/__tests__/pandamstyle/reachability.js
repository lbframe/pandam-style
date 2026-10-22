/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The `src/` modules a published Rollup entry reaches (AG-01.1 §5.3 (a)).
 *
 * Builds each configuration of `rollup.config.mjs` whose input is `entry`
 * through the Rollup JS API (`rollup()` and `generate()`; nothing is written)
 * and collects every output chunk's module ids under `packages/compiler/src/`.
 * The build runs in a child process because the config is an ES module. Any
 * initiative can reuse it with its own entries and forbidden globs through
 * `reachability.v1.json`.
 */

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const COMPILER = path.resolve(__dirname, '../..');

const COLLECT = `
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { rollup } from 'rollup';
const [compiler, ...entries] = process.argv.slice(1);
const configs = (await import(pathToFileURL(path.join(compiler, 'rollup.config.mjs')))).default;
const src = path.join(compiler, 'src') + path.sep;
const out = {};
for (const entry of entries) {
  const config = configs.find((c) => path.resolve(compiler, c.input) === path.resolve(compiler, entry));
  if (config == null) throw new Error('no rollup config for ' + entry);
  const bundle = await rollup({ input: config.input, external: config.external, plugins: config.plugins, onwarn() {} });
  const { output } = await bundle.generate(config.output[0]);
  await bundle.close();
  const modules = new Set();
  for (const chunk of output) {
    for (const id of Object.keys(chunk.modules ?? {})) {
      const file = id.replace(/^\\0/, '').split('?')[0];
      if (file.startsWith(src)) modules.add(path.relative(compiler, file).split(path.sep).join('/'));
    }
  }
  out[entry] = [...modules].sort();
}
process.stdout.write(JSON.stringify(out));
`;

/** `{ [entry]: sorted src-relative module paths }` for each entry. */
function reachableSourceModules(entries) {
  const text = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', COLLECT, COMPILER, ...entries],
    { cwd: COMPILER, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(text);
}

/** Minimal glob: `**` matches any path suffix, otherwise an exact path. */
function matchesGlob(file, glob) {
  if (glob.endsWith('/**')) return file.startsWith(glob.slice(0, -2));
  return file === glob;
}

module.exports = { reachableSourceModules, matchesGlob, COMPILER };
