/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

/**
 * CE-01.1 (#44) AC4 and AC5: the committed review catalogs, the frozen
 * default profile and the decision-closure record are consistent with the
 * bundled data, and every executable claim of the closure record is executed
 * here rather than trusted.
 */

const fs = require('fs');
const path = require('path');
const { loadCompiler } = require('./session-helpers');

const REPO = path.resolve(__dirname, '../../../..');
const TARGETS_SRC = path.join(REPO, 'packages/compiler/src/targets');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const { targets } = loadCompiler();
const DATA = readJson(path.join(TARGETS_SRC, 'data/compat-data.v1.json'));
const CAVEATS = readJson(path.join(TARGETS_SRC, 'catalog/caveats.v1.json'));
const INAPPLICABLE = readJson(
  path.join(TARGETS_SRC, 'catalog/inapplicable.v1.json'),
);
const PROFILE = readJson(path.join(TARGETS_SRC, 'profiles/default.v1.json'));
const CLOSURES = readJson(
  path.join(REPO, 'tests/core-evolution/decision-closures.v1.json'),
);
const REGISTRY = readJson(
  path.join(REPO, 'docs/research/core-evolution-registry.v1.json'),
);
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

function outcomes(key, refs) {
  const { record } = targets.resolveTargets({ profiles: refs });
  const feature = targets.featureByKey(key);
  return { feature, profiles: targets.profileOutcomes(feature, record) };
}

describe('caveat reviews (catalog/caveats.v1.json)', () => {
  test('are keyed to a note that exists in the bundled data, with a matching partial flag', () => {
    expect(CAVEATS.kind).toBeDefined();
    expect(CAVEATS.schemaVersion).toBe(1);
    expect(CAVEATS.compatData.bcdVersion).toBe('8.1.6');
    for (const review of CAVEATS.reviews) {
      for (const engine of review.engines) {
        const statements = (DATA.paths[review.path]?.e?.[engine] ?? []).filter(
          (s) => s.t === review.note,
        );
        expect({
          review: `${review.path}|${engine}`,
          found: statements.length > 0,
        }).toEqual({ review: `${review.path}|${engine}`, found: true });
        expect(statements.some((s) => s.p === 1)).toBe(review.partial === true);
      }
    }
  });

  test('every review has a disposition, a rationale and known engines', () => {
    for (const review of CAVEATS.reviews) {
      expect(['irrelevant', 'restricts', 'blocking']).toContain(
        review.disposition,
      );
      expect(typeof review.rationale).toBe('string');
      expect(review.rationale.trim()).not.toBe('');
      expect(review.engines.length).toBeGreaterThan(0);
      for (const engine of review.engines) expect(ENGINES).toContain(engine);
      if (review.effectiveFrom != null) {
        expect(targets.isReleaseString(String(review.effectiveFrom))).toBe(
          true,
        );
      }
    }
  });

  test('every partial review has partial: true, `missing` and a rationale', () => {
    const partials = CAVEATS.reviews.filter(
      (r) => r.partial != null || r.missing != null,
    );
    expect(partials.length).toBeGreaterThan(0);
    for (const review of partials) {
      expect(review.partial).toBe(true);
      expect(typeof review.missing).toBe('string');
      expect(review.missing.trim()).not.toBe('');
      expect(review.rationale.trim()).not.toBe('');
    }
    // The reviewed partials are exactly the orchestrator's list.
    expect([...new Set(partials.map((r) => r.path))].sort()).toEqual([
      'css.properties.accent-color',
      'css.properties.overscroll-behavior',
      'css.selectors.marker',
    ]);
    for (const marker of partials.filter(
      (r) => r.path === 'css.selectors.marker',
    )) {
      expect(
        marker.engines.every((e) => e === 'safari' || e === 'safari_ios'),
      ).toBe(true);
      expect(marker.properties).toEqual(['color', 'font-size']);
    }
  });
});

describe('platform-inapplicable entries (catalog/inapplicable.v1.json)', () => {
  test('every entry has features, engines and a reason', () => {
    expect(INAPPLICABLE.schemaVersion).toBe(1);
    for (const entry of INAPPLICABLE.entries) {
      expect(entry.features.length).toBeGreaterThan(0);
      expect(entry.engines.length).toBeGreaterThan(0);
      expect(typeof entry.reason).toBe('string');
      expect(entry.reason.trim()).not.toBe('');
    }
    expect(
      INAPPLICABLE.entries.map((e) => [e.features[0], [...e.engines].sort()]),
    ).toEqual([
      ['value:cursor/*', ['safari_ios']],
      ['property:forced-color-adjust', ['safari', 'safari_ios']],
      ['property:resize', ['firefox_android', 'safari_ios']],
    ]);
  });
});

