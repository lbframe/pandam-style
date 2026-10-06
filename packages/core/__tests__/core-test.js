/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';

const {
  ABI_VERSION,
  PmsSelectionError,
  assertAbi,
  defineRecipeSelector,
  props,
} = require('../src/index.js');

function style(systemId, entries, abiVersion = 1) {
  return {
    kind: 'pandamstyle-style-ref',
    abiVersion,
    systemId,
    entries,
  };
}

function theme(systemId, themeId, entries) {
  return {
    kind: 'pandamstyle-theme-ref',
    abiVersion: 1,
    systemId,
    themeId,
    entries,
  };
}

function recipeSpec(overrides = {}) {
  const systemId = 'test-system';
  return {
    abiVersion: 1,
    systemId,
    recipeId: 'button',
    axisOrder: ['tone', 'size', 'flag'],
    variantMap: {
      tone: ['quiet', 'loud'],
      size: ['sm', 'md'],
      flag: ['true', 'false'],
    },
    defaultVariants: { tone: 'quiet', size: 'md' },
    base: style(systemId, [['display', 'c-inline-flex']]),
    branches: {
      tone: {
        quiet: style(systemId, [['color', 'c-muted']]),
        loud: style(systemId, [['color', 'c-bright']]),
      },
      size: {
        sm: style(systemId, [['padding', 'c-small']]),
        md: style(systemId, [['padding', 'c-medium']]),
      },
      flag: {
        true: style(systemId, [['opacity', 'c-one']]),
        false: style(systemId, [['opacity', 'c-half']]),
      },
    },
    ...overrides,
  };
}

describe('finite slot and compound selectors', () => {
  const compound = (when, entries) => ({
    when,
    style: style('test-system', entries),
  });
  test('inherited selection values and branch members are outside the declared domain', () => {
    const selector = defineRecipeSelector(recipeSpec());
    expect(selector(Object.create({ tone: 'loud' }))).toEqual(selector({}));
    expect(() => selector({ tone: 'toString' })).toThrow(
      /PMS_INVALID_VARIANT_VALUE/,
    );
    expect(() => selector({ tone: Infinity })).toThrow(
      /PMS_INVALID_VARIANT_VALUE/,
    );
  });
  test('defaults match ordered compounds after declared axes; false remains a value', () => {
    const spec = recipeSpec({
      compounds: [
        compound({ tone: ['quiet'], size: ['sm', 'md'] }, [
          ['opacity', 'c-compound'],
        ]),
        compound({ size: ['md'], flag: ['false'] }, [['opacity', 'c-last']]),
      ],
    });
    const selector = defineRecipeSelector(spec);
    expect(props(selector({ flag: false })).className).toBe(
      'c-inline-flex c-muted c-medium c-last',
    );
    expect(props(selector({})).className).toBe(
      'c-inline-flex c-muted c-medium c-compound',
    );
    expect(selector({ flag: false, size: 'md' })).toEqual(
      selector({ size: 'md', flag: false }),
    );
    expect(props(selector({ tone: 'loud', size: 'sm' })).className).toBe(
      'c-inline-flex c-bright c-small',
    );
  });
  test('named slots preserve order and keep conflicts isolated', () => {
    const original = recipeSpec();
    const slots = (ref) => ({ root: ref, label: style('test-system', []) });
    const spec = {
      ...original,
      slotOrder: ['root', 'label'],
      base: {
        root: original.base,
        label: style('test-system', [['display', 'c-label']]),
      },
      branches: Object.fromEntries(
        Object.entries(original.branches).map(([axis, values]) => [
          axis,
          Object.fromEntries(
            Object.entries(values).map(([value, ref]) => [value, slots(ref)]),
          ),
        ]),
      ),
      compounds: [
        {
          when: { flag: ['false'] },
          style: {
            root: style('test-system', [['display', 'c-root-compound']]),
            label: style('test-system', [['display', 'c-label-compound']]),
          },
        },
      ],
    };
    const selector = defineRecipeSelector(spec);
    const result = selector({ flag: false });
    expect(selector.slotOrder).toEqual(['root', 'label']);
    expect(Object.keys(result)).toEqual(['root', 'label']);
    expect(props(result.root).className).toBe(
      'c-muted c-medium c-half c-root-compound',
    );
    expect(props(result.label).className).toBe('c-label-compound');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.root.entries[0])).toBe(true);
    expect(() => props(result)).toThrow(/PMS_UNVERIFIED_PROPS_SOURCE/);
  });
  test.each([
    { slotOrder: [] },
    { slotOrder: Array(1) },
    { slotOrder: ['root', 'root'] },
    { slotOrder: ['root'] },
    { compounds: {} },
    { compounds: [compound({}, [])] },
    { compounds: [compound({ absent: ['quiet'] }, [])] },
    { compounds: [compound({ tone: ['absent'] }, [])] },
    { compounds: [compound({ tone: Array(1) }, [])] },
    { compounds: [compound({ tone: ['quiet', 'quiet'] }, [])] },
    {
      compounds: [
        { when: { tone: ['quiet'] }, style: style('other-system', []) },
      ],
    },
  ])('malformed compiler data fails before selection: %j', (override) => {
    expect(() => defineRecipeSelector(recipeSpec(override))).toThrow(
      /PMS_UNVERIFIED_PROPS_SOURCE/,
    );
  });
});

