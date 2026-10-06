/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The verification reporter must not be able to say a run was green when it was
 * not.
 *
 * Every case below is a way that has actually happened, or could: a suite that
 * failed to load while the test total looked plausible, a suite that was skipped
 * and so contributed nothing while looking like a pass, a log with no suite line
 * at all, and a step whose exit code was swallowed by a wrapper. The tests are
 * named after the failure they prevent, because a test named "parses counts"
 * stops being read the day someone changes what the parser is FOR.
 */

'use strict';

const {
  assessRun,
  assessSuiteIntegrity,
  parseCountLine,
  parseJestCounts,
} = require('../test-counts');

/** A log line in Jest's own three shapes. */
const HEALTHY = `
PASS __tests__/a-test.js
PASS __tests__/b-test.js

Test Suites: 2 passed, 2 total
Tests:       7 passed, 7 total
Time:        3.1 s
`;

/** The Phase A/B defect: a suite failed to load, and the totals still look fine. */
const SUITE_FAILED_TO_LOAD = `
PASS __tests__/a-test.js
FAIL __tests__/b-test.js
  ● Test suite failed to run
    Cannot find module '@pandamstyle/compiler'

Test Suites: 1 failed, 1 passed, 2 total
Tests:       7 passed, 7 total
Time:        3.4 s
`;

const SKIPPED_SUITE = `
Test Suites: 1 skipped, 1 passed, 2 total
Tests:       1 skipped, 7 passed, 7 of 8 total
Time:        1.0 s
`;

const NO_SUITE_LINE = `
Tests:       7 passed, 7 total
Time:        3.1 s
`;

const PARTIAL_TEST_LINE = `
Test Suites: 2 passed, 2 total
Tests:       1 skipped, 6 passed, 7 of 8 total
Time:        3.1 s
`;

describe('test-counts: a healthy run is verified', () => {
  test('every count is extracted, and the verdict is verified', () => {
    const counts = parseJestCounts(HEALTHY);
    expect(counts.testsPassed).toBe(7);
    expect(counts.testsFailed).toBe(0);
    expect(counts.testsSkipped).toBe(0);
    expect(counts.suitesPassed).toBe(2);
    expect(counts.suitesFailed).toBe(0);
    expect(counts.suitesSkipped).toBe(0);
    expect(counts.testsAccountedFor).toBe(counts.testsTotal);
    expect(counts.suitesAccountedFor).toBe(counts.suitesTotal);

    const verdict = assessSuiteIntegrity({
      step: 'pandamstyle-suites',
      exitCode: 0,
      counts,
    });
    expect(verdict.verdict).toBe('verified');
    expect(verdict.findings).toEqual([]);
  });

  test('a log Jest never wrote is not a passing log', () => {
    expect(parseJestCounts('nothing here\n')).toBeNull();
    const verdict = assessSuiteIntegrity({
      step: 'pandamstyle-suites',
      exitCode: 0,
      counts: parseJestCounts('nothing here\n'),
    });
    expect(verdict.verdict).toBe('unverified');
    expect(verdict.findings[0].code).toBe('COUNTS_MISSING');
  });
});

describe('test-counts: a suite that failed to load cannot be reported as green', () => {
  test('seven passed tests do not outvote one failed suite', () => {
    // This is the exact shape of the Phase A/B defect: the aggregate looks
    // perfect and one suite contributed nothing because it never ran.
    const counts = parseJestCounts(SUITE_FAILED_TO_LOAD);
    expect(counts.testsPassed).toBe(7);
    expect(counts.testsFailed).toBe(0);
    expect(counts.suitesFailed).toBe(1);
    expect(counts.suitesPassed).toBe(1);

    const verdict = assessSuiteIntegrity({
      step: 'pandamstyle-suites',
      exitCode: 1,
      counts,
    });
    expect(verdict.verdict).toBe('failed');
    expect(verdict.findings.map((f) => f.code)).toContain('SUITE_FAILED');
  });

  test('a failed suite is a failure even when the exit code says zero', () => {
    // A wrapper that swallows the code - `|| true`, a pipe, a `set -e` that
    // never fired - must not be able to turn a real failure into a pass. The
    // counts are the authority; the exit code is the cross-check.
    const verdict = assessSuiteIntegrity({
      step: 'pandamstyle-suites',
      exitCode: 0,
      counts: parseJestCounts(SUITE_FAILED_TO_LOAD),
    });
    expect(verdict.verdict).toBe('failed');
    expect(verdict.findings.map((f) => f.code)).toContain('SUITE_FAILED');
    expect(verdict.findings.map((f) => f.code)).toContain(
      'EXIT_CODE_DISAGREES',
    );
  });

  test('a zero exit code with failures is caught even when the log is silent about tests', () => {
    const verdict = assessSuiteIntegrity({
      step: 'suites',
      exitCode: 0,
      counts: parseJestCounts(SUITE_FAILED_TO_LOAD),
    });
    expect(verdict.verdict).toBe('failed');
  });
});

