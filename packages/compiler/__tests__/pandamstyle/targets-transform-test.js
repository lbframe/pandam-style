/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

/**
 * CE-01.2 (#45): the compiler-owned transformation stage.
 *
 *   - the transform table: every entry admissible with a proof, and any
 *     unknown or incomplete rewrite refused (class-level mutations);
 *   - the proof obligations of every entry, executed on the pinned data and
 *     the CE-00.1 registry;
 *   - the rewrite class over the whole admitted vocabulary: the stage inserts
 *     table variants and changes nothing else;
 *   - extraction and outcome: the pair is `transformed-with-proof` only where
 *     the variant's own statements are native, with mutation checks;
 *   - end to end (TX-5, TX-6): enforced default profile, CSS bytes, source
 *     map, digests, manifest requirements and the incremental oracle.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { TraceMap, eachMapping } = require('@jridgewell/trace-mapping');
const {
  differential,
  loadCompiler,
  openProject,
} = require('./session-helpers');

const REPO = path.resolve(__dirname, '../../../..');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const compiler = loadCompiler();
const { targets } = compiler;
const TABLE = readJson(
  path.join(REPO, 'packages/compiler/src/targets/catalog/transforms.v1.json'),
);
const REGISTRY = readJson(
  path.join(REPO, 'docs/research/core-evolution-registry.v1.json'),
);
const BROWSER_TEST = fs.readFileSync(
  path.join(__dirname, 'targets-transform-browser-test.js'),
  'utf8',
);
const ENFORCED = { profiles: ['pandamstyle:default@1'] };
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
const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
// The admitted property domains, read from a canonical snapshot (CE-02.1).
const propertyDomains = compiler.repairDomainOf(
  compiler.buildDesignSystem({ systemId: 'transform-domains', tokens: {} })
    .snapshot,
  { kind: 'property' },
);
const admittedValuesOf = (property) =>
  Object.hasOwn(propertyDomains, property)
    ? propertyDomains[property].values
    : [];
const clone = (value) => JSON.parse(JSON.stringify(value));

function outcomesOf(record, query) {
  const { record: resolution } = targets.resolveTargets(query);
  return targets
    .profileOutcomes(record, resolution)
    .flatMap((profile) => profile.engines);
}
const recordsOf = (css) => targets.featuresOfCss(css).map((e) => e.record);

describe('the transform table (catalog/transforms.v1.json)', () => {
  test('is admissible, and its entries are exactly the reviewed inventory', () => {
    expect(targets.transformTableProblems(TABLE)).toEqual([]);
    // A new rewrite is added here together with its proof and fixtures.
    expect(TABLE.entries.map((e) => e.id)).toEqual([
      'prefix-alias:user-select:-webkit-',
    ]);
    expect(targets.transformTable()).toEqual(TABLE);
  });

  test('every proof names fixtures that exist and an executed E4 test', () => {
    for (const entry of TABLE.entries) {
      for (const fixture of entry.proof.fixtures) {
        expect({
          fixture,
          inBrowserTest: BROWSER_TEST.includes(fixture),
        }).toEqual({ fixture, inBrowserTest: true });
      }
      for (const executed of entry.proof.evidence.executed) {
        expect(fs.existsSync(path.join(REPO, executed.test))).toBe(true);
      }
      // Safari has no executed evidence here: it is deferred, never inferred.
      const deferred = entry.proof.evidence.deferred.flatMap((d) => d.engines);
      expect(deferred).toEqual(
        expect.arrayContaining(['safari', 'safari_ios']),
      );
      expect(entry.proof.evidence.deferred.every((d) => d.issue === 81)).toBe(
        true,
      );
    }
  });

  const MUTATIONS = {
    'unknown kind': (e) => {
      e.kind = 'lowering';
    },
    'no proof': (e) => {
      delete e.proof;
    },
    'empty rationale': (e) => {
      e.proof.rationale = ' ';
    },
    'no fixtures': (e) => {
      e.proof.fixtures = [];
    },
    'no executed evidence': (e) => {
      e.proof.evidence.executed = [];
    },
    'executed evidence of another class': (e) => {
      e.proof.evidence.executed[0].class = 'E3';
    },
    'deferral without an issue': (e) => {
      delete e.proof.evidence.deferred[0].issue;
    },
    'variant is not prefix + property': (e) => {
      e.variant = '-webkit-user-modify';
    },
    'unknown prefix': (e) => {
      e.prefix = '-ms-';
      e.variant = '-ms-user-select';
    },
    'no values': (e) => {
      e.values = [];
    },
    'a value that is not a keyword': (e) => {
      e.values = ['none;color:red'];
    },
  };
  test.each(Object.keys(MUTATIONS))('a table with %s is refused', (name) => {
    const table = clone(TABLE);
    MUTATIONS[name](table.entries[0]);
    expect(targets.transformTableProblems(table)).not.toEqual([]);
    expect(() => targets.compileTransformTable(table)).toThrow(
      /transform table is not admissible/,
    );
  });

  test('a duplicated entry or a property in two entries is refused', () => {
    const table = clone(TABLE);
    table.entries.push(clone(TABLE.entries[0]));
    expect(targets.transformTableProblems(table)).toEqual(
      expect.arrayContaining([expect.stringMatching(/id/)]),
    );
    table.entries[1].id = 'another';
    expect(targets.transformTableProblems(table)).toEqual(
      expect.arrayContaining([expect.stringMatching(/in two entries/)]),
    );
  });
});

describe('proof obligations of every entry, executed', () => {
  const minimum = targets.MINIMUM_FLOOR.engines;
  const data = targets.compatData();

  test.each(TABLE.entries.map((e) => [e.id, e]))(
    '%s: the variant is a CE-00.1 vendor-legacy-variant of the base',
    (_, entry) => {
      const variant = REGISTRY.entries.find((e) => e.name === entry.variant);
      expect(variant).toMatchObject({
        subkind: 'vendor-legacy-variant',
        variantOf: entry.property,
      });
    },
  );

  test.each(TABLE.entries.map((e) => [e.id, e]))(
    '%s: at the O13 floor the variant is native or absent on every engine',
    (_, entry) => {
      const bcdPath = `css.properties.${entry.property}`;
      for (const engine of ENGINES) {
        const statements = data.entry(bcdPath).e[engine] ?? [];
        const prefixed = statements.filter((s) => s.x === entry.prefix);
        const outcome = targets.statementOutcome({
          path: bcdPath,
          engine,
          statements,
          match: { prefix: entry.prefix },
          range: { floor: minimum[engine], upTo: null },
        });
        // Native (an alias or the only form), or no statement: dropped at
        // parse time.
        expect({
          engine,
          ok: outcome.state === 'native' || prefixed.length === 0,
        }).toEqual({ engine, ok: true });
      }
    },
  );

  test.each(TABLE.entries.map((e) => [e.id, e]))(
    '%s: every admitted value of the base is paired',
    (_, entry) => {
      const admitted = admittedValuesOf(camel(entry.property));
      expect(admitted.length).toBeGreaterThan(0);
      for (const value of admitted) expect(entry.values).toContain(value);
    },
  );
});

describe('the rewrite class', () => {
  test.each([
    ['.x{user-select:none}', '.x{-webkit-user-select:none;user-select:none}'],
    [
      '.x:not(#\\#){user-select:none !important}',
      '.x:not(#\\#){-webkit-user-select:none !important;user-select:none !important}',
    ],
    [
      '@media (hover:hover){.x{user-select:text}}',
      '@media (hover:hover){.x{-webkit-user-select:text;user-select:text}}',
    ],
    [
      "html[dir='rtl'] .x{color:red;user-select:all}",
      "html[dir='rtl'] .x{color:red;-webkit-user-select:all;user-select:all}",
    ],
    [
      '.x{ user-select:auto }',
      '.x{ -webkit-user-select:auto ;user-select:auto }',
    ],
  ])('%s is paired', (input, output) => {
    expect(targets.applyTransforms(input)).toBe(output);
    // Idempotent: an already paired declaration is left as is.
    expect(targets.applyTransforms(output)).toBe(output);
  });

  test.each([
    '.x{--user-select:none}',
    '.x{content:"{user-select:none}"}',
    ".x{content:';user-select:none'}",
    '.x{-webkit-user-select:none}',
    '.x{user-select:contain}',
    '.x{color:red}',
  ])('%s is unchanged (the same string)', (input) => {
    expect(targets.applyTransforms(input)).toBe(input);
  });

  test('over the whole admitted structural vocabulary, the stage only inserts table variants', () => {
    const properties = Object.keys(propertyDomains).filter(
      (property) => propertyDomains[property].values.length > 0,
    );
    expect(properties.length).toBeGreaterThan(20);
    let paired = 0;
    for (const property of properties) {
      for (const value of admittedValuesOf(property)) {
        const css = `.x{${kebab(property)}:${value}}`;
        const entry = targets.transformOfProperty(kebab(property));
        const out = targets.applyTransforms(css);
        if (entry == null) {
          expect({ css, out }).toEqual({ css, out: css });
        } else {
          paired += 1;
          expect(out).toBe(
            `.x{${entry.variant}:${value};${kebab(property)}:${value}}`,
          );
        }
      }
    }
    expect(paired).toBe(1);
  });
});

describe('extraction and outcome', () => {
  const pair = '.x{-webkit-user-select:none;user-select:none}';

  test('a pair is one construct of the base; an unpaired or mismatched pair is not', () => {
    expect(recordsOf(pair).map((r) => r.feature)).toEqual([
      'property:user-select/prefix-alias',
      'value:user-select/none',
    ]);
    expect(recordsOf('.x{user-select:none}').map((r) => r.feature)).toEqual([
      'property:user-select',
      'value:user-select/none',
    ]);
    expect(
      recordsOf('.x{-webkit-user-select:text;user-select:none}').map(
        (r) => r.feature,
      ),
    ).toEqual(
      expect.arrayContaining([
        'property:-webkit-user-select',
        'property:user-select',
      ]),
    );
    expect(targets.featureByKey('property:user-select/prefix-alias')).toEqual(
      recordsOf(pair)[0],
    );
    expect(targets.featureByKey('property:color/prefix-alias')).toBeNull();
  });

  test('TX-6: the pair is transformed-with-proof on Safari and iOS only, at the default and O13 floors', () => {
    const [record] = recordsOf(pair);
    for (const query of [
      ENFORCED,
      {
        profiles: ['project:low'],
        define: {
          low: {
            query:
              'chrome >= 100, firefox >= 100, safari >= 15.4, ios_saf >= 15.4',
          },
        },
      },
    ]) {
      const notNative = outcomesOf(record, query).filter(
        (o) => o.state !== 'native',
      );
      expect(notNative.map((o) => o.engine)).toEqual(['safari', 'safari_ios']);
      for (const outcome of notNative) {
        expect(outcome).toMatchObject({
          state: 'transformed-with-proof',
          reason: 'transformation-proven',
          basis: 'compat-data',
          proof: {
            transform: 'prefix-alias:user-select:-webkit-',
            kind: 'prefix-alias',
            variant: '-webkit-user-select',
            data: { state: 'incompatible', reason: 'prefixed-only' },
          },
        });
      }
    }
    // The unpaired declaration keeps the CE-01.1 answer.
    const [base] = recordsOf('.x{user-select:none}');
    expect(
      outcomesOf(base, ENFORCED)
        .filter((o) => o.state !== 'native')
        .map((o) => `${o.engine}:${o.state}/${o.reason}`),
    ).toEqual([
      'safari:incompatible/prefixed-only',
      'safari_ios:incompatible/prefixed-only',
    ]);
  });

  test('mutation: a transform whose variant is not native is never credited', () => {
    const [record] = recordsOf(pair);
    const mutant = {
      ...record,
      transform: {
        ...record.transform,
        prefix: '-moz-',
        variant: '-moz-user-select',
      },
    };
    // featureOutcome directly: profile outcomes are memoized per feature key.
    const { record: resolution } = targets.resolveTargets(ENFORCED);
    const rows = (r) =>
      resolution.profiles[0].engines
        .map((target) =>
          targets.featureOutcome(r, { ...target, platform: null }),
        )
        .filter((o) => o.state !== 'native')
        .map((o) => `${o.engine}:${o.state}`);
    expect(rows(record)).toEqual([
      'safari:transformed-with-proof',
      'safari_ios:transformed-with-proof',
    ]);
    expect(rows(mutant)).toEqual([
      'safari:incompatible',
      'safari_ios:incompatible',
    ]);
    // A record without its transform is the unpaired base.
    const { transform: _dropped, ...untransformed } = record;
    expect(rows(untransformed)).toEqual([
      'safari:incompatible',
      'safari_ios:incompatible',
    ]);
  });

  test('mutation: without the stage the evaluation fails the profile', () => {
    // The extraction reads the transformed text; an identity stage would
    // leave the base unpaired and Safari incompatible.
    const evaluate = (css) =>
      targets.evaluateTargets({
        resolution: targets.resolveTargets(ENFORCED).record,
        sources: [
          { owner: { role: 'page', file: 'a.js', line: 1, column: 1 }, css },
        ],
      });
    expect(evaluate('.x{user-select:none}').errors).toEqual([]);
    expect(targets.applyTransforms('.x{user-select:none}')).toBe(pair);
    // The identity stage (the raw text) leaves Safari incompatible.
    expect(
      targets
        .featuresOfCss('.x{user-select:none}')
        .some(({ record }) =>
          outcomesOf(record, ENFORCED).some((o) => o.state === 'incompatible'),
        ),
    ).toBe(true);
  });

  test('the resolution records the digest of the table', () => {
    const { record } = targets.resolveTargets(ENFORCED);
    expect(record.data.transformsDigest).toBe(
      `sha256:${crypto
        .createHash('sha256')
        .update(targets.stableJson(TABLE))
        .digest('hex')}`,
    );
  });
});

/** The valid fixture with a page style using `userSelect: 'none'`. */
function openWithUserSelect() {
  const h = openProject('valid');
  const page = h.src('src/page.js');
  fs.writeFileSync(
    page,
    fs
      .readFileSync(page, 'utf8')
      .replace(
        'padding: { base: SPACING.md, wide: SPACING.lg },',
        "padding: { base: SPACING.md, wide: SPACING.lg },\n    userSelect: 'none',",
      ),
  );
  return h;
}
const readOut = (h, name) => fs.readFileSync(path.join(h.outDir, name), 'utf8');

