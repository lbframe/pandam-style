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
    !spec.axisOrder.every(
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

  const base = assertCompiledRef(spec.base);
  if (base.kind !== 'pandamstyle-style-ref' || base.systemId !== spec.systemId)
    invalidSpec('base must be a StyleRef from the recipe system', {
      recipeId: spec.recipeId,
    });

  for (const axis of spec.axisOrder) {
    const domain = variantMap[axis];
    if (
      !Array.isArray(domain) ||
      !domain.every((value) => typeof value === 'string') ||
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
      const branch = assertCompiledRef(axisBranches[value]);
      if (
        branch.kind !== 'pandamstyle-style-ref' ||
        branch.systemId !== spec.systemId
      ) {
        invalidSpec('branch must be a StyleRef from the recipe system', {
          recipeId: spec.recipeId,
          axis,
          value,
        });
      }
    }
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

  const entries = [...spec.base.entries];
  for (const axis of spec.axisOrder) {
    let value = selected[axis];
    if (value === undefined) {
      value = spec.defaultVariants[axis];
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
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
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
    const branch = spec.branches[axis][key];
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
    entries.push(...branch.entries);
  }
  return Object.freeze({
    kind: 'pandamstyle-style-ref',
    abiVersion: 1,
    systemId: spec.systemId,
    entries: Object.freeze(entries.map((entry) => Object.freeze([...entry]))),
  });
}

export function validateSelectorSpec(spec) {
  return validateRecipeSpec(spec);
}