describe('@pandamstyle/core ABI v1', () => {
  test('assertAbi accepts v1 and rejects unsupported versions structurally', () => {
    expect(ABI_VERSION).toBe(1);
    expect(assertAbi(1)).toBe(1);
    try {
      assertAbi(2);
      throw new Error('expected ABI mismatch');
    } catch (error) {
      expect(error).toBeInstanceOf(PmsSelectionError);
      expect(error.code).toBe('PMS_ABI_MISMATCH');
      expect(error.diagnostic.code).toBe('PMS_ABI_MISMATCH');
    }
  });

  test('empty composition and false/null/undefined omissions return no classes', () => {
    expect(props()).toEqual({});
    expect(props(null, false, undefined, [null, false])).toEqual({});
  });

  test('nested refs flatten left to right and the last conflict wins', () => {
    const first = style('ui', [
      ['display', 'c-grid'],
      ['opacity', 'c-half'],
    ]);
    const second = style('ui', [
      ['display', 'c-flex'],
      ['gap', 'c-gap'],
    ]);
    expect(props(first, [null, [second, false]])).toEqual({
      className: 'c-half c-flex c-gap',
    });
  });

  test('tombstones cancel an earlier key and duplicate classes keep their last position', () => {
    const result = props(
      style('ui', [
        ['display', 'c-grid'],
        ['opacity', 'c-half'],
        ['old-gap', 'c-gap'],
        ['shared-a', 'c-shared'],
      ]),
      style('ui', [
        ['display', 'c-flex'],
        ['old-gap', null],
        ['shared-b', 'c-shared'],
      ]),
    );
    expect(result).toEqual({ className: 'c-half c-flex c-shared' });
  });

  test('themes replace the same variable group while styles remain independent', () => {
    expect(
      props(
        theme('ui', 'light', [['theme:colors', 'c-light']]),
        style('ui', [['display', 'c-grid']]),
        theme('ui', 'dark', [['theme:colors', 'c-dark']]),
      ),
    ).toEqual({ className: 'c-grid c-dark' });
  });

  test('cross-system composition and malformed runtime sources fail closed', () => {
    for (const input of [
      { className: 'invented' },
      'invented',
      true,
      42,
      () => null,
      style('ui', [['display', 'two classes']]),
    ]) {
      expect(() => props(input)).toThrow(
        expect.objectContaining({ code: 'PMS_UNVERIFIED_PROPS_SOURCE' }),
      );
    }
    expect(() => props(style('one', []), style('two', []))).toThrow(
      expect.objectContaining({ code: 'PMS_UNVERIFIED_PROPS_SOURCE' }),
    );
  });

  test('unsupported reference ABI fails with PMS_ABI_MISMATCH', () => {
    expect(() => props(style('ui', [], 2))).toThrow(
      expect.objectContaining({ code: 'PMS_ABI_MISMATCH' }),
    );
  });

  test('cyclic nested input arrays are rejected deterministically', () => {
    const cyclic = [];
    cyclic.push(cyclic);
    expect(() => props(cyclic)).toThrow(
      expect.objectContaining({ code: 'PMS_UNVERIFIED_PROPS_SOURCE' }),
    );
  });
});

