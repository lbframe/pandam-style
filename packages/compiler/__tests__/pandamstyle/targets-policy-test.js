/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

/**
 * CE-01.1 (#44) AC3: warning/error and enhancement/fallback policies on
 * positive and incompatible cases, and the executed-evidence schema.
 *
 * Structured fields are asserted, never message text.
 */

const { loadCompiler } = require('./session-helpers');

const compiler = loadCompiler();
const { targets } = compiler;
const { record: DEFAULT } = targets.resolveTargets(null);
const DS = {
  role: 'design-system',
  file: null,
  line: null,
  column: null,
  label: 'design-system',
};
const PAGE = { role: 'page', file: '/app/page.js', line: 3, column: 5 };

function evaluate(css, { owner = DS, enhancements = [], resolution } = {}) {
  return targets.evaluateTargets({
    resolution: resolution ?? DEFAULT,
    sources: [{ owner, css }],
    enhancements,
  });
}
const codes = (list) => list.map((d) => d.code);

describe('enhancement policy validation (definition field `enhancements`)', () => {
  const invalid = (value) => targets.normalizeEnhancements(value).diagnostics;

  test.each([
    ['not a list', { feature: 'selector::has' }],
    ['an entry that is not an object', ['selector::has']],
    [
      'an unknown policy field',
      [{ feature: 'selector::has', fallback: { kind: 'degrade' }, why: 1 }],
    ],
    [
      'an unknown feature key',
      [{ feature: 'selector::nope', fallback: { kind: 'degrade' } }],
    ],
    [
      'a key that is not a catalog key',
      [{ feature: 'has', fallback: { kind: 'degrade' } }],
    ],
    ['no fallback', [{ feature: 'selector::has' }]],
    [
      'an unknown fallback kind',
      [{ feature: 'selector::has', fallback: { kind: 'polyfill' } }],
    ],
    [
      'an unknown fallback field',
      [{ feature: 'selector::has', fallback: { kind: 'degrade', css: 'x' } }],
    ],
    [
      'a non-string note',
      [{ feature: 'selector::has', fallback: { kind: 'degrade', note: 1 } }],
    ],
    [
      'two policies for one feature',
      [
        { feature: 'selector::has', fallback: { kind: 'degrade' } },
        { feature: 'selector::has', fallback: { kind: 'degrade' } },
      ],
    ],
  ])('%s is refused', (_label, value) => {
    const diagnostics = invalid(value);
    expect(diagnostics.length).toBeGreaterThan(0);
    for (const d of diagnostics) {
      expect(d).toMatchObject({
        code: 'PMS_INVALID_ENHANCEMENT_POLICY',
        severity: 'error',
        phase: 'targets',
        rule: 'targets.enhancement.policy',
      });
    }
  });

  test('`alternative-value` is in the schema but its emission is deferred to CE-01.2', () => {
    expect(targets.FALLBACK_KINDS).toEqual(['degrade', 'alternative-value']);
    const [d] = invalid([
      {
        feature: 'value:text-wrap/pretty',
        fallback: {
          kind: 'alternative-value',
          property: 'text-wrap',
          value: 'wrap',
        },
      },
    ]);
    expect(d).toMatchObject({
      code: 'PMS_INVALID_ENHANCEMENT_POLICY',
      context: { deferredTo: 'CE-01.2' },
    });
  });

  test('valid policies are normalized and sorted', () => {
    expect(
      targets.normalizeEnhancements([
        { feature: 'value:text-wrap/pretty', fallback: { kind: 'degrade' } },
        { feature: 'selector::has', fallback: { kind: 'degrade', note: 'n' } },
      ]),
    ).toEqual({
      enhancements: [
        { feature: 'selector::has', fallback: { kind: 'degrade', note: 'n' } },
        { feature: 'value:text-wrap/pretty', fallback: { kind: 'degrade' } },
      ],
      diagnostics: [],
    });
  });

  test('the registry validates the field and the digest moves only when it is declared', () => {
    const base = compiler.buildDesignSystem(compiler.conformanceDefinition);
    const empty = compiler.buildDesignSystem({
      ...compiler.conformanceDefinition,
      enhancements: [],
    });
    const declared = compiler.buildDesignSystem({
      ...compiler.conformanceDefinition,
      enhancements: [
        { feature: 'selector::has', fallback: { kind: 'degrade' } },
      ],
    });
    expect(empty.registry.registryDigest).toBe(base.registry.registryDigest);
    expect(declared.registry.registryDigest).not.toBe(
      base.registry.registryDigest,
    );
    expect(declared.registry.enhancements).toEqual([
      { feature: 'selector::has', fallback: { kind: 'degrade' } },
    ]);
    let error = null;
    try {
      compiler.buildDesignSystem({
        ...compiler.conformanceDefinition,
        enhancements: [
          { feature: 'selector::nope', fallback: { kind: 'degrade' } },
        ],
      });
    } catch (e) {
      error = e;
    }
    expect(codes(error.diagnostics)).toEqual([
      'PMS_INVALID_ENHANCEMENT_POLICY',
    ]);
  });
});

