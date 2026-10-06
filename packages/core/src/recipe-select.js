/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { assertAbi, assertCompiledRef } from './abi.js';
import { selectionError } from './selection-error.js';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidSpec(reason, context = {}) {
  throw selectionError(
    'PMS_UNVERIFIED_PROPS_SOURCE',
    `Recipe selector data is malformed: ${reason}.`,
    'runtime.recipe-spec',
    context,
  );
}

function assertRecord(value, name, context) {
  if (!isRecord(value)) invalidSpec(`${name} must be an object`, context);
  return value;
}

function validateStyle(spec, style, name) {
  const validateRef = (ref) => {
    const compiled = assertCompiledRef(ref);
    if (
      compiled.kind !== 'pandamstyle-style-ref' ||
      compiled.systemId !== spec.systemId
    )
      invalidSpec(`${name} must contain StyleRefs from the recipe system`, {
        recipeId: spec.recipeId,
      });
  };
  if (spec.slotOrder === undefined) return validateRef(style);
  assertRecord(style, name, { recipeId: spec.recipeId });
  if (
    Object.keys(style).length !== spec.slotOrder.length ||
    spec.slotOrder.some((slot) => !Object.hasOwn(style, slot))
  )
    invalidSpec(`${name} slots must match slotOrder`, {
      recipeId: spec.recipeId,
    });
  for (const slot of spec.slotOrder) validateRef(style[slot]);
}

function validateRecipeSpec(spec) {
  assertRecord(spec, 'spec');
  if (!Number.isInteger(spec.abiVersion))
    invalidSpec('missing integer ABI version');
  assertAbi(spec.abiVersion);
  if (typeof spec.systemId !== 'string' || spec.systemId.length === 0)
    invalidSpec('missing system identity');
  if (typeof spec.recipeId !== 'string' || spec.recipeId.length === 0)
    invalidSpec('missing recipe identity', { systemId: spec.systemId });
  if (
    !Array.isArray(spec.axisOrder) ||
    !Array.from(spec.axisOrder).every(
      (axis) => typeof axis === 'string' && axis.length > 0,
    ) ||
    new Set(spec.axisOrder).size !== spec.axisOrder.length
  ) {
    invalidSpec('axisOrder must contain unique nonempty strings', {
      recipeId: spec.recipeId,
    });
  }

  const variantMap = assertRecord(spec.variantMap, 'variantMap', {
    recipeId: spec.recipeId,
  });
  const axisNames = Object.keys(variantMap);
  if (
    axisNames.length !== spec.axisOrder.length ||
    spec.axisOrder.some((axis) => !Object.hasOwn(variantMap, axis))
  ) {
    invalidSpec('variantMap axes must match axisOrder', {
      recipeId: spec.recipeId,
      axisOrder: spec.axisOrder,
      variantAxes: axisNames,
    });
  }

  const defaults = assertRecord(spec.defaultVariants, 'defaultVariants', {
    recipeId: spec.recipeId,
  });
  for (const [axis, value] of Object.entries(defaults)) {
    if (!Object.hasOwn(variantMap, axis))
      invalidSpec('default references an unknown axis', {
        recipeId: spec.recipeId,
        axis,
      });
    if (typeof value !== 'string' && typeof value !== 'boolean')
      invalidSpec('default value must be a string or boolean', {
        recipeId: spec.recipeId,
        axis,
      });
  }

  const branches = assertRecord(spec.branches, 'branches', {
    recipeId: spec.recipeId,
  });
  if (
    Object.keys(branches).length !== spec.axisOrder.length ||
    spec.axisOrder.some((axis) => !Object.hasOwn(branches, axis))
  ) {
    invalidSpec('branch axes must match axisOrder', {
      recipeId: spec.recipeId,
    });
  }

  if (
    spec.slotOrder !== undefined &&
    (!Array.isArray(spec.slotOrder) ||
      spec.slotOrder.length === 0 ||
      !Array.from(spec.slotOrder).every(
        (slot) => typeof slot === 'string' && slot.length > 0,
      ) ||
      new Set(spec.slotOrder).size !== spec.slotOrder.length)
  )
    invalidSpec('slotOrder must contain unique nonempty strings', {
      recipeId: spec.recipeId,
    });
  validateStyle(spec, spec.base, 'base');

  for (const axis of spec.axisOrder) {
    const domain = variantMap[axis];
    if (
      !Array.isArray(domain) ||
      !Array.from(domain).every((value) => typeof value === 'string') ||
      new Set(domain).size !== domain.length
    ) {
      invalidSpec('variant domains must contain unique strings', {
        recipeId: spec.recipeId,
        axis,
      });
    }
    if (
      Object.hasOwn(defaults, axis) &&
      !domain.includes(String(defaults[axis]))
    ) {
      invalidSpec('default value is outside its declared domain', {
        recipeId: spec.recipeId,
        axis,
        value: defaults[axis],
      });
    }

    const axisBranches = assertRecord(branches[axis], 'branches axis', {
      recipeId: spec.recipeId,
      axis,
    });
    if (
      Object.keys(axisBranches).length !== domain.length ||
      domain.some((value) => !Object.hasOwn(axisBranches, value))
    ) {
      invalidSpec('branches must contain every declared value and no extras', {
        recipeId: spec.recipeId,
        axis,
        domain,
      });
    }
    for (const value of domain) {
      validateStyle(spec, axisBranches[value], 'branch');
    }
  }
  if (spec.compounds !== undefined && !Array.isArray(spec.compounds))
    invalidSpec('compounds must be an array');
  for (const compound of spec.compounds ?? []) {
    assertRecord(compound, 'compound');
    const when = assertRecord(compound.when, 'compound predicate');
    if (Object.keys(when).length === 0)
      invalidSpec('compound predicate must name an axis');
    for (const [axis, values] of Object.entries(when)) {
      if (
        !Object.hasOwn(variantMap, axis) ||
        !Array.isArray(values) ||
        values.length === 0 ||
        Array.from(values).some(
          (value) =>
            typeof value !== 'string' || !variantMap[axis].includes(value),
        ) ||
        new Set(values).size !== values.length
      )
        invalidSpec(
          'compound predicate must contain declared axes and values',
          { recipeId: spec.recipeId, axis },
        );
    }
    validateStyle(spec, compound.style, 'compound style');
  }
  return spec;
}

