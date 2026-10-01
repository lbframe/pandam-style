/**
 * Every route below must be refused with PMS_FORBIDDEN_VALUE.
 * A raw string, a forged var() string, an object imitating an internal
 * reference, a local alias, a statically computed key, and a spread must all
 * reach the same policy decision.
 */
import { create } from '../generated/design.pandamstyle';

const RAW = '17px';
const ALIAS = RAW;
const FORGED_VAR = 'var(--x1a2b3c)';

// Imitates the internal TokenRef shape without being one.
const FORGED_REF = { [Symbol.for('pandamstyle.tokenRef')]: 'spacing.md' };

const SPREAD_IN = { padding: '17px' };

export const a = create({ ns1: { padding: '17px' } });
export const b = create({ ns2: { padding: 'var(--x1a2b3c)' } });
export const c = create({ ns3: { padding: FORGED_REF } });
export const d = create({ ns4: { padding: ALIAS } });
export const e = create({ ns5: { ['padding']: '17px' } });
export const f = create({ ns6: { ...SPREAD_IN } });
