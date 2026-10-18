/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Compiles one `stylex.create()` declaration per research-inventory entry with
// the published StyleX Babel plugin and records what CSS it actually emits.
// The comparator is loaded from an isolated install outside the repository:
//
//   node tests/core-evolution/tools/probe-stylex-emission.mjs \
//     --install <dir containing node_modules/@stylexjs/babel-plugin> \
//     --inventory docs/research/core-evolution-inventory.json \
//     --keys <extract-upstream-keys output> --out <file.json>
//
// Each entry is compiled with the defaults (`propertyValidationMode: silent`)
// and again with `throw`, so silent drops keep their upstream reason.

import { createRequire } from 'node:module';
import path from 'node:path';
import {
  camelCaseKey,
  fileDigest,
  parseArgs,
  readJson,
  run,
  summarizeCss,
  writeJson,
} from './lib.mjs';

const options = parseArgs(process.argv.slice(2), [
  'install',
  'inventory',
  'keys',
  'out',
]);
const requireUpstream = createRequire(
  path.join(options.install, 'package.json'),
);
const babel = requireUpstream('@babel/core');
const stylexPlugin = requireUpstream('@stylexjs/babel-plugin');
const versions = Object.fromEntries(
  [
    '@babel/core',
    '@stylexjs/babel-plugin',
    '@stylexjs/stylex',
    '@stylexjs/shared',
  ].map((name) => [name, requireUpstream(`${name}/package.json`).version]),
);
const inventory = readJson(options.inventory);
const keys = readJson(options.keys);
const stylexKeyByName = new Map(
  keys.stylex.keys.map((item) => [item.name, item.key]),
);
const PROBE_VALUE = 'initial';

function compile(key, mode) {
  const value = key.startsWith('--') ? '1px' : PROBE_VALUE;
  const source = `import * as stylex from '@stylexjs/stylex';\nexport const s = stylex.create({ probe: ${JSON.stringify({ [key]: value })} });\n`;
  try {
    const result = babel.transformSync(source, {
      filename: '/ce001-probe/probe.js',
      babelrc: false,
      configFile: false,
      plugins: [
        [
          stylexPlugin,
          {
            dev: false,
            runtimeInjection: false,
            propertyValidationMode: mode,
            unstable_moduleResolution: { type: 'haste' },
          },
        ],
      ],
    });
    const css = stylexPlugin.processStylexRules(result.metadata.stylex, {
      useLayers: false,
    });
    return { css };
  } catch (error) {
    return {
      error: String(error.message)
        .split('\n')[0]
        .replace(/^\/ce001-probe\/probe\.js: /, ''),
    };
  }
}

function probe(key, name) {
  const silent = compile(key, 'silent');
  const strict = compile(key, 'throw');
  const summary =
    silent.css != null ? summarizeCss(silent.css, name) : { kind: 'error' };
  return {
    key,
    value: key.startsWith('--') ? '1px' : PROBE_VALUE,
    ...summary,
    silentError: silent.error ?? null,
    throwModeError: strict.error ?? null,
  };
}

const entries = [];
for (const [name] of inventory.properties) {
  const originalKey = stylexKeyByName.get(name) ?? null;
  let result = probe(originalKey ?? camelCaseKey(name), name);
  let keySource = originalKey ? 'stylex-type' : 'derived-camel-case';
  // A derived camelCase key can be misspelled by StyleX's own dashify (for
  // example `OAnimation`); the kebab-case key is the other accepted spelling.
  if (
    !originalKey &&
    result.kind !== 'passthrough' &&
    name !== 'custom-property'
  ) {
    const kebab = probe(name, name);
    if (kebab.kind === 'passthrough') {
      result = {
        ...kebab,
        rejectedDerivedKey: result.key,
        rejectedDerivedProperties: result.properties,
      };
      keySource = 'derived-kebab-case';
    }
  }
  entries.push({ name, keySource, ...result });
}

run(async () => {
  await writeJson(options.out, {
    schemaVersion: 1,
    kind: 'stylex-emission-probe',
    comparator: 'StyleX 0.19.1',
    versions,
    pluginOptions: {
      dev: false,
      runtimeInjection: false,
      styleResolution: 'property-specificity (default)',
      propertyValidationMode: ['silent (default)', 'throw'],
      processStylexRules: { useLayers: false },
    },
    inventoryDigest: fileDigest(options.inventory),
    keysDigest: fileDigest(options.keys),
    probeValue: PROBE_VALUE,
    method:
      "One stylex.create() namespace with one declaration per entry, original StyleX type key when present, otherwise the derived camelCase key; CSS from processStylexRules summarized by the tools' minimal CSS parser.",
    entries,
  });
  process.stdout.write(`stylex probe entries=${entries.length}\n`);
});
