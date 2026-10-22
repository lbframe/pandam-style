/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CE-01.2 design input: which transformations the target floors still need.
//
//   node tools/targets/transform-needs.mjs [--json]
//
// Evaluates probe CSS for the transformation families of #45 with the
// compiler's own extractor (`featuresOfCss`) and outcome function
// (`featureOutcome`) at two floors:
//   - `minimum`: the O13 minimum floor (`profiles/minimum.v1.json`), the lowest
//     target any profile may resolve to;
//   - `default`: the frozen `pandamstyle:default@1` floors (D-BP-01), with
//     Android WebView at `android >= 120`.
// For each feature key and engine it prints the outcome at both floors and the
// first release (from the pinned Browserslist release lists) at which the
// outcome is native, and, where it is not native, the vendor prefixes whose
// own statements would be native at that floor.
//
// Constructs outside the bundled emittable data (properties Alpha 1 does not
// admit, and CSS nesting, which the compiler never emits) are evaluated with
// the same `statementOutcome` on the full pinned BCD 8.1.6 `data.json`, whose
// digest is checked against the CE-00.1 evidence lock; those rows are labelled
// `bcd-full`.
//
// It then sweeps every bundled `css.*` node and lists those not native at a
// floor on some engine for which a vendor-prefixed or renamed statement is
// native there: the complete set a prefixing transformation could make
// acceptable for what the compiler can emit.
//
// Reads only pinned, committed data. Requires `yarn install` and `yarn build`
// (private inspection bundle). Output is deterministic.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO, loadInspection } from './corpus-features.mjs';
import { BROWSERSLIST_NAMES } from './measure-floor.mjs';
import { compactStatement } from './build-compat-data.mjs';

const require = createRequire(
  path.join(REPO, 'packages/compiler/package.json'),
);
const browserslist = require('browserslist');

const ENGINES = [
  'chrome',
  'chrome_android',
  'edge',
  'firefox',
  'firefox_android',
  'safari',
  'safari_ios',
  'webview_android',
];

// Probe CSS per #45 family, written the way the compiler emits rules.
export const FAMILIES = [
  {
    family: 'cascade layers',
    css: [
      '@layer priority1, priority2;',
      '@layer priority2{.x:hover{color:red}}',
      '.x{color:revert-layer}',
    ],
  },
  {
    family: 'logical properties',
    css: [
      '.x{margin-inline:1px;margin-inline-start:1px;margin-block:1px;margin-block-end:1px}',
      '.x{padding-inline:1px;padding-inline-end:1px;padding-block:1px;padding-block-start:1px}',
      '.x{inset:0;inset-inline:0;inset-inline-start:0;inset-block:0;inset-block-end:0}',
      '.x{inline-size:1px;block-size:1px;min-inline-size:1px;max-block-size:1px}',
      '.x{border-inline:1px solid red;border-inline-start-width:1px;border-block-end-color:red}',
      '.x{border-start-start-radius:1px;border-end-end-radius:1px}',
      '.x{float:inline-start;clear:inline-end;text-align:start}',
      '.x{scroll-margin-inline:1px;scroll-padding-block:1px;overscroll-behavior-inline:contain}',
    ],
    paths: [
      ['value:float/inline-start', 'css.properties.float.inline-start'],
      ['value:clear/inline-end', 'css.properties.clear.inline-end'],
      ['value:text-align/start', 'css.properties.text-align.start'],
    ],
  },
  {
    family: 'modern colors',
    css: [
      '.x{color:oklch(50% 0.1 30)}',
      '.x{color:oklab(50% 0.1 0.1)}',
      '.x{color:lab(50% 10 10)}',
      '.x{color:lch(50% 10 30)}',
      '.x{color:hwb(30 10% 10%)}',
      '.x{color:color(display-p3 1 0 0)}',
      '.x{color:color(srgb-linear 1 0 0)}',
      '.x{color:color(xyz-d65 0.4 0.2 0.1)}',
      '.x{color:color-mix(in oklab, red, blue)}',
      '.x{color:color-mix(in srgb, red 40%, blue)}',
      '.x{color:oklch(from red l c h)}',
      '.x{color:rgb(from red r g b)}',
      '.x{color:rgb(1 2 3 / 50%)}',
      '.x{color:#ff000080}',
    ],
  },
  {
    family: 'light-dark()',
    css: ['.x{color:light-dark(red, blue)}', ':root{color-scheme:light dark}'],
  },
  {
    family: 'nesting',
    // Not read by the extractor: the compiler never emits nested rules.
    paths: [['selector:&', 'css.selectors.nesting']],
  },
  {
    family: ':is / :where / :has',
    css: [
      '.x:is(.a, .b){color:red}',
      '.x:where(.a, .b){color:red}',
      '.x:has(.y){color:red}',
      '.x:not(.a, .b){color:red}',
    ],
  },
  {
    family: 'media range syntax',
    css: [
      '@media (width >= 600px){.x{color:red}}',
      '@media (400px <= width <= 700px){.x{color:red}}',
    ],
  },
  {
    family: 'container queries',
    css: [
      '.x{container-type:inline-size;container-name:card}',
      '@container (min-width: 400px){.x{color:red}}',
      '@container card (inline-size > 400px){.x{color:red}}',
      '.x{width:10cqi;height:10cqh}',
      '@container style(--x: 1){.x{color:red}}',
    ],
    paths: [
      [
        'value:container-type/inline-size',
        'css.properties.container-type.inline-size',
      ],
    ],
  },
  {
    family: '@property',
    css: [
      '@property --x { syntax: "<color>"; inherits: true; initial-value: red }',
    ],
  },
  {
    family: 'default-floor binders (context)',
    css: [
      '.x:dir(rtl){color:red}',
      '.x{mask-image:linear-gradient(red, blue)}',
      '.x{text-wrap:balance}',
      '.x{user-select:none}',
    ],
  },
];

