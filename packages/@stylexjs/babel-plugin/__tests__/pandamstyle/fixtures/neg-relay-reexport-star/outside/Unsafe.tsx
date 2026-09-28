/**
 * Outside every declared root, reached only through a re-export chain.
 *
 * The inline `style` attribute and the unapproved stylesheet below must be
 * refused, which can only happen if the coverage closure followed the chain.
 */
import './theme.css';

export function Panel() {
  return <div style={{ padding: '17px' }}>relayed</div>;
}
