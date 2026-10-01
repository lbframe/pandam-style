/**
 * A JSX spread whose absence of style/className cannot be established
 * statically is refused. Only a props() result is admissible.
 */
import { create, token } from '../generated/design.pandamstyle';

const styles = create({ page: { padding: token('spacing.md') } });

export function Page({ extra }) {
  return <div {...extra}>hello</div>;
}
