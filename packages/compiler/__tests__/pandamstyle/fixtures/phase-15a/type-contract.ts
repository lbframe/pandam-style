// Phase 15C handoff: compile this against declarations for recipe.json.
import { recipes, props, manifest } from './design.pandamstyle';
import type { StyleRef } from '@pandamstyle/core';

const result = recipes.card({ tone: 'quiet', size: 'md', flag: false });
const root: StyleRef = result.root;
const label: StyleRef = result.label;
props(root, label);
const slots: readonly ['root', 'label'] = recipes.card.slotOrder;
const catalogSlots: readonly ['root', 'label'] = manifest.recipes.card.slots;
const firstTone: readonly ['quiet'] = manifest.recipes.card.compoundVariants[0].when.tone;
const flagDomain: readonly ['false'] = manifest.recipes.card.compoundVariants[1].when.flag;
const selection = recipes.card.getVariantProps({ flag: false });
recipes.card(selection);
recipes.card({ flag: true });
recipes.card({ tone: undefined });

// @ts-expect-error: a named slot must belong to the recipe.
result.absent;
// @ts-expect-error: slots are immutable compiled references.
result.root = label;
// @ts-expect-error: slot containers cannot be composed as styles.
props(result);
// @ts-expect-error: the boolean domain retains boolean author syntax.
recipes.card({ flag: 'false' });
// @ts-expect-error: selection axes must belong to the recipe.
recipes.card({ absent: 'md' });
// @ts-expect-error: values are bounded by the declared axis domain.
recipes.card({ size: 'lg' });
// @ts-expect-error: null is an invalid selected value.
recipes.card({ size: null });

void slots;
void catalogSlots;
void firstTone;
void flagDomain;
