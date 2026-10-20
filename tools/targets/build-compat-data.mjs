/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CE-01.1 compat-data generator.
//
//   node tools/targets/build-compat-data.mjs [--bcd-data <data.json>] [--check]
//
// Writes packages/compiler/src/targets/data/compat-data.v1.json: the BCD
// statements of the paths the compiler can emit, from the same published BCD
// 8.1.6 `data.json` CE-00.1 pins (its digest is read from the CE-00.1 evidence
// lock and checked). No other data source is used: browser versions come from
// Browserslist at resolution time.
//
// Included paths:
//   - `css.properties.<p>` (with every subfeature) for the properties Alpha 1
//     admits (registry `alpha1.kind` is not `unsupported`), the registry entries
//     the accepted CE-00.2 corpus and both Wacando declaration sets exercise,
//     and `custom-property`;
//   - `css.selectors`, `css.at-rules` and `css.types`, because condition
//     definitions and token values can emit any selector, at-rule, function or
//     unit.
//
// The output is compiler-owned generated data: regenerate it, never edit it.
// `--check` regenerates in memory and fails unless the committed file is byte
// identical.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(new URL('../..', import.meta.url).pathname);
export const OUT = path.join(
  REPO,
  'packages/compiler/src/targets/data/compat-data.v1.json',
);
const EVIDENCE = path.join(REPO, 'docs/research/core-evolution-evidence.json');
const REGISTRY = path.join(
  REPO,
  'docs/research/core-evolution-registry.v1.json',
);
const ACCOUNTING = path.join(
  REPO,
  'tests/core-evolution/corpus/accounting.v1.json',
);
const WACANDO = [
  'tests/core-evolution/corpus/calibration/w-mockup-1559.declarations.v1.json',
  'tests/core-evolution/corpus/calibration/w-util-343.declarations.v1.json',
].map((file) => path.join(REPO, file));
const DEFAULT_BCD = path.join(
  REPO,
  'node_modules/@mdn/browser-compat-data/data.json',
);

export const ENGINES = Object.freeze([
  'chrome',
  'chrome_android',
  'edge',
  'firefox',
  'firefox_android',
  'safari',
  'safari_ios',
  'webview_android',
]);

function sha256(bytes) {
  return 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function noteDigest(notes) {
  const text = Array.isArray(notes) ? notes.join('\n') : String(notes);
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function compactStatement(statement) {
  const out = { a: statement.version_added };
  if (statement.version_removed != null) out.r = statement.version_removed;
  if (statement.partial_implementation === true) out.p = 1;
  if (statement.prefix != null) out.x = statement.prefix;
  if (statement.alternative_name != null) out.n = statement.alternative_name;
  if (statement.flags != null) out.f = 1;
  if (statement.notes != null) out.t = noteDigest(statement.notes);
  return out;
}

const VENDOR_PREFIX = /^-(webkit|moz|ms|o|khtml)-/;

/**
 * The property names whose BCD subtree is bundled. An exercised name reaches
 * its BCD property directly, through its unprefixed name, or as a recorded
 * alternative name (`-moz-osx-font-smoothing` under `font-smooth`).
 */
export function includedProperties(bcdProperties = null) {
  const registry = readJson(REGISTRY);
  const byName = new Map(registry.entries.map((entry) => [entry.name, entry]));
  const names = new Set(['custom-property']);
  const alternatives = new Map();
  for (const [property, node] of Object.entries(bcdProperties ?? {})) {
    for (const support of Object.values(node.__compat?.support ?? {})) {
      for (const statement of [].concat(support)) {
        if (statement.alternative_name != null) {
          alternatives.set(statement.alternative_name, property);
        }
      }
    }
  }
  const add = (name) => {
    const entry = byName.get(name);
    if (entry?.bcd != null) names.add(entry.sources?.bcd ?? entry.name);
    const unprefixed = name.replace(VENDOR_PREFIX, '');
    if (unprefixed !== name && bcdProperties?.[unprefixed] != null) {
      names.add(unprefixed);
    }
    if (alternatives.has(name)) names.add(alternatives.get(name));
  };
  for (const entry of registry.entries) {
    if (entry.alpha1?.kind != null && entry.alpha1.kind !== 'unsupported') {
      add(entry.name);
    }
  }
  for (const name of Object.keys(
    readJson(ACCOUNTING).totals.registryEntriesExercised,
  )) {
    add(name);
  }
  for (const file of WACANDO) {
    for (const declaration of readJson(file).declarations) {
      if (declaration.registry?.entry != null) add(declaration.registry.entry);
    }
  }
  return [...names].sort();
}

export function buildCompatData({ bcdData = DEFAULT_BCD } = {}) {
  const pin = readJson(EVIDENCE).sourcePins.bcd;
  const bytes = fs.readFileSync(bcdData);
  if (sha256(bytes) !== pin.publishedDataDigest) {
    throw new Error(
      `${bcdData} is not the BCD ${pin.version} data.json pinned by the CE-00.1 evidence lock.`,
    );
  }
  const bcd = JSON.parse(bytes);
  const paths = {};
  const visit = (node, pathName) => {
    if (node == null || typeof node !== 'object') return;
    if (node.__compat != null) {
      const e = {};
      for (const engine of ENGINES) {
        const support = node.__compat.support[engine];
        if (support !== undefined)
          e[engine] = [].concat(support).map(compactStatement);
      }
      paths[pathName] = { e };
    }
    for (const key of Object.keys(node).sort()) {
      if (key !== '__compat') visit(node[key], `${pathName}.${key}`);
    }
  };
  for (const name of includedProperties(bcd.css.properties)) {
    if (bcd.css.properties[name] != null) {
      visit(bcd.css.properties[name], `css.properties.${name}`);
    }
  }
  visit(bcd.css.selectors, 'css.selectors');
  visit(bcd.css['at-rules'], 'css.at-rules');
  visit(bcd.css.types, 'css.types');
  const sorted = {};
  for (const key of Object.keys(paths).sort()) sorted[key] = paths[key];
  return {
    kind: 'pandamstyle-compat-data',
    schemaVersion: 1,
    generatedBy: 'tools/targets/build-compat-data.mjs',
    sources: {
      bcd: {
        package: '@mdn/browser-compat-data',
        version: pin.version,
        commit: pin.commit,
        publishedDataDigest: pin.publishedDataDigest,
        pinnedBy: 'docs/research/core-evolution-evidence.json',
      },
    },
    paths: sorted,
  };
}

export function serializeCompatData(data) {
  return JSON.stringify(data) + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf('--bcd-data');
  const text = serializeCompatData(
    buildCompatData(
      index === -1 ? {} : { bcdData: path.resolve(argv[index + 1]) },
    ),
  );
  if (argv.includes('--check')) {
    const committed = fs.readFileSync(OUT, 'utf8');
    if (committed !== text) {
      process.stderr.write(
        `compat data differs from a regeneration: committed ${sha256(committed)}, regenerated ${sha256(text)}\n`,
      );
      process.exitCode = 1;
    } else {
      process.stdout.write(`compat data reproduces: ${sha256(text)}\n`);
    }
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, text);
    process.stdout.write(
      `wrote ${path.relative(REPO, OUT)} ${sha256(text)} (${text.length} bytes)\n`,
    );
  }
}
