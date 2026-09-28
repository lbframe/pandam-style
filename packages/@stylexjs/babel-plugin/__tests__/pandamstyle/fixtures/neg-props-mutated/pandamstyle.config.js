/**
 * Build configuration for the valid fixture project.
 * The design system is a separate input file so it can be mutated without
 * touching any page file.
 */
'use strict';

module.exports = {
  definition: '../_shared/design.pms.config.js',
  roots: ['./src'],
  outDir: './generated',
  runtimeModule: '@pandamstyle/compiler/runtime',
};
