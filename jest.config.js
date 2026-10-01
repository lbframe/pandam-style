/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The repository had no Jest configuration, which was fine only for as long as
 * every test ran from a package directory. Run Jest from the ROOT - which is
 * how a cross-package change gets checked - and it crawls the whole tree,
 * including `evidence/`.
 *
 * That is not harmless. `tools/pilot/run-pilot.sh` extracts a packed build to
 * `evidence/native/pilot/.unpacked` on every pilot run, and Jest's haste map
 * finds TWO `package.json` files that both answer to `@pandamstyle/compiler`:
 * the real workspace package and the unpacked copy of it. Resolution then fails
 * with `_assertNoDuplicates`, and every test that loads a design-system
 * definition dies on a module map that has nothing to do with what it is
 * testing.
 *
 * A gitignored build artifact must not be able to break the test suite, and the
 * fix is to keep those directories out of the module map in the first place.
 * `evidence` is generated output and `examples` contains an install-from-
 * tarballs pilot rather than Jest suites.
 *
 * Only these keys are set. Everything else keeps Jest's defaults, so this
 * config cannot change which tests run or how they are transformed - it can
 * only stop Jest from indexing directories that are not part of the code.
 */

const path = require('path');

/**
 * The Babel config the compiler's own test files are written against.
 *
 * The packages each carry a `.babelrc` and are tested from their own directory,
 * where Babel finds it. Run from the ROOT, Babel looks for a root config, finds
 * none, and hands Jest files it never transformed - so a test file written with
 * `import` fails to parse with "Cannot use import statement outside a module",
 * which says nothing about the code under test.
 *
 * Naming the package's Babel root explicitly fixes that without inventing a
 * second set of presets to keep in step with the first. Jest only reads a config
 * from its own working directory, so this file governs root-level runs and
 * leaves every per-package `jest` invocation exactly as it was.
 */
const BABEL_ROOT = path.join(__dirname, 'packages/compiler');

module.exports = {
  // The repository's own convention is a test file named `*-test.js`. The
  // second spelling is retained for existing `*.test.js` suites.
  testMatch: ['**/__tests__/**/*-test.js', '**/?(*.)+(spec|test).js'],
  modulePathIgnorePatterns: [
    '<rootDir>/evidence/',
    '<rootDir>/.pms-bench/',
    '<rootDir>/examples/',
    '<rootDir>/\\.unpacked/',
  ],
  watchPathIgnorePatterns: [
    '<rootDir>/evidence/',
    '<rootDir>/.pms-bench/',
    '<rootDir>/\\.unpacked/',
  ],
  testPathIgnorePatterns: [
    '<rootDir>/evidence/',
    // Fixture projects are real application sources read by the build, and the
    // build writes their compiled output into them. Neither is a test.
    '/__fixtures__/',
    '/pandamstyle/fixtures/',
    '/fixtures/',
  ],
  transform: {
    '^.+\\.[cm]?[jt]sx?$': [
      'babel-jest',
      {
        root: BABEL_ROOT,
        babelrcRoots: [
          BABEL_ROOT,
          path.join(__dirname, 'packages/core'),
          __dirname,
        ],
      },
    ],
  },
};
