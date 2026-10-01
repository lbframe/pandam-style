/**
 * The helper is recognized by its IMPORT BINDING, never by its spelling.
 *
 * Two impostors appear here, and neither is the PandamStyle helper:
 *
 *  - `const props = pmsProps` is a local constant holding the helper value. A
 *    name-keyed map would have treated every call to `props` as the real one;
 *  - the nested `const props = ...` shadows the import and the alias both.
 *
 * Neither call is recognized, so neither is rewritten to the composition
 * runtime, and both results are refused as JSX spreads. The control at the
 * bottom uses the real import and compiles.
 */
import {
  create,
  token,
  props as pmsProps,
} from '../generated/design.pandamstyle';

const styles = create({
  root: { padding: token('spacing.md') },
});

const props = pmsProps;
const aliased = props(styles.root);

let shadowed;
{
  const props = (value: unknown) => ({ style: { padding: '17px' } });
  shadowed = props(styles.root);
}

export const FromAlias = <div {...aliased} />;
export const FromShadow = <div {...shadowed} />;
export const FromRealHelper = <div {...pmsProps(styles.root)} />;
