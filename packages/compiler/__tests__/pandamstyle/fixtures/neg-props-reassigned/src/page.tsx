/**
 * A reassigned binding is not the value that was proven.
 *
 * `let attrs` starts as a props() result and is then overwritten by arbitrary
 * input. The initializer proves nothing about the value that is spread.
 */
import { create, token, props } from '../generated/design.pandamstyle';

const styles = create({
  root: { padding: token('spacing.md') },
});

const userInput: unknown = { style: { padding: '17px' } };

export let attrs = props(styles.root);
attrs = userInput;

export const el = <div {...attrs} />;
