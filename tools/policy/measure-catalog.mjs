/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CE-02.1 cost of the property catalog in the built compiler.
//
//   node tools/policy/measure-catalog.mjs [--base <root>] [--definition <design.mjs>] [--runs <n>]
//
// Run after `yarn build`. `--base` is the root of another built checkout (its
// packages/compiler/lib and .pms-test-support), to report deltas. Every memory
// figure is a median over fresh Node processes started with --expose-gc,
// measured after a forced collection while the measured object is retained:
//
//   bytes        the shipped lib/ files
//   import       heapUsed and RSS after importing lib/index.mjs
//   recognized   reading and parsing lib/recognized-properties.v1.json, as the
//                first unsupported-property diagnostic does (candidate only)
//   properties   building the effective property table, the snapshot's
//                `properties` member (inspection bundle of the same sources;
//                lib/ does not export it)
//   designSystem one buildDesignSystem of --definition, retained (inspection
//                bundle)
//
// It reports measurements only: no budget, no verdict.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(new URL('../..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const index = argv.indexOf(name);
  return index < 0 ? fallback : argv[index + 1];
};
const RUNS = Number(arg('--runs', '7'));
const BASE = arg('--base') == null ? null : path.resolve(arg('--base'));
const DEFINITION =
  arg('--definition') == null ? null : path.resolve(arg('--definition'));

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

function child(source) {
  const result = spawnSync(
    process.execPath,
    ['--expose-gc', '--input-type=module', '-e', source],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

const PRELUDE = `
const settle = () => { for (let i = 0; i < 4; i++) globalThis.gc(); };
const sample = () => { settle(); const m = process.memoryUsage(); return { heap: m.heapUsed, rss: m.rss }; };
`;

function measure(source) {
  const runs = Array.from({ length: RUNS }, () => child(PRELUDE + source));
  return {
    heapBytes: median(runs.map((r) => r.after.heap - r.before.heap)),
    rssBytes: median(runs.map((r) => r.after.rss - r.before.rss)),
    runs: RUNS,
  };
}

function libBytes(root) {
  const lib = path.join(root, 'packages/compiler/lib');
  return Object.fromEntries(
    fs
      .readdirSync(lib)
      .sort()
      .map((file) => [file, fs.statSync(path.join(lib, file)).size]),
  );
}

function importCost(root) {
  const url = pathToFileURL(
    path.join(root, 'packages/compiler/lib/index.mjs'),
  ).href;
  return measure(`
const before = sample();
const m = await import(${JSON.stringify(url)});
const after = sample();
globalThis.keep = m;
console.log(JSON.stringify({ before, after }));`);
}

function recognizedCost(root) {
  const file = path.join(
    root,
    'packages/compiler/lib/recognized-properties.v1.json',
  );
  if (!fs.existsSync(file)) return null;
  return measure(`
import { readFileSync } from 'node:fs';
const before = sample();
globalThis.keep = JSON.parse(String(readFileSync(${JSON.stringify(file)}))).entries;
const after = sample();
console.log(JSON.stringify({ before, after }));`);
}

function inspection(root, body) {
  const bundle = path.join(root, '.pms-test-support/compiler-inspection.cjs');
  return measure(`
import { createRequire } from 'node:module';
const compiler = createRequire(import.meta.url)(${JSON.stringify(bundle)});
${body}`);
}

function propertiesCost(root) {
  return inspection(
    root,
    `
if (typeof compiler.effectivePropertiesOf !== 'function') {
  console.log(JSON.stringify({ before: { heap: 0, rss: 0 }, after: { heap: 0, rss: 0 } }));
} else {
  const before = sample();
  globalThis.keep = compiler.effectivePropertiesOf(null);
  const after = sample();
  console.log(JSON.stringify({ before, after }));
}`,
  );
}

function designSystemCost(root) {
  if (DEFINITION == null) return null;
  const url = pathToFileURL(DEFINITION).href;
  return inspection(
    root,
    `
const definition = (await import(${JSON.stringify(url)})).default;
const before = sample();
globalThis.keep = compiler.buildDesignSystem(definition);
const after = sample();
console.log(JSON.stringify({ before, after }));`,
  );
}

function report(root) {
  return {
    bytes: libBytes(root),
    import: importCost(root),
    recognized: recognizedCost(root),
    properties: propertiesCost(root),
    designSystem: designSystemCost(root),
  };
}

const candidate = report(REPO);
const out = { node: process.version, definition: DEFINITION, candidate };
if (BASE != null) {
  const base = report(BASE);
  out.base = base;
  out.delta = {
    bytes: Object.fromEntries(
      [
        ...new Set([
          ...Object.keys(candidate.bytes),
          ...Object.keys(base.bytes),
        ]),
      ]
        .sort()
        .map((file) => [
          file,
          (candidate.bytes[file] ?? 0) - (base.bytes[file] ?? 0),
        ]),
    ),
    importHeapBytes: candidate.import.heapBytes - base.import.heapBytes,
    importRssBytes: candidate.import.rssBytes - base.import.rssBytes,
    designSystemHeapBytes:
      candidate.designSystem == null
        ? null
        : candidate.designSystem.heapBytes - base.designSystem.heapBytes,
    designSystemRssBytes:
      candidate.designSystem == null
        ? null
        : candidate.designSystem.rssBytes - base.designSystem.rssBytes,
  };
}
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
