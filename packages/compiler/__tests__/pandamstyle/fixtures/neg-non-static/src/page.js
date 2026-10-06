/**
 * A local function named `token` must gain no trust, and a value coming from
 * props is not statically resolvable. Both must fail explicitly rather than
 * being ignored or accepted by default.
 */
import { create } from '../generated/design.pandamstyle';

// Local helper with the same name as the compiler helper.
function token(path) {
  return path;
}

export const a = create({ ns1: { padding: token('spacing.md') } });

export function Dynamic({ value }) {
  return create({ ns2: { padding: value } });
}
