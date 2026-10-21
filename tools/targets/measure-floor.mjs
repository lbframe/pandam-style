/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CE-01.1 default-profile floor measurement.
//
//   node tools/targets/measure-floor.mjs [--out <file>] [--caveats]
//
// For every feature of the floor set F and every engine, finds the earliest
// shipped release at which the outcome function answers `native` (full,
// unprefixed, unflagged, not partial, no unreviewed caveat). The floor of an
// engine is the maximum of those versions over F. A feature never native on an
// engine is a floor exception and needs a reviewed decision. Upstream headline
// numbers are not inputs.
//
// F (as designed): the CE-00.2 corpus stylesheets and declarations, the CSS
// the compiler emits for the frozen workloads, and the default intrinsic
// emission. The alternative variant adds both Wacando declaration sets.
//
// `--caveats` prints every unreviewed BCD note met by F, with its text, for
// review in packages/compiler/src/targets/catalog/caveats.v1.json.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO, collectFeatureUses } from './corpus-features.mjs';

const require = createRequire(
  path.join(REPO, 'packages/compiler/package.json'),
);
const browserslist = require('browserslist');
// BCD browser id -> Browserslist name, for release lists only.
export const BROWSERSLIST_NAMES = {
  chrome: 'chrome',
  chrome_android: 'and_chr',
  edge: 'edge',
  firefox: 'firefox',
  firefox_android: 'and_ff',
  safari: 'safari',
  safari_ios: 'ios_saf',
  webview_android: 'android',
};

export const DEFAULT_ENGINES = [
  'chrome',
  'chrome_android',
  'edge',
  'firefox',
  'firefox_android',
  'safari',
  'safari_ios',
];
export const OPTIONAL_ENGINES = ['webview_android'];

export const VARIANTS = {
  designed: ['ce-00.2-corpus', 'compiler-emitted', 'intrinsic-default'],
  'with-wacando': [
    'ce-00.2-corpus',
    'compiler-emitted',
    'intrinsic-default',
    'wacando:W-MOCKUP-1559',
    'wacando:W-UTIL-343',
  ],
};

function bcdNoteText(bcd, bcdPath, engine, digest) {
  const node = bcdPath.split('.').reduce((o, k) => o?.[k], bcd);
  const statements = [].concat(node?.__compat?.support?.[engine] ?? []);
  for (const statement of statements) {
    if (statement.notes == null) continue;
    const text = [].concat(statement.notes).join('\n');
    const d = crypto
      .createHash('sha256')
      .update(text)
      .digest('hex')
      .slice(0, 16);
    if (d === digest) return text;
  }
  return null;
}

