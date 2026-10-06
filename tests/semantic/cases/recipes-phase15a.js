/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';

const { add, design, selection, yes, no, r, c } = require('./catalog');
const slotDefinition = require('../../../packages/compiler/__tests__/pandamstyle/fixtures/phase-15a/recipe.json');
const slotted = structuredClone(design);
slotted.recipes.card = slotDefinition;

add(
  'recipe.slots',
  'recipes',
  'Explicit slots keep CSS conflicts local to the selected slot',
  selection('recipes.card({flag:false}).root'),
  yes(
    [r('display', 'grid'), r('opacity', '0.5')],
    [c('manifest/recipes/card/slots', ['root', 'label'])],
  ),
  { designSystem: slotted },
);
add(
  'recipe.slot-label',
  'recipes',
  'A sparse variant slot keeps its base and applies the matching compound',
  selection("recipes.card({flag:false,size:'sm'}).label"),
  yes([r('position', 'relative'), r('display', 'flex')]),
  { designSystem: slotted },
);
add(
  'recipe.slot-defaults',
  'recipes',
  'Defaults participate in compound matching',
  selection('recipes.card().root'),
  yes([r('display', 'inline-block'), r('opacity', '0.5')]),
  { designSystem: slotted },
);
add(
  'recipe.slot-unknown',
  'recipes',
  'An unknown slot receives a source diagnostic',
  selection('recipes.card().absent'),
  no('PMS_INVALID_RECIPE_SLOT'),
  { designSystem: slotted },
);
add(
  'recipe.slot-container',
  'recipes',
  'Slot containers cannot enter the style composition channel',
  selection('recipes.card()'),
  no('PMS_UNVERIFIED_PROPS_SOURCE'),
  { designSystem: slotted },
);
const compound = structuredClone(design);
compound.recipes.bare = {
  base: { display: 'block' },
  variants: { flag: { true: {}, false: {} }, size: { sm: {}, md: {} } },
  defaultVariants: { flag: false, size: 'md' },
  compoundVariants: [
    { flag: false, css: { display: 'flex' } },
    { size: ['sm', 'md'], css: { display: 'grid' } },
  ],
};
add(
  'recipe.compounds',
  'recipes',
  'Later matching compounds win after branches without a Cartesian product',
  selection('recipes.bare()'),
  yes([r('display', 'grid')]),
  { designSystem: compound },
);
const edited = structuredClone(slotted);
edited.recipes.card.compoundVariants[1].css.root.display = 'none';
const removed = structuredClone(edited);
removed.recipes.card.compoundVariants = [];
add(
  'recipe.compound-revisions',
  'recipes',
  'Editing and removing compounds updates selection and removes stale CSS',
  selection('recipes.card({flag:false}).root'),
  yes([r('display', 'grid'), r('opacity', '0.5')]),
  {
    designSystem: slotted,
    revisions: [
      {
        label: 'compound edited',
        designSystem: edited,
        expected: yes([r('display', 'none'), r('opacity', '0.5')]),
      },
      {
        label: 'compound removed',
        designSystem: removed,
        expected: yes([r('display', 'inline-flex'), r('opacity', '0.5')]),
      },
    ],
  },
);
add(
  'recipe.compound-absent-axis',
  'recipes',
  'A missing axis without a default cannot satisfy a compound predicate',
  selection('recipes.card({tone:"loud",size:"sm"}).root'),
  yes([r('display', 'flex'), r('opacity', '1')]),
  { designSystem: slotted },
);
