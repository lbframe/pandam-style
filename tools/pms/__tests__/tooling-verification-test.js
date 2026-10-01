/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { assessStep } = require('../step-contracts');
const { parseJestCounts } = require('../test-counts');

const ROOT = path.resolve(__dirname, '../../..');
const ORDER = [
  'install',
  'build',
  'upstream-babel-plugin',
  'upstream-stylex',
  'pandamstyle',
  'semantic-oracle',
  'tooling-tests',
  'pilot',
  'artifacts',
];
let fixture;

function write(relative, text, executable = false) {
  const file = path.join(fixture, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: executable ? 0o755 : 0o644 });
}

beforeAll(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-nine-step-'));
  write('verify-pms.sh', fs.readFileSync(path.join(ROOT, 'verify-pms.sh')));
  for (const name of [
    'test-counts.js',
    'step-contracts.js',
    'run-tooling-tests.js',
  ]) {
    write(
      `tools/pms/${name}`,
      fs.readFileSync(path.join(ROOT, 'tools/pms', name)),
    );
  }
  write('yarn.lock', '# fixture lockfile\n');
  write(
    'tools/semantic-oracle/run.js',
    'process.stderr.write("Test Suites: 1 passed, 1 total\\nTests: 2 passed, 2 total\\n");\n',
  );
  write(
    'bin/yarn',
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.22.22; fi\n',
    true,
  );
  for (const name of ['babel', 'rollup'])
    write(`node_modules/.bin/${name}`, '#!/bin/sh\nexit 0\n', true);
  write('node_modules/.bin/cross-env', '#!/bin/sh\nshift\nexec "$@"\n', true);
  write(
    'node_modules/.bin/jest',
    '#!/bin/sh\nexec node "$(dirname "$0")/../jest/bin/jest.js" "$@"\n',
    true,
  );
  fs.symlinkSync(
    path.join(ROOT, 'node_modules/glob'),
    path.join(fixture, 'node_modules/glob'),
  );
  for (const name of ['a', 'b', 'c'])
    write(`tools/pms/__tests__/${name}-test.js`, '// fixture suite\n');
  for (const name of [
    'style-value-parser',
    '@stylexjs/shared',
    '@stylexjs/stylex',
    '@stylexjs/babel-plugin',
  ]) {
    fs.mkdirSync(path.join(fixture, 'packages', name), { recursive: true });
  }
  write('packages/compiler/lib/index.mjs', '// delivered build\n');
  write('packages/compiler/package.json', '{"name":"@pandamstyle/compiler"}\n');
  write('packages/compiler/bin/pms-build.js', '// fixture generator\n');
  write(
    'packages/@stylexjs/babel-plugin/__tests__/pandamstyle/fixtures/valid/generated/fixture.css',
    '.fixture{}\n',
  );
  write('tools/pilot/run-pilot.sh', '#!/bin/sh\nexit 0\n', true);
  // Substitute costly commands, but exercise the actual shell runner, helper,
  // contract dispatcher, parser, summary writer and final exit decision.
  write(
    'node_modules/jest/bin/jest.js',
    `
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../../..');
const mode = fs.readFileSync(path.join(root, 'mode'), 'utf8');
const args = process.argv.slice(2);
const tooling = args.includes('tools/pms/__tests__');
const files = ['a', 'b', 'c'].map(n => path.join(root, 'tools/pms/__tests__', n + '-test.js'));
if (args.includes('--listTests')) {
  console.log(JSON.stringify(mode === 'discovery-missing' ? files.slice(1) : files));
  process.exit(0);
}
let tests = tooling ? 43 : process.cwd().endsWith('/stylex') ? 99 : args.some(a => a.startsWith('__tests__/pandamstyle')) ? 498 : 1007;
let suites = tooling ? 3 : tests === 99 ? 4 : tests === 498 ? 21 : 42;
let log = 'Test Suites: ' + suites + ' passed, ' + (tests === 1007 ? '1 skipped, ' : '') + (suites + (tests === 1007 ? 1 : 0)) + ' total\\nTests: ' + tests + ' passed, ' + (tests === 1007 ? '64 skipped, ' : '') + (tests + (tests === 1007 ? 64 : 0)) + ' total\\n';
if (tooling) {
  if (mode === 'command-fails') process.exit(2);
  if (mode === 'test-fails') log = 'Test Suites: 1 failed, 2 passed, 3 total\\nTests: 1 failed, 42 passed, 43 total\\n';
  if (mode === 'suite-fails') log = 'FAIL b-test.js\\nTest suite failed to run\\nTest Suites: 1 failed, 2 passed, 3 total\\nTests: 43 passed, 43 total\\n';
  if (mode === 'counts-missing') log = 'no count output\\n';
  if (mode === 'tests-line-missing') log = 'Test Suites: 3 passed, 3 total\\n';
  if (mode === 'suites-line-missing') log = 'Tests: 43 passed, 43 total\\n';
  if (mode === 'tests-unaccounted') log = 'Test Suites: 3 passed, 3 total\\nTests: 42 passed, 43 total\\n';
  if (mode === 'suites-unaccounted') log = 'Test Suites: 2 passed, 3 total\\nTests: 43 passed, 43 total\\n';
  if (mode === 'total-missing') log = 'Test Suites: 3 passed\\nTests: 43 passed\\n';
  fs.writeFileSync(args[args.indexOf('--outputFile') + 1], JSON.stringify({
    testResults: (mode === 'execution-missing' ? files.slice(1) : files).map(name => ({name})),
    numTotalTestSuites: 3, numPassedTestSuites: 3, numFailedTests: 0, success: true,
  }));
}
process.stderr.write(log);
`,
  );
  write('mode', 'green');
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  const git = (...args) =>
    execFileSync('git', args, { cwd: fixture, env: gitEnv, stdio: 'pipe' });
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'nine-step fixture');
  git('branch', 'fixture-base');
});

