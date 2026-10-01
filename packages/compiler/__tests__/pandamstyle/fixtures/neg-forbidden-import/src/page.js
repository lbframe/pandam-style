/**
 * Direct engine entries in a covered page are refused; the upstream import
 * filter is not the only gate, and private subpaths do not slip through.
 */
import { stylex } from '@stylexjs/stylex';
import { atom } from '@stylexjs/atoms';
import { create, token } from '../generated/design.pandamstyle';

export const styles = create({ page: { padding: token('spacing.md') } });
export const other = stylex.create({ x: { color: 'red' } });
export const a = atom({ padding: '17px' });
