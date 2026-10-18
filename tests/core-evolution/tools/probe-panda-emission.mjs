/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Extracts and emits one `css()` declaration per research-inventory entry with
// the published Panda 2.2.0 native compiler and preset-base, and records the
// CSS it actually emits. Upstream code is loaded from an isolated install and
// the scratch project lives outside the repository:
//
//   node tests/core-evolution/tools/probe-panda-emission.mjs \
//     --install <dir containing node_modules/@pandacss/compiler> \
//     --project <new empty scratch directory> \
//     --inventory docs/research/core-evolution-inventory.json \
//     --keys <extract-upstream-keys output> --out <file.json>
//
// A fresh NodeDriver compiles each entry so no atom from an earlier entry can
// be attributed to a later one. Utility transforms run through the driver.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
  'project',
  'inventory',
  'keys',
  'out',
]);
const requireUpstream = createRequire(
  path.join(options.install, 'package.json'),
);
// Assigned in main(): the comparator is an ES module loaded by path.
let compiler;
const versions = Object.fromEntries(
  [
    '@pandacss/compiler',
    '@pandacss/compiler-shared',
    '@pandacss/config',
    '@pandacss/preset-base',
    '@pandacss/types',
    '@pandacss/dev',
  ].map((name) => [name, requireUpstream(`${name}/package.json`).version]),
);
const project = path.resolve(options.project);
if (fs.existsSync(project) && fs.readdirSync(project).length > 0) {
  throw new Error(`--project must be a new empty directory: ${project}`);
}
fs.mkdirSync(path.join(project, 'src'), { recursive: true });
fs.symlinkSync(
  path.join(path.resolve(options.install), 'node_modules'),
  path.join(project, 'node_modules'),
);
// Probe resources let resource-backed utilities (textStyle, layerStyle,
// animationStyle) show what they emit when a referenced resource exists.
const CONFIG = `export default {
  presets: ['@pandacss/preset-base'],
  include: ['./src/**/*.tsx'],
  outdir: 'styled-system',
  preflight: false,
  jsxFramework: 'react',
  theme: {
    extend: {
      textStyles: { probe: { value: { fontSize: '1rem' } } },
      layerStyles: { probe: { value: { color: 'red' } } },
      animationStyles: { probe: { value: { animationDuration: '1s' } } },
      keyframes: { probe: { from: { opacity: 0 }, to: { opacity: 1 } } },
    },
  },
}
`;
fs.writeFileSync(path.join(project, 'panda.config.mjs'), CONFIG);
const sourceFile = path.join(project, 'src/probe.tsx');

async function emit(key, value) {
  const content = `import { css } from '../styled-system/css'\ncss(${JSON.stringify({ [key]: value })})\n`;
  fs.writeFileSync(sourceFile, content);
  const driver = await compiler.createNodeDriver({
    cwd: project,
    configPath: 'panda.config.mjs',
  });
  driver.scan();
  const parse = driver.parseFiles();
  const output = driver.cssgen({ emitLayerDeclaration: false });
  const marker = output.css.indexOf('@layer utilities');
  const utilities = marker >= 0 ? output.css.slice(marker) : '';
  return {
    utilities,
    diagnostics: [
      ...parse.flatMap((report) => report.diagnostics),
      ...output.diagnostics,
    ].map((d) => d.message ?? String(d)),
  };
}

async function probe(key, name) {
  const attempts = [];
  for (const value of ['initial', 'probe', true, 'outside', 'hidden']) {
    const result = await emit(key, value);
    const summary = summarizeCss(result.utilities, name);
    attempts.push({ value, kind: summary.kind });
    if (summary.kind !== 'no-emission') {
      return {
        key,
        value,
        ...summary,
        diagnostics: result.diagnostics,
        attempts,
      };
    }
  }
  return {
    key,
    value: null,
    kind: 'no-emission',
    properties: [],
    selectors: [],
    atRules: [],
    important: false,
    diagnostics: [],
    attempts,
  };
}

run(async () => {
  compiler = await import(
    pathToFileURL(requireUpstream.resolve('@pandacss/compiler')).href
  );
  const binding = compiler.getBindingInfo();
  const inventory = readJson(options.inventory);
  const keys = readJson(options.keys);
  const utilityKey = new Map(
    keys.pandaUtilities.keys.map((item) => [item.name, item.key]),
  );
  const typeKey = new Map(
    keys.pandaTypes.keys.map((item) => [item.name, item.key]),
  );
  const entries = [];
  for (const [name] of inventory.properties) {
    let key;
    let keySource;
    if (utilityKey.has(name)) {
      key = utilityKey.get(name);
      keySource = 'panda-utility';
    } else if (typeKey.has(name)) {
      key = typeKey.get(name);
      keySource = 'panda-type';
    } else {
      key = camelCaseKey(name, { msPrefix: 'ms' });
      keySource = 'derived-camel-case';
    }
    let result = await probe(key, name);
    if (
      keySource === 'derived-camel-case' &&
      result.kind !== 'passthrough' &&
      name !== 'custom-property'
    ) {
      const kebab = await probe(name, name);
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

  await writeJson(options.out, {
    schemaVersion: 1,
    kind: 'panda-emission-probe',
    comparator: 'PandaCSS 2.2.0',
    versions,
    nativeBinding: binding,
    config: CONFIG,
    inventoryDigest: fileDigest(options.inventory),
    keysDigest: fileDigest(options.keys),
    method:
      "Fresh NodeDriver per entry: scan, parseFiles, cssgen; the utilities layer is summarized by the tools' minimal CSS parser. Values tried in order: initial, probe (a configured resource name), true, outside, hidden; the first emitting value is recorded.",
    entries,
  });
  process.stdout.write(`panda probe entries=${entries.length}\n`);
});