afterAll(() => {
  if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
});

function run(mode = 'green', env = {}, omitted = false, reuseOutput = false) {
  write('mode', mode);
  const original = fs.readFileSync(path.join(ROOT, 'verify-pms.sh'), 'utf8');
  write(
    'verify-pms.sh',
    omitted
      ? original.replace(
          new RegExp(
            'if is_filtered_out "' +
              (omitted === true ? 'tooling-tests' : omitted) +
              '"; then[\\s\\S]*?\\nfi\\n',
          ),
          '',
        )
      : original,
  );
  const outDir = path.join(fixture, 'evidence/run');
  if (!reuseOutput) fs.rmSync(outDir, { recursive: true, force: true });
  const result = spawnSync('bash', ['verify-pms.sh'], {
    cwd: fixture,
    env: {
      ...process.env,
      PATH: path.join(fixture, 'bin') + path.delimiter + process.env.PATH,
      PMS_OUT_DIR: outDir,
      PMS_BATCH_BASE_REF: 'fixture-base',
      PMS_SKIP_INSTALL: '',
      PMS_SKIP_PILOT: '',
      PMS_ONLY_STEPS: '',
      ...env,
    },
    encoding: 'utf8',
    timeout: 30000,
  });
  if (result.error) throw result.error;
  return {
    ...result,
    summary: fs.existsSync(path.join(outDir, 'summary.json'))
      ? JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'))
      : null,
  };
}

test('the real summary accepts a green nine-step fixture with separate and summed counts', () => {
  const { status, stdout, summary } = run();
  expect(status).toBe(0);
  expect(stdout).toContain('VERIFICATION OK');
  expect(Object.keys(summary.steps)).toEqual(ORDER);
  expect(summary.complete).toBe(true);
  expect(summary.verification.verdict).toBe('verified');
  expect(summary.failedSteps).toEqual([]);
  expect(summary.skippedSteps).toEqual([]);
  for (const name of ORDER)
    expect(summary.steps[name].verification.verdict).toBe('verified');
  expect(summary.steps['tooling-tests'].kind).toBe('test');
  expect(summary.steps['tooling-tests'].counts.testsPassed).toBe(43);
  expect(summary.steps['semantic-oracle'].kind).toBe('test');
  expect(summary.steps['semantic-oracle'].counts.testsPassed).toBe(2);
  expect(summary.steps.pandamstyle.counts.testsPassed).toBe(498);
  expect(summary.verification.testsPassed).toBe(1649);
  expect(summary.verification.suitesPassed).toBe(71);
  expect(summary.verification.testsSkipped).toBe(64);
  expect(summary.verification.suitesSkipped).toBe(1);
  for (const name of ['install', 'build', 'pilot', 'artifacts'])
    expect(summary.steps[name].counts).toBeNull();
});

