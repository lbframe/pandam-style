/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Pilot page.
 *
 * Every style goes through the generated design system module: composition uses
 * props(), and the recipe selection is validated or guarded. No inline style,
 * no local stylesheet, no upstream engine import.
 */
import { create, token, recipes, themes, props } from './bridge.js';

const styles = create({
  page: {
    backgroundColor: token('colors.surface.base'),
    color: token('colors.text.primary'),
    padding: { base: token('spacing.md'), wide: token('spacing.lg') },
  },
  title: {
    fontSize: token('fontSizes.md'),
    fontWeight: token('fontWeights.bold'),
    marginBottom: token('spacing.sm'),
  },
  card: {
    backgroundColor: token('colors.surface.base'),
    borderRadius: token('radii.lg'),
    boxShadow: token('shadows.card'),
    padding: token('spacing.lg'),
  },
  row: {
    display: 'flex',
    gap: token('spacing.sm'),
    marginTop: token('spacing.md'),
  },
});

export function App() {
  return (
    <div {...props(themes.light, styles.page)}>
      <h1 {...props(styles.title)}>PandamStyle pilot</h1>
      <div {...props(styles.card)}>
        <p>
          The stylesheet below was extracted statically by the PandamStyle
          compiler and the recipe below is selected at runtime.
        </p>
        <div {...props(styles.row)}>
          <button {...props(recipes.button({ tone: 'primary', size: 'md' }))}>
            Continue
          </button>
          <button {...props(recipes.button({ tone: 'quiet', size: 'sm' }))}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
