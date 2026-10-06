/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Copy beside a generated conformance design.pandamstyle.d.ts for Phase 15C.
import {
  patterns,
  token,
  props,
  recipes,
  themes,
  manifest,
} from './design.pandamstyle';

const gap = token('spacing.md');
const stack = patterns.stack({
  gap,
  align: { base: 'stretch', wide: 'start', hover: 'center' },
});
const inline = patterns.inline({
  justify: 'between',
  gap: { default: gap, wide: token('spacing.lg') },
});
const grid = patterns.grid({
  columns: { base: 1, wide: 6 },
  gap,
  align: 'stretch',
});
const box = patterns.box({
  padding: gap,
  paddingInline: { base: token('spacing.sm'), wide: gap },
});
const centered = patterns.center({ inline: true });
props(stack, inline, grid, box, centered, recipes.button(), themes.dark);
manifest.patterns.grid.parameters.columns.values;

// @ts-expect-error Arbitrary CSS is not a pattern parameter.
patterns.stack({ color: token('colors.text.primary') });
// @ts-expect-error Spacing is token-aware and rejects raw CSS.
patterns.box({ padding: '17px' });
// @ts-expect-error The colors category cannot be passed as spacing.
patterns.stack({ gap: token('colors.text.primary') });
// @ts-expect-error Columns are a finite integer domain.
patterns.grid({ columns: 7 });
// @ts-expect-error CSS templates are not public pattern parameters.
patterns.grid({ columns: 'repeat(2, 1fr)' });
// @ts-expect-error Responsive maps use registered condition names.
patterns.grid({ columns: { unknownCondition: 2 } });
// @ts-expect-error Center inline is a scalar boolean.
patterns.center({ inline: { base: true } });
// @ts-expect-error Alignment is a constrained semantic domain.
patterns.inline({ align: 'middle' });
// @ts-expect-error The vocabulary has five named patterns.
patterns.masonry({});
