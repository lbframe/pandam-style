/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

/**
 * CE-01.1 (#44): every cache and memo of target evaluation is invisible.
 *
 * A session evaluation (accumulator, per-key memo, reused page and
 * design-system summaries, facts and serialization caches) must equal a
 * one-shot evaluation of fresh copies of the same inputs, for every edit kind
 * and every parameter change; the caches must drop what a session no longer
 * holds; and each fast path must equal the exact path it stands in for.
 */

const { tokenize } = require('@csstools/css-tokenizer');
const { loadCompiler } = require('./session-helpers');

const { targets } = loadCompiler();
const DEFAULT = targets.resolveTargets(null).record;
const ENFORCED = targets.resolveTargets({
  profiles: ['pandamstyle:default@1'],
}).record;
const ELECTRON = targets.resolveTargets({
  profiles: ['pandamstyle:electron@1'],
}).record;

const clone = (value) => JSON.parse(JSON.stringify(value));
const DATA = JSON.parse(
  require('fs').readFileSync(
    require('path').resolve(
      __dirname,
      '../../src/targets/data/compat-data.v1.json',
    ),
    'utf8',
  ),
);
const rule = (ltr, rtl = null) => ({ ltr, rtl });

/** One revision's inputs, as a session passes them. */
function revision({
  resolution = DEFAULT,
  injected,
  pages,
  enhancements = [],
  useCSSLayers = false,
}) {
  return { resolution, injected, pages, enhancements, useCSSLayers };
}

function evaluateRevision(input, accumulator) {
  return targets.evaluateProjectTargets({
    resolution: input.resolution,
    designSystem: {
      registry: {
        enhancements: input.enhancements,
        conditions: {},
        conditionOrder: [],
      },
      injected: input.injected,
    },
    designSystemRules: [],
    pages: input.pages,
    useCSSLayers: input.useCSSLayers,
    accumulator,
  });
}

/** A one-shot evaluation of copies: no identity-keyed cache can apply. */
function fresh(input) {
  return evaluateRevision(
    {
      ...input,
      injected: clone(input.injected),
      pages: input.pages.map((page) => ({
        file: page.file,
        rules: clone(page.rules),
        ruleOrigins: clone(page.ruleOrigins),
      })),
      enhancements: clone(input.enhancements),
    },
    null,
  );
}

function expectSame(actual, expected) {
  expect(actual.facts).toEqual(expected.facts);
  expect(actual.facts.digest).toBe(expected.facts.digest);
  expect(actual.errors).toEqual(expected.errors);
  expect(actual.warnings).toEqual(expected.warnings);
}

const page = (file, css, line = 1) => ({
  file,
  rules: [['x1', rule(css)]],
  ruleOrigins: [{ className: 'x1', line, column: 4 }],
});

const DEGRADE_BALANCE = [
  { feature: 'value:text-wrap/balance', fallback: { kind: 'degrade' } },
];

