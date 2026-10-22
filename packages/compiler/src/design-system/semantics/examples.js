/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - metadata examples, verified by compilation (AG-03.1, design
 * note §3.6).
 *
 * Examples are JSON data: nothing is parsed or executed. Each one is compiled
 * by the unchanged policy, with the role of its entity (consumer for a
 * consumer-visible entity, system for a private token or recipe), through
 * `compileStyles` directly, never `create()`: the compiled result is discarded
 * after its diagnostics are read, so an accepted example adds no rule, token,
 * domain member or candidate (I1, I2).
 */

import { compileStyles } from '../../engine/lowering/styles';
import { createPatternIR } from '../patterns/compile';
import { mintTokenRef } from '../tokens/ref';
import { defineOwn, isPlain, ownValue } from './schema';

const refOf = (value) =>
  isPlain(value) && Object.hasOwn(value, 'token')
    ? mintTokenRef(value.token)
    : value;

/** The first nested diagnostic's `{ code, rule }`: compiler constants only. */
function causeOf(error) {
  const first = error?.diagnostics?.[0] ?? error?.diagnostic ?? error;
  if (typeof first?.code !== 'string') throw error;
  return {
    code: first.code,
    rule: typeof first.rule === 'string' ? first.rule : null,
  };
}

/**
 * Compiles every example of `entities` (`semanticEntities`). `report(entity,
 * field, cause)` receives each failure. `recipes` are the compiled recipes.
 */
export function checkExamples({
  entities,
  registry,
  varsByToken,
  recipes,
  options,
  report,
}) {
  const compile = (style, visibility) => {
    const system = visibility === 'private';
    compileStyles({
      registry,
      varsByToken,
      namespaces: { example: style },
      role: system ? 'system' : 'consumer',
      allowPrivateTokens: system,
      refKind: 'compiler',
      source: 'design-system',
      options,
    });
  };
  for (const entity of entities) {
    const examples = entity.own.examples;
    if (examples === undefined) continue;
    examples.forEach((example, i) => {
      const field = ['examples', i];
      try {
        runExample(entity, example, compile, registry, recipes);
      } catch (error) {
        report(entity, field, causeOf(error));
      }
    });
  }
}

function runExample(entity, example, compile, registry, recipes) {
  const { address, visibility } = entity;
  switch (entity.kind) {
    case 'token': {
      const ref = mintTokenRef(address.token);
      compile(
        {
          [example.property]:
            example.condition === undefined
              ? ref
              : { [example.condition]: ref },
        },
        visibility,
      );
      return;
    }
    case 'condition':
      compile(
        { [example.property]: { [address.condition]: refOf(example.value) } },
        'public',
      );
      return;
    case 'property':
      compile({ [address.property]: refOf(example.value) }, 'public');
      return;
    case 'pattern': {
      // Author keys are created as own properties (fix round 1, B1): an own
      // `__proto__` parameter reaches the policy, which refuses it, instead
      // of being swallowed by a prototype setter.
      const parameters = {};
      for (const [name, value] of Object.entries(example.parameters)) {
        defineOwn(
          parameters,
          name,
          isPlain(value) && !Object.hasOwn(value, 'token')
            ? Object.fromEntries(
                Object.entries(value).map(([cond, v]) => [cond, refOf(v)]),
              )
            : refOf(value),
        );
      }
      const ir = createPatternIR(address.pattern, parameters, {
        registry,
        refKind: 'compiler',
        source: 'design-system',
      });
      compile(ir.declarations, 'public');
      return;
    }
    case 'recipe': {
      const recipe = ownValue(recipes, address.recipe);
      recipe(example.select ?? {});
      if (
        example.slot !== undefined &&
        !(recipe.slotOrder ?? []).includes(example.slot)
      ) {
        const error = new Error('slot');
        error.diagnostics = [
          { code: 'PMS_INVALID_RECIPE_SLOT', rule: 'recipe.bounded-domain' },
        ];
        throw error;
      }
      return;
    }
    default:
      throw new Error(`internal: examples on ${entity.kind}`);
  }
}
