/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The root Jest configuration must stay NARROW.
 *
 * Phase B added it because running Jest from the repository root - which is how
 * a cross-package change gets checked - crawled `evidence/`, where
 * `tools/pilot/run-pilot.sh` unpacks a build on every pilot run. The module map
 * then found TWO packages answering to `@pandamstyle/compiler`: the real
 * workspace package and the unpacked copy. Resolution failed with
 * `_assertNoDuplicates`, and every test that loads a design-system definition
 * died on a module map that had nothing to do with what it was testing.
 *
 * Two failure modes follow from that, and this file covers both:
 *
 *   too NARROW   a legitimate source test stops being discovered, and the run
 *                reports a smaller, greener suite than the repository has. A
 *                green run that silently stopped testing something is the
 *                failure mode nobody notices.
 *   too WIDE     a generated tree comes back, the duplicate package returns, and
 *                the whole suite dies on a directory that is not source.
 *
 * So the assertions are two-sided: the generated trees ARE excluded, and the
 * real test surfaces ARE still discovered.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  assertUniqueWorkspacePackageNames,
} = require('../workspace-package-manifests');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const config = require(path.join(REPO_ROOT, 'jest.config.js'));
const semanticConfig = require(
  path.join(REPO_ROOT, 'tools/semantic-oracle/jest.config.js'),
);

/** Runs Jest at the root and returns its `--listTests` output. */
function listTests(extraArgs = []) {
  const out = execFileSync(
    process.execPath,
    [
      path.join(REPO_ROOT, 'node_modules', 'jest', 'bin', 'jest.js'),
      '--listTests',
      ...extraArgs,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((l) => path.relative(REPO_ROOT, l).split(path.sep).join('/'));
}

describe('the root jest configuration excludes the generated trees', () => {
  test('every excluded tree is named in an ignore pattern', () => {
    // The four directories that hold generated or vendored work rather than
    // source. Each one is named here so that deleting an ignore is a test
    // failure rather than a surprise on the next pilot run.
    const patterns = [
      ...(config.modulePathIgnorePatterns ?? []),
      ...(config.testPathIgnorePatterns ?? []),
      ...(config.watchPathIgnorePatterns ?? []),
    ].join('\n');
    for (const dir of ['evidence/', '.pms-bench/', 'examples/', '.unpacked/']) {
      expect(patterns).toContain(dir);
    }
  });

  test('no discovered test lives under an excluded tree', () => {
    const tests = listTests();
    expect(tests.length).toBeGreaterThan(0);
    for (const test of tests) {
      expect(test.startsWith('evidence/')).toBe(false);
      expect(test.startsWith('examples/')).toBe(false);
      expect(test.includes('/.unpacked/')).toBe(false);
    }
  });

  test('the duplicate package is not in the module map', () => {
    // Only package.json files in the root package manager's declared workspace
    // inventory are live packages. Historical tarball extracts under evidence
    // are immutable records and are not current workspace candidates.
    const packages = assertUniqueWorkspacePackageNames(REPO_ROOT);
    const found = packages
      .filter((item) => item.name === '@pandamstyle/compiler')
      .map((item) => item.manifestPath);
    expect(found).toEqual(['packages/compiler/package.json']);
  });

  test('archived manifests are excluded while duplicate live workspaces fail', () => {
    const fixture = fs.mkdtempSync(
      path.join(os.tmpdir(), 'pms-workspace-manifest-inventory-'),
    );
    const writePackage = (relativePath, name) => {
      const file = path.join(fixture, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ name }) + '\n');
    };

    try {
      fs.writeFileSync(
        path.join(fixture, 'package.json'),
        JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] }) + '\n',
      );
      writePackage('packages/compiler/package.json', '@pandamstyle/compiler');
      writePackage(
        'evidence/phase-10/archive/package/package.json',
        '@pandamstyle/compiler',
      );

      const packages = assertUniqueWorkspacePackageNames(fixture);
      expect(
        packages
          .filter((item) => item.name === '@pandamstyle/compiler')
          .map((item) => item.manifestPath),
      ).toEqual(['packages/compiler/package.json']);

      writePackage(
        'packages/compiler-copy/package.json',
        '@pandamstyle/compiler',
      );
      expect(() => assertUniqueWorkspacePackageNames(fixture)).toThrow(
        /DUPLICATE_WORKSPACE_PACKAGE_NAMES: @pandamstyle\/compiler: packages\/compiler\/package\.json, packages\/compiler-copy\/package\.json/,
      );
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});

test('the semantic oracle does not ignore the deleted donor checkout', () => {
  expect(semanticConfig.modulePathIgnorePatterns).not.toContain(
    '<rootDir>/upstream/',
  );
});

