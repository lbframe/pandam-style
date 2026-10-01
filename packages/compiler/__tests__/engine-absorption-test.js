/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * PandamStyle-owned protection for the behavior absorbed in Phase 4.
 */

'use strict';

const path = require('path');
const babel = require('@babel/core');
const engine = require(
  path.resolve(__dirname, '../../../.pms-test-support/compiler-inspection.cjs'),
);

function evaluateInitializer(source, name, parserPlugins = []) {
  let result = null;
  babel.transformSync(source, {
    babelrc: false,
    configFile: false,
    parserOpts: { sourceType: 'module', plugins: parserPlugins },
    plugins: [
      () => ({
        visitor: {
          VariableDeclarator(p) {
            if (p.get('id').isIdentifier({ name })) {
              result = engine.evaluateStaticExpression(p.get('init'));
            }
          },
        },
      }),
    ],
  });
  return result;
}

describe('PandamStyle absorbed static evaluator and pass state', () => {
  test('folds immutable aliases, spreads, computed keys, and TypeScript wrappers', () => {
    const result = evaluateInitializer(
      `const base = { padding: 4 };
       const value = { ...base, ['marginTop']: 2 } satisfies object;`,
      'value',
      ['typescript'],
    );
    expect(result).toMatchObject({
      confident: true,
      value: { padding: 4, marginTop: 2 },
    });
  });

  test('fails closed for imported values and reassigned bindings', () => {
    const imported = evaluateInitializer(
      "import { value } from './external.js'; const result = value;",
      'result',
    );
    const reassigned = evaluateInitializer(
      'let value = 1; value = 2; const result = value;',
      'result',
    );
    expect(imported.confident).toBe(false);
    expect(reassigned.confident).toBe(false);
  });

  test('creates isolated, immutable state for each Babel pass', () => {
    const first = engine.createPassState({
      file: { opts: { filename: '/one/page.tsx' } },
    });
    const second = engine.createPassState({
      file: { opts: { filename: '/two/page.tsx' } },
    });
    expect(first).not.toBe(second);
    expect(first.filename).toBe('/one/page.tsx');
    expect(second.filename).toBe('/two/page.tsx');
    expect(Object.isFrozen(first)).toBe(true);
  });
});

describe('PandamStyle absorbed atomic and variable engine', () => {
  test('generates deterministic atoms, property conflicts, conditions, and deduplicated rules', () => {
    const namespaces = {
      card: {
        padding: 8,
        marginTop: 2,
        margin: 4,
        ':hover': { opacity: 0.5 },
        '@media (min-width: 700px)': { padding: 12 },
      },
      duplicate: { padding: 8 },
    };
    const options = engine.normalizeEngineOptions();
    expect(options).toMatchObject({
      classNamePrefix: 'x',
      enableFontSizePxToRem: false,
      enableLogicalStylesPolyfill: false,
      enableMediaQueryOrder: true,
      styleResolution: 'property-specificity',
    });
    const first = engine.lowerAtomicStyles(namespaces, options);
    const second = engine.lowerAtomicStyles(namespaces, options);
    expect(first).toEqual(second);
    expect(first[0].card.$$css).toBe(true);
    expect(Object.values(first[0].card)).toContain(
      Object.values(first[0].duplicate)[0],
    );
    const declarations = Object.values(first[1]);
    expect(
      declarations.filter((r) => r.ltr.includes('padding:8px')),
    ).toHaveLength(1);
    expect(declarations.some((r) => r.ltr.includes(':hover'))).toBe(true);
    expect(
      declarations.some((r) => r.ltr.includes('@media (min-width: 700px)')),
    ).toBe(true);
    expect(
      declarations.find((r) => r.ltr.includes('margin:4px')).priority,
    ).toBeLessThan(
      declarations.find((r) => r.ltr.includes('margin-top:2px')).priority,
    );

    const expanded = engine.lowerAtomicStyles(
      { box: { margin: '1px 2px 3px 4px' } },
      engine.normalizeEngineOptions({
        styleResolution: 'legacy-expand-shorthands',
      }),
    )[1];
    const expandedDeclarations = Object.values(expanded).map(
      (rule) => rule.ltr,
    );
    expect(expandedDeclarations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('{margin-top:1px}'),
        expect.stringContaining('{margin-inline-end:2px}'),
        expect.stringContaining('{margin-bottom:3px}'),
        expect.stringContaining('{margin-inline-start:4px}'),
      ]),
    );
  });

  test('lowers stable token variables and projects themes onto one variable group', () => {
    const options = engine.normalizeEngineOptions();
    const tokens = {
      primary: '#123',
      responsive: {
        default: '1rem',
        '@media (min-width: 700px)': '2rem',
      },
    };
    const [base, baseRules] = engine.lowerTokenVariables(tokens, {
      ...options,
      exportId: 'fixture.system',
    });
    const [sameBase, sameRules] = engine.lowerTokenVariables(tokens, {
      ...options,
      exportId: 'fixture.system',
    });
    const [alternate, alternateRules] = engine.projectTheme(
      base,
      { primary: '#456' },
      options,
    );
    expect(base).toEqual(sameBase);
    expect(baseRules).toEqual(sameRules);
    expect(alternate[base.__varGroupHash__]).toContain(base.__varGroupHash__);
    expect(Object.values(baseRules).some((r) => r.ltr.includes('@media'))).toBe(
      true,
    );
    expect(
      Object.values(alternateRules).some((r) => r.ltr.includes('--')),
    ).toBe(true);
  });

  test('uses shared ordering for priority, breakpoint, layer, and direction output', () => {
    const rules = [
      ['wide', { ltr: '@media (min-width: 800px){.wide{padding:2px}}' }, 3000],
      ['color', { ltr: '.color{color:red}' }, 3000],
      ['margin', { ltr: '.margin{margin:1px}' }, 1000],
    ];
    const compare = engine.createRuleComparator({});
    expect(compare(rules[2], rules[1])).toBeLessThan(0);
    const css = engine.processStylexRules(rules, {
      useLayers: { before: ['reset'], after: ['utilities'], prefix: 'pms' },
    });
    expect(css).toContain(
      '@layer reset, pms.priority1, pms.priority2, utilities;',
    );
    expect(css.indexOf('.margin{margin:1px}')).toBeLessThan(
      css.indexOf('.color{color:red}'),
    );
    expect(css).toContain('@media (min-width: 800px)');
    expect(engine.layerHeader({ useLayers: false }, 2)).toBe('');
    expect(
      engine.logicalFloatVars([
        ['float', { ltr: '.float{float:var(--stylex-logical-start)}' }, 3000],
      ]),
    ).toContain('--stylex-logical-start: left');
    const [, directionRules] = engine.lowerAtomicStyles(
      { flow: { float: 'inline-start' } },
      engine.normalizeEngineOptions(),
    );
    const floatRule = Object.values(directionRules).find((rule) =>
      rule.ltr.includes('float:left'),
    );
    expect(floatRule.ltr).toContain('float:left');
    expect(floatRule.rtl).toContain('float:right');
  });
});