describe('end to end (TX-5, TX-6)', () => {
  test('enforced default@1 passes with the transformed declaration', () => {
    const h = openWithUserSelect();
    h.setBuildOption('targets', ENFORCED);
    const validation = h.revise({ config: { targets: ENFORCED } });
    expect(validation.ok).toBe(true);
    expect(
      validation.diagnostics.filter((d) =>
        String(d.context?.feature ?? '').includes('user-select'),
      ),
    ).toEqual([]);
    h.session.compile();
    const css = readOut(h, 'styles.css');
    expect(css).toContain('{-webkit-user-select:none;user-select:none}');
    const manifest = JSON.parse(readOut(h, 'manifest.json'));
    const report = JSON.parse(readOut(h, 'build-report.json')).targets;
    expect(report.profiles).toEqual([
      { ref: 'pandamstyle:default@1', status: 'passing' },
    ]);
    // The page's feature is not a design-system requirement.
    expect(manifest.targetRequirements.features).not.toContain(
      'property:user-select',
    );
  });

  test('CSS bytes do not depend on targets', () => {
    const bytes = [
      null,
      ENFORCED,
      { profiles: ['pandamstyle:ios-safari@1'] },
    ].map((targetConfig) => {
      const h = openWithUserSelect();
      h.setBuildOption('targets', targetConfig);
      h.full();
      return readOut(h, 'styles.css');
    });
    expect(bytes[0]).toContain('-webkit-user-select:none;user-select:none');
    expect(bytes[1]).toBe(bytes[0]);
    expect(bytes[2]).toBe(bytes[0]);
  });

  test('TX-5: artifacts.json hashes the transformed bytes and the source map keeps the create() origin', async () => {
    const fixture = openWithUserSelect();
    const project = fixture.openPublicSession();
    try {
      const initial = await project.initialize();
      const validated = await project.validate(initial.revision);
      expect(validated.ok).toBe(true);
      const artifact = await project.readArtifact(
        validated.revision,
        'src/page.js',
      );
      const css = artifact.css[0];
      const line = css.content
        .split('\n')
        .findIndex((text) =>
          text.includes('-webkit-user-select:none;user-select:none'),
        );
      expect(line).toBeGreaterThanOrEqual(0);
      const map = new TraceMap(JSON.parse(css.sourceMap));
      const mapped = [];
      eachMapping(map, (mapping) => {
        if (mapping.generatedLine - 1 === line && mapping.source != null) {
          mapped.push(
            map.sourcesContent[map.sources.indexOf(mapping.source)].split('\n')[
              mapping.originalLine - 1
            ],
          );
        }
      });
      expect(mapped.length).toBeGreaterThan(0);
      expect(mapped[0]).toMatch(/create/);
    } finally {
      await project.close();
    }
    const h = openWithUserSelect();
    h.full();
    const metadata = JSON.parse(readOut(h, 'artifacts.json'));
    const styles = readOut(h, 'styles.css');
    expect(styles).toContain('-webkit-user-select:none;user-select:none');
    expect(metadata.artifacts.css.sha256).toBe(
      crypto.createHash('sha256').update(styles).digest('hex'),
    );
  });

  test('the incremental session equals the fresh oracle across a transformed edit', () => {
    const h = openProject('valid');
    expect(h.revise().ok).toBe(true);
    const page = h.src('src/page.js');
    fs.writeFileSync(
      page,
      fs
        .readFileSync(page, 'utf8')
        .replace(
          'padding: { base: SPACING.md, wide: SPACING.lg },',
          "padding: { base: SPACING.md, wide: SPACING.lg },\n    userSelect: 'none',",
        ),
    );
    const result = differential(h, 'add userSelect');
    expect(result.validation.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });
});