export async function measure() {
  const { sources, inspection } = await collectFeatureUses();
  const t = inspection.targets;
  const data = t.compatData();
  // Released versions as Browserslist resolves them (mobile names mapped to
  // their desktop releases, as resolution does), lower bound of each range.
  const releases = Object.fromEntries(
    [...DEFAULT_ENGINES, ...OPTIONAL_ENGINES].map((engine) => {
      const name = BROWSERSLIST_NAMES[engine];
      const list = browserslist(`${name} > 0`, {
        mobileToDesktop: true,
        stats: {},
      }).map((entry) => entry.split(' ')[1].split('-')[0]);
      return [engine, [...new Set(list)].sort(t.compareVersions)];
    }),
  );
  const current = Object.fromEntries(
    Object.entries(releases).map(([engine, list]) => [engine, list.at(-1)]),
  );

  const records = new Map();
  const groupsOf = new Map();
  for (const source of sources) {
    for (const use of source.uses) {
      records.set(use.feature, use.record);
      if (!groupsOf.has(use.feature)) groupsOf.set(use.feature, new Set());
      groupsOf.get(use.feature).add(source.group);
    }
  }

  const minimum = {};
  const atCurrent = {};
  const caveats = new Map();
  for (const [feature, record] of [...records].sort()) {
    minimum[feature] = {};
    atCurrent[feature] = {};
    for (const engine of [...DEFAULT_ENGINES, ...OPTIONAL_ENGINES]) {
      const target = (floor) => ({
        engine,
        floor,
        upTo: null,
        basis: 'declared',
        dataEngine: engine,
        platform: null,
      });
      const latest = t.featureOutcome(record, target(current[engine]));
      atCurrent[feature][engine] = {
        state: latest.state,
        reason: latest.reason,
        basis: latest.basis,
      };
      for (const caveat of latest.caveats ?? []) {
        if (caveat.disposition === 'unreviewed') {
          caveats.set(`${caveat.path}|${caveat.engine}|${caveat.note}`, {
            ...caveat,
            features: [
              ...(caveats.get(`${caveat.path}|${caveat.engine}|${caveat.note}`)
                ?.features ?? []),
              feature,
            ],
          });
        }
      }
      let found = null;
      const acceptable = (state) =>
        state === 'native' || state === 'equivalent-fallback';
      if (acceptable(latest.state)) {
        for (const version of releases[engine]) {
          if (acceptable(t.featureOutcome(record, target(version)).state)) {
            found = version;
            break;
          }
        }
      }
      minimum[feature][engine] = found;
    }
  }

  const variants = {};
  for (const [name, groups] of Object.entries(VARIANTS)) {
    const features = [...records.keys()]
      .filter((feature) =>
        [...groupsOf.get(feature)].some((g) => groups.includes(g)),
      )
      .sort();
    // A feature never acceptable on some default engine is a per-feature
    // outcome there; it sets no floor on any engine, because raising other
    // floors for it would not make the profile able to rely on it.
    const nonBinding = new Set(
      features.filter((feature) =>
        DEFAULT_ENGINES.some((engine) => minimum[feature][engine] == null),
      ),
    );
    const floors = {};
    for (const engine of [...DEFAULT_ENGINES, ...OPTIONAL_ENGINES]) {
      let floor = null;
      let binding = [];
      const exceptions = [];
      for (const feature of features) {
        const version = minimum[feature][engine];
        if (version == null) {
          exceptions.push({ feature, ...atCurrent[feature][engine] });
          continue;
        }
        if (nonBinding.has(feature)) continue;
        const cmp = floor == null ? 1 : t.compareVersions(version, floor);
        if (cmp > 0) {
          floor = version;
          binding = [feature];
        } else if (cmp === 0) binding.push(feature);
      }
      floors[engine] = { floor, binding: binding.sort(), exceptions };
    }
    variants[name] = {
      groups,
      featureCount: features.length,
      nonBinding: [...nonBinding].sort(),
      floors,
    };
  }

  // Every reviewable note of F: notes on full statements and on partial
  // statements of the emitted name, any version. Reviewing a partial note is
  // what can make an earlier floor acceptable; it is never implied.
  const reviewable = new Map();
  for (const [feature, record] of records) {
    for (const { path: bcdPath, match } of record.bcd ?? []) {
      const entry = data.entry(bcdPath);
      for (const engine of [...DEFAULT_ENGINES, ...OPTIONAL_ENGINES]) {
        for (const statement of entry?.e?.[engine] ?? []) {
          if (statement.t == null || statement.f != null) continue;
          if ((statement.x ?? null) !== (match?.prefix ?? null)) continue;
          if ((statement.n ?? null) !== (match?.alternativeName ?? null))
            continue;
          const key = `${bcdPath}|${engine}|${statement.t}`;
          const previous = reviewable.get(key);
          reviewable.set(key, {
            path: bcdPath,
            engine,
            note: statement.t,
            partial: statement.p != null,
            added: statement.a,
            removed: statement.r ?? null,
            features: [
              ...new Set([...(previous?.features ?? []), feature]),
            ].sort(),
          });
        }
      }
    }
  }

  let caveatList = [...caveats.values()];
  if (caveatList.length > 0) {
    const bcd = JSON.parse(
      fs.readFileSync(
        path.join(REPO, 'node_modules/@mdn/browser-compat-data/data.json'),
        'utf8',
      ),
    );
    caveatList = caveatList
      .map((caveat) => ({
        ...caveat,
        features: [...new Set(caveat.features)].sort(),
        text: bcdNoteText(bcd, caveat.path, caveat.engine, caveat.note),
      }))
      .sort((a, b) =>
        `${a.path}|${a.engine}` < `${b.path}|${b.engine}` ? -1 : 1,
      );
  }

  return {
    kind: 'pandamstyle-floor-measurement',
    schemaVersion: 1,
    compatDataDigest: data.digest,
    current,
    variants,
    minimum,
    atCurrent,
    groups: Object.fromEntries(
      [...groupsOf]
        .map(([feature, groups]) => [feature, [...groups].sort()])
        .sort(),
    ),
    unreviewedCaveats: caveatList,
    reviewable: [...reviewable.values()].sort((a, b) =>
      `${a.path}|${a.engine}|${a.note}` < `${b.path}|${b.engine}|${b.note}`
        ? -1
        : 1,
    ),
  };
}

async function printMeasurement() {
  const argv = process.argv.slice(2);
  const result = await measure();
  const outIndex = argv.indexOf('--out');
  if (outIndex !== -1) {
    fs.writeFileSync(
      argv[outIndex + 1],
      JSON.stringify(result, null, 2) + '\n',
    );
  }
  if (argv.includes('--caveats')) {
    for (const caveat of result.unreviewedCaveats) {
      process.stdout.write(
        `${caveat.path} | ${caveat.engine} | ${caveat.note} | ${caveat.features.join(',')}\n    ${String(caveat.text).replace(/\n/g, '\n    ')}\n`,
      );
    }
    process.stdout.write(
      `${result.unreviewedCaveats.length} unreviewed caveats\n`,
    );
  }
  for (const [name, variant] of Object.entries(result.variants)) {
    process.stdout.write(`\n== ${name} (${variant.featureCount} features)\n`);
    for (const [engine, row] of Object.entries(variant.floors)) {
      process.stdout.write(
        `${engine.padEnd(16)} floor=${String(row.floor).padEnd(6)} binding=${row.binding.join(',')} exceptions=${row.exceptions.length}\n`,
      );
    }
  }
}

