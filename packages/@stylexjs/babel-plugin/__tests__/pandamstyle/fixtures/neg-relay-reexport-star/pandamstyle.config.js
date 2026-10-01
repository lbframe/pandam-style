/**
 * Build configuration for the valid fixture project.
 * The design system is a separate input file so it can be mutated without
 * touching any page file.
 */
'use strict';

module.exports = {
  definition: '../_shared/design.pms.config.mjs',
  roots: ['./src'],
  outDir: './generated',
};
