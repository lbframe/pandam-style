/**
 * A proven value handed to an unrecognized function is an escape.
 *
 * `mutateLater` is ordinary application code. Whatever it does internally, it
 * receives the composed value and may replace it with an arbitrary object, so
 * the value cannot keep its provenance. The same refusal covers
 * `Object.assign(attrs, ...)`, which is the reflective form of the same attack.
 */
import { create, token, props } from '../generated/design.pandamstyle';

declare function mutateLater(value: unknown): void;

const styles = create({
  root: { padding: token('spacing.md') },
});

const attrs = props(styles.root);
mutateLater(attrs);
Object.assign(attrs, { style: { padding: '17px' } });

export const el = <div {...attrs} />;