describe('frozen default profile', () => {
  test('the built-in preset is the frozen query and its inputs name the bundled data', () => {
    expect(PROFILE.status).toBe('frozen');
    expect(targets.BUILTIN_PROFILES['pandamstyle:default@1'].query).toBe(
      PROFILE.query,
    );
    const { record } = targets.resolveTargets(null);
    expect(PROFILE.inputs.compatData).toBe(record.data.compatData.digest);
    expect(PROFILE.inputs.browserslist).toBe(record.data.browserslist.version);
    expect(PROFILE.inputs.caniuseLite).toBe(
      record.data['caniuse-lite'].version,
    );
  });
});

describe('decision-closures.v1.json', () => {
  test('is versioned and closes D-BP-01..13 once each, D-BP-12 untouched in CE-13', () => {
    expect(CLOSURES).toMatchObject({
      kind: 'pandamstyle-core-evolution-decision-closures',
      schemaVersion: 1,
      task: 'CE-01.1',
      issue: 44,
    });
    const ids = CLOSURES.closures.map((c) => c.id);
    expect(ids).toEqual(
      Array.from(
        { length: 13 },
        (_, i) => `D-BP-${String(i + 1).padStart(2, '0')}`,
      ),
    );
    for (const closure of CLOSURES.closures) {
      expect(['closed', 'split', 'deferred', 'untouched']).toContain(
        closure.status,
      );
      for (const field of ['closesIn', 'decision', 'rationale']) {
        expect(typeof closure[field]).toBe('string');
      }
      expect(Array.isArray(closure.evidence)).toBe(true);
      expect(Array.isArray(closure.commands)).toBe(true);
    }
    expect(CLOSURES.closures.find((c) => c.id === 'D-BP-12')).toMatchObject({
      status: 'untouched',
      closesIn: 'CE-13',
    });
    expect(CLOSURES.closures.find((c) => c.id === 'D-BP-07')).toMatchObject({
      status: 'deferred',
      closesIn: 'CE-01.2',
      issue: 45,
    });
  });

  test('every evidence path exists', () => {
    for (const closure of CLOSURES.closures) {
      for (const file of closure.evidence) {
        expect({ file, exists: fs.existsSync(path.join(REPO, file)) }).toEqual({
          file,
          exists: true,
        });
      }
    }
  });

  test('orchestrator decisions O1..O12 are recorded once each', () => {
    expect(CLOSURES.orchestratorDecisions.map((d) => d.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `CE-01.1-O${i + 1}`),
    );
  });

  test('the CE-01.2 deferrals are the four orchestrator deferrals', () => {
    expect(CLOSURES.deferrals.map((d) => [d.to, d.issue])).toEqual(
      Array(4).fill(['CE-01.2', 45]),
    );
    // Executed: alternative-value is refused as deferred.
    const [d] = targets.normalizeEnhancements([
      { feature: 'selector::has', fallback: { kind: 'alternative-value' } },
    ]).diagnostics;
    expect(d.context.deferredTo).toBe('CE-01.2');
  });

  test('each recorded unknown is unrecognized by the catalog, with an owner', () => {
    expect(CLOSURES.unknowns.map((u) => u.construct)).toEqual([
      'selector:::-webkit-search-decoration',
      'selector:::-webkit-outer-spin-button',
    ]);
    for (const unknown of CLOSURES.unknowns) {
      expect(unknown.owner).toMatch(/^CE-07/);
      const pseudo = unknown.construct.slice('selector:::'.length);
      const [record] = targets
        .featuresOfCss(`input::${pseudo}{color:red}`)
        .map((entry) => entry.record)
        .filter((r) => r.feature === unknown.construct);
      expect(record.recognized).toBe(false);
    }
  });
});

