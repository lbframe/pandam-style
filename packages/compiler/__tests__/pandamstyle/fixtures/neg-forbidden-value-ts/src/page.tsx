/**
 * The same error written in TSX with `as any`, and in a spread, must be
 * refused identically. A tsc-only failure would not satisfy the case.
 */
import { create } from '../generated/design.pandamstyle';

const RAW = '17px' as any;

export const a = create({ ns1: { padding: '17px' as any } });
export const b = create({ ns2: { padding: RAW } });
export const c = create({ ns3: { padding: ('17px' as unknown) as string } });
