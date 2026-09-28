/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

module.exports = {
  collectCoverageFrom: [
    '<rootDir>/src/**/*.{js,jsx}',
    // exclude
    '!<rootDir>/src/**/__tests__/**',
    '!<rootDir>/src/**/tests/**',
    '!<rootDir>/src/**/types/**',
  ],
  coverageThreshold: {
    global: {
      branches: 74,
      functions: 59,
      lines: 78,
      statements: 78,
    },
  },
  snapshotFormat: {
    printBasicPrototype: false,
  },
  // Every test file in this package is named `*-test.js`; shared modules and
  // fixture projects live next to them and must not be collected as suites.
  testMatch: ['**/__tests__/**/*-test.js'],
  // Fixture projects are real application sources read by the build, not tests.
  testPathIgnorePatterns: ['/__fixtures__/', '/pandamstyle/fixtures/'],
  verbose: true,
};
