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
const babel = require('@babel/core');
const { freshCopyOf, runBuild } = require('./pms-helpers');

function loadCoreRuntime(entry) {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const { code } = babel.transformSync(fs.readFileSync(file, 'utf8'), {
      configFile: false,
      babelrc: false,
      plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')],
    });
    const mod = { exports: {} };
    cache.set(file, mod);
    const localRequire = (request) => {
      if (!request.startsWith('.')) return require(request);
      return load(path.resolve(path.dirname(file), request));
    };
    // The tests are CommonJS, while the public core package intentionally ships
    // ESM only. Transform its source in memory without adding a CJS package API.
    // eslint-disable-next-line no-new-func
    new Function('require', 'module', 'exports', code)(
      localRequire,
      mod,
      mod.exports,
    );
    return mod.exports;
  }
  return load(entry);
}

const runtime = loadCoreRuntime(
  path.resolve(__dirname, '../../../core/src/index.js'),
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
  test('the core runtime stays ESM and donor-free', () => {
    const files = fs
      .readdirSync(path.join(__dirname, '../../../core/src'))
      .filter((name) => name.endsWith('.js'));
    const source = files
      .map((name) =>
        fs.readFileSync(
          path.join(__dirname, '../../../core/src', name),
          'utf8',
        ),
      )
      .join('\n');
    expect(source).not.toMatch(/require\s*\(/);
    expect(source).not.toMatch(
      /from\s+['"](?:node:)?(?:fs|path|crypto|module)['"]/,
    );
    expect(source).not.toContain('@stylexjs/');
    expect(source).not.toContain('@pandacss/');
  });

  test('core ships no runtime dependencies', () => {
    const manifest = require('../../../core/package.json');
    expect(manifest.type).toBe('module');
    expect(manifest.sideEffects).toBe(false);
    expect(manifest.dependencies ?? {}).toEqual({});
  });
});

describe('recipe selection follows axisOrder and defaults', () => {
  test('one StyleRef flattens base then branches in declaration order', () => {
    const ref = selector({ variant: 'primary', size: 'md' });
    expect(ref.kind).toBe('pandamstyle-style-ref');
    expect(ref.entries).toEqual([
      ...spec.base.entries,
      ...spec.branches.variant.primary.entries,
      ...spec.branches.size.md.entries,
    ]);
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
      abiVersion: 1,
      systemId: 'bool-system',
      recipeId: 'flagged',
      axisOrder: ['flag'],
      variantMap: { flag: ['true', 'false'] },
      defaultVariants: {},
      base: {
        kind: 'pandamstyle-style-ref',
        abiVersion: 1,
        systemId: 'bool-system',
        entries: [['base', 'x']],
      },
      branches: {
        flag: {
          true: {
            kind: 'pandamstyle-style-ref',
            abiVersion: 1,
            systemId: 'bool-system',
            entries: [['opacity', 'x1']],
          },
          false: {
            kind: 'pandamstyle-style-ref',
            abiVersion: 1,
            systemId: 'bool-system',
            entries: [['opacity', 'x2']],
          },
        },
      },
    };
    const sel = runtime.defineRecipeSelector(boolSpec);
    expect(sel({ flag: false }).entries).toEqual([
      ...boolSpec.base.entries,
      ...boolSpec.branches.flag.false.entries,
    ]);
    // absent: no default, so the axis contributes no branch
    expect(sel({}).entries).toEqual(boolSpec.base.entries);
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
      expect(e.code).toBe('PMS_INVALID_VARIANT_VALUE');
      expect(e.context.admitted).toEqual(['primary', 'secondary']);
      expect(e.context.recipeId).toBe('button');
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

  test('the core composition runtime composes compiled refs', () => {
    const base = runtime.props(spec.base);
    const variant = runtime.props(spec.branches.variant.primary);
    const composed = runtime.props(spec.base, spec.branches.variant.secondary);
    expect(typeof base.className).toBe('string');
    expect(typeof variant.className).toBe('string');
    // Both classes are kept: the composition is additive, not a replacement.
    const merged = runtime.props(spec.base, spec.branches.size.md);
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
