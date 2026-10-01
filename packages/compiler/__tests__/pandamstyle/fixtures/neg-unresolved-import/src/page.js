/**
 * A local import from a covered root that resolves to nothing.
 *
 * P0 requires a static module graph. An unresolved local edge is a coverage gap
 * (PMS_COVERAGE_GAP), never a silently skipped file.
 */
import { missing } from './does-not-exist';

export const value = missing;
