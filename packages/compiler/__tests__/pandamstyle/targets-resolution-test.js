/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

/**
 * CE-01.1 (#44) AC1: target resolution, provenance and schema are versioned
 * and deterministic.
 *
 * Every expected value here was observed by running the resolver first.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadCompiler } = require('./session-helpers');

const INSPECTION = path.resolve(
  __dirname,
  '../../../../.pms-test-support/compiler-inspection.cjs',
);
const { targets } = loadCompiler();

const project = (query, extra = {}) => ({
  profiles: ['project:app'],
  define: { app: { query, ...extra } },
});

function refusal(config) {
  try {
    targets.resolveTargets(config);
  } catch (error) {
    return error.diagnostics;
  }
  throw new Error(`expected ${JSON.stringify(config)} to be refused`);
}

describe('resolution record', () => {
  test('is versioned, names its data and never consults ambient sources', () => {
    const { record, diagnostics } = targets.resolveTargets(null);
    expect(record.kind).toBe('pandamstyle-target-resolution');
    expect(record.schemaVersion).toBe(1);
    expect(record.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record.provenance.origin).toBe('default');
    expect(record.provenance.ambientSourcesConsulted).toEqual([]);
    expect(diagnostics).toEqual([]);
    expect(record.data.pinned).toBe(true);
    for (const [name, version] of Object.entries(targets.DATA_PINS)) {
      expect(record.data[name].version).toBe(version);
      expect(record.data[name].digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(targets.DATA_PINS).toEqual({
      browserslist: '4.28.0',
      'caniuse-lite': '1.0.30001799',
      'electron-to-chromium': '1.5.459',
      'baseline-browser-mapping': '2.11.23',
    });
    expect(record.data.browserslistOptions).toEqual({
      config: false,
      ignoreUnknownVersions: false,
      mobileToDesktop: true,
      stats: 'fixed-empty',
    });
    expect(record.data.compatData.bcd.version).toBe('8.1.6');
    expect(record.data.compatData.digest).toMatch(/^sha256:/);
    expect(record.data.caveatReviewsDigest).toMatch(/^sha256:/);
    expect(Object.isFrozen(record)).toBe(true);
  });

  test('the same configuration resolves to the same record twice', () => {
    const a = targets.resolveTargets({
      profiles: ['pandamstyle:default@1', 'project:app'],
      define: { app: { query: 'defaults' } },
    });
    const b = targets.resolveTargets({
      define: { app: { query: 'defaults' } },
      profiles: ['pandamstyle:default@1', 'project:app'],
    });
    expect(b.record).toEqual(a.record);
    expect(b.record.digest).toBe(a.record.digest);
  });

  test('provenance separates the implicit default from a declared one', () => {
    const implicit = targets.resolveTargets(null).record;
    const declared = targets.resolveTargets({
      profiles: ['pandamstyle:default@1'],
    }).record;
    expect(declared.provenance.origin).toBe('project-config');
    expect(declared.profiles).toEqual(implicit.profiles);
    expect(declared.digest).not.toBe(implicit.digest);
  });

  test('the built-in profiles resolve to the frozen engines and floors', () => {
    const { record } = targets.resolveTargets({
      profiles: [...targets.BUILTIN_PROFILE_REFS],
    });
    const summary = Object.fromEntries(
      record.profiles.map((p) => [
        p.ref,
        {
          platform: p.platform,
          engines: p.engines.map((e) => [
            e.engine,
            e.dataEngine,
            e.floor,
            e.basis,
          ]),
          excluded: p.excluded.length,
        },
      ]),
    );
    expect(summary).toEqual({
      'pandamstyle:default@1': {
        platform: null,
        engines: [
          ['chrome', 'chrome', '120', 'declared'],
          ['chrome_android', 'chrome_android', '120', 'declared'],
          ['edge', 'edge', '120', 'declared'],
          ['firefox', 'firefox', '121', 'declared'],
          ['firefox_android', 'firefox_android', '121', 'declared'],
          ['safari', 'safari', '18.2', 'declared'],
          ['safari_ios', 'safari_ios', '18.2', 'declared'],
        ],
        excluded: 0,
      },
      'pandamstyle:ios-safari@1': {
        platform: null,
        engines: [['safari_ios', 'safari_ios', '18.2', 'declared']],
        excluded: 0,
      },
      'pandamstyle:electron@1': {
        platform: 'electron',
        engines: [['electron', 'chrome', '152', 'derived-from-electron']],
        excluded: 0,
      },
      'pandamstyle:android-webview@1': {
        platform: null,
        engines: [['webview_android', 'webview_android', '120', 'declared']],
        excluded: 0,
      },
    });
    expect(targets.BUILTIN_PROFILES['pandamstyle:default@1'].query).toBe(
      'chrome >= 120, edge >= 120, firefox >= 121, and_chr >= 120, and_ff >= 121, safari >= 18.2, ios_saf >= 18.2',
    );
    expect(targets.BUILTIN_PROFILES['pandamstyle:electron@1']).toEqual({
      query: 'electron 44.7',
      platform: 'electron',
    });
  });
});

describe('determinism against ambient inputs', () => {
  test('a separate process with planted config, stats, env and a future clock resolves identically', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-targets-ambient-'));
    fs.writeFileSync(path.join(dir, '.browserslistrc'), 'ie 6\n');
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'planted', browserslist: ['ie 7'] }),
    );
    fs.writeFileSync(
      path.join(dir, 'browserslist-stats.json'),
      JSON.stringify({ ie: { 8: 99 } }),
    );
    // The clock is moved past every release in the pinned data, so the
    // stale-data warning would fire and any clock read would shift.
    fs.writeFileSync(
      path.join(dir, 'clock.cjs'),
      [
        'const RealDate = Date;',
        'const NOW = RealDate.UTC(2031, 5, 1);',
        'class FakeDate extends RealDate {',
        '  constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }',
        '  static now() { return NOW; }',
        '}',
        'global.Date = FakeDate;',
      ].join('\n'),
    );
    const configs = [
      null,
      { profiles: [...targets.BUILTIN_PROFILE_REFS] },
      project('defaults'),
      project('> 0.5%, last 2 versions, firefox esr'),
      project('baseline 2024 with downstream'),
    ];
    const script = `
      const { targets } = require(${JSON.stringify(INSPECTION)});
      const configs = ${JSON.stringify(configs)};
      process.stdout.write(JSON.stringify(configs.map((c) => {
        const { record, diagnostics } = targets.resolveTargets(c);
        return { record, diagnostics: diagnostics.map((d) => d.rule) };
      })));
    `;
    const child = spawnSync(
      process.execPath,
      ['--require', path.join(dir, 'clock.cjs'), '-e', script],
      {
        cwd: dir,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          BROWSERSLIST: 'ie 8',
          BROWSERSLIST_CONFIG: path.join(dir, '.browserslistrc'),
          BROWSERSLIST_STATS: path.join(dir, 'browserslist-stats.json'),
          BROWSERSLIST_ENV: 'legacy',
          BROWSERSLIST_DANGEROUS_EXTEND: '1',
          NODE_ENV: 'production',
        },
      },
    );
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    const inChild = JSON.parse(child.stdout);
    const here = configs.map((c) => {
      const { record, diagnostics } = targets.resolveTargets(c);
      return {
        record: JSON.parse(JSON.stringify(record)),
        diagnostics: diagnostics.map((d) => d.rule),
      };
    });
    expect(inChild).toEqual(here);
    for (const entry of inChild) {
      expect(entry.record.provenance.ambientSourcesConsulted).toEqual([]);
      for (const profile of entry.record.profiles) {
        // The planted inputs name ie 6, 7 and 8; none of them leaks in.
        expect(profile.browsers.some((b) => /^ie [678]$/.test(b))).toBe(false);
      }
    }
  });
});

describe('refused query terms', () => {
  test.each([
    ['last 2 years', 'targets.query.clock', 'last_years'],
    ['since 2020', 'targets.query.clock', 'since_y'],
    ['since 2020-01', 'targets.query.clock', 'since_y_m'],
    ['since 2020-01-01', 'targets.query.clock', 'since_y_m_d'],
    ['baseline widely available', 'targets.query.clock', 'baseline'],
    ['baseline newly available', 'targets.query.clock', 'baseline'],
    ['maintained node versions', 'targets.query.clock', 'maintained_node'],
    ['current node', 'targets.query.ambient', 'current_node'],
    ['browserslist config', 'targets.query.ambient', 'browserslist_config'],
    ['extends browserslist-config-acme', 'targets.query.ambient', 'extends'],
    ['> 1% in my stats', 'targets.query.ambient', 'popularity_in_my_stats'],
    [
      '> 1% in browserslist-config-acme stats',
      'targets.query.ambient',
      'popularity_in_config_stats',
    ],
    // A combined query is refused for its refused term.
    ['defaults, last 2 years', 'targets.query.clock', 'last_years'],
    ['chrome >= 120 and not since 2020', 'targets.query.clock', 'since_y'],
  ])('%s', (query, rule, type) => {
    const diagnostics = refusal(project(query));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: 'PMS_INVALID_TARGET_CONFIG',
      severity: 'error',
      phase: 'targets',
      rule,
      context: { type, profile: 'project:app' },
    });
  });

  test('a dated Baseline term after the pinned data is refused as clock-dependent', () => {
    // baseline-browser-mapping rejects a year after the wall clock's; the
    // resolver bounds it by the newest release in the pinned data instead.
    for (const query of [
      'baseline 2099',
      'baseline widely available on 2099-01-01',
    ]) {
      expect(refusal(project(query))[0]).toMatchObject({
        code: 'PMS_INVALID_TARGET_CONFIG',
        rule: 'targets.query.clock',
        context: { type: 'baseline' },
      });
    }
    expect(() =>
      targets.resolveTargets(project('baseline 2024')),
    ).not.toThrow();
  });

  test('standard queries are accepted', () => {
    for (const query of [
      'defaults',
      '> 0.5%',
      'last 2 versions',
      'firefox esr',
      'baseline 2024',
    ]) {
      const { record } = targets.resolveTargets(project(query));
      expect(record.profiles[0].engines.length).toBeGreaterThan(0);
    }
  });
});

describe('engines PandamStyle does not announce', () => {
  test('obsolete engines are excluded with a warning', () => {
    const { record, diagnostics } = targets.resolveTargets(
      project('ie 11, chrome 120'),
    );
    expect(record.profiles[0].engines.map((e) => e.engine)).toEqual(['chrome']);
    expect(record.profiles[0].excluded).toEqual([
      { browser: 'ie', version: '11', disposition: 'obsolete' },
    ]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: 'PMS_INCOMPATIBLE_TARGET_ENGINE',
      severity: 'warning',
      rule: 'targets.engine.obsolete',
      context: { profile: 'project:app', limitation: 'LIM-05' },
    });
  });

  test('unannounced engines are excluded with a warning', () => {
    const { record, diagnostics } = targets.resolveTargets(
      project('chrome 120, samsung 25'),
    );
    expect(record.profiles[0].excluded).toEqual([
      { browser: 'samsung', version: '25', disposition: 'unannounced' },
    ]);
    expect(diagnostics[0]).toMatchObject({
      code: 'PMS_INCOMPATIBLE_TARGET_ENGINE',
      severity: 'warning',
      rule: 'targets.engine.unannounced',
    });
  });

  test('`defaults` keeps its exclusions visible', () => {
    const { record, diagnostics } = targets.resolveTargets(project('defaults'));
    expect(record.profiles[0].excluded.length).toBeGreaterThan(0);
    expect(diagnostics.map((d) => d.severity)).toEqual(['warning']);
  });

  test.each([['ie 11'], ['ie 11, op_mini all'], ['node 20']])(
    'a profile with no announced engine is an error: %s',
    (query) => {
      const [error] = refusal(project(query));
      expect(error).toMatchObject({
        code: 'PMS_INCOMPATIBLE_TARGET_ENGINE',
        severity: 'error',
        rule: 'targets.engine.none-announced',
        context: { profile: 'project:app' },
      });
    },
  );
});

describe('invalid configurations', () => {
  test.each([
    ['not an object', 'chrome 120', 'targets.config'],
    ['an array', ['pandamstyle:default@1'], 'targets.config'],
    ['no profiles', {}, 'targets.config'],
    ['empty profiles', { profiles: [] }, 'targets.config'],
    [
      'unknown field',
      { profiles: ['pandamstyle:default@1'], floor: 1 },
      'targets.config',
    ],
    [
      'duplicate profile',
      { profiles: ['pandamstyle:default@1', 'pandamstyle:default@1'] },
      'targets.config',
    ],
    [
      'unknown built-in profile',
      { profiles: ['pandamstyle:default@2'] },
      'targets.profile.unknown',
    ],
    [
      'undefined project profile',
      { profiles: ['project:missing'] },
      'targets.profile.unknown',
    ],
    ['definition without query', project(undefined), 'targets.config'],
    [
      'definition with an unknown field',
      project('chrome 120', { floor: '120' }),
      'targets.config',
    ],
    [
      'definition with an unknown platform',
      project('chrome 120', { platform: 'tauri' }),
      'targets.config',
    ],
    ['unparsable query', project('nonsense!!'), 'targets.query.resolution'],
  ])('%s', (_label, config, rule) => {
    const diagnostics = refusal(config);
    expect(diagnostics.some((d) => d.rule === rule)).toBe(true);
    for (const d of diagnostics) {
      expect(d.code).toBe('PMS_INVALID_TARGET_CONFIG');
      expect(d.severity).toBe('error');
    }
  });

  test('an unknown profile lists the candidates', () => {
    const [error] = refusal({
      profiles: ['pandamstyle:defualt@1'],
      define: { mine: { query: 'chrome 120' } },
    });
    expect(error.context.candidates).toEqual([
      ...targets.BUILTIN_PROFILE_REFS,
      'project:mine',
    ]);
  });
});

describe('precomputed built-in resolutions', () => {
  test('every precomputed list equals a live Browserslist resolution with the pinned data', () => {
    const { packages } = targets.dataPackages();
    expect(targets.BUILTIN_RESOLUTIONS.data).toEqual(packages);
    for (const ref of targets.BUILTIN_PROFILE_REFS) {
      const { query } = targets.BUILTIN_PROFILES[ref];
      expect(targets.precomputedBrowsers(ref, query)).toEqual(
        targets.liveBrowsers(query),
      );
    }
  });

  test('a different data identity or query never reads a precomputed list', () => {
    const { packages } = targets.dataPackages();
    const ref = 'pandamstyle:default@1';
    const { query } = targets.BUILTIN_PROFILES[ref];
    for (const name of Object.keys(packages)) {
      for (const field of ['version', 'digest']) {
        const changed = {
          ...packages,
          [name]: { ...packages[name], [field]: 'other' },
        };
        expect(targets.precomputedBrowsers(ref, query, changed)).toBeNull();
      }
    }
    expect(targets.precomputedBrowsers(ref, 'chrome >= 99')).toBeNull();
    expect(targets.precomputedBrowsers('project:app', query)).toBeNull();
  });

  test('built-in profiles resolve without loading Browserslist; a project query loads it', () => {
    const script = `
      const { targets } = require(${JSON.stringify(INSPECTION)});
      const loaded = () => Object.keys(require.cache).some((k) => /[\\\\/]browserslist[\\\\/]index\\.js$/.test(k));
      targets.resolveTargets({ profiles: [...targets.BUILTIN_PROFILE_REFS] });
      const afterBuiltin = loaded();
      targets.resolveTargets({ profiles: ['project:a'], define: { a: { query: 'chrome 120' } } });
      process.stdout.write(JSON.stringify([afterBuiltin, loaded()]));
    `;
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
    });
    expect(child.stderr).toBe('');
    expect(JSON.parse(child.stdout)).toEqual([false, true]);
  });
});
