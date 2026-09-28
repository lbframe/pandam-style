/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - bounded recipe selection (ARC-10/ARC-11, D-06).
 *
 * ONE implementation, shared by:
 *  - build time (validation of a literal selection);
 *  - consumer runtime (selection that depends on props).
 *
 * The module deliberately has no dependency beyond `diagnostics` (itself
 * import-free): the runtime therefore imports neither Babel, nor the design
 * system loader, nor the full registry, nor a CSS object interpreter. It only
 * handles finite data: `spec` is produced by the build.
 *
 * Contract (D-06):
 *  - base first, then one branch per axis following `axisOrder`;
 *  - absent / `undefined` -> default; no default -> no branch;
 *  - `false` is a value when the axis is boolean;
 *  - `null`, unknown key, unknown value -> deterministic error.
 */

import { diagnostic, PmsError, Codes } from './diagnostics';

export function recipeError(code, message, context) {
  return new PmsError([
    diagnostic({
      code,
      severity: 'error',
      phase: 'runtime-selection',
      message,
      rule: 'recipe.bounded-domain',
      context,
    }),
  ]);
}

/**
 * Returns the ordered list of compiled references.
 * @param {object} spec  { recipeId, variantMap, axisOrder, defaultVariants, base, branches }
 * @param {object} props axis selection
 */
export function selectRecipeRefs(spec, props) {
  const { recipeId, axisOrder, variantMap, defaultVariants, base, branches } =
    spec;
  const selection = props ?? {};

  if (selection === null || typeof selection !== 'object') {
    throw recipeError(
      Codes.INVALID_VARIANT_KEY,
      `The selection of ${recipeId} must be an object of axes.`,
      { recipeId, admitted: axisOrder },
    );
  }

  for (const key of Object.keys(selection)) {
    if (!axisOrder.includes(key)) {
      throw recipeError(
        Codes.INVALID_VARIANT_KEY,
        `Unknown variant axis "${key}" for ${recipeId}.`,
        { recipeId, axis: key, admitted: axisOrder },
      );
    }
  }

  const refs = [base];
  for (const axis of axisOrder) {
    let value = selection[axis];
    if (value === undefined) {
      value = defaultVariants?.[axis];
      // No default: this axis contributes no branch.
      if (value === undefined) continue;
    }
    if (value === null) {
      throw recipeError(
        Codes.INVALID_VARIANT_VALUE,
        `null is not a valid selection for ${recipeId}.${axis}.`,
        { recipeId, axis, value, admitted: variantMap[axis] },
      );
    }
    // `false` is a value: String(false) === 'false' stays inside the domain.
    const key = String(value);
    const branch = branches[axis]?.[key];
    if (branch === undefined) {
      throw recipeError(
        Codes.INVALID_VARIANT_VALUE,
        `Value "${key}" is outside the domain of ${recipeId}.${axis}.`,
        { recipeId, axis, value: key, admitted: variantMap[axis] },
      );
    }
    refs.push(branch);
  }
  return refs;
}

/** Builds the serialized `spec` from a compiled recipe. */
export function makeRecipeSpec(recipeId, recipe, compiled) {
  return {
    recipeId,
    axisOrder: recipe.axisOrder,
    variantMap: recipe.variantMap,
    defaultVariants: compiled.defaultVariants,
    base: compiled.base,
    branches: compiled.branches,
  };
}