// Each step is one edit kind applied to the previous revision.
const STEPS = [
  [
    'initial build',
    () =>
      revision({
        injected: {
          k1: rule('.k1{color:oklch(from red l c h)}'),
          k2: rule('.k2{display:flex}'),
        },
        pages: [
          page('/app/a.js', '.x1{text-wrap:pretty}'),
          page('/app/b.js', '.x1{display:inline flex}'),
        ],
      }),
  ],
  [
    'token value edit (same features, new design-system texts)',
    (r) => ({
      ...r,
      injected: {
        ...r.injected,
        k1: rule('.k1{color:oklch(from blue l c h)}'),
      },
    }),
  ],
  [
    'theme edit (a new design-system rule; pages recompiled unchanged)',
    (r) => ({
      ...r,
      injected: { ...r.injected, t1: rule('.t1{--c:red}') },
      pages: r.pages.map((p) => page(p.file, p.rules[0][1].ltr)),
    }),
  ],
  [
    'recipe edit (design-system structure changes)',
    (r) => ({
      ...r,
      injected: { ...r.injected, k2: rule('.k2{display:grid;inset:0}') },
    }),
  ],
  [
    'local style edit',
    (r) => ({
      ...r,
      pages: [page('/app/a.js', '.x1{text-wrap:pretty;inset:0}'), r.pages[1]],
    }),
  ],
  [
    'location-only edit',
    (r) => ({
      ...r,
      pages: [
        page('/app/a.js', '.x1{text-wrap:pretty;inset:0}', 9),
        r.pages[1],
      ],
    }),
  ],
  [
    'page added',
    (r) => ({
      ...r,
      pages: [...r.pages, page('/app/c.js', '.x1{text-wrap:pretty}')],
    }),
  ],
  [
    // The same rule list under another file (a host may reuse it).
    'page renamed (a failing page, so its location is reported)',
    (r) => ({
      ...r,
      pages: r.pages.map((p) =>
        p.file === '/app/a.js' ? { ...p, file: '/app/a2.js' } : p,
      ),
    }),
  ],
  [
    'page deleted',
    (r) => ({ ...r, pages: r.pages.filter((p) => p.file !== '/app/a2.js') }),
  ],
  [
    'design-system rule removed',
    (r) => {
      const { t1: _t1, ...injected } = r.injected;
      return { ...r, injected };
    },
  ],
  ['targets made explicit', (r) => ({ ...r, resolution: ENFORCED })],
  ['targets changed', (r) => ({ ...r, resolution: ELECTRON })],
  [
    'data identity changed (same profiles, another resolution digest)',
    (r) => ({
      ...r,
      resolution: { ...DEFAULT, digest: `sha256:${'0'.repeat(64)}` },
    }),
  ],
  ['targets back to the default', (r) => ({ ...r, resolution: DEFAULT })],
  [
    'enhancement policy declared',
    (r) => ({ ...r, enhancements: DEGRADE_BALANCE }),
  ],
  ['useCSSLayers changed', (r) => ({ ...r, useCSSLayers: true })],
  [
    'page restored after deletion',
    (r) => ({
      ...r,
      enhancements: [],
      pages: [...r.pages, page('/app/a.js', '.x1{text-wrap:pretty}')],
    }),
  ],
  ['no change', (r) => r],
];

describe('a session evaluation equals a fresh one', () => {
  test('after every edit kind, targets change and data identity change', () => {
    const accumulator = targets.createTargetAccumulator();
    let input = null;
    let previous = null;
    for (const [name, edit] of STEPS) {
      input = edit(input);
      const incremental = evaluateRevision(input, accumulator);
      try {
        expectSame(incremental, fresh(input));
      } catch (error) {
        error.message = `${name}\n${error.message}`;
        throw error;
      }
      if (name.startsWith('page renamed')) {
        // The renamed page's finding is reported at its new location.
        const sources = incremental.warnings.map((d) => String(d.source));
        expect(sources.some((source) => source.includes('/app/a2.js'))).toBe(
          true,
        );
        expect(sources.some((source) => source.includes('/app/a.js'))).toBe(
          false,
        );
      }
      if (name === 'no change') expect(incremental.facts).toBe(previous.facts);
      previous = incremental;
    }
  });

  test('a token value edit in a failing design-system feature updates its diagnostic', () => {
    const accumulator = targets.createTargetAccumulator();
    const at = (color) =>
      revision({
        resolution: ENFORCED,
        injected: { k1: rule(`.k1{color:oklch(from ${color} l c h)}`) },
        pages: [],
      });
    const value = (result) =>
      result.errors.find((d) => d.context.feature === 'function:oklch/relative')
        ?.context.value;
    const red = evaluateRevision(at('red'), accumulator);
    expect(value(red)).toBe('oklch(from red l c h)');
    const blue = evaluateRevision(at('blue'), accumulator);
    expect(value(blue)).toBe('oklch(from blue l c h)');
    // The features did not change: the facts are kept, the diagnostics move.
    expect(blue.facts).toBe(red.facts);
    expectSame(blue, fresh(at('blue')));
  });
});