function parseQueryFloors(query) {
  const out = {};
  for (const term of query.split(',')) {
    const [name, op, version] = term.trim().split(/\s+/);
    if (op !== '>=') throw new Error(`unexpected default term ${term}`);
    out[name] = version;
  }
  return out;
}

function floors(t) {
  const minimum = { ...t.MINIMUM_FLOOR.engines };
  delete minimum.electron;
  const profile = JSON.parse(
    fs.readFileSync(
      path.join(REPO, 'packages/compiler/src/targets/profiles/default.v1.json'),
      'utf8',
    ),
  );
  const byName = {
    ...parseQueryFloors(profile.query),
    ...parseQueryFloors(profile.androidWebViewQuery),
  };
  const defaults = Object.fromEntries(
    ENGINES.map((engine) => [engine, byName[BROWSERSLIST_NAMES[engine]]]),
  );
  return { minimum, default: defaults };
}

function releasesOf(t) {
  return Object.fromEntries(
    ENGINES.map((engine) => {
      const list = browserslist(`${BROWSERSLIST_NAMES[engine]} > 0`, {
        mobileToDesktop: true,
        stats: {},
      }).map((entry) => entry.split(' ')[1].split('-')[0]);
      return [engine, [...new Set(list)].sort(t.compareVersions)];
    }),
  );
}

const target = (engine, floor) => ({
  engine,
  floor,
  upTo: null,
  basis: 'declared',
  dataEngine: engine,
  platform: null,
});

/** The full pinned BCD, checked against the CE-00.1 evidence lock. */
function fullBcd() {
  const pin = JSON.parse(
    fs.readFileSync(
      path.join(REPO, 'docs/research/core-evolution-evidence.json'),
      'utf8',
    ),
  ).sourcePins.bcd;
  const bytes = fs.readFileSync(
    path.join(REPO, 'node_modules/@mdn/browser-compat-data/data.json'),
  );
  const digest =
    'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== pin.publishedDataDigest) {
    throw new Error(
      `installed BCD ${digest} is not the pinned ${pin.publishedDataDigest}`,
    );
  }
  const bcd = JSON.parse(bytes);
  const cache = new Map();
  return (bcdPath) => {
    if (!cache.has(bcdPath)) {
      const node = bcdPath.split('.').reduce((o, k) => o?.[k], bcd);
      const support = node?.__compat?.support;
      cache.set(
        bcdPath,
        support == null
          ? null
          : {
              e: Object.fromEntries(
                ENGINES.filter((engine) => support[engine] !== undefined).map(
                  (engine) => [
                    engine,
                    [].concat(support[engine]).map(compactStatement),
                  ],
                ),
              ),
            },
      );
    }
    return cache.get(bcdPath);
  };
}

