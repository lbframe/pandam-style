/**
 * An arbitrary object does not gain provenance by being named, nor by being
 * spread into a fresh literal.
 *
 * `rawObject` is a perfectly ordinary local constant. It is not a compiled
 * style, so passing it - or a spread of it - to `props()` must be refused.
 */
import { create, token, props } from '../generated/design.pandamstyle';

const styles = create({
  root: { padding: token('spacing.md') },
});

const rawObject = { padding: '17px' };

export const direct = props(rawObject);
export const spread = props({ ...rawObject });

export const ok = props(styles.root);
