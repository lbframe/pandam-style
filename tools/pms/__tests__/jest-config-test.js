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
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const config = require(path.join(REPO_ROOT, 'jest.config.js'));

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
    for (const dir of ['evidence/', 'upstream/', 'examples/', '.unpacked/']) {
      expect(patterns).toContain(dir);
    }
  });

  test('no discovered test lives under an excluded tree', () => {
    const tests = listTests();
    expect(tests.length).toBeGreaterThan(0);
    for (const test of tests) {
      expect(test.startsWith('evidence/')).toBe(false);
      expect(test.startsWith('upstream/')).toBe(false);
      expect(test.startsWith('examples/')).toBe(false);
      expect(test.includes('/.unpacked/')).toBe(false);
    }
  });

  test('the duplicate package is not in the module map', () => {
    // The failure this configuration exists for, asserted as the thing it was
    // for. If a generated tree ever comes back into the module map, the number
    // of packages answering to this name goes above one and the assertion
    // fails BEFORE the suites that load a design system do.
    const name = '@pandamstyle/compiler';
    const roots = ['evidence', 'upstream', 'examples', 'packages', 'tools'];
    const found = [];
    for (const root of roots) {
      const dir = path.join(REPO_ROOT, root);
      if (!fs.existsSync(dir)) continue;
      const stack = [dir];
      while (stack.length > 0) {
        const current = stack.pop();
        let entries;
        try {
          entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (entry.name === 'node_modules') continue;
          const abs = path.join(current, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === '.unpacked') continue;
            stack.push(abs);
          } else if (entry.name === 'package.json') {
            try {
              // eslint-disable-next-line
              const pkg = JSON.parse(fs.readFileSync(abs, 'utf8'));
              if (pkg?.name === name) found.push(path.relative(REPO_ROOT, abs));
            } catch {
              /* an unreadable package.json is not a duplicate */
            }
          }
        }
      }
    }
    // Exactly one: the real workspace package. A second one is the
    // `_assertNoDuplicates` crash, found here rather than inside a suite.
    expect(found).toEqual(['packages/compiler/package.json']);
  });
});

describe('the root jest configuration is not a broad ignore', () => {
  test('the real test surfaces are still discovered', () => {
    const tests = listTests();
    // A representative from each maintained surface. If an ignore pattern grows
    // by accident, one of these goes missing and the run reports a smaller
    // suite than the repository has.
    const expected = [
      'packages/@stylexjs/babel-plugin/__tests__/pandamstyle/agent-result-test.js',
      'packages/@stylexjs/babel-plugin/__tests__/pandamstyle/agent-dirty-input-test.js',
      'packages/@stylexjs/babel-plugin/__tests__/pandamstyle/incremental-publication-test.js',
      'packages/@stylexjs/babel-plugin/__tests__/pandamstyle/watcher-provider-test.js',
      'packages/@stylexjs/babel-plugin/__tests__/transform-stylex-props-test.js',
      'packages/@stylexjs/stylex/__tests__/stylex-test.js',
      'packages/style-value-parser/src/properties/__tests__/border-radius.test.js',
      'tools/pms/__tests__/test-counts-test.js',
    ];
    for (const file of expected) {
      expect(tests).toContain(file);
    }
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
    // explicitly, and it must be the SAME convention the babel-plugin's own
    // config uses: two configs that disagree about what a test file is will
    // eventually disagree about whether a suite exists.
    const pluginConfig = require(
      path.join(
        REPO_ROOT,
        'packages',
        '@stylexjs',
        'babel-plugin',
        'jest.config.js',
      ),
    );
    // `testMatch` is a GLOB; Jest's `testRegex` is the regular expression. So
    // the check is on the pattern strings, and on the NAMES of what was
    // discovered.
    expect(config.testMatch[0]).toBe(pluginConfig.testMatch[0]);
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
