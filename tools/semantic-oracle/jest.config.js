/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';
module.exports = {
  rootDir: '../..',
  testEnvironment: 'node',
  transform: {},
  testMatch: ['<rootDir>/tests/semantic/__tests__/*-test.js'],
  modulePathIgnorePatterns: ['<rootDir>/evidence/', '<rootDir>/examples/'],
  testTimeout: 120000,
};