describe('executed claims of the closures', () => {
  test('W-UTIL-343: text-decoration dotted is incompatible on Safari and iOS at the default floor', () => {
    const { profiles } = outcomes('value:text-decoration/dotted', [
      'pandamstyle:default@1',
    ]);
    const failing = profiles[0].engines
      .filter((o) => o.state !== 'native')
      .map((o) => [o.engine, o.state, o.reason]);
    expect(failing).toEqual([
      ['safari', 'incompatible', 'support-after-floor'],
      ['safari_ios', 'incompatible', 'support-after-floor'],
    ]);
    // It does not set the floor (O3).
    expect(PROFILE.measurement.floors.safari.binding).not.toContain(
      'value:text-decoration/dotted',
    );
  });

  test('D-BP-03: Electron admits its platform keys; -webkit-user-drag has no data', () => {
    const states = (key) =>
      outcomes(key, [
        'pandamstyle:electron@1',
        'pandamstyle:default@1',
      ]).profiles.map((p) =>
        p.engines.map((o) => `${o.engine}:${o.state}/${o.reason}`),
      );
    expect(states('platform:electron/-webkit-app-region')[0]).toEqual([
      'electron:native/full-support-at-floor',
    ]);
    expect(states('platform:electron/-webkit-font-smoothing')[0]).toEqual([
      'electron:native/full-support-at-floor',
    ]);
    expect(states('platform:electron/-webkit-user-drag')[0]).toEqual([
      'electron:unknown/no-data',
    ]);
    for (const key of [
      'platform:electron/-webkit-app-region',
      'platform:electron/-webkit-user-drag',
    ]) {
      expect(new Set(states(key)[1].map((s) => s.split(':')[1]))).toEqual(
        new Set(['incompatible/platform-scoped']),
      );
    }
  });

  test('D-BP-06: every registry entry has a determined per-engine outcome', () => {
    const entries = REGISTRY.entries.filter(
      (e) => e.targetDecision?.decision === 'D-BP-06',
    );
    expect(entries).toHaveLength(35);
    const { record: resolution } = targets.resolveTargets(null);
    const evaluated = {};
    for (const entry of entries) {
      const css = `.x{${entry.name}:initial}`;
      const record = targets
        .featuresOfCss(css)
        .map((e) => e.record)
        .find((r) => r.feature === `property:${entry.name}`);
      const [profile] = targets.profileOutcomes(record, resolution);
      expect(profile.engines).toHaveLength(7);
      if (record.recognized) {
        evaluated[entry.name] = profile.engines
          .filter((o) => o.state !== 'native')
          .map((o) => `${o.engine}:${o.state}/${o.reason}`);
        // An engine the registry lists without an unprefixed release is never
        // native.
        for (const engine of entry.targetDecision
          .enginesWithoutUnprefixedRelease ?? []) {
          for (const o of profile.engines.filter((x) =>
            x.engine.startsWith(engine),
          )) {
            expect(o.state).not.toBe('native');
          }
        }
      } else {
        expect(
          new Set(profile.engines.map((o) => `${o.state}/${o.reason}`)),
        ).toEqual(new Set(['unknown/unrecognized-construct']));
      }
    }
    expect(evaluated).toEqual({
      'forced-color-adjust': [
        'safari:equivalent-fallback/platform-inapplicable',
        'safari_ios:equivalent-fallback/platform-inapplicable',
      ],
      'overscroll-behavior': [],
    });
  });

  test('D-BP-07: user-select stays prefixed-only on Safari and iOS', () => {
    const { profiles } = outcomes('property:user-select', [
      'pandamstyle:default@1',
    ]);
    expect(
      profiles[0].engines
        .filter((o) => o.state !== 'native')
        .map((o) => [o.engine, o.reason]),
    ).toEqual([
      ['safari', 'prefixed-only'],
      ['safari_ios', 'prefixed-only'],
    ]);
  });

  test('D-BP-13: a package requirement set is evaluated against the application targets', () => {
    const app = targets.resolveTargets({
      profiles: ['pandamstyle:default@1'],
    }).record;
    expect(
      targets.evaluateRequirements(
        ['selector::has', 'value:text-wrap/balance'],
        app,
        targets.featureByKey,
      ),
    ).toEqual({ ok: true, failing: [] });
    const result = targets.evaluateRequirements(
      ['value:text-wrap/pretty', 'not-a-key'],
      app,
      targets.featureByKey,
    );
    expect(result.ok).toBe(false);
    expect(result.failing.map((f) => [f.feature, f.state])).toEqual([
      ['not-a-key', 'unknown'],
      ['value:text-wrap/pretty', 'incompatible'],
    ]);
  });
});

describe('lazily parsed compat data', () => {
  test('every entry, child list and the digest equal a whole-file parse', () => {
    const text = fs.readFileSync(
      path.join(TARGETS_SRC, 'data/compat-data.v1.json'),
      'utf8',
    );
    for (const variant of [text, JSON.stringify(JSON.parse(text), null, 2)]) {
      const lazy = targets.compatDataFromText(variant);
      const raw = JSON.parse(variant);
      for (const [key, value] of Object.entries(raw.paths)) {
        expect(lazy.entry(key)).toEqual(value);
      }
      expect(lazy.has('css.properties.not-a-property')).toBe(false);
      expect(lazy.childrenOf('css.properties.text-wrap').sort()).toEqual(
        Object.keys(raw.paths)
          .filter((k) => /^css\.properties\.text-wrap\.[^.]+$/.test(k))
          .map((k) => k.split('.').at(-1))
          .sort(),
      );
    }
    expect(targets.compatData().digest).toBe(
      targets.compatDataFromText(text).digest,
    );
  });
});