if (
  import.meta.url === `file://${process.argv[1]}` &&
  !process.argv.includes('--freeze') &&
  !process.argv.includes('--check')
) {
  printMeasurement().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}

// ------------------------------------------------------------------ freeze --

export const PROFILE_FILE = path.join(
  REPO,
  'packages/compiler/src/targets/profiles/default.v1.json',
);

// Decided at the CE-01.1 floor checkpoint (orchestrator, 2026-10-19).
export const FROZEN = {
  query:
    'chrome >= 120, edge >= 120, firefox >= 121, and_chr >= 120, and_ff >= 121, safari >= 18.2, ios_saf >= 18.2',
  iosQuery: 'ios_saf >= 18.2',
  androidWebViewQuery: 'android >= 120',
};

function fileDigest(relative) {
  return (
    'sha256:' +
    crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(REPO, relative)))
      .digest('hex')
  );
}

/** The frozen profile record for a measurement. */
export function profileRecord(result) {
  const designed = result.variants.designed;
  const wacando = result.variants['with-wacando'];
  return {
    kind: 'pandamstyle-default-profile',
    schemaVersion: 1,
    ref: 'pandamstyle:default@1',
    status: 'frozen',
    decision: 'CE-01.1 floor checkpoint, orchestrator decision of 2026-10-19',
    query: FROZEN.query,
    iosQuery: FROZEN.iosQuery,
    androidWebViewQuery: FROZEN.androidWebViewQuery,
    measurement: {
      method:
        'Floor = max over the floor set of the earliest Browserslist release whose outcome is native or equivalent-fallback; features never acceptable on some default engine set no floor (tools/targets/measure-floor.mjs).',
      variant: 'designed',
      groups: designed.groups,
      featureCount: designed.featureCount,
      floors: Object.fromEntries(
        Object.entries(designed.floors).map(([engine, row]) => [
          engine,
          { floor: row.floor, binding: row.binding },
        ]),
      ),
      exceptions: Object.fromEntries(
        Object.entries(designed.floors).map(([engine, row]) => [
          engine,
          row.exceptions.map((e) => ({
            feature: e.feature,
            state: e.state,
            reason: e.reason,
          })),
        ]),
      ),
      nonBinding: designed.nonBinding,
      notAdopted: {
        variant: 'with-wacando',
        floors: Object.fromEntries(
          Object.entries(wacando.floors).map(([engine, row]) => [
            engine,
            { floor: row.floor, binding: row.binding },
          ]),
        ),
        reason:
          'The floor is derived from the accepted CE-00.2 corpus; one consumer declaration (W-UTIL-343 text-decoration: underline dotted, Safari 26.2) does not raise every project floor.',
      },
    },
    inputs: {
      compatData: result.compatDataDigest,
      caveatReviews: fileDigest(
        'packages/compiler/src/targets/catalog/caveats.v1.json',
      ),
      inapplicableReviews: fileDigest(
        'packages/compiler/src/targets/catalog/inapplicable.v1.json',
      ),
      corpusAccounting: fileDigest(
        'tests/core-evolution/corpus/accounting.v1.json',
      ),
      workloads: fileDigest('benchmarks/core-evolution/workloads.v1.json'),
      browserslist: require('browserslist/package.json').version,
      caniuseLite: require('caniuse-lite/package.json').version,
    },
  };
}

/** Problems between the frozen query and the measured floors. */
export function queryProblems(record) {
  const problems = [];
  const names = {
    chrome: 'chrome',
    edge: 'edge',
    firefox: 'firefox',
    chrome_android: 'and_chr',
    firefox_android: 'and_ff',
    safari: 'safari',
    safari_ios: 'ios_saf',
  };
  for (const [engine, name] of Object.entries(names)) {
    const floor = record.measurement.floors[engine]?.floor;
    if (!record.query.includes(`${name} >= ${floor}`)) {
      problems.push(`${engine}: query does not state ${name} >= ${floor}`);
    }
  }
  return problems;
}

async function freezeOrCheck(argv) {
  const record = profileRecord(await measure());
  const problems = queryProblems(record);
  const text = JSON.stringify(record, null, 2) + '\n';
  if (argv.includes('--freeze')) {
    if (problems.length > 0) throw new Error(problems.join('\n'));
    fs.writeFileSync(PROFILE_FILE, text);
    process.stdout.write(`froze ${path.relative(REPO, PROFILE_FILE)}\n`);
  } else {
    const committed = fs.readFileSync(PROFILE_FILE, 'utf8');
    if (committed !== text || problems.length > 0) {
      process.stderr.write(
        `default profile does not re-derive:\n${problems.join('\n')}\n`,
      );
      process.exitCode = 1;
    } else {
      process.stdout.write('default profile re-derives byte for byte\n');
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  if (argv.includes('--freeze') || argv.includes('--check')) {
    freezeOrCheck(argv).catch((error) => {
      process.stderr.write(`${error.stack ?? error}\n`);
      process.exitCode = 1;
    });
  }
}
