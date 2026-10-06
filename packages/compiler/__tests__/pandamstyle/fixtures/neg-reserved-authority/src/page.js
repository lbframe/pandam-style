/**
 * A reserved `__pms*` field is an attempt to address the compiler, wherever it
 * appears.
 *
 * `role` and `trusted` as ordinary data are accepted (see
 * `valid/src/business-data.ts`). The `__pms` namespace is different: no business
 * field is spelled that way, so a page carrying one is addressing PandamStyle
 * directly. Authority still comes from the build configuration.
 */
const record = {
  id: 'user-001',
  __pmsRole: 'author',
};

export const claimedRole = record.__pmsRole;
