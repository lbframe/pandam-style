/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - compiled recipes (ARC-10/ARC-11, D-06).
 * Selection/defaults carried over from @pandacss cva
 * (chakra-ui/panda @ 1a310482, packages/generator/src/artifacts/js/cva.ts)
 * avec restrictions P0 : pas de compoundVariants, pas de .raw/.merge,
 * precompiled branches and a bounded runtime selector.
 */

import { selectRecipeRefs } from '../../../../@stylexjs/babel-plugin/pandamstyle/recipe-select';

function compact(obj) {
  const out = {};
  for (const k of Object.keys(obj ?? {})) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

export function defineRecipe(config, compileStyleObject) {
  const { base = {}, variants = {}, defaultVariants = {} } = config;
  const recipeId = config.recipeId ?? 'anonymous';
  const axisOrder = Object.keys(variants); // order captured at declaration time

  // Compiles each branch: base + one entry per (axis, value).
  // Sum of the branches, not a cartesian product (ARC-11).
  const compiledBase = compileStyleObject(base, `${recipeId}.base`);
  const compiledBranches = {};
  for (const axis of axisOrder) {
    compiledBranches[axis] = {};
    for (const value of Object.keys(variants[axis])) {
      compiledBranches[axis][value] = compileStyleObject(
        variants[axis][value],
        `${recipeId}.${axis}.${value}`,
      );
    }
  }

  const variantMap = Object.fromEntries(
    axisOrder.map((axis) => [axis, Object.keys(variants[axis])]),
  );
  const variantKeys = axisOrder;

  // Finite data exposed to the runtime and to the build: no CSS object
  // interpretation, only already-compiled references.
  const spec = {
    recipeId,
    axisOrder,
    variantMap,
    defaultVariants,
    base: compiledBase,
    branches: compiledBranches,
  };

  // One single selection implementation, shared with the runtime.
  function resolve(props) {
    return selectRecipeRefs(spec, props);
  }

  function cvaFn(props) {
    // Opaque StyleRef: ordered list of compiled refs; only the fork runtime
    // (props) composes them. No CSS string, no free-form merge.
    return Object.freeze({ __pmsStyleRef: true, refs: resolve(props) });
  }

  function splitVariantProps(props) {
    const picked = {};
    const rest = {};
    for (const k of Object.keys(props ?? {})) {
      if (axisOrder.includes(k)) picked[k] = props[k];
      else rest[k] = props[k];
    }
    return [picked, rest];
  }

  const getVariantProps = (variants) => ({
    ...defaultVariants,
    ...compact(variants),
  });

  return Object.assign(cvaFn, {
    __pmsRecipe: true,
    recipeId,
    variantMap,
    variantKeys,
    axisOrder,
    defaultVariants,
    spec,
    splitVariantProps,
    getVariantProps,
    // ARC-11 : pas de .raw (CSS brut), pas de .merge (fusion libre).
  });
}

export function isStyleRef(value) {
  return (
    value !== null && typeof value === 'object' && value.__pmsStyleRef === true
  );
}
