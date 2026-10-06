/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Phase 2 boundary adapter from the current compiler engine's compiled atom
 * maps to the public ABI-v1 runtime representation. CSS/conflict keys are
 * already compiler-produced and remain opaque to core.
 */

export function toStyleRef(compiled, systemId) {
  if (
    compiled == null ||
    typeof compiled !== 'object' ||
    Array.isArray(compiled) ||
    compiled.$$css !== true
  ) {
    throw new TypeError('Expected a compiler-produced compiled style map.');
  }
  const entries = [];
  for (const [conflictKey, className] of Object.entries(compiled)) {
    if (conflictKey === '$$css') continue;
    if (
      typeof conflictKey !== 'string' ||
      (className !== null && typeof className !== 'string')
    ) {
      throw new TypeError('Compiler-produced style map has an invalid entry.');
    }
    entries.push([conflictKey, className]);
  }
  return {
    kind: 'pandamstyle-style-ref',
    abiVersion: 1,
    systemId,
    entries,
  };
}

export function toRuntimeRefs(value, systemId) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value))
    return value.map((item) => toRuntimeRefs(item, systemId));
  if (value.$$css === true) return toStyleRef(value, systemId);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      toRuntimeRefs(item, systemId),
    ]),
  );
}

function themeClassNames(className) {
  if (className === null) return [];
  const classes = className.trim().split(/\s+/).filter(Boolean);
  if (classes.length === 0) {
    throw new TypeError('Compiler-produced theme has an empty class entry.');
  }
  return classes;
}

function themeSlotCounts(themes, systemId) {
  const counts = new Map();
  for (const theme of Object.values(themes)) {
    for (const [conflictKey, className] of toStyleRef(theme, systemId)
      .entries) {
      const count = themeClassNames(className).length;
      counts.set(conflictKey, Math.max(counts.get(conflictKey) ?? 0, count));
    }
  }
  return counts;
}

function themeEntries(compiled, systemId, slotCounts) {
  const entries = [];
  for (const [conflictKey, className] of toStyleRef(compiled, systemId)
    .entries) {
    const classes = themeClassNames(className);
    const count = Math.max(slotCounts.get(conflictKey) ?? 0, classes.length);
    for (let index = 0; index < count; index++) {
      // The legacy compiler occasionally returns multiple class identifiers
      // for one theme group. ABI v1 keeps one identifier per entry, so expose
      // later identifiers under stable opaque slots and tombstone missing
      // slots when a subsequently composed theme has fewer identifiers.
      const key =
        index === 0
          ? conflictKey
          : `${conflictKey}\u0000pandamstyle-theme-class:${index}`;
      entries.push([key, classes[index] ?? null]);
    }
  }
  return entries;
}

export function toThemeRefs(themes, systemId) {
  const slotCounts = themeSlotCounts(themes, systemId);
  return Object.fromEntries(
    Object.entries(themes).map(([themeId, compiled]) => [
      themeId,
      {
        kind: 'pandamstyle-theme-ref',
        abiVersion: 1,
        systemId,
        themeId,
        entries: themeEntries(compiled, systemId, slotCounts),
      },
    ]),
  );
}

export function toThemeRef(themeId, compiled, systemId, themes = {}) {
  const slotCounts = themeSlotCounts(
    { ...themes, [themeId]: compiled },
    systemId,
  );
  return {
    kind: 'pandamstyle-theme-ref',
    abiVersion: 1,
    systemId,
    themeId,
    entries: themeEntries(compiled, systemId, slotCounts),
  };
}

export function toRecipeSpec(recipe, systemId) {
  const source = recipe.spec ?? recipe;
  const convert = (compiled) =>
    source.slotOrder === undefined
      ? toStyleRef(compiled, systemId)
      : Object.fromEntries(
          source.slotOrder.map((slot) => [
            slot,
            toStyleRef(compiled[slot], systemId),
          ]),
        );
  const branches = Object.fromEntries(
    Object.entries(source.branches).map(([axis, values]) => [
      axis,
      Object.fromEntries(
        Object.entries(values).map(([value, compiled]) => [
          value,
          convert(compiled),
        ]),
      ),
    ]),
  );
  return {
    abiVersion: 1,
    systemId,
    recipeId: source.recipeId,
    axisOrder: [...source.axisOrder],
    variantMap: Object.fromEntries(
      Object.entries(source.variantMap).map(([axis, values]) => [
        axis,
        [...values],
      ]),
    ),
    defaultVariants: { ...source.defaultVariants },
    base: convert(source.base),
    branches,
    ...(source.slotOrder === undefined
      ? {}
      : { slotOrder: [...source.slotOrder] }),
    ...(source.compounds === undefined
      ? {}
      : {
          compounds: source.compounds.map((compound) => ({
            when: compound.when,
            style: convert(compound.style),
          })),
        }),
  };
}
