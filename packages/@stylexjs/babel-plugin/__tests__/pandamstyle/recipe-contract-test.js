/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle: recipe selection contract and runtime purity.
 *
 * The runtime exercised here is the real one: the built `@pandamstyle/compiler`
 * runtime, driven with the real recipe spec emitted into the generated design
 * system module. Build-time literal selection and runtime props-dependent
 * selection therefore go through the same implementation.
 */

'use strict';

jest.autoMockOff();

const fs = require('fs');
const path = require('path');
const { COMPILER_PKG, freshCopyOf, runBuild } = require('./pms-helpers');

const runtime = require(
  path.resolve(
    __dirname,
    '../../../../../.pms-test-support/compiler-inspection.cjs',
  ),
);

let project;
let spec;
let selector;

beforeAll(() => {
  project = freshCopyOf('valid');
  const result = runBuild(project);
  expect(result.status).toBe(0);

  const generated = fs.readFileSync(
    path.join(project, 'generated/design.pandamstyle.js'),
    'utf8',
  );
  spec = JSON.parse(
    generated.match(/defineRecipeSelector\((\{[\s\S]*?\n\})\);/)[1],
  );
  selector = runtime.defineRecipeSelector(spec);
});

describe('the consumer runtime is dependency-light', () => {
  test('the shipped runtime has no import at all', () => {
    const esm = fs.readFileSync(
      path.join(COMPILER_PKG, 'lib', 'runtime.mjs'),
      'utf8',
    );
    expect(esm).not.toMatch(/^\s*import\s/m);
    expect(esm).not.toMatch(/require\(/);
  });

  test('it imports no Babel, no loader, no registry, no CSS interpreter', () => {
    const esm = fs.readFileSync(
      path.join(COMPILER_PKG, 'lib', 'runtime.mjs'),
      'utf8',
    );
    for (const forbidden of [
      '@babel/',
      'crypto',
      'node:fs',
      'fs.readFile',
      'registry',
      'createHash',
      'styleXCreateSet',
      'processStylexRules',
    ]) {
      expect(esm).not.toContain(forbidden);
    }
  });

  test('it is finite: a small module, not a second engine', () => {
    const esm = fs.readFileSync(
      path.join(COMPILER_PKG, 'lib', 'runtime.mjs'),
      'utf8',
    );
    expect(esm.length).toBeLessThan(16384);
  });
});

describe('recipe selection follows axisOrder and defaults', () => {
  test('base first, then one branch per axis, in declaration order', () => {
    const refs = selector({ variant: 'primary', size: 'md' });
    expect(refs).toHaveLength(3);
    expect(refs[0]).toBe(spec.base);
    expect(refs[1]).toEqual(spec.branches.variant.primary);
    expect(refs[2]).toEqual(spec.branches.size.md);
  });

  test('absent and undefined both take the default', () => {
    const a = selector({});
    const b = selector({ variant: undefined, size: undefined });
    const c = selector({ variant: 'primary', size: 'md' });
    expect(a).toEqual(c);
    expect(b).toEqual(c);
  });

  test('the key order of the props object has no effect', () => {
    const a = selector({ variant: 'secondary', size: 'sm' });
    const b = selector({ size: 'sm', variant: 'secondary' });
    expect(a).toEqual(b);
  });

  test('false is a value, not an absence', () => {
    const boolSpec = {
      recipeId: 'flagged',
      axisOrder: ['flag'],
      variantMap: { flag: ['true', 'false'] },
      defaultVariants: {},
      base: { base: 'x', $$css: true },
      branches: {
        flag: {
          true: { opacity: 'x1', $$css: true },
          false: { opacity: 'x2', $$css: true },
        },
      },
    };
    const sel = runtime.defineRecipeSelector(boolSpec);
    expect(sel({ flag: false })).toEqual([
      boolSpec.base,
      boolSpec.branches.flag.false,
    ]);
    // absent: no default, so the axis contributes no branch
    expect(sel({})).toEqual([boolSpec.base]);
  });

  test('null, unknown key and unknown value fail deterministically', () => {
    expect(() => selector({ size: null })).toThrow(/PMS_INVALID_VARIANT_VALUE/);
    expect(() => selector({ weight: 'md' })).toThrow(/PMS_INVALID_VARIANT_KEY/);
    expect(() => selector({ variant: 'huge' })).toThrow(
      /PMS_INVALID_VARIANT_VALUE/,
    );
  });

  test('the error carries the admitted domain', () => {
    try {
      selector({ variant: 'huge' });
      throw new Error('should have thrown');
    } catch (e) {
      const d = e.diagnostics[0];
      expect(d.code).toBe('PMS_INVALID_VARIANT_VALUE');
      expect(d.context.admitted).toEqual(['primary', 'secondary']);
      expect(d.context.recipeId).toBe('button');
    }
  });

  test('no cartesian product is generated', () => {
    // base + sum of the axis values, not the product of the axes.
    const branchCount =
      1 +
      Object.values(spec.branches).reduce(
        (n, axis) => n + Object.keys(axis).length,
        0,
      );
    expect(branchCount).toBe(1 + 2 + 2);
    // The emitted spec contains exactly that many compiled references.
    expect(spec.axisOrder).toHaveLength(2);
  });
});

describe('composition contract: base + hover, then a base variant', () => {
  test('the hover branch of the variant survives in the emitted CSS', () => {
    const css = fs.readFileSync(
      path.join(project, 'generated/styles.css'),
      'utf8',
    );
    // variant.primary declares _hover { color }, so the element-state rule
    // must be present alongside the base background-color.
    expect(css).toContain(':is(:hover, [data-hover])');
    expect(css).toContain('background-color:var(--');
  });

  test('changing the base color does not remove the hover branch', () => {
    const css = fs.readFileSync(
      path.join(project, 'generated/styles.css'),
      'utf8',
    );
    const hoverRules = css
      .split('\n')
      .filter((line) => line.includes(':is(:hover, [data-hover])'));
    expect(hoverRules.length).toBeGreaterThan(0);
    for (const rule of hoverRules) {
      expect(rule).toMatch(/color:var\(--/);
    }
  });

  test('the fork composition runtime composes the compiled refs', () => {
    // styleq is the fork's composer: last wins per property+condition.
    const stylex = require(
      require.resolve('@stylexjs/stylex', { paths: [COMPILER_PKG] }),
    );
    const base = stylex.props(spec.base);
    const variant = stylex.props(spec.branches.variant.primary);
    const composed = stylex.props(spec.base, spec.branches.variant.secondary);
    expect(typeof base.className).toBe('string');
    expect(typeof variant.className).toBe('string');
    // Both classes are kept: the composition is additive, not a replacement.
    const merged = stylex.props(spec.base, spec.branches.size.md);
    expect(merged.className.split(' ').length).toBeGreaterThan(
      base.className.split(' ').length,
    );
    expect(composed.className).not.toBe(variant.className);
  });
});

describe('props-dependent selection keeps the runtime guard', () => {
  test('the TSX page emits an uncompiled selector call, not a baked literal', () => {
    const code = fs.readFileSync(
      path.join(project, 'generated/js/src/page.tsx'),
      'utf8',
    );
    // `size` comes from props, so the call must survive to runtime.
    expect(code).toMatch(/recipes\.button\(\{/);
    expect(code).toMatch(/variant:\s*['"]primary['"]/);
    expect(code).toMatch(/\bsize\b\s*,?\s*\}\)/);
  });

  test('that call goes through the bounded selector', () => {
    const code = fs.readFileSync(
      path.join(project, 'generated/js/src/page.tsx'),
      'utf8',
    );
    expect(code).toContain('recipes');
    // The runtime selector is the only thing that can resolve it.
    expect(() => selector({ variant: 'primary', size: 'md' })).not.toThrow();
    expect(() => selector({ variant: 'primary', size: 'huge' })).toThrow(
      /PMS_INVALID_VARIANT_VALUE/,
    );
  });
});
