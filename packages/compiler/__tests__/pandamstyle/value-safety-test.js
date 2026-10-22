/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * CE-02.2 (#47) PR B: S1, the safety predicate of author text, and S2, the
 * re-read of emitted CSS (design note §4.2).
 *
 *   - S1 refusal classes: escapes, line continuations, raw `;`/`{`/`}` in
 *     strings, tokenizer errors, CDO/CDC, comments, `!important`, url tokens,
 *     functions outside APPROVED_FUNCTIONS at every depth (mixed case,
 *     Unicode lookalikes, vendor aliases, nested references), non-finite
 *     numbers; and the texts the fixtures, workloads and corpus use pass;
 *   - every entry point refuses: token values, theme overrides, condition
 *     definitions, condition-block keys for consumers and recipes (the
 *     breakout key `':hover}body{display:none}/*'`), `propertyDomains`
 *     literals; the S1 call sites are pinned;
 *   - S1 tokenizes each author text exactly once, before any verdict (a JS
 *     number from its canonical text), at every entry point;
 *   - every compiler-owned standard, default and opaque value passes S1;
 *   - the strict CSS reader refuses malformed CSS (stray `}`, unclosed
 *     blocks, unbalanced brackets, trailing text) and keeps strings exactly;
 *   - S2: every emitted rule re-reads, alone and inside the whole stylesheet,
 *     as the same prelude and declarations, one declaration per property,
 *     with the approved value's tokens; before and after the CE-01.2
 *     transform stage.
 */

const fs = require('fs');
const path = require('path');
const { tokenize } = require('@csstools/css-tokenizer');
const { loadCompiler, openProject } = require('./session-helpers');

const compiler = loadCompiler();
const REPO = path.resolve(__dirname, '../../../..');
const SRC = path.join(REPO, 'packages/compiler/src');
const { unsafeValueClass, APPROVED_FUNCTIONS } = compiler;

describe('S1 refusal classes', () => {
  test.each([
    // Escapes and line continuations re-spell what the rest would refuse.
    ['value', '\\75 rl(x)', 'escape'],
    ['value', 'r\\65 d', 'escape'],
    ['value', '"\\3b"', 'escape'],
    ['value', 'red\\7d', 'escape'],
    ['value', '"a\\\nb"', 'escape'],
    // Raw boundaries, strings included (the transform stage scans them).
    ['value', 'red;}body{display:none', 'breakout'],
    ['value', '"a;b"', 'breakout'],
    ['value', "'}'", 'breakout'],
    ['condition', ':hover}body{display:none}/*', 'breakout'],
    ['condition', '@media (min-width: 1px){', 'breakout'],
    // Tokenizer errors and balance.
    ['value', '"oops', 'tokenizer-error'],
    ['value', '"line\nbreak"', 'tokenizer-error'],
    ['value', 'red/*', 'tokenizer-error'],
    ['value', '[bad', 'unbalanced'],
    ['value', 'calc(1px', 'unbalanced'],
    ['value', 'calc(1px))', 'unbalanced'],
    ['value', '(a]', 'unbalanced'],
    // Comments, CDO/CDC, !important.
    ['value', 'red/*x*/', 'comment'],
    ['condition', '&:hover /* x */', 'comment'],
    ['value', '-->', 'token-kind'],
    ['value', '<!--', 'token-kind'],
    ['value', 'red !important', 'important'],
    ['value', 'red!important', 'important'],
    // Tokens outside the closed set.
    ['value', 'a:b', 'token-kind'],
    ['value', '@media', 'token-kind'],
    ['value', 'a > b', 'token-kind'],
    ['condition', '& ? b', 'token-kind'],
    // Resources and functions outside the list, at every depth.
    ['value', 'url(x)', 'url-token'],
    ['value', 'url( x y)', 'url-token'],
    ['value', 'uRl(x)', 'url-token'],
    ['value', 'url("x")', 'function-not-approved'],
    ['value', 'VAR(--x)', 'function-not-approved'],
    ['value', 'var(--x)', 'function-not-approved'],
    ['value', 'env(safe-area-inset-top)', 'function-not-approved'],
    ['value', 'attr(data-x)', 'function-not-approved'],
    ['value', 'expression(alert(1))', 'function-not-approved'],
    ['value', 'image-set("x" 1x)', 'function-not-approved'],
    ['value', '-webkit-image-set("x" 1x)', 'function-not-approved'],
    ['value', '-webkit-gradient(linear, 0 0, 0 100%)', 'function-not-approved'],
    ['value', '-moz-element(#a)', 'function-not-approved'],
    ['value', 'calc(var(--x))', 'function-not-approved'],
    ['value', 'rgb(from var(--x) r g b)', 'function-not-approved'],
    ['value', 'color-mix(in srgb, url(x), red)', 'url-token'],
    ['value', 'min(1px, max(2px, paint(x)))', 'function-not-approved'],
    // Unicode lookalikes never fold to a listed name.
    ['value', 'ｒgb(0 0 0)', 'function-not-approved'],
    ['value', 'rɡb(0 0 0)', 'function-not-approved'],
    ['value', 'сalc(1px)', 'function-not-approved'],
    ['condition', ':іs(.a)', 'function-not-approved'],
    // A value function is not a condition function, and vice versa.
    ['condition', ':nth-child(calc(1))', 'function-not-approved'],
    ['value', 'not(a)', 'function-not-approved'],
    // Numbers.
    ['value', NaN, 'non-finite'],
    ['value', Infinity, 'non-finite'],
    ['value', -Infinity, 'non-finite'],
    ['value', 1e6 + 1, 'non-finite'],
    ['value', 1e308, 'non-finite'],
  ])('%s %j: %s', (kind, text, reason) => {
    expect(unsafeValueClass(text, kind)).toMatchObject({ reason });
  });

  test.each([
    ['value', '#112233'],
    ['value', 'rgba(0, 0, 0, 0.1)'],
    ['value', 'RGBA(0, 0, 0, 0.1)'],
    ['value', '0 1px 2px rgba(0, 0, 0, 0.1)'],
    ['value', '"Inter", system-ui, sans-serif'],
    ['value', "'Fira Code', monospace"],
    ['value', 'cubic-bezier(0.4, 0, 0.2, 1)'],
    ['value', 'calc(100% - 1px)'],
    ['value', 'clamp(1rem, 2vw, 2rem)'],
    ['value', 'oklch(50% 0.1 30)'],
    ['value', 'light-dark(#fff, #000)'],
    ['value', 'color-mix(in srgb, red 50%, blue)'],
    ['value', 'repeat(3, minmax(0, 1fr))'],
    ['value', 'translateY(1px)'],
    ['value', '1px / 2px'],
    ['value', '-4px'],
    ['value', ''],
    ['value', 0.5],
    ['value', 1e6],
    ['condition', '@media (min-width: 40rem)'],
    [
      'condition',
      '@media (width >= 40rem) and (prefers-reduced-motion: reduce)',
    ],
    ['condition', '@container (min-width: 20rem)'],
    ['condition', '@supports selector(:has(a))'],
    ['condition', '&:hover'],
    ['condition', ':hover'],
    ['condition', '&:focus-visible'],
    ['condition', '[dir=rtl] &'],
    ['condition', '[data-state="open"] &'],
    ['condition', '.dark &'],
    ['condition', ':is(.a, .b) > &'],
    ['condition', '&:nth-child(2n+1)'],
    ['condition', ':where(&) ~ .x'],
  ])('%s %j is safe', (kind, text) => {
    expect(unsafeValueClass(text, kind)).toBe(null);
  });

  test('the approved functions are the note proposal, frozen', () => {
    expect(APPROVED_FUNCTIONS).toEqual({
      value: [
        'blur',
        'calc',
        'clamp',
        'color',
        'color-mix',
        'cubic-bezier',
        'grayscale',
        'hsl',
        'hsla',
        'hwb',
        'inset',
        'lab',
        'lch',
        'light-dark',
        'linear',
        'max',
        'min',
        'minmax',
        'oklab',
        'oklch',
        'repeat',
        'rgb',
        'rgba',
        'rotate',
        'scale',
        'steps',
        'translate',
        'translatex',
        'translatey',
      ],
      condition: [
        'dir',
        'has',
        'is',
        'lang',
        'not',
        'nth-child',
        'nth-last-child',
        'nth-last-of-type',
        'nth-of-type',
        'scroll-state',
        'selector',
        'where',
      ],
    });
    for (const never of [
      'url',
      'src',
      'image',
      'image-set',
      'element',
      'cross-fade',
      'paint',
      'attr',
      'var',
      'env',
      'if',
      'expression',
    ]) {
      expect(APPROVED_FUNCTIONS.value).not.toContain(never);
      expect(APPROVED_FUNCTIONS.condition).not.toContain(never);
    }
    expect(Object.isFrozen(APPROVED_FUNCTIONS.value)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Entry points.

function refusalOf(definition) {
  try {
    compiler.buildDesignSystem(definition);
    return [];
  } catch (error) {
    if (!Array.isArray(error.diagnostics)) throw error;
    return error.diagnostics.map((d) => ({
      code: d.code,
      phase: d.phase,
      rule: d.rule,
      context: d.context,
    }));
  }
}

const BASE = {
  systemId: 'ce022-safety',
  conditions: { hover: ':hover' },
  tokens: { colors: { a: { value: 'red', visibility: 'public' } } },
};

describe('S1 at every entry point', () => {
  test('a token value', () => {
    expect(
      refusalOf({
        ...BASE,
        tokens: {
          colors: { a: { value: 'red !important', visibility: 'public' } },
        },
      }),
    ).toEqual([
      {
        code: 'PMS_FORBIDDEN_VALUE',
        phase: 'registry',
        rule: 'value-safety.important',
        context: expect.objectContaining({ tokenId: 'colors.a', theme: null }),
      },
    ]);
  });

  test('a theme override value', () => {
    expect(
      refusalOf({
        ...BASE,
        themes: {
          dark: { tokens: { colors: { a: { value: 'var(--evil)' } } } },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        code: 'PMS_FORBIDDEN_VALUE',
        rule: 'value-safety.function-not-approved',
        context: expect.objectContaining({
          tokenId: 'colors.a',
          theme: 'dark',
          function: 'var(',
        }),
      }),
    ]);
  });

  test('a condition definition', () => {
    expect(
      refusalOf({ ...BASE, conditions: { evil: '}body{color:red}x' } }),
    ).toEqual([
      expect.objectContaining({
        code: 'PMS_UNKNOWN_CONDITION',
        phase: 'registry',
        rule: 'value-safety.breakout',
        context: expect.objectContaining({ condition: 'evil' }),
      }),
    ]);
  });

  test('a propertyDomains literal', () => {
    const [d] = refusalOf({
      ...BASE,
      propertyDomains: { display: { values: ['flex;color:red'] } },
    });
    expect(d).toMatchObject({
      code: 'PMS_INVALID_PROPERTY_DOMAIN',
      rule: 'property-domains.unsafe-text',
      context: { property: 'display', reason: 'breakout' },
    });
  });

  const ds = compiler.buildDesignSystem(BASE);
  const compile = (namespaces, role = 'consumer') => {
    try {
      const out = compiler.compileStyles({
        registry: ds.registry,
        varsByToken: ds.varsByToken,
        namespaces,
        role,
        allowPrivateTokens: role === 'system',
      });
      return { css: compiler.renderCss(out.injected), diagnostics: [] };
    } catch (error) {
      if (!Array.isArray(error.diagnostics)) throw error;
      return { css: null, diagnostics: error.diagnostics };
    }
  };

  test.each([
    [':hover}body{display:none}/*', 'breakout'],
    ['@media (min-width: 1px)}body{x:y}', 'breakout'],
    [':hover /* x */', 'comment'],
    ['[data-x="\\7d"] &', 'escape'],
    [':is(url(x))', 'url-token'],
    ['@media screen and (min-width: env(x))', 'function-not-approved'],
  ])('the condition-block key %j, for every role', (key, reason) => {
    for (const role of ['consumer', 'system']) {
      const result = compile(
        { n: { [key]: { color: compiler.token('colors.a') } } },
        role,
      );
      expect(result.css).toBe(null);
      expect(
        result.diagnostics.map((d) => [d.code, d.phase, d.rule, d.context.key]),
      ).toEqual([
        ['PMS_UNKNOWN_CONDITION', 'policy', `value-safety.${reason}`, key],
      ]);
    }
  });

  test('a safe raw key still compiles, as Alpha 1 records (SF-02, CE-07.1)', () => {
    const result = compile({
      n: { '[dir=rtl] &': { color: compiler.token('colors.a') } },
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.css).toContain('[dir=rtl]');
  });

  test.each([
    ['base', { base: { ':hover}x{': { color: { $t: 1 } } } }],
    [
      'a variant',
      { variants: { tone: { loud: { ':hover}x{': { opacity: 1 } } } } },
    ],
  ])('a recipe %s refuses its design system', (_, recipe) => {
    const recipes = {
      box: JSON.parse(JSON.stringify(recipe).replace('{"$t":1}', '"red"')),
    };
    const diagnostics = refusalOf({ ...BASE, recipes });
    expect(
      diagnostics.some(
        (d) =>
          d.code === 'PMS_UNKNOWN_CONDITION' &&
          d.rule === 'value-safety.breakout',
      ),
    ).toBe(true);
  });
});

// CE-02.2 §4.3: custom properties are compiler-owned; an unrecognized vendor
// key is a vendor extension, with the standard property when one exists.
describe('custom-property and vendor keys', () => {
  const ds = compiler.buildDesignSystem(BASE);
  const ruleOf = (property, value = 'x') => {
    try {
      compiler.compileStyles({
        registry: ds.registry,
        varsByToken: ds.varsByToken,
        namespaces: { n: { [property]: value } },
        role: 'consumer',
      });
      return null;
    } catch (error) {
      const [d] = error.diagnostics;
      return [d.code, d.rule, d.context.replacement ?? null];
    }
  };
  test.each([
    [
      '--x',
      [
        'PMS_UNSUPPORTED_PROPERTY',
        'supported-properties.custom-property',
        null,
      ],
    ],
    [
      '--',
      [
        'PMS_UNSUPPORTED_PROPERTY',
        'supported-properties.custom-property',
        null,
      ],
    ],
    [
      '--pms-color',
      [
        'PMS_UNSUPPORTED_PROPERTY',
        'supported-properties.custom-property',
        null,
      ],
    ],
    [
      'WebkitWidth',
      [
        'PMS_UNSUPPORTED_PROPERTY',
        'supported-properties.vendor-extension',
        'width',
      ],
    ],
    [
      'MozWidth',
      [
        'PMS_UNSUPPORTED_PROPERTY',
        'supported-properties.vendor-extension',
        'width',
      ],
    ],
    [
      'msOpacity',
      [
        'PMS_UNSUPPORTED_PROPERTY',
        'supported-properties.vendor-extension',
        'opacity',
      ],
    ],
    [
      '-webkit-width',
      [
        'PMS_UNSUPPORTED_PROPERTY',
        'supported-properties.vendor-extension',
        'width',
      ],
    ],
    [
      'msFlexGrow',
      [
        'PMS_UNSUPPORTED_PROPERTY',
        'supported-properties.vendor-extension',
        'flex-grow',
      ],
    ],
    [
      'WebkitFooBar',
      [
        'PMS_UNSUPPORTED_PROPERTY',
        'supported-properties.vendor-extension',
        null,
      ],
    ],
    // A recognized vendor variant keeps its CE-02.1 disposition rule.
    [
      'WebkitFlexGrow',
      [
        'PMS_UNSUPPORTED_PROPERTY',
        'supported-properties.deprecated',
        'flex-grow',
      ],
    ],
    [
      'OTransition',
      [
        'PMS_UNSUPPORTED_PROPERTY',
        'supported-properties.deprecated',
        'transition',
      ],
    ],
    // Not vendor prefixes.
    [
      'Width',
      ['PMS_UNSUPPORTED_PROPERTY', 'supported-properties.unrecognized', null],
    ],
    [
      'msx',
      ['PMS_UNSUPPORTED_PROPERTY', 'supported-properties.unrecognized', null],
    ],
    [
      'Order',
      ['PMS_UNSUPPORTED_PROPERTY', 'supported-properties.unrecognized', null],
    ],
  ])('%s', (property, expected) => {
    expect(ruleOf(property)).toEqual(expected);
  });

  test('every context refuses a custom property', () => {
    for (const namespaces of [
      { n: { '--x': 'red' } },
      { n: { _hover: { '--x': 'red' } } },
      { n: { ':hover': { '--x': 'red' } } },
    ]) {
      let error;
      try {
        compiler.compileStyles({
          registry: ds.registry,
          varsByToken: ds.varsByToken,
          namespaces,
          role: 'system',
          allowPrivateTokens: true,
        });
      } catch (e) {
        error = e;
      }
      expect(error.diagnostics.map((d) => d.rule)).toEqual([
        'supported-properties.custom-property',
      ]);
    }
  });
});

describe('the S1 call sites', () => {
  const callers = () => {
    const out = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.name.endsWith('.js')) {
          const text = fs.readFileSync(file, 'utf8');
          const count = (
            text.match(/(?:unsafeValueClass|inspectAuthorText)\(/g) ?? []
          ).length;
          if (count > 0) out.push([path.relative(SRC, file), count]);
        }
      }
    };
    walk(SRC);
    return out.sort();
  };

  test('are exactly the enumerated entry points', () => {
    expect(callers()).toEqual([
      // propertyDomains literals; a refused consumer literal's reason.
      ['design-system/policy/domains.js', 2],
      // The two definitions, their documentation comment and the one call
      // of inspectAuthorText by unsafeValueClass.
      ['design-system/policy/value-safety.js', 4],
      // Token and theme values (inspectAuthorText, whose tokens the numeric
      // facts reuse); condition definitions.
      ['design-system/registry/index.js', 2],
      // Condition-block keys of style objects (consumers, recipes).
      ['engine/lowering/styles.js', 1],
    ]);
  });

  test('global rules have no authoring entry', () => {
    const registry = fs.readFileSync(
      path.join(SRC, 'design-system/registry/index.js'),
      'utf8',
    );
    const destructured = /const \{([\s\S]*?)\n {2}\} = definition;/.exec(
      registry,
    )[1];
    expect(
      destructured
        .split(',')
        .map((s) => s.trim().split(/\s|=/)[0])
        .filter(Boolean),
    ).toEqual(['systemId', 'tokens', 'themes', 'conditions', 'recipes']);
  });
});

// Codex round 1: S1 tokenizes the complete text before any verdict, a JS
// number from its canonical text; no entry point skips or repeats it.
describe('S1 tokenizes every author text exactly once', () => {
  const cssTokenizer = require('@csstools/css-tokenizer');
  /** The texts tokenized while `fn` runs, and its result or error. */
  const tokenizations = (fn) => {
    const spy = jest.spyOn(cssTokenizer, 'tokenize');
    try {
      let result;
      try {
        result = fn();
      } catch (error) {
        result = error;
      }
      return { texts: spy.mock.calls.map(([input]) => input.css), result };
    } finally {
      spy.mockRestore();
    }
  };
  const countIn = (texts, text) => texts.filter((t) => t === text).length;

  test.each([
    ['value', 'red'],
    ['value', 'calc(1px + 2px)'],
    ['value', 0.5],
    ['value', 12],
    ['value', NaN],
    ['value', 1e7],
    ['value', 'a\\62 c'],
    ['value', 'red;}body{x:y'],
    ['value', 'var(--x)'],
    ['value', 'red !important'],
    ['condition', ':hover'],
    ['condition', ':hover}body{display:none}/*'],
  ])(
    'unsafeValueClass(%s, %p): one tokenization of its text',
    (kind, input) => {
      const { texts } = tokenizations(() => unsafeValueClass(input, kind));
      expect(texts).toEqual([String(input)]);
    },
  );

  test('a design system: every token, theme and condition text once', () => {
    const definition = {
      systemId: 'ce022-once',
      conditions: {
        hover: ':hover:not(.s1-once)',
        wide: '@media (width>=31rem)',
      },
      tokens: {
        colors: {
          a: { value: 'rgb(1 2 3 / 0.25)', visibility: 'public' },
          b: { value: 'oklch(0.7 0.1 31)', visibility: 'public' },
        },
        spacing: { a: { value: 'calc(1rem + 3px)', visibility: 'public' } },
      },
      themes: {
        dark: { tokens: { colors: { a: { value: 'rgb(3 2 1 / 0.75)' } } } },
      },
    };
    const { texts, result } = tokenizations(() =>
      compiler.buildDesignSystem(definition),
    );
    expect(result).not.toBeInstanceOf(Error);
    for (const text of [
      ':hover:not(.s1-once)',
      '@media (width>=31rem)',
      'rgb(1 2 3 / 0.25)',
      'oklch(0.7 0.1 31)',
      'calc(1rem + 3px)',
      'rgb(3 2 1 / 0.75)',
    ]) {
      expect([text, countIn(texts, text)]).toEqual([text, 1]);
    }
  });

  test('a refused token value: tokenized once, then refused', () => {
    const { texts, result } = tokenizations(() =>
      compiler.buildDesignSystem({
        ...BASE,
        tokens: {
          colors: { a: { value: 'rgb(9 9 9);x', visibility: 'public' } },
        },
      }),
    );
    expect(result.diagnostics.map((d) => d.rule)).toEqual([
      'value-safety.breakout',
    ]);
    expect(countIn(texts, 'rgb(9 9 9);x')).toBe(1);
  });

  test('propertyDomains literals, string and number', () => {
    const { texts, result } = tokenizations(() =>
      compiler.buildDesignSystem({
        ...BASE,
        propertyDomains: {
          display: {
            values: ['flex', 'inline-flex', 'grid', 'inline-grid'],
          },
          opacity: { values: [0.35, 0.65] },
        },
      }),
    );
    expect(result).not.toBeInstanceOf(Error);
    for (const text of ['inline-grid', '0.35', '0.65']) {
      expect([text, countIn(texts, text)]).toEqual([text, 1]);
    }
  });

  test('a raw condition-block key: once per design system', () => {
    const ds = compiler.buildDesignSystem(BASE);
    const key = '[data-once="1"] &';
    const { texts, result } = tokenizations(() =>
      compiler.compileStyles({
        registry: ds.registry,
        varsByToken: ds.varsByToken,
        namespaces: {
          a: { [key]: { color: compiler.token('colors.a') } },
          b: { [key]: { display: 'flex' } },
        },
        role: 'consumer',
      }),
    );
    expect(result).not.toBeInstanceOf(Error);
    expect(countIn(texts, key)).toBe(1);
  });
});

describe('compiler-owned values', () => {
  test('every standard, default and opaque value passes S1', () => {
    const failures = [];
    for (const key of compiler.descriptorKeys()) {
      const d = compiler.descriptorOf(key);
      if (d.standard == null) continue;
      for (const v of [
        ...d.standard.values,
        ...d.default.values,
        ...d.opaqueValues,
      ]) {
        const unsafe = unsafeValueClass(v, 'value');
        if (unsafe != null) failures.push([key, v, unsafe.reason]);
      }
    }
    expect(failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// S2: re-read emitted CSS.

const {
  readCss,
  valueForm,
} = require('../../../../tests/support/css-reread.cjs');

describe('the strict CSS reader', () => {
  test.each([
    ['a stray }', '.a{color:red}}.b{color:blue}', /stray \}/],
    ['an unclosed {', '.a{color:red', /unbalanced/],
    ['an unclosed at-rule', '@media (x){.a{color:red}', /unbalanced/],
    ['trailing garbage', '.a{color:red} junk', /trailing text/],
    ['a bracket closed twice', '.a{color:red)}', /unbalanced bracket/],
    ['mismatched brackets', '.a{color:rgb(1 2 3]}', /unbalanced bracket/],
    ['} inside a bracket', '.a{color:(red}}', /inside a bracket/],
    ['a tokenizer error', '.a{content:"x}', /tokenizer error/],
  ])('refuses %s', (_, css, message) => {
    expect(() => readCss(css)).toThrow(message);
  });

  test('keeps whitespace inside a quoted string exactly', () => {
    const [two] = readCss('[x="a  b"] .c{color:red}');
    const [one] = readCss('[x="a b"] .c{color:red}');
    expect(two.prelude).toEqual(['[x="a  b"] .c']);
    expect(one.prelude).not.toEqual(two.prelude);
    // Whitespace between tokens is one space.
    expect(readCss('.a   .b{color:red}')[0].prelude).toEqual(['.a .b']);
  });
});

function s2(injected, transform) {
  const texts = Object.values(injected).map((rule) =>
    transform ? compiler.targets.applyTransforms(rule.ltr) : rule.ltr,
  );
  const alone = texts.flatMap((text) => {
    try {
      return readCss(text);
    } catch (error) {
      throw new Error(`${error.message}: ${text}`);
    }
  });
  const together = readCss(texts.join('\n'));
  expect(together).toEqual(alone);
  for (const rule of together) {
    const names = rule.declarations.map(([name]) => name);
    expect({
      prelude: rule.prelude,
      duplicate: names.length !== new Set(names).size,
    }).toEqual({ prelude: rule.prelude, duplicate: false });
  }
  return together;
}

describe('S2: every emitted rule re-reads as itself', () => {
  const ds = compiler.buildDesignSystem({
    systemId: 'ce022-s2',
    conditions: {
      hover: ':hover',
      wide: '@media (min-width: 40rem)',
      rtl: '[dir=rtl] &',
    },
    tokens: {
      colors: { a: { value: 'rgba(0, 0, 0, 0.1)', visibility: 'public' } },
      fontFamilies: {
        a: { value: '"Inter", "Fira Code", sans-serif', visibility: 'public' },
      },
      shadows: {
        a: { value: '0 1px 2px rgba(0, 0, 0, 0.1)', visibility: 'public' },
      },
      easings: {
        a: { value: 'cubic-bezier(0.4, 0, 0.2, 1)', visibility: 'public' },
      },
      spacing: { a: { value: 'calc(1rem + 2px)', visibility: 'public' } },
    },
    themes: {
      dark: { tokens: { colors: { a: { value: 'light-dark(#fff, #000)' } } } },
    },
  });
  const rows = Object.values(ds.snapshot.properties.descriptors).filter(
    (row) => row.domain != null,
  );

  // Every admitted value of every row, plain, under a named condition, an
  // at-rule condition and a raw key.
  const namespaces = {};
  const expected = [];
  for (const row of rows) {
    row.domain.values.forEach((value, i) => {
      namespaces[`${row.key}_${i}`] = {
        [row.key]: { base: value, hover: value, wide: value },
        '[dir=rtl] &': { [row.key]: value },
      };
      expected.push([row.css, value]);
    });
  }
  const out = compiler.compileStyles({
    registry: ds.registry,
    varsByToken: ds.varsByToken,
    namespaces,
    role: 'system',
    allowPrivateTokens: true,
  });

  test.each([
    ['before the transform stage', false],
    ['after the transform stage', true],
  ])('%s', (_, transform) => {
    const rules = s2(out.injected, transform);
    expect(rules.length).toBeGreaterThan(expected.length);
    // Each approved literal appears with its own tokens (the engine may
    // re-spell a number, `0.5` as `.5`, but never change its value).
    const seen = new Set(
      rules.flatMap((rule) =>
        rule.declarations.map(
          ([name, value]) => `${name}=${JSON.stringify(value)}`,
        ),
      ),
    );
    for (const [css, value] of expected) {
      const form = valueForm(
        tokenize({ css: String(value) }).filter((t) => t[0] !== 'EOF-token'),
      );
      expect({
        css,
        value,
        found: seen.has(`${css}=${JSON.stringify(form)}`),
      }).toEqual({ css, value, found: true });
    }
  });

  test('the design-system token and theme rules re-read as themselves', () => {
    const rules = s2(ds.injected ?? {}, true);
    const declared = rules.flatMap((rule) => rule.declarations.map(([n]) => n));
    expect(declared.filter((n) => n.startsWith('--')).length).toBeGreaterThan(
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// Through the Project Service: source-located, with the raw-key fixture.

describe('the breakout key through the Project Service', () => {
  test('is refused at its line, and the safe raw key compiles', () => {
    const h = openProject('valid');
    const calls = [
      "create({ n: { ':hover}body{display:none}/*': { color: token('colors.text.primary') } } })",
      "create({ n: { '[dir=rtl] &': { paddingLeft: token('spacing.md') } } })",
    ];
    fs.writeFileSync(
      h.src('src/ce022b.js'),
      [
        "import { create, token } from '../generated/design.pandamstyle';",
        ...calls.map((c, i) => `export const s${i} = ${c};`),
        '',
      ].join('\n'),
    );
    h.session.applyChanges({
      definition: h.reloadDefinition(),
      mutation: undefined,
    });
    const validation = h.session.validate();
    const file = h.src('src/ce022b.js');
    const byLine = calls.map((_, i) =>
      validation.diagnostics
        .filter((d) => d.location?.file === file && d.location.line === i + 2)
        .map((d) => [d.code, d.rule]),
    );
    expect(byLine).toEqual([
      [['PMS_UNKNOWN_CONDITION', 'value-safety.breakout']],
      [],
    ]);
  });
});
