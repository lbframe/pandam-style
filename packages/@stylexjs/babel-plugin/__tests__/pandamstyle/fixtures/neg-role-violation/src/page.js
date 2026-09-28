/**
 * The author role is assigned by build configuration, never self-declared by a
 * page. Importing an engine entry or asserting `trusted` must be refused.
 */
import { defineVars } from '@stylexjs/babel-plugin';
import { create, token } from '../generated/design.pandamstyle';

export const styles = create({
  page: { padding: token('spacing.md'), trusted: true },
});
export const vars = defineVars({ bad: '17px' });