describe('design-system facts memo', () => {
  const facts = (injected, enhancements = []) =>
    targets.designSystemTargetFacts({
      resolution: DEFAULT,
      summary: targets.unitSummary(injected, () =>
        Object.values(injected).map(({ ltr }) => ({
          owner: {
            role: 'design-system',
            file: null,
            line: null,
            column: null,
          },
          css: ltr,
        })),
      ),
      enhancements,
    });
  const oneShot = (injected, enhancements = []) =>
    targets.evaluateTargets({
      resolution: DEFAULT,
      sources: Object.values(injected).map(({ ltr }) => ({
        owner: { role: 'design-system', file: null, line: null, column: null },
        css: ltr,
      })),
      enhancements,
    }).facts;

  test('keeps facts while the structure is unchanged and equals a fresh evaluation', () => {
    const red = { k: rule('.k{color:oklch(from red l c h)}') };
    const blue = { k: rule('.k{color:oklch(from blue l c h)}') };
    const grid = { k: rule('.k{display:grid}') };
    expect(facts(blue)).toBe(facts(red));
    expect(facts(red)).toEqual(oneShot(red));
    expect(facts(grid)).toEqual(oneShot(grid));
    expect(facts(grid).digest).not.toBe(facts(red).digest);
    // Enhancements are part of the key.
    const policy = [
      { feature: 'function:oklch/relative', fallback: { kind: 'degrade' } },
    ];
    expect(facts(red, policy)).toEqual(oneShot(red, policy));
    expect(facts(red, policy).digest).not.toBe(facts(red).digest);
  });
});

describe('retention', () => {
  test('the accumulator drops deleted and renamed files', () => {
    const accumulator = targets.createTargetAccumulator();
    const base = revision({
      injected: { k: rule('.k{display:flex}') },
      pages: [
        page('/app/a.js', '.x1{text-wrap:pretty}'),
        page('/app/b.js', '.x1{display:grid}'),
      ],
    });
    evaluateRevision(base, accumulator);
    // Design system, intrinsic and two pages; one content key per page.
    expect(accumulator.retained()).toMatchObject({ units: 4, contentKeys: 2 });
    for (let i = 0; i < 20; i += 1) {
      evaluateRevision(
        {
          ...base,
          pages: [
            { ...base.pages[0], file: `/app/renamed-${i}.js` },
            base.pages[1],
          ],
        },
        accumulator,
      );
    }
    expect(accumulator.retained()).toMatchObject({ units: 4, contentKeys: 2 });
    evaluateRevision({ ...base, pages: [] }, accumulator);
    expect(accumulator.retained()).toEqual({
      units: 2,
      contentKeys: 0,
      uses: expect.any(Number),
    });
    const empty = evaluateRevision({ ...base, pages: [] }, null);
    expect(accumulator.retained().uses).toBe(empty.facts.features.length);
  });

  test('the extraction caches are bounded and evicted together', () => {
    let maxTexts = 0;
    let maxConstructs = 0;
    let evicted = false;
    let previous = targets.extractionCacheSizes().texts;
    for (let i = 0; i < 60000; i += 1) {
      targets.featuresOfCss(`.r${i}{width:${i}px;--v${i}:${i}}`);
      const sizes = targets.extractionCacheSizes();
      maxTexts = Math.max(maxTexts, sizes.texts);
      maxConstructs = Math.max(maxConstructs, sizes.constructs);
      if (sizes.texts < previous) {
        evicted = true;
        // Records go with the extraction results that reach them: after an
        // eviction only the new text's records remain.
        expect(sizes.texts).toBe(1);
        expect(sizes.constructs).toBeLessThanOrEqual(
          targets.featuresOfCss(`.r${i}{width:${i}px;--v${i}:${i}}`).length,
        );
      }
      previous = sizes.texts;
    }
    expect(evicted).toBe(true);
    expect(maxTexts).toBeLessThanOrEqual(50000);
    expect(maxConstructs).toBeLessThanOrEqual(20000);
  });
});

