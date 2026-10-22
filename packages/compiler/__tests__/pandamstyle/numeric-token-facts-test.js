/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * CE-02.2 (#47) PR A, note §3.5: the numeric facts of token values and the
 * per-row scalar constraint checked at use.
 *
 *   - numericFactsOfValue: one tokenization, decoded numbers, units, the
 *     non-finite identifiers, and null for an unchecked shape;
 *   - every row whose token categories can carry a number has a scalar, with
 *     the component counts of its CSS Box 4 / CSS Logical 1 form;
 *   - at use, in the base value and in every theme: bounds (negative padding
 *     refused, negative margin and offsets admitted), units, unitless
 *     non-zero numbers, precision, magnitude, non-finite values, and both
 *     component-count boundaries of every shorthand form;
 *   - the same refusal in consumer, condition, recipe and pattern contexts,
 *     source-located through the Project Service.
 */

const fs = require('fs');
const { loadCompiler, openProject } = require('./session-helpers');

const compiler = loadCompiler();

describe('numericFactsOfValue', () => {
  const f = (value, unit) => ({ value, unit });
  test.each([
    ['4px', [f(4, 'px')]],
    ['-4PX', [f(-4, 'px')]],
    ['0', [f(0, null)]],
    ['1.5', [f(1.5, null)]],
    ['50%', [f(50, '%')]],
    ['1px 2px', [f(1, 'px'), f(2, 'px')]],
    ['  1px\t2rem  ', [f(1, 'px'), f(2, 'rem')]],
    ['1e308px', [f(1e308, 'px')]],
    ['200ms', [f(200, 'ms')]],
    ['0.12345px', [f(0.12345, 'px')]],
  ])('%j', (text, facts) => {
    expect(compiler.numericFactsOfValue(text)).toEqual(facts);
  });

  test.each([['NaN'], ['infinity'], ['-Infinity']])(
    '%j is the non-finite fact',
    (text) => {
      expect(compiler.numericFactsOfValue(text)).toBe(compiler.NON_FINITE);
    },
  );

  // Unchecked shapes (CE-03 typed category grammar).
  test.each([
    ['calc(1px + 2px)'],
    ['auto'],
    ['#fff'],
    ['1px solid'],
    ['0 1px 2px rgba(0, 0, 0, 0.1)'],
    ['1px, 2px'],
    ['1px / 2px'],
    ['NaN 1px'],
    [''],
    ['/* c */'],
  ])('%j has no facts', (text) => {
    expect(compiler.numericFactsOfValue(text)).toBe(null);
  });
});

// ---------------------------------------------------------------------------

const NUMERIC_CATEGORIES = [
  'spacing',
  'sizes',
  'radii',
  'fontSizes',
  'fontWeights',
  'lineHeights',
  'letterSpacings',
  'durations',
];
const admitted = compiler
  .descriptorKeys()
  .map((key) => compiler.descriptorOf(key))
  .filter((d) => d.standard != null);

// The expected scalar of each row: its constraint text and component count,
// stated independently of descriptors.js (CSS Box 4, CSS Logical 1, CSS
// Backgrounds 3, CSS Fonts 4, CSS Inline 3, CSS Transitions/Animations).
const NON_NEGATIVE = '<length-percentage [0,∞]>';
const SIGNED = '<length-percentage>';
const EXPECTED_SCALARS = {
  padding: [NON_NEGATIVE, 1, 4],
  paddingTop: [NON_NEGATIVE, 1, 1],
  paddingRight: [NON_NEGATIVE, 1, 1],
  paddingBottom: [NON_NEGATIVE, 1, 1],
  paddingLeft: [NON_NEGATIVE, 1, 1],
  paddingInline: [NON_NEGATIVE, 1, 2],
  paddingInlineStart: [NON_NEGATIVE, 1, 1],
  paddingInlineEnd: [NON_NEGATIVE, 1, 1],
  paddingBlock: [NON_NEGATIVE, 1, 2],
  paddingBlockStart: [NON_NEGATIVE, 1, 1],
  paddingBlockEnd: [NON_NEGATIVE, 1, 1],
  margin: [SIGNED, 1, 4],
  marginTop: [SIGNED, 1, 1],
  marginRight: [SIGNED, 1, 1],
  marginBottom: [SIGNED, 1, 1],
  marginLeft: [SIGNED, 1, 1],
  marginInline: [SIGNED, 1, 2],
  marginInlineStart: [SIGNED, 1, 1],
  marginInlineEnd: [SIGNED, 1, 1],
  marginBlock: [SIGNED, 1, 2],
  marginBlockStart: [SIGNED, 1, 1],
  marginBlockEnd: [SIGNED, 1, 1],
  top: [SIGNED, 1, 1],
  right: [SIGNED, 1, 1],
  bottom: [SIGNED, 1, 1],
  left: [SIGNED, 1, 1],
  inset: [SIGNED, 1, 4],
  insetInlineStart: [SIGNED, 1, 1],
  insetInlineEnd: [SIGNED, 1, 1],
  insetBlockStart: [SIGNED, 1, 1],
  insetBlockEnd: [SIGNED, 1, 1],
  textUnderlineOffset: [SIGNED, 1, 1],
  gap: [NON_NEGATIVE, 1, 2],
  rowGap: [NON_NEGATIVE, 1, 1],
  columnGap: [NON_NEGATIVE, 1, 1],
  borderRadius: [NON_NEGATIVE, 1, 4],
  borderTopLeftRadius: [NON_NEGATIVE, 1, 2],
  borderTopRightRadius: [NON_NEGATIVE, 1, 2],
  borderBottomLeftRadius: [NON_NEGATIVE, 1, 2],
  borderBottomRightRadius: [NON_NEGATIVE, 1, 2],
  borderStartStartRadius: [NON_NEGATIVE, 1, 2],
  borderStartEndRadius: [NON_NEGATIVE, 1, 2],
  borderEndStartRadius: [NON_NEGATIVE, 1, 2],
  borderEndEndRadius: [NON_NEGATIVE, 1, 2],
  fontSize: [NON_NEGATIVE, 1, 1],
  fontWeight: ['<number [1,1000]>', 1, 1],
  lineHeight: [`<number [0,∞]> | ${NON_NEGATIVE}`, 1, 1],
  letterSpacing: [SIGNED, 1, 1],
  transitionDuration: ['<time [0s,∞]>', 1, 1],
  transitionDelay: ['<time>', 1, 1],
  animationDuration: ['<time [0s,∞]>', 1, 1],
  animationDelay: ['<time>', 1, 1],
  width: [NON_NEGATIVE, 1, 1],
  height: [NON_NEGATIVE, 1, 1],
  minWidth: [NON_NEGATIVE, 1, 1],
  maxWidth: [NON_NEGATIVE, 1, 1],
};

describe('scalar constraints', () => {
  test('every row admitting a numeric-capable category has a scalar, and only those', () => {
    const withScalar = admitted
      .filter((d) => d.scalar != null)
      .map((d) => d.key)
      .sort();
    const numeric = admitted
      .filter((d) =>
        d.standard.tokens.some((c) => NUMERIC_CATEGORIES.includes(c)),
      )
      .map((d) => d.key)
      .sort();
    expect(withScalar).toEqual(numeric);
    expect(withScalar).toEqual(Object.keys(EXPECTED_SCALARS).sort());
  });

  test.each(Object.entries(EXPECTED_SCALARS))(
    '%s: %j',
    (key, [text, min, max]) => {
      const scalar = compiler.descriptorOf(key).scalar;
      expect(scalar.count).toEqual([min, max]);
      expect(scalar.constraints).toEqual(compiler.compileGrammar(text).numeric);
    },
  );

  // A scalar agrees with the numeric branch of its row's own grammar where
  // that grammar has one (no property reference or multiplier).
  test('a scalar equals its own grammar numeric branch when there is one', () => {
    for (const d of admitted) {
      if (d.scalar == null || d.standard.numeric.length === 0) continue;
      expect({ key: d.key, constraints: d.scalar.constraints }).toEqual({
        key: d.key,
        constraints: d.standard.numeric,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// The use-site check.

const DARK = 'dark';
function systemWith(spacing, themeSpacing = {}, extra = {}) {
  const spacingTokens = Object.fromEntries(
    Object.entries(spacing).map(([k, value]) => [
      k,
      { value, visibility: 'public' },
    ]),
  );
  return compiler.buildDesignSystem({
    systemId: 'ce022-facts',
    tokens: {
      spacing: spacingTokens,
      ...extra,
    },
    themes: {
      [DARK]: {
        tokens: {
          spacing: Object.fromEntries(
            Object.entries(themeSpacing).map(([k, value]) => [k, { value }]),
          ),
        },
      },
    },
  });
}

function outcome(ds, property, value, role = 'consumer', namespaces = null) {
  try {
    compiler.compileStyles({
      registry: ds.registry,
      varsByToken: ds.varsByToken,
      namespaces: namespaces ?? { n: { [property]: value } },
      role,
      allowPrivateTokens: role === 'system',
    });
    return null;
  } catch (error) {
    if (!Array.isArray(error.diagnostics)) throw error;
    return error.diagnostics.map((d) => ({
      code: d.code,
      rule: d.rule,
      reason: d.context?.reason ?? null,
      theme: d.context?.theme ?? null,
      cause: d.context?.cause ?? null,
    }));
  }
}

const REFUSED = (reason = 'token-value-out-of-domain', extra = {}) => [
  expect.objectContaining({
    code: 'PMS_FORBIDDEN_VALUE',
    rule: 'category-strict',
    reason,
    ...extra,
  }),
];

describe('the numeric value of a token at use', () => {
  const ds = systemWith({
    pos: '4px',
    neg: '-4px',
    zero: '0',
    rem: '0.5rem',
    pct: '10%',
    deg: '4deg',
    unitless: '4',
    precise: '0.12345px',
    huge: '1e308px',
    big: '1000001px',
    nan: 'NaN',
    inf: 'Infinity',
    calc: 'calc(1px - 8px)',
    two: '1px 2px',
    three: '1px 2px 3px',
    four: '1px 2px 3px 4px',
    five: '1px 2px 3px 4px 5px',
    twoNeg: '1px -2px',
  });
  const t = (name) => compiler.token(`spacing.${name}`);

  test.each([
    // Bounds: a negative length is a margin or an offset, never a padding or
    // a gap.
    ['paddingTop', 'neg', REFUSED()],
    ['paddingInlineStart', 'neg', REFUSED()],
    ['padding', 'neg', REFUSED()],
    ['padding', 'twoNeg', REFUSED()],
    ['gap', 'neg', REFUSED()],
    ['rowGap', 'neg', REFUSED()],
    ['marginTop', 'neg', null],
    ['marginInlineStart', 'neg', null],
    ['margin', 'twoNeg', null],
    ['top', 'neg', null],
    ['insetInlineStart', 'neg', null],
    ['textUnderlineOffset', 'neg', null],
    // Admitted values.
    ['paddingTop', 'pos', null],
    ['paddingTop', 'zero', null],
    ['paddingTop', 'rem', null],
    ['paddingTop', 'pct', null],
    // Units, unitless numbers, precision, magnitude.
    [
      'paddingTop',
      'deg',
      REFUSED('token-value-out-of-domain', { cause: 'unit-not-applicable' }),
    ],
    [
      'marginTop',
      'unitless',
      REFUSED('token-value-out-of-domain', { cause: 'number-not-length' }),
    ],
    [
      'paddingTop',
      'precise',
      REFUSED('token-value-out-of-domain', { cause: 'precision' }),
    ],
    [
      'paddingTop',
      'huge',
      REFUSED('token-value-out-of-domain', { cause: 'out-of-bounds' }),
    ],
    [
      'marginTop',
      'big',
      REFUSED('token-value-out-of-domain', { cause: 'out-of-bounds' }),
    ],
    // Non-finite identifiers.
    ['paddingTop', 'nan', REFUSED('non-finite')],
    ['marginTop', 'inf', REFUSED('non-finite')],
    // An unchecked shape (CE-03): accepted, a stated limitation.
    ['paddingTop', 'calc', null],
    // Component-count boundaries of every form.
    [
      'paddingTop',
      'two',
      REFUSED('token-value-out-of-domain', { cause: 'component-count' }),
    ],
    ['paddingInline', 'two', null],
    [
      'paddingInline',
      'three',
      REFUSED('token-value-out-of-domain', { cause: 'component-count' }),
    ],
    [
      'paddingBlock',
      'three',
      REFUSED('token-value-out-of-domain', { cause: 'component-count' }),
    ],
    ['padding', 'four', null],
    [
      'padding',
      'five',
      REFUSED('token-value-out-of-domain', { cause: 'component-count' }),
    ],
    ['margin', 'four', null],
    [
      'margin',
      'five',
      REFUSED('token-value-out-of-domain', { cause: 'component-count' }),
    ],
    ['marginBlock', 'two', null],
    [
      'marginBlock',
      'three',
      REFUSED('token-value-out-of-domain', { cause: 'component-count' }),
    ],
    ['gap', 'two', null],
    [
      'gap',
      'three',
      REFUSED('token-value-out-of-domain', { cause: 'component-count' }),
    ],
  ])('%s with spacing.%s', (property, name, expected) => {
    expect(outcome(ds, property, t(name))).toEqual(expected);
  });

  test('the refusal carries the token, the constraint and the passing candidates', () => {
    let error;
    try {
      compiler.compileStyles({
        registry: ds.registry,
        varsByToken: ds.varsByToken,
        namespaces: { n: { paddingTop: t('neg') } },
        role: 'consumer',
      });
    } catch (e) {
      error = e;
    }
    const [d] = error.diagnostics;
    expect(d.context).toMatchObject({
      property: 'paddingTop',
      tokenId: 'spacing.neg',
      category: 'spacing',
      reason: 'token-value-out-of-domain',
      theme: null,
      component: 0,
      cause: 'out-of-bounds',
      constraint: {
        count: [1, 1],
        constraints: [{ type: 'length-percentage', min: 0, max: null }],
      },
    });
    expect(d.context.candidates).toEqual(
      expect.arrayContaining(['spacing.pos', 'spacing.zero', 'spacing.calc']),
    );
    for (const refused of ['spacing.neg', 'spacing.deg', 'spacing.two']) {
      expect(d.context.candidates).not.toContain(refused);
    }
  });

  test('a row without a scalar does not check token numbers', () => {
    const colors = compiler.buildDesignSystem({
      systemId: 'ce022-colors',
      tokens: { colors: { odd: { value: '-4px', visibility: 'public' } } },
    });
    expect(outcome(colors, 'color', compiler.token('colors.odd'))).toBe(null);
  });
});

describe('every theme is checked', () => {
  test('a valid base with a negative dark value is refused, naming the theme', () => {
    const ds = systemWith({ s: '4px' }, { s: '-4px' });
    expect(outcome(ds, 'paddingTop', compiler.token('spacing.s'))).toEqual(
      REFUSED('token-value-out-of-domain', { theme: DARK }),
    );
    expect(outcome(ds, 'marginTop', compiler.token('spacing.s'))).toBe(null);
  });

  test('a theme value through a ref is checked as resolved', () => {
    const ds = compiler.buildDesignSystem({
      systemId: 'ce022-ref',
      tokens: {
        spacing: {
          s: { value: '4px', visibility: 'public' },
          n: { value: '-8px', visibility: 'public' },
        },
      },
      themes: { dark: { tokens: { spacing: { s: { ref: 'spacing.n' } } } } },
    });
    expect(outcome(ds, 'paddingTop', compiler.token('spacing.s'))).toEqual(
      REFUSED('token-value-out-of-domain', { theme: 'dark' }),
    );
  });

  test('the facts are recorded per base and theme', () => {
    const ds = systemWith({ s: '4px' }, { s: '-4px' });
    expect(compiler.numericFactsOf(ds.registry, 'spacing.s')).toEqual([
      { theme: null, facts: [{ value: 4, unit: 'px' }] },
      { theme: DARK, facts: [{ value: -4, unit: 'px' }] },
    ]);
  });
});

describe('numbers arriving as token values', () => {
  const ds = compiler.buildDesignSystem({
    systemId: 'ce022-numbers',
    tokens: {
      lineHeights: {
        ok: { value: 1.5, visibility: 'public' },
        huge: { value: 1e308, visibility: 'public' },
        neg: { value: -1, visibility: 'public' },
        nan: { value: NaN, visibility: 'public' },
        inf: { value: Infinity, visibility: 'public' },
        precise: { value: 1.23456, visibility: 'public' },
      },
      fontWeights: {
        ok: { value: 600, visibility: 'public' },
        zero: { value: 0, visibility: 'public' },
        px: { value: '600px', visibility: 'public' },
      },
      durations: {
        ok: { value: '200ms', visibility: 'public' },
        neg: { value: '-1s', visibility: 'public' },
        unitless: { value: 200, visibility: 'public' },
      },
    },
  });
  test.each([
    ['lineHeight', 'lineHeights.ok', null],
    ['lineHeight', 'lineHeights.huge', REFUSED()],
    ['lineHeight', 'lineHeights.neg', REFUSED()],
    ['lineHeight', 'lineHeights.nan', REFUSED('non-finite')],
    ['lineHeight', 'lineHeights.inf', REFUSED('non-finite')],
    ['lineHeight', 'lineHeights.precise', REFUSED()],
    ['fontWeight', 'fontWeights.ok', null],
    ['fontWeight', 'fontWeights.zero', REFUSED()],
    ['fontWeight', 'fontWeights.px', REFUSED()],
    ['transitionDuration', 'durations.ok', null],
    ['transitionDuration', 'durations.neg', REFUSED()],
    ['transitionDelay', 'durations.neg', null],
    ['transitionDuration', 'durations.unitless', REFUSED()],
  ])('%s with %s', (property, path, expected) => {
    expect(outcome(ds, property, compiler.token(path))).toEqual(expected);
  });
});

describe('the same refusal in every authoring context', () => {
  const ds = compiler.buildDesignSystem({
    systemId: 'ce022-contexts',
    conditions: { hover: ':hover', wide: '@media (min-width: 40rem)' },
    tokens: {
      spacing: {
        neg: { value: '-4px', visibility: 'public' },
        pos: { value: '4px', visibility: 'public' },
      },
    },
  });
  const neg = compiler.token('spacing.neg');
  test.each([
    ['base', { n: { paddingTop: neg } }],
    [
      'condition map',
      {
        n: { paddingTop: { base: compiler.token('spacing.pos'), hover: neg } },
      },
    ],
    ['named block', { n: { _hover: { paddingTop: neg } } }],
    ['engine block', { n: { ':hover': { paddingTop: neg } } }],
    ['at-rule map', { n: { paddingTop: { wide: neg } } }],
  ])('%s', (_, namespaces) => {
    for (const role of ['consumer', 'system']) {
      expect(outcome(ds, null, null, role, namespaces)).toEqual(REFUSED());
    }
  });
});

// ---------------------------------------------------------------------------
// Through the Project Service: source-located, in pages, patterns and recipes.

function openWithNeg({ page = null, recipes = '' }) {
  const h = openProject('valid');
  let definition = fs.readFileSync(h.sharedDefinitionPath, 'utf8');
  definition = definition.replace(
    '    spacing: {\n',
    "    spacing: {\n      neg: { value: '-4px', visibility: 'public' },\n",
  );
  if (recipes !== '') {
    definition = definition.replace(
      '  recipes: {\n',
      `  recipes: {\n${recipes}\n`,
    );
  }
  fs.writeFileSync(h.sharedDefinitionPath, definition);
  if (page != null) fs.writeFileSync(h.src('src/ce022.js'), page);
  h.session.applyChanges({
    definition: h.reloadDefinition(),
    mutation: undefined,
  });
  return h;
}

describe('ce022-negative-spacing through the Project Service', () => {
  const CALLS = [
    "create({ n: { paddingTop: token('spacing.neg') } })",
    "create({ n: { marginTop: token('spacing.neg') } })",
    "create({ n: { _hover: { paddingInlineStart: token('spacing.neg') } } })",
    "patterns.stack({ gap: token('spacing.neg') })",
    "patterns.stack({ gap: token('spacing.sm') })",
    "create({ n: { padding: token('spacing.neg') } })",
  ];
  test('each call is refused or admitted at its own line', () => {
    const page = [
      "import { create, token, patterns } from '../generated/design.pandamstyle';",
      ...CALLS.map((call, i) => `export const s${i} = ${call};`),
      '',
    ].join('\n');
    const h = openWithNeg({ page });
    const file = h.src('src/ce022.js');
    const validation = h.session.validate();
    const byCall = CALLS.map((_, i) =>
      validation.diagnostics
        .filter((d) => d.location?.file === file && d.location.line === i + 2)
        .map((d) => [d.code, d.rule, d.context?.reason ?? null]),
    );
    const refused = [
      ['PMS_FORBIDDEN_VALUE', 'category-strict', 'token-value-out-of-domain'],
    ];
    expect(byCall).toEqual([refused, [], refused, refused, [], refused]);
  });

  test('a recipe using it on padding refuses the design system', () => {
    const h = openWithNeg({
      recipes: "    negbox: { base: { paddingTop: token('spacing.neg') } },",
    });
    const validation = h.session.validate();
    expect(validation.ok).toBe(false);
    expect(
      validation.diagnostics.map((d) => [d.code, d.rule, d.context?.reason]),
    ).toContainEqual([
      'PMS_FORBIDDEN_VALUE',
      'category-strict',
      'token-value-out-of-domain',
    ]);
  });

  test('a recipe using it on margin is admitted', () => {
    const h = openWithNeg({
      recipes: "    negbox: { base: { marginTop: token('spacing.neg') } },",
    });
    expect(h.session.validate().ok).toBe(true);
  });
});
