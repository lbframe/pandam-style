/**
 * Inline style attributes and unapproved local stylesheets are style channels
 * outside the closed profile: controlled or refused, never exempt.
 */
import '../theme.css';
import { create, token } from '../generated/design.pandamstyle';

const styles = create({ page: { padding: token('spacing.md') } });

export function Page() {
  return <div style={{ padding: '17px' }}>hello</div>;
}
