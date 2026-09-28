/**
 * Every props() form whose provenance is demonstrated.
 *
 * This is the positive half of the provenance contract. Each value handed to
 * `props()` here belongs to the finite domain the compiler produced:
 * a create() namespace, a theme, a recipe selection, or a composition of those.
 */
import {
  create,
  token,
  themes,
  recipes,
  props,
} from '../generated/design.pandamstyle';

const styles = create({
  base: { padding: token('spacing.md') },
  active: { color: token('colors.action.primary') },
  shell: { display: 'flex', gap: token('spacing.sm') },
});

/** A create() namespace. */
export const plain = props(styles.base);

/** A theme, a create() namespace, and a compiled style member. */
export const themed = props(themes.dark, styles.shell);
export const member = props(styles.base.className);

/** A recipe selection, statically folded and validated. */
export const button = props(recipes.button({ variant: 'primary', size: 'md' }));

/** Conditional compositions, which the fork runtime merges by design. */
export function Active({ isActive, isDisabled }: Record<string, boolean>) {
  return (
    <>
      <div {...props(isActive && styles.active)} />
      <div {...props(isActive ? styles.active : null)} />
      <div {...props([styles.base, isActive && styles.active])} />
      <div {...props(styles.shell, isDisabled && styles.active)} />
    </>
  );
}