describe('finite generated recipe selectors', () => {
  const spec = recipeSpec();

  test('returns one StyleRef with base and selected branches in axis order', () => {
    const selector = defineRecipeSelector(spec);
    const result = selector({ size: 'sm', tone: 'loud' });
    expect(result).toEqual({
      kind: 'pandamstyle-style-ref',
      abiVersion: 1,
      systemId: 'test-system',
      entries: [
        ...spec.base.entries,
        ...spec.branches.tone.loud.entries,
        ...spec.branches.size.sm.entries,
      ],
    });
  });

  test('undefined uses defaults, absent defaults add no branch, and false is a value', () => {
    const selector = defineRecipeSelector(spec);
    expect(selector().entries).toEqual([
      ...spec.base.entries,
      ...spec.branches.tone.quiet.entries,
      ...spec.branches.size.md.entries,
    ]);
    expect(selector({ flag: false }).entries).toContainEqual([
      'opacity',
      'c-half',
    ]);
    const withoutDefault = recipeSpec({ defaultVariants: {} });
    expect(defineRecipeSelector(withoutDefault)({}).entries).toEqual(
      withoutDefault.base.entries,
    );
  });

  test('selection helpers expose readonly metadata and split declared axes', () => {
    const selector = defineRecipeSelector(spec);
    expect(selector.recipeId).toBe('button');
    expect(selector.variantKeys).toEqual(['tone', 'size', 'flag']);
    expect(selector.getVariantProps({ size: 'sm' })).toEqual({
      tone: 'quiet',
      size: 'sm',
    });
    expect(selector.splitVariantProps({ size: 'sm', id: 'cta' })).toEqual([
      { size: 'sm' },
      { id: 'cta' },
    ]);
    expect(() => {
      selector.recipeId = 'changed';
    }).toThrow();
  });

  test('unknown axes/values and explicit null fail with structured errors', () => {
    const selector = defineRecipeSelector(spec);
    const cases = [
      [{ weight: 'md' }, 'PMS_INVALID_VARIANT_KEY'],
      [{ size: 'xl' }, 'PMS_INVALID_VARIANT_VALUE'],
      [{ size: null }, 'PMS_INVALID_VARIANT_VALUE'],
    ];
    for (const [selection, code] of cases) {
      try {
        selector(selection);
        throw new Error('expected selection error');
      } catch (error) {
        expect(error).toBeInstanceOf(PmsSelectionError);
        expect(error.code).toBe(code);
        expect(error.diagnostic).toMatchObject({
          code,
          phase: 'runtime-selection',
        });
      }
    }
  });

  test('numeric scalar values retain baseline coercion to finite string keys', () => {
    const numeric = recipeSpec({
      axisOrder: ['level'],
      variantMap: { level: ['1', '2'] },
      defaultVariants: {},
      branches: {
        level: {
          '1': style('test-system', [['opacity', 'c-half']]),
          '2': style('test-system', [['opacity', 'c-one']]),
        },
      },
    });
    expect(defineRecipeSelector(numeric)({ level: 2 }).entries).toEqual([
      ...numeric.base.entries,
      ...numeric.branches.level['2'].entries,
    ]);
  });

  test('malformed recipe data and cross-system branches are rejected at factory time', () => {
    expect(() => defineRecipeSelector({ ...spec, abiVersion: 2 })).toThrow(
      expect.objectContaining({ code: 'PMS_ABI_MISMATCH' }),
    );
    expect(() =>
      defineRecipeSelector({
        ...spec,
        branches: {
          ...spec.branches,
          size: {
            ...spec.branches.size,
            sm: style('other-system', [['padding', 'c-small']]),
          },
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'PMS_UNVERIFIED_PROPS_SOURCE' }));
  });
});
