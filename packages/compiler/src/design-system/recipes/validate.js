/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Codes, diagnostic, PmsError } from '../../protocol/diagnostics';

const record = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const scalar = (value) =>
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value));
const safeName = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  !['__proto__', 'constructor', 'prototype'].includes(value);

// Normalize only finite domains. CSS remains compiler input and never travels
// into a runtime selector; sparse slot maps are completed while compiling.
export function validateRecipeDefinition(recipeId, config) {
  const fail = (code, message, context = {}) => {
    throw new PmsError([
      diagnostic({
        code,
        phase: 'registry',
        source: `design-system:recipes.${recipeId}`,
        rule: 'recipe.definition',
        message: `Recipe ${recipeId}: ${message}`,
        context: { recipeId, ...context },
      }),
    ]);
  };
  const object = (value, name) => {
    if (!record(value))
      fail(Codes.INVALID_RECIPE, `${name} must be an object.`);
    return value;
  };
  object(config, 'definition');
  if (config.jsx != null)
    fail(Codes.UNSUPPORTED_FEATURE, 'jsx is not supported.');
  const slots = config.slots;
  if (
    slots !== undefined &&
    (!Array.isArray(slots) ||
      slots.length === 0 ||
      !Array.from(slots).every(safeName) ||
      new Set(slots).size !== slots.length)
  )
    fail(
      Codes.INVALID_RECIPE_SLOT,
      'slots must be a nonempty array of unique names.',
      { slots },
    );
  const style = (value, name) => {
    object(value, name);
    if (slots !== undefined) {
      for (const slot of Object.keys(value)) {
        if (!slots.includes(slot))
          fail(
            Codes.INVALID_RECIPE_SLOT,
            `unknown slot "${slot}" in ${name}.`,
            { slot, admitted: slots },
          );
        object(value[slot], `${name}.${slot}`);
      }
    }
    return value;
  };
  const base = style(config.base ?? {}, 'base');
  const variants = object(config.variants ?? {}, 'variants');
  const axisOrder = Object.keys(variants);
  for (const axis of axisOrder) {
    if (!safeName(axis))
      fail(Codes.INVALID_VARIANT_KEY, 'axes must have nonempty safe names.', {
        axis,
      });
    object(variants[axis], `variants.${axis}`);
    for (const value of Object.keys(variants[axis]))
      style(variants[axis][value], `variants.${axis}.${value}`);
  }
  const domain = (axis, value) => {
    if (!Object.hasOwn(variants, axis))
      fail(Codes.INVALID_VARIANT_KEY, `unknown variant axis "${axis}".`, {
        axis,
        admitted: axisOrder,
      });
    if (!scalar(value) || !Object.hasOwn(variants[axis], String(value)))
      fail(Codes.INVALID_VARIANT_VALUE, `invalid value for axis "${axis}".`, {
        axis,
        value,
        admitted: Object.keys(variants[axis]),
      });
    return String(value);
  };
  const defaultVariants = object(
    config.defaultVariants ?? {},
    'defaultVariants',
  );
  for (const [axis, value] of Object.entries(defaultVariants)) {
    domain(axis, value);
    if (typeof value !== 'string' && typeof value !== 'boolean')
      fail(
        Codes.INVALID_VARIANT_VALUE,
        'defaults must be strings or booleans.',
        { axis, value },
      );
  }
  const declarations = config.compoundVariants ?? [];
  if (!Array.isArray(declarations))
    fail(Codes.INVALID_RECIPE, 'compoundVariants must be an array.');
  const seen = new Map();
  const compounds = declarations.map((compound, index) => {
    object(compound, `compoundVariants.${index}`);
    const predicateAxes = Object.keys(compound).filter(
      (axis) => axis !== 'css',
    );
    if (predicateAxes.length === 0)
      fail(Codes.INVALID_RECIPE, 'compound must select at least one axis.', {
        compoundIndex: index,
      });
    const predicate = Object.fromEntries(
      predicateAxes.map((axis) => {
        const values = Array.isArray(compound[axis])
          ? compound[axis]
          : [compound[axis]];
        if (values.length === 0)
          fail(
            Codes.INVALID_VARIANT_VALUE,
            'compound domain must be nonempty.',
            { axis, compoundIndex: index },
          );
        const normalized = Array.from(values, (value) => domain(axis, value));
        if (new Set(normalized).size !== normalized.length)
          fail(
            Codes.INVALID_VARIANT_VALUE,
            'compound domain must contain unique values.',
            { axis, compoundIndex: index },
          );
        return [axis, normalized];
      }),
    );
    // Predicate key/array ordering has no selection semantics. Project it in
    // the declared axis/domain order so equivalent predicates emit identical
    // finite data and share the same registry identity.
    const when = Object.fromEntries(
      axisOrder
        .filter((axis) => Object.hasOwn(predicate, axis))
        .map((axis) => [
          axis,
          Object.keys(variants[axis]).filter((value) =>
            predicate[axis].includes(value),
          ),
        ]),
    );
    // Key order and array order cannot hide an identical match predicate.
    const key = JSON.stringify(
      Object.keys(when)
        .sort()
        .map((axis) => [axis, [...when[axis]].sort()]),
    );
    if (seen.has(key))
      fail(Codes.AMBIGUOUS_RECIPE_COMPOUND, 'duplicate compound predicate.', {
        compoundIndex: index,
        earlierCompoundIndex: seen.get(key),
        when,
      });
    seen.set(key, index);
    return { when, css: style(compound.css, `compoundVariants.${index}.css`) };
  });
  return {
    recipeId,
    base,
    variants,
    defaultVariants,
    axisOrder,
    ...(slots === undefined ? {} : { slots: [...slots] }),
    compounds,
    visibility: config.visibility === 'private' ? 'private' : 'public',
  };
}