describe('required capabilities and enhancements', () => {
  test('positive: native emitted CSS gives facts only', () => {
    const result = evaluate('.x:has(.y){color:red;text-wrap:balance}');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.infos).toEqual([]);
    expect(result.facts.counts.failingRequired).toBe(0);
    expect(result.facts.features.every((f) => f.required)).toBe(true);
  });

  test('a required incompatible capability is an error with structured context', () => {
    const result = evaluate('.x{text-wrap:pretty}');
    expect(codes(result.errors)).toEqual([
      'PMS_TARGET_CAPABILITY_INCOMPATIBLE',
    ]);
    const [error] = result.errors;
    expect(error).toMatchObject({
      severity: 'error',
      phase: 'targets',
      rule: 'targets.capability.required',
      role: 'design-system',
      context: {
        feature: 'value:text-wrap/pretty',
        property: 'text-wrap',
        value: 'pretty',
        profile: 'pandamstyle:default@1',
        state: 'incompatible',
      },
      expected: {
        states: ['native', 'transformed-with-proof', 'equivalent-fallback'],
        profile: 'pandamstyle:default@1',
      },
      repair: { kind: 'declare-enhancement', applicable: false },
    });
    expect(
      error.context.engines.map((e) => [e.engine, e.state, e.reason]),
    ).toEqual([
      ['firefox', 'incompatible', 'no-support'],
      ['firefox_android', 'incompatible', 'no-support'],
      ['safari', 'incompatible', 'support-after-floor'],
      ['safari_ios', 'incompatible', 'support-after-floor'],
    ]);
    expect(result.facts.counts.failingRequired).toBe(1);
  });

  test('a required unknown-only capability is a distinct error', () => {
    const result = evaluate('.x{anchor-name:--a}');
    expect(codes(result.errors)).toEqual(['PMS_TARGET_CAPABILITY_UNKNOWN']);
    expect(result.errors[0]).toMatchObject({
      rule: 'targets.capability.evidence',
      context: { feature: 'property:anchor-name', state: 'unknown' },
    });
  });

  test('a page-owned failure is located at its source and keeps the page role', () => {
    const result = evaluate('.x{text-wrap:pretty}', { owner: PAGE });
    expect(result.errors[0]).toMatchObject({
      role: 'page',
      location: { file: '/app/page.js', line: 3, column: 5, role: 'page' },
    });
  });

  test('`degrade` turns the same failure into a warning naming the fallback', () => {
    const result = evaluate('.x{text-wrap:pretty}', {
      enhancements: [
        { feature: 'value:text-wrap/pretty', fallback: { kind: 'degrade' } },
      ],
    });
    expect(result.errors).toEqual([]);
    expect(codes(result.warnings)).toEqual(['PMS_TARGET_ENHANCEMENT_DEGRADED']);
    expect(result.warnings[0]).toMatchObject({
      severity: 'warning',
      rule: 'targets.enhancement.degraded',
      context: {
        feature: 'value:text-wrap/pretty',
        profile: 'pandamstyle:default@1',
        fallback: { kind: 'degrade' },
      },
    });
    const fact = result.facts.features.find(
      (f) => f.feature === 'value:text-wrap/pretty',
    );
    expect(fact).toMatchObject({
      required: false,
      enhancement: { kind: 'degrade' },
    });
    // The state stays honest: an enhancement does not change the outcome.
    expect(fact.profiles[0].state).toBe('incompatible');
  });

  test('an enhancement native on every profile gives an info: the policy is inert', () => {
    const result = evaluate('.x{text-wrap:balance}', {
      enhancements: [
        { feature: 'value:text-wrap/balance', fallback: { kind: 'degrade' } },
      ],
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(codes(result.infos)).toEqual(['PMS_TARGET_ENHANCEMENT_INEFFECTIVE']);
    expect(result.infos[0]).toMatchObject({
      severity: 'info',
      context: {
        feature: 'value:text-wrap/balance',
        profiles: ['pandamstyle:default@1'],
      },
    });
  });

  test('a fallback written in the value (a font stack entry) warns instead of failing', () => {
    // `system-ui` has its own subfeature; every entry but the last is backed
    // up by a later one.
    const result = evaluate(
      '.x{font-family:ui-rounded, system-ui, sans-serif}',
    );
    expect(result.errors).toEqual([]);
    const fact = result.facts.features.find(
      (f) => f.feature === 'value:font-family/ui-rounded',
    );
    expect(fact).toMatchObject({
      required: false,
      enhancement: { kind: 'css-list-fallback' },
    });
    expect(codes(result.warnings)).toContain('PMS_TARGET_ENHANCEMENT_DEGRADED');
  });

  test('an Electron profile admits a platform feature, the web profile refuses it', () => {
    const electron = targets.resolveTargets({
      profiles: ['pandamstyle:electron@1'],
    }).record;
    const css = '.x{-webkit-app-region:drag}';
    expect(evaluate(css, { resolution: electron }).errors).toEqual([]);
    expect(codes(evaluate(css).errors)).toEqual([
      'PMS_TARGET_CAPABILITY_INCOMPATIBLE',
    ]);
  });

  test('useCSSLayers is checked as the compiler emits it, the ladder otherwise', () => {
    const layered = targets.evaluateTargets({
      resolution: DEFAULT,
      sources: [],
      intrinsic: { useCSSLayers: true },
    });
    const ladder = targets.evaluateTargets({
      resolution: DEFAULT,
      sources: [],
    });
    const keys = (r) => r.facts.features.map((f) => f.feature);
    expect(keys(layered)).toEqual(
      expect.arrayContaining([
        'at-rule:layer/block',
        'at-rule:layer/statement',
      ]),
    );
    expect(keys(ladder)).not.toContain('at-rule:layer/block');
    expect(keys(ladder)).toContain('selector::not');
    // Below layer support the layered emission fails the profile.
    const old = targets.resolveTargets({
      profiles: ['project:old'],
      define: { old: { query: 'chrome 90' } },
    }).record;
    const below = targets.evaluateTargets({
      resolution: old,
      sources: [],
      intrinsic: { useCSSLayers: true },
    });
    expect(below.errors.map((e) => e.context.feature)).toEqual(
      expect.arrayContaining([
        'at-rule:layer/block',
        'at-rule:layer/statement',
      ]),
    );
  });
});

describe('advisory and enforced modes', () => {
  const pageWith = (css) => ({ file: '/app/page.js', rules: [], css });
  const project = (resolution) =>
    targets.evaluateProjectTargets({
      resolution,
      designSystem: {
        registry: { enhancements: [], conditions: {}, conditionOrder: [] },
      },
      designSystemRules: [['k', { ltr: '.x{text-wrap:pretty}', rtl: null }]],
      pages: [pageWith('')],
    });

  test('no targets: the default profile is recorded as failing and findings are warnings', () => {
    const result = project(targets.resolveTargets(null).record);
    expect(result.errors).toEqual([]);
    expect(codes(result.warnings)).toEqual([
      'PMS_TARGET_CAPABILITY_INCOMPATIBLE',
    ]);
    expect(result.warnings[0].severity).toBe('warning');
    expect(result.warnings[0].context.enforcement).toBe('advisory');
    expect(result.facts.enforcement).toBe('advisory');
    expect(result.facts.profileStatus).toEqual([
      { ref: 'pandamstyle:default@1', status: 'failing' },
    ]);
  });

  test('explicit targets: the same finding is an error', () => {
    const result = project(
      targets.resolveTargets({ profiles: ['pandamstyle:default@1'] }).record,
    );
    expect(codes(result.errors)).toEqual([
      'PMS_TARGET_CAPABILITY_INCOMPATIBLE',
    ]);
    expect(result.errors[0].severity).toBe('error');
    expect(result.facts.enforcement).toBe('enforced');
    expect(result.facts.profileStatus[0].status).toBe('failing');
  });

  test('the bounded build-report section caps the failing list', () => {
    const facts = {
      digest: 'sha256:f',
      resolutionDigest: 'sha256:r',
      enforcement: 'enforced',
      profileStatus: [],
      counts: {},
      features: Array.from({ length: 40 }, (_, i) => ({
        feature: `property:p${String(i).padStart(2, '0')}`,
        required: true,
        profiles: [{ ref: 'r', state: 'unknown' }],
      })),
    };
    const section = targets.targetReportSection(facts);
    expect(section).toMatchObject({
      kind: 'pandamstyle-target-report',
      schemaVersion: 1,
      failingTotal: 40,
      failingTruncated: true,
    });
    expect(section.failing).toHaveLength(32);
  });
});

describe('executed evidence (schema only; records come from #81)', () => {
  const evidence = (engine, extra = {}) => ({
    class: 'E4',
    fixtureId: 'CE-FX-1',
    feature: 'value:text-wrap/pretty',
    result: 'pass',
    engine: { version: '18.2', build: '20C', ...engine },
    ...extra,
  });

  test('Playwright WebKit is never Safari or Safari on iOS evidence', () => {
    for (const id of ['safari', 'safari_ios']) {
      for (const automation of [
        { driver: 'playwright' },
        { automationEngine: 'Playwright WebKit' },
        { driver: 'webkitgtk MiniBrowser' },
      ]) {
        const record = evidence({
          id,
          device: id === 'safari_ios' ? 'real-device' : 'desktop',
          ...automation,
        });
        expect(targets.evidenceProblems(record)).toContain(
          'webkit-port-is-not-safari',
        );
        expect(targets.evidenceBasis(record)).toBeNull();
        expect(targets.evidenceSupports('executed-simulator', id, record)).toBe(
          false,
        );
      }
    }
  });

  test('the iOS Simulator is labelled as such and never counts as a real device', () => {
    const simulator = evidence({ id: 'safari_ios', device: 'simulator' });
    expect(targets.evidenceProblems(simulator)).toEqual([]);
    expect(targets.evidenceBasis(simulator)).toBe('executed-simulator');
    expect(
      targets.evidenceSupports('executed-simulator', 'safari_ios', simulator),
    ).toBe(true);
    expect(targets.evidenceSupports('executed', 'safari_ios', simulator)).toBe(
      false,
    );
    const device = evidence({ id: 'safari_ios', device: 'real-device' });
    expect(targets.evidenceBasis(device)).toBe('executed');
    expect(targets.evidenceSupports('executed', 'safari_ios', device)).toBe(
      true,
    );
  });

  test('desktop Safari and headless runs are not Safari on iOS evidence', () => {
    for (const device of ['desktop', 'headless']) {
      expect(
        targets.evidenceProblems(evidence({ id: 'safari_ios', device })),
      ).toContain('ios-requires-device-or-simulator');
    }
    const desktop = evidence({ id: 'safari', device: 'desktop' });
    expect(targets.evidenceSupports('executed', 'safari_ios', desktop)).toBe(
      false,
    );
    expect(
      targets.evidenceProblems(evidence({ id: 'safari', device: 'simulator' })),
    ).toContain('simulator-is-ios-only');
  });

  test('an engine is identified exactly', () => {
    expect(
      targets.evidenceProblems(evidence({ id: 'webkit', device: 'desktop' })),
    ).toContain('engine-id');
    expect(
      targets.evidenceProblems(
        evidence({ id: 'chrome', device: 'desktop', build: '' }),
      ),
    ).toContain('engine-build');
    expect(
      targets.evidenceSupports(
        'executed',
        'chrome',
        evidence({ id: 'chrome', device: 'desktop' }, { result: 'fail' }),
      ),
    ).toBe(false);
  });
});

describe('incremental accumulation equals a fresh evaluation', () => {
  const page = (file, css) =>
    targets.summarizeSources([
      { owner: { role: 'page', file, line: 1, column: 1 }, css },
    ]);
  const canonical = ({ uses }) =>
    JSON.stringify(
      [...uses.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, use]) => [
          key,
          use.occurrences,
          [...use.owners.keys()].sort(),
          Object.entries(use.roles)
            .filter(([, n]) => n > 0)
            .sort(),
        ]),
    );

  test('after adds, changes and removals the sums equal a fresh accumulator', () => {
    const a = page('/a.js', '.a{color:red;text-wrap:pretty}');
    const b1 = page('/b.js', '.b{display:inline flex}');
    const b2 = page('/b.js', '.b{display:flex;color:blue}');
    const c = page('/c.js', '.c{text-wrap:balance}');
    const steps = [
      [
        ['/a.js', a],
        ['/b.js', b1],
      ],
      [
        ['/a.js', a],
        ['/b.js', b2],
        ['/c.js', c],
      ],
      [
        ['/b.js', b2],
        ['/c.js', c],
      ],
      [
        ['/c.js', c],
        ['/a.js', a],
      ],
      [],
    ];
    const incremental = targets.createTargetAccumulator();
    let previous = -1;
    for (const step of steps) {
      const result = incremental.sync(step);
      expect(result.version).toBeGreaterThan(previous);
      previous = result.version;
      expect(canonical(result)).toBe(
        canonical(targets.createTargetAccumulator().sync(step)),
      );
    }
    // An identical revision costs nothing and keeps the version.
    expect(incremental.sync([]).version).toBe(previous);
  });

  test('the session evaluation reuses its previous result when nothing changed', () => {
    const accumulator = targets.createTargetAccumulator();
    const units = [['/a.js', page('/a.js', '.a{text-wrap:pretty}')]];
    const first = targets.evaluateTargets({
      resolution: DEFAULT,
      units,
      accumulator,
    });
    const second = targets.evaluateTargets({
      resolution: DEFAULT,
      units,
      accumulator,
    });
    expect(second).toBe(first);
    const fresh = targets.evaluateTargets({ resolution: DEFAULT, units });
    expect(fresh.facts).toEqual(first.facts);
    expect(fresh.errors).toEqual(first.errors);
  });
});

describe('recompiled pages with unchanged content', () => {
  test('keep their summary; a changed page is re-read', () => {
    const accumulator = targets.createTargetAccumulator();
    const designSystem = {
      registry: { enhancements: [], conditions: {}, conditionOrder: [] },
    };
    const evaluate = (rules) =>
      targets.evaluateProjectTargets({
        resolution: DEFAULT,
        designSystem,
        designSystemRules: [],
        pages: [{ file: '/app/p.js', rules, ruleOrigins: [] }],
        accumulator,
      });
    const rule = (css) => [['x1', { ltr: css, rtl: null }]];
    const first = evaluate(rule('.x1{text-wrap:pretty}'));
    // A new rule list with the same content: the previous result stands.
    const same = evaluate(rule('.x1{text-wrap:pretty}'));
    expect(same.facts).toBe(first.facts);
    const changed = evaluate(rule('.x1{text-wrap:balance}'));
    expect(changed.facts.features.map((f) => f.feature)).toContain(
      'value:text-wrap/balance',
    );
    expect(changed.facts.features.map((f) => f.feature)).not.toContain(
      'value:text-wrap/pretty',
    );
  });
});
