/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { selectRecipe, validateSelectorSpec } from './recipe-select.js';

function compact(value) {
  const result = {};
  for (const key of Object.keys(value ?? {})) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  return result;
}

function frozenRecord(record) {
  return Object.freeze({ ...record });
}

export function defineRecipeSelector(spec) {
  validateSelectorSpec(spec);
  const axisOrder = Object.freeze([...spec.axisOrder]);
  const variantMap = Object.freeze(
    Object.fromEntries(
      axisOrder.map((axis) => [
        axis,
        Object.freeze([...spec.variantMap[axis]]),
      ]),
    ),
  );
  const defaultVariants = frozenRecord(spec.defaultVariants);
  const selector = (selection) => selectRecipe(spec, selection);

  Object.defineProperties(selector, {
    recipeId: { value: spec.recipeId, enumerable: true },
    axisOrder: { value: axisOrder, enumerable: true },
    variantMap: { value: variantMap, enumerable: true },
    variantKeys: { value: axisOrder, enumerable: true },
    defaultVariants: { value: defaultVariants, enumerable: true },
    ...(spec.slotOrder === undefined
      ? {}
      : {
          slotOrder: {
            value: Object.freeze([...spec.slotOrder]),
            enumerable: true,
          },
        }),
    splitVariantProps: {
      enumerable: true,
      value(props = {}) {
        const axes = {};
        const rest = {};
        for (const key of Object.keys(props ?? {})) {
          (axisOrder.includes(key) ? axes : rest)[key] = props[key];
        }
        return [axes, rest];
      },
    },
    getVariantProps: {
      enumerable: true,
      value(selection) {
        return { ...defaultVariants, ...compact(selection) };
      },
    },
  });
  return selector;
}
