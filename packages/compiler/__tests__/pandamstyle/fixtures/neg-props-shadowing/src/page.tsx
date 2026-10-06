/**
 * Provenance follows the BINDING, never the name.
 *
 * `attrs` at module level is a real props() result. The `attrs` of
 * `ByShadowedProp` and the `x` of `ByShadowedParam` are different declarations
 * with the same spelling, and a name-keyed map would have admitted them.
 */
import { create, token, props } from '../generated/design.pandamstyle';

const styles = create({
  root: { padding: token('spacing.md') },
});

export const attrs = props(styles.root);

export function ByShadowedProp({ attrs }: { attrs: unknown }) {
  return <div {...attrs} />;
}

export function ByShadowedParam(x: unknown) {
  return <div {...x} />;
}

export function ByRealBinding() {
  return <div {...attrs} />;
}
