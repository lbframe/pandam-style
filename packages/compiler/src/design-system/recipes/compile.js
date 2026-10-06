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
 * Named slots and ordered compound variants, without .raw/.merge,
 * precompiled branches and a bounded runtime selector.
 */

import { defineRecipeSelector } from '@pandamstyle/core';
import { toRecipeSpec } from '../../artifacts/javascript/refs';
import { validateRecipeDefinition } from './validate';

function compact(obj) {
  const out = {};
  for (const k of Object.keys(obj ?? {})) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

export function defineRecipe(config, compileStyleObject) {
  const recipeId = config.recipeId ?? 'anonymous';
  const {
    base = {},
    variants = {},
    defaultVariants = {},
    slots,
    compounds = [],
  } = config.compounds === undefined
    ? validateRecipeDefinition(recipeId, config)
    : config;
  const axisOrder = Object.keys(variants); // order captured at declaration time

  // Compiles each branch: base + one entry per (axis, value).
  // Sum of the branches, not a cartesian product (ARC-11).
  const compile = (style, name) =>
    slots === undefined
      ? compileStyleObject(style, name)
      : Object.fromEntries(
          slots.map((slot) => [
            slot,
            compileStyleObject(
              Object.hasOwn(style, slot) ? style[slot] : {},
              `${name}.${slot}`,
            ),
          ]),
        );
  const compiledBase = compile(base, `${recipeId}.base`);
  const compiledBranches = Object.fromEntries(
    axisOrder.map((axis) => [
      axis,
      Object.fromEntries(
        Object.entries(variants[axis]).map(([value, style]) => [
          value,
          compile(style, `${recipeId}.${axis}.${value}`),
        ]),
      ),
    ]),
  );

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
    ...(slots === undefined ? {} : { slotOrder: [...slots] }),
    ...(compounds.length === 0
      ? {}
      : {
          compounds: compounds.map((compound, index) => ({
            when: compound.when,
            style: compile(compound.css, `${recipeId}.compound.${index}`),
          })),
        }),
  };

  const selector = defineRecipeSelector(toRecipeSpec(spec, config.systemId));

  function cvaFn(props) {
    return selector(props);
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
    recipeId,
    variantMap,
    variantKeys,
    axisOrder,
    defaultVariants,
    spec,
    ...(slots === undefined ? {} : { slotOrder: [...slots] }),
    splitVariantProps,
    getVariantProps,
    // ARC-11 : pas de .raw (CSS brut), pas de .merge (fusion libre).
  });
}

export function isStyleRef(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    value.kind === 'pandamstyle-style-ref'
  );
}
