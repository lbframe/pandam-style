/**
 * Valid TSX page. The recipe selection depends on props, so it must use the
 * bounded runtime guard instead of a build-time literal.
 */
import { create, token, recipes, themes, props } from '../generated/design.pandamstyle';

const styles = create({
  shell: {
    display: 'flex',
    flexDirection: 'column',
    gap: token('spacing.md'),
    padding: { base: token('spacing.md'), wide: token('spacing.lg') },
  },
});

export function Shell({ size = 'md' }: { size?: 'sm' | 'md' }) {
  return (
    <div {...props(themes.light, styles.shell)}>
      <button {...props(recipes.button({ variant: 'primary', size }))}>Continue</button>
    </div>
  );
}