describe('the root jest configuration is not a broad ignore', () => {
  test('the real test surfaces are still discovered', () => {
    const tests = listTests();
    // A representative from each maintained surface. If an ignore pattern grows
    // by accident, one of these goes missing and the run reports a smaller
    // suite than the repository has.
    const expected = [
      'packages/compiler/__tests__/pandamstyle/agent-result-test.js',
      'packages/compiler/__tests__/pandamstyle/agent-dirty-input-test.js',
      'packages/compiler/__tests__/pandamstyle/incremental-publication-test.js',
      'packages/compiler/__tests__/pandamstyle/watcher-provider-test.js',
      'packages/compiler/__tests__/engine-absorption-test.js',
      'packages/core/__tests__/core-test.js',
      'tests/semantic/__tests__/browser-test.js',
      'tools/pms/__tests__/test-counts-test.js',
    ];
    for (const file of expected) {
      expect(tests).toContain(file);
    }
  });

  test('every migrated PandamStyle suite remains discoverable', () => {
    const tests = listTests();
    const inventory = JSON.parse(
      fs.readFileSync(
        path.join(
          REPO_ROOT,
          'docs/architecture/phase-5-test-migration-inventory.json',
        ),
        'utf8',
      ),
    );
    const expected = inventory.records
      .filter((record) => record.kind === 'test')
      .map((record) => record.newPath)
      .sort();
    const discovered = tests
      .filter((file) => file.startsWith(`${inventory.newOwnedRoot}/`))
      .sort();
    expect(expected).toHaveLength(inventory.counts.tests);
    expect(discovered).toEqual(
      [
        ...expected,
        'packages/compiler/__tests__/pandamstyle/accepted-snapshot-test.js',
        'packages/compiler/__tests__/pandamstyle/phase-6-design-system-test.js',
        'packages/compiler/__tests__/pandamstyle/phase-6-7-reconciliation-test.js',
        'packages/compiler/__tests__/pandamstyle/phase-15-convergence-test.js',
        'packages/compiler/__tests__/pandamstyle/phase-15a-recipes-test.js',
        'packages/compiler/__tests__/pandamstyle/phase-15b-patterns-host-test.js',
        'packages/compiler/__tests__/pandamstyle/phase-15b-patterns-test.js',
        'packages/compiler/__tests__/pandamstyle/phase-15c-themes-types-test.js',
        'packages/compiler/__tests__/pandamstyle/global-incremental-test.js',
        'packages/compiler/__tests__/pandamstyle/local-publication-test.js',
        'packages/compiler/__tests__/pandamstyle/transaction-backup-test.js',
        'packages/compiler/__tests__/pandamstyle/source-map-test.js',
      ].sort(),
    );
  });

  test('no ignore pattern is a bare catch-all', () => {
    // `<rootDir>` on its own, `/.*/`, or an empty string would exclude the whole
    // repository. Each pattern must name something.
    for (const pattern of [
      ...(config.modulePathIgnorePatterns ?? []),
      ...(config.testPathIgnorePatterns ?? []),
      ...(config.watchPathIgnorePatterns ?? []),
    ]) {
      expect(typeof pattern).toBe('string');
      expect(pattern.trim()).not.toBe('');
      expect(pattern.replace(/\\/g, '')).not.toBe('<rootDir>.');
      expect(pattern).not.toMatch(/^\/.*\*.*\/$/);
    }
  });

  test('the configuration sets only the keys it says it sets', () => {
    // Jest's defaults are what choose how tests are transformed and where Jest
    // looks for modules. A config that also set `roots`, `moduleDirectories`,
    // `modulePaths` or `transformIgnorePatterns` would change what the repository
    // tests rather than only which files it indexes.
    expect(Object.keys(config).sort()).toEqual([
      'modulePathIgnorePatterns',
      'testMatch',
      'testPathIgnorePatterns',
      'transform',
      'watchPathIgnorePatterns',
    ]);
    expect(config.testRegex).toBeUndefined();
    expect(config.roots).toBeUndefined();
    expect(config.moduleDirectories).toBeUndefined();
    expect(config.modulePaths).toBeUndefined();
    expect(config.transformIgnorePatterns).toBeUndefined();
    expect(config.testEnvironment).toBeUndefined();
  });

  test('the configuration admits ONLY the repository test convention', () => {
    // `testMatch` is what stops Jest's default from treating every file under a
    // `__tests__` directory as a test - which is how 128 fixture projects
    // became 128 failed suites. It must therefore name the convention
    // explicitly, so the set of discovered suites is deliberate.
    // `testMatch` is a GLOB; Jest's `testRegex` is the regular expression. So
    // the check is on the pattern strings, and on the NAMES of what was
    // discovered.
    expect(config.testMatch[0]).toBe('**/__tests__/**/*-test.js');
    const offenders = listTests().filter((test) => {
      const base = test.slice(test.lastIndexOf('/') + 1);
      return !base.endsWith('-test.js') && !base.endsWith('.test.js');
    });
    // A LIST rather than a loop of expects, so the failure names every file
    // that does not follow the convention instead of the first one.
    expect(offenders).toEqual([]);
  });

  test('a fixture project is not a test', () => {
    // The specific cause, asserted directly rather than through a count: these
    // are real application sources that a build reads, and the build writes
    // their compiled output into them. Collected as suites they fail to load,
    // and a suite that fails to load makes the passed-test total look BETTER.
    const tests = listTests();
    for (const dir of ['__fixtures__', 'fixtures']) {
      for (const test of tests) {
        expect(test.includes(`/${dir}/`)).toBe(false);
      }
    }
    // And the compiled fixture output specifically, which is what actually
    // appeared in the failing run.
    expect(
      tests.some((t) => t.includes('pandamstyle/fixtures/valid/generated/')),
    ).toBe(false);
  });
});
