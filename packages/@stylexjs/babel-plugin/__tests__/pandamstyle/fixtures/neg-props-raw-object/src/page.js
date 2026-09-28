/**
 * An object literal is NOT a compiled style.
 *
 * The StyleX fork's `props()` accepts uncompiled objects and turns them into
 * inline styles, so `<div {...props({ padding: '17px' })} />` would otherwise
 * reach the runtime with an arbitrary CSS object. An object does not become safe
 * because it is handed to a function called `props`.
 *
 * `export const ok` is the control: the same file, the same import, one admitted
 * form and two refused ones.
 */
import { create, token, props } from '../generated/design.pandamstyle';

const styles = create({
  root: { padding: token('spacing.md') },
});

export const rawPadding = props({ padding: '17px' });
export const rawColor = props({ color: '#fff' });
export const rawMulti = props({ padding: '8px', backgroundColor: 'red' });

export const ok = props(styles.root);