test.each([
  ['command-fails', 'EXIT_CODE_NONZERO'],
  ['test-fails', 'TEST_FAILED'],
  ['suite-fails', 'SUITE_FAILED'],
  ['counts-missing', 'COUNTS_MISSING'],
  ['tests-line-missing', 'TEST_LINE_MISSING'],
  ['suites-line-missing', 'SUITE_LINE_MISSING'],
  ['tests-unaccounted', 'TESTS_UNACCOUNTED'],
  ['suites-unaccounted', 'SUITES_UNACCOUNTED'],
  ['total-missing', 'TESTS_UNACCOUNTED'],
  ['discovery-missing', 'EXIT_CODE_NONZERO'],
  ['execution-missing', 'EXIT_CODE_NONZERO'],
])('%s cannot make the official summary complete', (mode, code) => {
  const result = run(mode);
  expect(result.status).toBe(1);
  expect(result.summary.complete).toBe(false);
  expect(result.summary.verification.verdict).not.toBe('verified');
  expect(result.stdout).not.toContain('VERIFICATION OK');
  expect(
    result.summary.steps['tooling-tests'].verification.findings.map(
      (f) => f.code,
    ),
  ).toContain(code);
});

test.each(['omitted', 'skipped'])(
  '%s required tooling step makes the actual runner incomplete',
  (mode) => {
    const result = run(
      'green',
      mode === 'skipped'
        ? {
            PMS_ONLY_STEPS: ORDER.filter((n) => n !== 'tooling-tests').join(
              ',',
            ),
          }
        : {},
      mode === 'omitted',
    );
    expect(result.summary.complete).toBe(false);
    expect(result.summary.verification.verdict).toBe('incomplete');
    expect(result.summary.skippedSteps).toEqual(['tooling-tests']);
    expect(
      result.summary.steps['tooling-tests'].verification.findings[0].code,
    ).toBe('STEP_SKIPPED');
    expect(result.stdout).not.toContain('VERIFICATION OK');
  },
);

test('tooling retains the exit disagreement and missing exit evidence findings', () => {
  const counts = parseJestCounts(
    'Test Suites: 1 failed, 1 total\nTests: 1 failed, 1 total\n',
  );
  for (const [exitCode, code] of [
    [0, 'EXIT_CODE_DISAGREES'],
    [null, 'EXIT_CODE_MISSING'],
  ]) {
    const verdict = assessStep({
      step: 'tooling-tests',
      status: 'passed',
      exitCode,
      counts,
    });
    expect(verdict.verdict).not.toBe('verified');
    expect(verdict.findings.map((f) => f.code)).toContain(code);
  }
});

test.each(['omitted', 'skipped'])(
  '%s required semantic oracle prevents a complete official run',
  (mode) => {
    const result = run(
      'green',
      mode === 'skipped'
        ? {
            PMS_ONLY_STEPS: ORDER.filter(
              (name) => name !== 'semantic-oracle',
            ).join(','),
          }
        : {},
      mode === 'omitted' ? 'semantic-oracle' : false,
    );
    expect(result.status).toBe(mode === 'omitted' ? 1 : 0);
    expect(result.summary.complete).toBe(false);
    expect(result.summary.verification.verdict).toBe('incomplete');
    expect(result.summary.skippedSteps).toEqual(['semantic-oracle']);
    expect(
      result.summary.steps['semantic-oracle'].verification.findings[0].code,
    ).toBe('STEP_SKIPPED');
    expect(result.stdout).not.toContain('VERIFICATION OK');
  },
);

