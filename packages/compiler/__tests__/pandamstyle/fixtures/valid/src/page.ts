/**
 * Valid TypeScript page. `as const` and a non-null assertion must not grant any
 * privilege: they are folded before the policy runs.
 */
import { create, token, themes, props } from '../generated/design.pandamstyle';

const PAD = token('spacing.md') as const;
const RADIUS = token('radii.sm');

export const styles = create({
  card: {
    padding: PAD!,
    borderRadius: RADIUS,
    fontFamily: token('fontFamilies.base'),
    lineHeight: token('lineHeights.normal'),
  },
});

export const card = props(themes.light, styles.card);
