/**
 * A proven value that is then written to has no durable provenance.
 *
 * `attrs.style = { padding: '17px' }` injects an arbitrary CSS object into a
 * value the compiler already accepted. The write is statically visible, so
 * blind trust would be a hole with a known shape.
 */
import { create, token, props } from '../generated/design.pandamstyle';

const styles = create({
  root: { padding: token('spacing.md') },
});

const attrs = props(styles.root);
attrs.style = { padding: '17px' };

export const el = <div {...attrs} />;