/** Outcome of one subject on one engine at one floor. */
function outcomeOf(t, subject, engine, floor) {
  if (subject.source === 'compiler') {
    const o = t.featureOutcome(subject.record, target(engine, floor));
    return { state: o.state, reason: o.reason };
  }
  const o = t.statementOutcome({
    path: subject.path,
    engine,
    statements: subject.entry?.e?.[engine],
    match: null,
    range: { floor, upTo: null },
  });
  return { state: o.state, reason: o.reason };
}

/**
 * Vendor prefixes and alternative names whose own statements are native at
 * `floor` on `engine`, for every BCD path of the subject.
 */
function nativeVariants(t, subject, engine, floor, entryOf) {
  const refs =
    subject.source === 'compiler'
      ? subject.record.bcd.map(({ path: p }) => ({
          path: p,
          entry: entryOf(p),
        }))
      : [{ path: subject.path, entry: subject.entry }];
  const out = new Set();
  for (const { path: p, entry } of refs) {
    const statements = entry?.e?.[engine] ?? [];
    for (const s of statements) {
      if (s.x == null && s.n == null) continue;
      const match = { prefix: s.x ?? null, alternativeName: s.n ?? null };
      const o = t.statementOutcome({
        path: p,
        engine,
        statements,
        match,
        range: { floor, upTo: null },
      });
      if (o.state === 'native') out.add(s.x ?? `alt:${s.n}`);
    }
  }
  return [...out].sort();
}

function evaluateSubject(t, subject, floorSets, releases, entryOf) {
  const engines = {};
  for (const engine of ENGINES) {
    let nativeFrom = null;
    for (const version of releases[engine]) {
      if (outcomeOf(t, subject, engine, version).state === 'native') {
        nativeFrom = version;
        break;
      }
    }
    const row = { nativeFrom };
    for (const set of ['minimum', 'default']) {
      const floor = floorSets[set][engine];
      const o = outcomeOf(t, subject, engine, floor);
      row[set] =
        o.state === 'native'
          ? o
          : {
              ...o,
              nativeVariants: nativeVariants(
                t,
                subject,
                engine,
                floor,
                entryOf,
              ),
            };
    }
    engines[engine] = row;
  }
  return engines;
}

function subjectsOfFamily(t, family, entryOf, bundled) {
  const subjects = new Map();
  for (const css of family.css ?? []) {
    for (const { record } of t.featuresOfCss(css)) {
      if (subjects.has(record.feature)) continue;
      if (record.recognized) {
        subjects.set(record.feature, {
          feature: record.feature,
          source: 'compiler',
          record,
        });
        continue;
      }
      // Not emittable in Alpha 1: evaluate the property on the full data.
      const name = record.feature.startsWith('property:')
        ? record.feature.slice('property:'.length)
        : null;
      const p = name == null ? null : `css.properties.${name}`;
      subjects.set(record.feature, {
        feature: record.feature,
        source: 'bcd-full',
        path: p,
        entry: p == null ? null : entryOf(p),
      });
    }
  }
  for (const [feature, p] of family.paths ?? []) {
    subjects.set(feature, {
      feature,
      source: bundled.has(p) ? 'bundled-path' : 'bcd-full',
      path: p,
      entry: bundled.has(p) ? bundled.entry(p) : entryOf(p),
    });
  }
  return [...subjects.values()];
}

const REVIEW_REASONS = new Set(['unreviewed-caveat', 'partial-implementation']);

/** Property names Alpha 1 admits (CE-00.1 registry, `alpha1.kind`). */
function alpha1Admitted() {
  const registry = JSON.parse(
    fs.readFileSync(
      path.join(REPO, 'docs/research/core-evolution-registry.v1.json'),
      'utf8',
    ),
  );
  return new Set(
    registry.entries
      .filter((e) => e.alpha1?.kind != null && e.alpha1.kind !== 'unsupported')
      .map((e) => e.name),
  );
}