describe('fast paths equal the exact paths', () => {
  test('facts entries serialize byte for byte as stableJson', () => {
    const css = [
      '.a{text-wrap:pretty;display:inline flex;color:oklch(from red l c h)}',
      '.b:has(.c){scrollbar-gutter:stable;user-select:none;inset:0}',
      '@container (width>1px){.d{text-wrap:balance}}',
      '@layer a{.e{color:red!important}}',
      '.f{-webkit-app-region:drag;font-family:"X",sans-serif}',
    ].join('\n');
    const seen = new Set();
    for (const resolution of [DEFAULT, ENFORCED, ELECTRON]) {
      for (const enhancements of [[], DEGRADE_BALANCE]) {
        const { facts } = targets.evaluateTargets({
          resolution,
          sources: [{ owner: { role: 'page', file: '/p.js' }, css }],
          enhancements,
          intrinsic: { useCSSLayers: true },
        });
        for (const entry of facts.features) {
          expect(targets.entryJson(entry)).toBe(targets.stableJson(entry));
          if (entry.enhancement != null) seen.add('enhancement');
          for (const profile of entry.profiles) {
            for (const outcome of profile.engines) {
              for (const field of ['caveats', 'path', 'restriction']) {
                if (outcome[field] !== undefined) seen.add(field);
              }
            }
          }
        }
        expect(targets.featuresJson(facts.features)).toBe(
          targets.stableJson(facts.features),
        );
      }
    }
    // Every optional field of the entry shape was exercised.
    expect([...seen].sort()).toEqual([
      'caveats',
      'enhancement',
      'path',
      'restriction',
    ]);
  });

  test('construct keys are equal exactly when the constructs JSON is', () => {
    const constructs = [
      { kind: 'property', name: 'a' },
      { kind: 'property', name: 'a', value: undefined },
      { name: 'a', kind: 'property' },
      { kind: 'property', name: '1' },
      { kind: 'property', name: 1 },
      { kind: 'property', name: true },
      { kind: 'property', name: 'true' },
      { kind: 'property', name: null },
      { kind: 'property', name: 'null' },
      { kind: 'property', name: 'a\u0002kind\u0001string\u0001b' },
      { kind: 'property', name: 'a', kind2: 'b' },
      { kind: 'property', name: ['a'] },
      { kind: 'property', name: { a: 1 } },
    ];
    for (const a of constructs) {
      for (const b of constructs) {
        expect(targets.constructKey(a) === targets.constructKey(b)).toBe(
          JSON.stringify(a) === JSON.stringify(b),
        );
      }
    }
  });

  test('the emitted-subset tokenizer gives the tokens of @csstools/css-tokenizer', () => {
    const FRAGMENTS = [
      '1',
      '12',
      '1.5',
      '.5',
      '1.',
      '-1',
      '+1',
      '-.5',
      '+.5',
      '1e3',
      '1E3',
      '1e',
      '1e+3',
      '1e-3',
      '1e+',
      '2e-x',
      '5%',
      '5px',
      '5e3px',
      '-5em',
      '.5rem',
      '1x',
      '1-x',
      '1--x',
      '1_a',
      'px',
      'a',
      '-a',
      '--a',
      '--',
      '-',
      '+',
      '.',
      '-webkit-box',
      '_a',
      'a1',
      'a-b',
      'a_b',
      '#',
      '#a',
      '#1',
      '#-',
      '#--a',
      '#-1',
      '#abc',
      '@',
      '@media',
      '@-x',
      '@1',
      '@--a',
      '"s"',
      "'s'",
      '"a b"',
      '""',
      'url("x")',
      "url( 'x')",
      'URL("y")',
      'rgb(',
      'var(--x)',
      '(',
      ')',
      '[',
      ']',
      '{',
      '}',
      ',',
      ':',
      ';',
      '!',
      '*',
      '>',
      '~',
      '|',
      '=',
      '&',
      '$',
      '^',
      '/',
      '?',
      '%',
      ' ',
      '\n',
      '\t',
      '  ',
      'calc(1px + 2%)',
      '!important',
      'a:hover',
      '.x',
      '::before',
      ':not(#\\#)',
      'url(x)',
      '/* c */',
      'é',
      '<!--',
      '-->',
      '\\61',
      '"a\nb',
    ];
    let seed = 307;
    const random = () =>
      (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let fast = 0;
    let fallback = 0;
    for (let k = 0; k < 40000; k += 1) {
      let css = '';
      const length = 1 + Math.floor(random() * 8);
      for (let j = 0; j < length; j += 1) {
        css += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)];
      }
      const mine = targets.tokenizeEmitted(css);
      if (mine == null) {
        fallback += 1;
        continue;
      }
      fast += 1;
      expect(JSON.stringify(mine)).toBe(JSON.stringify(tokenize({ css })));
    }
    // Both paths were exercised.
    expect(fast).toBeGreaterThan(10000);
    expect(fallback).toBeGreaterThan(1000);
  });

  test('indexed keyword lookup equals the linear search over the bundled data', () => {
    const data = targets.compatData();
    const STRIDE = /^css\.properties\.[^.]+$/;
    // The search the index replaces: the first child, then the first
    // statement, naming the keyword as an alternative name or a prefix.
    const reference = (base, keyword) => {
      for (const child of data.childrenOf(base)) {
        const path = `${base}.${child}`;
        for (const statements of Object.values(data.entry(path)?.e ?? {})) {
          for (const st of statements) {
            if (st.n === keyword)
              return [{ path, match: { alternativeName: keyword } }];
            if (st.x != null && `${st.x}${child}` === keyword) {
              return [{ path, match: { prefix: st.x } }];
            }
          }
        }
      }
      return null;
    };
    let compared = 0;
    let aliased = 0;
    for (const base of Object.keys(DATA.paths).filter((p) => STRIDE.test(p))) {
      const property = base.slice('css.properties.'.length);
      const keywords = new Set();
      for (const child of data.childrenOf(base)) {
        keywords.add(child.toLowerCase());
        keywords.add(`-webkit-${child}`);
        keywords.add(`-moz-${child}`);
        for (const statements of Object.values(
          data.entry(`${base}.${child}`)?.e ?? {},
        )) {
          for (const st of statements) {
            if (st.n != null) keywords.add(st.n);
            if (st.x != null) keywords.add(`${st.x}${child}`);
          }
        }
      }
      for (const keyword of keywords) {
        const [record] = targets.featuresOf({
          kind: 'value-keyword',
          property,
          keyword,
        });
        const direct = data
          .childrenOf(base)
          .find((child) => child.toLowerCase() === keyword.toLowerCase());
        if (direct != null) continue;
        const expected = reference(base, keyword);
        compared += 1;
        if (expected != null) {
          aliased += 1;
          expect({ keyword, bcd: record?.bcd }).toEqual({
            keyword,
            bcd: expected,
          });
        } else {
          expect({
            keyword,
            recognized: record?.recognized ?? null,
          }).not.toEqual({
            keyword,
            recognized: true,
          });
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
    expect(aliased).toBeGreaterThan(10);
  });

  test('extraction with the fast tokenizer equals extraction with the exact one', () => {
    const texts = [
      '.a{color:rgb(1 2 3/.5);margin:-1px 2e1px .5rem}',
      '@media (min-width:40rem) and (hover:hover){.b:hover{inset:0}}',
      '.c::before{content:"x";font-family:"A B",sans-serif}',
      '.d:not(#\\#){color:red}',
      '.e{background:url(x.png)}',
      '.f{width:calc(100% - 2px);grid-template-columns:repeat(2,1fr)}',
    ];
    for (const css of texts) {
      // A comment forces the exact tokenizer; it adds no construct.
      expect(targets.extractConstructs(css)).toEqual(
        targets.extractConstructs(`/**/${css}`),
      );
    }
  });
});