test('an empty tooling inventory fails before invoking Jest', () => {
  const testDir = path.join(fixture, 'tools/pms/__tests__');
  fs.renameSync(testDir, testDir + '.saved');
  try {
    const result = run();
    expect(result.status).toBe(1);
    expect(result.summary.complete).toBe(false);
    expect(
      fs.readFileSync(
        path.join(fixture, 'evidence/run/tooling-tests.log'),
        'utf8',
      ),
    ).toContain('TOOLING_INVENTORY_EMPTY');
  } finally {
    fs.renameSync(testDir + '.saved', testDir);
  }
});

test.each(['test failure', 'suite load failure'])(
  'the tooling command propagates a real Jest %s',
  (mode) => {
    const jestDir = path.join(fixture, 'node_modules/jest');
    const testDir = path.join(fixture, 'tools/pms/__tests__');
    fs.renameSync(jestDir, jestDir + '.saved');
    fs.renameSync(testDir, testDir + '.saved');
    fs.symlinkSync(path.join(ROOT, 'node_modules/jest'), jestDir);
    write('jest.config.js', 'module.exports = { transform: {} };\n');
    write(
      'tools/pms/__tests__/a-test.js',
      'test("passes", () => expect(true).toBe(true));\n',
    );
    write(
      'tools/pms/__tests__/c-test.js',
      'test("also passes", () => expect(true).toBe(true));\n',
    );
    write(
      'tools/pms/__tests__/b-test.js',
      mode === 'test failure'
        ? 'test("fails", () => expect(true).toBe(false));\n'
        : 'throw new Error("intentional suite load failure");\n',
    );
    const out = path.join(fixture, 'real-jest-evidence');
    fs.mkdirSync(out, { recursive: true });
    try {
      const result = spawnSync(
        process.execPath,
        ['tools/pms/run-tooling-tests.js', out],
        {
          cwd: fixture,
          encoding: 'utf8',
          timeout: 30000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      const report = JSON.parse(
        fs.readFileSync(path.join(out, 'tooling-jest-results.json'), 'utf8'),
      );
      expect(report.numFailedTestSuites).toBe(1);
      expect(report.numFailedTests).toBe(mode === 'test failure' ? 1 : 0);
      expect(result.stderr).toContain('Test Suites:');
      expect(result.stderr).toContain('Tests:');
    } finally {
      fs.rmSync(jestDir);
      fs.renameSync(jestDir + '.saved', jestDir);
      fs.rmSync(testDir, { recursive: true });
      fs.renameSync(testDir + '.saved', testDir);
      fs.rmSync(path.join(fixture, 'jest.config.js'));
    }
  },
);

test('a tracked tooling suite missing from disk cannot shrink the expected population', () => {
  const suite = path.join(fixture, 'tools/pms/__tests__/c-test.js');
  fs.renameSync(suite, suite + '.saved');
  try {
    const result = run();
    expect(result.status).toBe(1);
    expect(result.summary.complete).toBe(false);
    expect(
      fs.readFileSync(
        path.join(fixture, 'evidence/run/tooling-tests.log'),
        'utf8',
      ),
    ).toContain('TOOLING_TRACKED_SUITE_MISSING');
  } finally {
    fs.renameSync(suite + '.saved', suite);
  }
});

test('broken verifier code preserves raw evidence and cannot invent a passing summary', () => {
  const parser = path.join(fixture, 'tools/pms/test-counts.js');
  const source = fs.readFileSync(parser);
  const out = path.join(fixture, 'evidence/run');
  try {
    expect(run().summary.complete).toBe(true);
    write(
      'tools/pms/test-counts.js',
      'throw new Error("intentional parser bootstrap failure");\n',
    );
    const result = run('green', {}, false, true);
    expect(result.status).toBe(1);
    expect(result.summary).toBeNull();
    expect(result.stderr).toContain('intentional parser bootstrap failure');
    expect(fs.existsSync(path.join(out, 'summary.json'))).toBe(false);
    expect(fs.readFileSync(path.join(out, 'steps.tsv'), 'utf8')).toContain(
      'tooling-tests',
    );
    expect(
      fs.readFileSync(path.join(out, 'tooling-tests.log'), 'utf8'),
    ).toContain('Tests:');
    expect(fs.readFileSync(path.join(out, 'run.log'), 'utf8')).not.toContain(
      'VERIFICATION OK',
    );
  } finally {
    fs.writeFileSync(parser, source);
  }
});