describe('test-counts: skipped is not passed', () => {
  test('a skipped suite is counted as skipped and never as passed', () => {
    const counts = parseJestCounts(SKIPPED_SUITE);
    expect(counts.suitesSkipped).toBe(1);
    expect(counts.suitesPassed).toBe(1);
    expect(counts.suitesAccountedFor).toBe(counts.suitesTotal);
    expect(counts.testsSkipped).toBe(1);
    expect(counts.testsAccountedFor).toBe(counts.testsTotal);

    // A skipped suite with a zero exit code is INCOMPLETE, not verified: nothing
    // failed, but not everything ran either, and the two claims are different.
    const verdict = assessSuiteIntegrity({
      step: 'suites',
      exitCode: 0,
      counts,
    });
    expect(verdict.verdict).toBe('verified');
  });

  test('a log with no suite line is INCOMPLETE, not verified', () => {
    // "0 suites failed and 0 suites passed" is the same sentence as "Jest never
    // said", and only one of them is evidence.
    const counts = parseJestCounts(NO_SUITE_LINE);
    expect(counts.suitesTotal).toBeNull();
    const verdict = assessSuiteIntegrity({
      step: 'suites',
      exitCode: 0,
      counts,
    });
    expect(verdict.verdict).toBe('incomplete');
    expect(verdict.findings.map((f) => f.code)).toContain('SUITE_LINE_MISSING');
  });
});

describe('test-counts: unaccounted suites are a finding', () => {
  test('passed + failed + skipped must equal the total Jest reported', () => {
    // `Tests: 1 skipped, 6 passed, 7 of 8 total` is a real Jest shape: one
    // test did not run, and the arithmetic has to notice rather than assume the
    // gap is benign.
    const counts = parseJestCounts(PARTIAL_TEST_LINE);
    expect(counts.testsAccountedFor).toBe(7);
    expect(counts.testsTotal).toBe(8);
    const verdict = assessSuiteIntegrity({
      step: 'suites',
      exitCode: 0,
      counts,
    });
    expect(verdict.verdict).toBe('failed');
    expect(verdict.findings.map((f) => f.code)).toContain('TESTS_UNACCOUNTED');
  });

  test('a missing suite clause is null, not zero', () => {
    // The difference matters: `null` means "Jest did not report this", and 0
    // would mean "Jest reported none".
    const line = parseCountLine('Tests: 7 passed, 7 total', 'Tests');
    expect(line.failed).toBeNull();
    expect(line.skipped).toBeNull();
    const suites = parseCountLine(
      'Test Suites: 2 passed, 2 total',
      'Test Suites',
    );
    expect(suites.failed).toBeNull();
    expect(suites.skipped).toBeNull();
  });
});

describe('test-counts: a step with no exit code has not been shown to pass', () => {
  test('a missing exit code is a finding, and 0 is not inferred', () => {
    const verdict = assessSuiteIntegrity({
      step: 'suites',
      exitCode: null,
      counts: parseJestCounts(HEALTHY),
    });
    expect(verdict.exitCode).toBeNull();
    expect(verdict.verdict).toBe('incomplete');
    expect(verdict.findings.map((f) => f.code)).toContain('EXIT_CODE_MISSING');
  });
});

describe('test-counts: the run verdict does not collapse failed and incomplete', () => {
  test('one failed step makes the run failed even if everything else verified', () => {
    const run = assessRun([
      assessSuiteIntegrity({
        step: 'a',
        exitCode: 0,
        counts: parseJestCounts(HEALTHY),
      }),
      assessSuiteIntegrity({
        step: 'b',
        exitCode: 1,
        counts: parseJestCounts(SUITE_FAILED_TO_LOAD),
      }),
    ]);
    expect(run.verdict).toBe('failed');
    expect(run.stepsFailed).toEqual(['b']);
    // The aggregate numbers are still reported, because a reader needs them -
    // but the verdict is the counts' verdict, not the totals'.
    expect(run.testsPassed).toBe(14);
    expect(run.suitesFailed).toBe(1);
  });

  test('an unverified step makes the run incomplete, not failed, and not verified', () => {
    const run = assessRun([
      assessSuiteIntegrity({
        step: 'a',
        exitCode: 0,
        counts: parseJestCounts(HEALTHY),
      }),
      assessSuiteIntegrity({ step: 'b', exitCode: null, counts: null }),
    ]);
    expect(run.verdict).toBe('incomplete');
    expect(run.stepsUnverified).toEqual(['b']);
  });

  test('the run reports the six numbers a delivery has to quote', () => {
    const run = assessRun([
      assessSuiteIntegrity({
        step: 'a',
        exitCode: 0,
        counts: parseJestCounts(HEALTHY),
      }),
      assessSuiteIntegrity({
        step: 'b',
        exitCode: 0,
        counts: parseJestCounts(SKIPPED_SUITE),
      }),
    ]);
    expect(run.testsPassed).toBe(14);
    expect(run.testsFailed).toBe(0);
    expect(run.testsSkipped).toBe(1);
    expect(run.suitesPassed).toBe(3);
    expect(run.suitesFailed).toBe(0);
    expect(run.suitesSkipped).toBe(1);
  });
});