export function selectRecipe(spec, selection) {
  validateRecipeSpec(spec);
  const selected = selection ?? {};
  if (!isRecord(selected)) {
    throw selectionError(
      'PMS_INVALID_VARIANT_KEY',
      `The selection of ${spec.recipeId} must be an object of axes.`,
      'recipe.bounded-domain',
      { recipeId: spec.recipeId, admitted: spec.axisOrder },
      { axes: spec.axisOrder },
    );
  }

  for (const axis of Object.keys(selected)) {
    if (!Object.hasOwn(spec.variantMap, axis)) {
      throw selectionError(
        'PMS_INVALID_VARIANT_KEY',
        `Unknown variant axis "${axis}" for ${spec.recipeId}.`,
        'recipe.bounded-domain',
        { recipeId: spec.recipeId, axis, admitted: spec.axisOrder },
        { axes: spec.axisOrder },
      );
    }
  }

  const effective = Object.create(null);
  const styles = [spec.base];
  for (const axis of spec.axisOrder) {
    let value = Object.hasOwn(selected, axis) ? selected[axis] : undefined;
    if (value === undefined) {
      value = Object.hasOwn(spec.defaultVariants, axis)
        ? spec.defaultVariants[axis]
        : undefined;
      if (value === undefined) continue;
    }
    if (value === null) {
      throw selectionError(
        'PMS_INVALID_VARIANT_VALUE',
        `null is not a valid selection for ${spec.recipeId}.${axis}.`,
        'recipe.bounded-domain',
        {
          recipeId: spec.recipeId,
          axis,
          value,
          admitted: spec.variantMap[axis],
        },
        { axis, domain: spec.variantMap[axis] },
      );
    }
    if (
      (typeof value !== 'string' &&
        typeof value !== 'number' &&
        typeof value !== 'boolean') ||
      (typeof value === 'number' && !Number.isFinite(value))
    ) {
      throw selectionError(
        'PMS_INVALID_VARIANT_VALUE',
        `Value for ${spec.recipeId}.${axis} must be a finite scalar.`,
        'recipe.bounded-domain',
        { recipeId: spec.recipeId, axis, admitted: spec.variantMap[axis] },
        { axis, domain: spec.variantMap[axis] },
      );
    }
    const key = String(value);
    const branch = Object.hasOwn(spec.branches[axis], key)
      ? spec.branches[axis][key]
      : undefined;
    if (branch === undefined) {
      throw selectionError(
        'PMS_INVALID_VARIANT_VALUE',
        `Value "${key}" is outside the domain of ${spec.recipeId}.${axis}.`,
        'recipe.bounded-domain',
        {
          recipeId: spec.recipeId,
          axis,
          value: key,
          admitted: spec.variantMap[axis],
        },
        { axis, domain: spec.variantMap[axis] },
      );
    }
    effective[axis] = key;
    styles.push(branch);
  }
  for (const compound of spec.compounds ?? []) {
    if (
      Object.entries(compound.when).every(([axis, values]) =>
        values.includes(effective[axis]),
      )
    )
      styles.push(compound.style);
  }
  const compose = (refs) =>
    Object.freeze({
      kind: 'pandamstyle-style-ref',
      abiVersion: 1,
      systemId: spec.systemId,
      entries: Object.freeze(
        refs
          .flatMap((ref) => ref.entries)
          .map((entry) => Object.freeze([...entry])),
      ),
    });
  if (spec.slotOrder === undefined) return compose(styles);
  return Object.freeze(
    Object.fromEntries(
      spec.slotOrder.map((slot) => [
        slot,
        compose(styles.map((style) => style[slot])),
      ]),
    ),
  );
}

export function validateSelectorSpec(spec) {
  return validateRecipeSpec(spec);
}