/** Every bundled css.* path not native at a floor that a variant would make native. */
function prefixSweep(t, floorSets) {
  const data = t.compatData();
  const paths = [];
  const walk = (p) => {
    for (const child of data.childrenOf(p)) {
      const next = `${p}.${child}`;
      if (data.has(next)) paths.push(next);
      walk(next);
    }
  };
  for (const root of ['at-rules', 'properties', 'selectors', 'types']) {
    walk(`css.${root}`);
  }
  const out = { minimum: [], default: [] };
  const reviewNeeded = { minimum: 0, default: 0 };
  const admitted = alpha1Admitted();
  const admittedOf = (p) => {
    const m = /^css\.properties\.([^.]+)/.exec(p);
    return m == null ? null : admitted.has(m[1]);
  };
  for (const p of paths.sort()) {
    const subject = {
      feature: p,
      source: 'bundled-path',
      path: p,
      entry: data.entry(p),
    };
    for (const set of ['minimum', 'default']) {
      const engines = [];
      for (const engine of ENGINES) {
        const floor = floorSets[set][engine];
        const o = outcomeOf(t, subject, engine, floor);
        if (o.state === 'native') continue;
        // An unreviewed note or partial statement on the base needs a note
        // review (CE-01.1 §4.4), not a transformation.
        if (REVIEW_REASONS.has(o.reason)) {
          reviewNeeded[set] += 1;
          continue;
        }
        const variants = nativeVariants(t, subject, engine, floor, data.entry);
        if (variants.length > 0)
          engines.push(
            `${engine} ${floor}: ${variants.join(', ')} (base ${o.reason})`,
          );
      }
      if (engines.length > 0) {
        out[set].push({ path: p, alpha1Admitted: admittedOf(p), engines });
      }
    }
  }
  return { pathsSwept: paths.length, reviewNeeded, ...out };
}

export function transformNeeds() {
  const t = loadInspection().targets;
  const floorSets = floors(t);
  const releases = releasesOf(t);
  const entryOf = fullBcd();
  const bundled = t.compatData();
  const families = FAMILIES.map((family) => ({
    family: family.family,
    features: subjectsOfFamily(t, family, entryOf, bundled).map((subject) => ({
      feature: subject.feature,
      source: subject.source,
      paths:
        subject.source === 'compiler'
          ? subject.record.bcd.map((b) => b.path)
          : [subject.path],
      engines: evaluateSubject(
        t,
        subject,
        floorSets,
        releases,
        (p) => bundled.entry(p) ?? entryOf(p),
      ),
    })),
  }));
  return {
    kind: 'pandamstyle-ce-01.2-transform-needs',
    data: t.compatData().sources,
    floors: floorSets,
    families,
    prefixSweep: prefixSweep(t, floorSets),
  };
}

function lacking(engines, set) {
  return Object.entries(engines)
    .filter(([, row]) => row[set].state !== 'native')
    .map(([engine, row]) => {
      const variants = row[set].nativeVariants ?? [];
      return (
        `${engine} ${row[set].state}/${row[set].reason}` +
        (row.nativeFrom == null
          ? ' (never native)'
          : ` (native ${row.nativeFrom})`) +
        (variants.length ? ` [native as ${variants.join(', ')}]` : '')
      );
    });
}

function printMarkdown(result) {
  const lines = [];
  lines.push(
    `BCD ${result.data.bcd.version} (${result.data.bcd.publishedDataDigest})`,
  );
  lines.push(`minimum floor: ${JSON.stringify(result.floors.minimum)}`);
  lines.push(`default floor: ${JSON.stringify(result.floors.default)}`);
  for (const family of result.families) {
    lines.push('', `## ${family.family}`, '');
    lines.push(
      '| Feature | Source | Not native at O13 minimum | Not native at default |',
    );
    lines.push('| --- | --- | --- | --- |');
    for (const f of family.features) {
      const min = lacking(f.engines, 'minimum');
      const def = lacking(f.engines, 'default');
      lines.push(
        `| \`${f.feature}\` | ${f.source} | ${min.length ? min.join('; ') : 'none'} | ${def.length ? def.join('; ') : 'none'} |`,
      );
    }
  }
  lines.push(
    '',
    `## prefix sweep over ${result.prefixSweep.pathsSwept} bundled css.* paths`,
  );
  for (const set of ['minimum', 'default']) {
    lines.push(
      '',
      `### not native at the ${set} floor, native as a variant`,
      '',
    );
    for (const row of result.prefixSweep[set]) {
      const admitted =
        row.alpha1Admitted == null
          ? ''
          : row.alpha1Admitted
            ? ' (Alpha 1 admitted)'
            : ' (not admitted in Alpha 1)';
      lines.push(`- \`${row.path}\`${admitted}: ${row.engines.join('; ')}`);
    }
    lines.push(
      `- (${result.prefixSweep[set].length} paths; ${result.prefixSweep.reviewNeeded[set]} engine rows skipped because the base needs a note review)`,
    );
    if (result.prefixSweep[set].length === 0) lines.push('- none');
  }
  process.stdout.write(lines.join('\n') + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = transformNeeds();
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    printMarkdown(result);
  }
}
