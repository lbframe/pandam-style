/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CE-00.2 declaration classifier.
//
//   node tools/coverage/cli.mjs extract --css <file> --input-id <id>
//        --source-path <logical path> [--baseline-layer <name>]
//        [--header <json>] [--policy <file>] --out <file>
//   node tools/coverage/cli.mjs check --set <file> [--policy <file>]
//   node tools/coverage/cli.mjs calibrate [--policy <file>]
//   node tools/coverage/cli.mjs account --css <file> [--policy <file>]
//
// `extract` reads a stylesheet as data and writes a publishable declaration
// set. `check` re-derives a committed set from its raw fields. `calibrate`
// checks the committed consumer sets against the reported baseline counts.
// `account` prints the accounting of an authored stylesheet.

import fs from 'node:fs';
import path from 'node:path';
import {
  ACCOUNTING,
  CORPUS,
  buildAccounting,
  serializeAccounting,
} from './accounting.mjs';
import { loadAlpha1Policy, loadRegistry, REPO } from './classify.mjs';
import {
  RAW_FIELDS,
  countSet,
  deriveSet,
  extractSet,
  serializeSet,
} from './declaration-set.mjs';

export const BASELINE_RECORD =
  'tests/core-evolution/corpus/calibration/baseline.v1.json';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] == null) {
      throw new Error(`Expected --name value pairs, got ${argv[i]}`);
    }
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Re-derives a committed set; returns a list of differences. */
export function recheckSet(set, policy, registry) {
  const raw = set.declarations.map((d) =>
    Object.fromEntries(RAW_FIELDS.map((k) => [k, d[k]])),
  );
  const { declarations: _ignored, counts: _counts, ...header } = set;
  const derived = deriveSet(header, raw, policy, registry);
  const problems = [];
  if (derived.registryVersion !== set.registryVersion)
    problems.push(
      `registryVersion ${set.registryVersion} != ${derived.registryVersion}`,
    );
  derived.declarations.forEach((d, i) => {
    const committed = JSON.stringify(set.declarations[i]);
    if (committed !== JSON.stringify(d) && problems.length < 20)
      problems.push(`${d.id}: committed record differs from re-derivation`);
  });
  if (
    JSON.stringify(set.counts) !==
    JSON.stringify(countSet(derived.declarations))
  )
    problems.push('counts differ from re-derivation');
  return { derived, problems };
}

/** Compares each committed calibration set with its reported baseline. */
export function calibrate(baseline, sets) {
  const results = [];
  for (const entry of baseline.sets) {
    const set = sets[entry.inputId];
    const c = set.counts;
    const measured = {
      total: c.baseline,
      expressible: c.byOutcome.expressible ?? 0,
      compositeRewrite: c.byOutcome['composite-rewrite'] ?? 0,
      gap: c.byOutcome.gap ?? 0,
      absentProperty: c.byGapKind['absent-property'] ?? 0,
      outOfDomain: c.byGapKind['out-of-domain'] ?? 0,
    };
    const mismatches = Object.entries(entry.reported)
      .filter(([k, v]) => measured[k] !== v)
      .map(
        ([k, v]) =>
          `${entry.inputId}.${k}: reported ${v}, measured ${measured[k]}`,
      );
    if (set.input.sha256 !== entry.input.sha256)
      mismatches.push(
        `${entry.inputId}: input digest differs from the baseline record`,
      );
    results.push({ inputId: entry.inputId, measured, mismatches });
  }
  return results;
}

export function loadCalibrationSets(baseline) {
  return Object.fromEntries(
    baseline.sets.map((s) => [
      s.inputId,
      readJson(path.join(REPO, s.declarationSet)),
    ]),
  );
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const { policy } = await loadAlpha1Policy(args.policy);
  const registry = loadRegistry();
  if (command === 'extract') {
    for (const k of ['css', 'input-id', 'source-path', 'out'])
      if (!args[k]) throw new Error(`extract needs --${k}`);
    const header = args.header ? readJson(args.header) : {};
    const set = extractSet({
      css: fs.readFileSync(args.css, 'utf8'),
      inputId: args['input-id'],
      sourcePath: args['source-path'],
      baselineLayer: args['baseline-layer'] ?? null,
      header,
      policy,
      registry,
    });
    fs.writeFileSync(args.out, serializeSet(set));
    console.log(
      JSON.stringify({ inputId: set.inputId, counts: set.counts }, null, 1),
    );
  } else if (command === 'check') {
    const { derived, problems } = recheckSet(
      readJson(args.set),
      policy,
      registry,
    );
    console.log(JSON.stringify(derived.counts, null, 1));
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exitCode = 1;
    }
  } else if (command === 'calibrate') {
    const baseline = readJson(path.join(REPO, BASELINE_RECORD));
    const sets = loadCalibrationSets(baseline);
    let failed = false;
    for (const [id, set] of Object.entries(sets)) {
      const { problems } = recheckSet(set, policy, registry);
      if (problems.length) {
        failed = true;
        console.error(`${id}:\n  ${problems.join('\n  ')}`);
      }
    }
    for (const r of calibrate(baseline, sets)) {
      console.log(`${r.inputId}: ${JSON.stringify(r.measured)}`);
      if (r.mismatches.length) {
        failed = true;
        console.error(`  ${r.mismatches.join('\n  ')}`);
      }
    }
    if (failed) process.exitCode = 1;
    else
      console.log('calibration: every reported baseline category reconciles');
  } else if (command === 'corpus') {
    const corpus = readJson(path.join(REPO, CORPUS));
    const accounting = buildAccounting(corpus, policy, registry);
    fs.writeFileSync(
      path.join(REPO, ACCOUNTING),
      serializeAccounting(accounting),
    );
    const t = accounting.totals;
    console.log(
      JSON.stringify(
        {
          all: t.all,
          baseline: t.baseline,
          byOutcome: t.byOutcome,
          byGapKind: t.byGapKind,
        },
        null,
        1,
      ),
    );
  } else if (command === 'account') {
    const set = extractSet({
      css: fs.readFileSync(args.css, 'utf8'),
      inputId: args['input-id'] ?? path.basename(args.css),
      sourcePath: args.css,
      header: {},
      policy,
      registry,
    });
    console.log(JSON.stringify(set.counts, null, 1));
  } else {
    throw new Error(
      'Usage: cli.mjs extract|check|calibrate|corpus|account ...',
    );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
