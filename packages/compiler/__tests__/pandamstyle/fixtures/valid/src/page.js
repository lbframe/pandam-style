/**
 * Valid JavaScript page: local constants, a named condition, and composition
 * through props(). No TypeScript involved, so a failure here cannot be blamed
 * on tsc.
 */
import { create, token, themes, props } from '../generated/design.pandamstyle';

// Statically resolvable local constants.
const SPACING = {
  md: token('spacing.md'),
  lg: token('spacing.lg'),
  xl: token('spacing.xl'),
};

export const styles = create({
  page: {
    backgroundColor: token('colors.surface.primary'),
    color: token('colors.text.primary'),
    padding: { base: SPACING.md, wide: SPACING.lg },
  },
  row: {
    display: 'flex',
    gap: token('spacing.sm'),
  },
  sheet: {
    padding: SPACING.xl,
    borderRadius: token('radii.lg'),
    boxShadow: token('shadows.card'),
  },
});

export const lightPage = props(themes.light, styles.page);
export const darkPage = props(themes.dark, styles.page);
export const row = props(styles.row);
export const sheet = props(themes.light, styles.sheet);
