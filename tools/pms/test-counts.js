/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - reading Jest's output without being fooled by it.
 *
 * THE DEFECT THIS EXISTS TO FIX
 *
 * Phase A and B found a verification hole that had nothing to do with the
 * compiler: a test run can report a healthy-looking aggregate number of passed
 * tests while one or more SUITES failed to load. A suite that fails to load
 * contributes no tests, so removing it from the count makes the total look
 * better, and a delivery that quoted the total would claim a green run that
 * never ran the code.
 *
 * The two ways this goes wrong, and both are covered below:
 *
 *   a suite FAILED and nobody said so, because only the test total was read;
 *   a suite was SKIPPED, ran zero tests, and was counted as a pass because
 *   "0 failed" and "0 passed" are the same sentence.
 *
 * So the rule is not "did the tests pass". The rule is: every suite is
 * accounted for as passed, failed or skipped, and the three numbers must add up
 * to the total Jest reported. A suite that is in none of the three is a
 * finding, and a non-zero failed count is a failure REGARDLESS of every other
 * number, including the process exit code.
 *
 * WHY THE EXIT CODE IS NOT ENOUGH
 *
 * Jest exits non-zero on a failed suite, so the exit code would catch this. It
 * is not sufficient on its own for two reasons: a wrapper that swallows the
 * code (`|| true`, a pipe, a `set -e` that never fired because the step was
 * skipped) turns a real failure into a passing step, and a step that was
 * SKIPPED has no exit code at all - and `0` is not a safe value to infer, which
 * is why a skipped step records `null` and not `0`.
 *
 * So both are read, and they are cross-checked against each other and against
 * the counts. Disagreement is itself a finding, reported as such.
 */

'use strict';

/**
 * One "Tests:" or "Test Suites:" line, parsed into its three counts.
 *
 * Jest's format varies: `Tests: 1 skipped, 46 passed, 47 of 48 total`,
 * `Test Suites: 16 passed, 16 total`, and the all-failed form
 * `Tests: 3 failed, 5 passed, 8 total`. All of them are matched by the same
 * three independent searches, so the order of the clauses does not matter and a
 * missing clause is `null` rather than `0` - "Jest did not report this" and
 * "Jest reported zero" are different facts.
 */
function parseCountLine(text, label) {
  const match = new RegExp(`${label}:\\s+(.*)`).exec(text);
  if (match == null) return null;
  const tail = match[1];
  const pick = (re) => {
    const m = re.exec(tail);
    return m == null ? null : Number(m[1]);
  };
  return {
    passed: pick(/(\d+) passed/),
    failed: pick(/(\d+) failed/),
    skipped: pick(/(\d+) skipped/),
    total: pick(/(?:of )?(\d+) total/),
  };
}

/**
 * Every count a Jest log carries, plus the verdict.
 *
 * `suitesAccountedFor` is the load-bearing number: it is
 * `passed + failed + skipped`, and `suitesTotal` is what Jest said there were.
 * When they differ, suites went missing - and a suite that went missing is the
 * failure mode this module exists to catch, whatever the test total says.
 */
function parseJestCounts(text) {
  const tests = parseCountLine(text, 'Tests');
  const suites = parseCountLine(text, 'Test Suites');
  if (tests == null && suites == null) return null;

  const suiteAccounted =
    suites == null
      ? null
      : (suites.passed ?? 0) + (suites.failed ?? 0) + (suites.skipped ?? 0);
  const testAccounted =
    tests == null
      ? null
      : (tests.passed ?? 0) + (tests.failed ?? 0) + (tests.skipped ?? 0);

  return {
    tests,
    suites,
    testsPassed: tests?.passed ?? 0,
    testsFailed: tests?.failed ?? 0,
    testsSkipped: tests?.skipped ?? 0,
    suitesPassed: suites?.passed ?? 0,
    suitesFailed: suites?.failed ?? 0,
    suitesSkipped: suites?.skipped ?? 0,
    testsAccountedFor: testAccounted,
    testsTotal: tests?.total ?? null,
    suitesAccountedFor: suiteAccounted,
    suitesTotal: suites?.total ?? null,
  };
}

/**
 * The verdict on one step, from its counts and its exit code.
 *
 * The findings are named, not merged, so a reader can see WHICH rule fired.
 * Each one is a different defect:
 *
 *   SUITE_FAILED            a suite reported failures. A failure, full stop.
 *   TEST_FAILED             a test reported failures, with no suite line. Still a
 *                           failure; the missing suite line is itself recorded.
 *   SUITES_UNACCOUNTED      the passed/failed/skipped counts do not add up to the
 *                           total. Suites went missing.
 *   TESTS_UNACCOUNTED       the same, for tests.
 *   SUITE_LINE_MISSING      the log has no "Test Suites:" line at all, so the
 *                           suite count is unknown. UNKNOWN, not zero: a step
 *                           that reported no suites has not been shown to have
 *                           none.
 *   EXIT_CODE_DISAGREES     the exit code and the counts tell different stories.
 *   EXIT_CODE_MISSING       a step with no exit code. A skipped step must not be
 *                           reported as a pass, and 0 is not a safe inference.
 */
function assessSuiteIntegrity({ step, exitCode, counts, text = null }) {
  const findings = [];
  if (counts == null) {
    findings.push({
      code: 'COUNTS_MISSING',
      message:
        `${step}: the log carries no "Tests:" or "Test Suites:" line, so ` +
        'nothing about this step is verified',
    });
    return {
      step,
      verdict: 'unverified',
      exitCode: exitCode ?? null,
      findings,
      counts: null,
    };
  }

  if (counts.suitesFailed > 0) {
    findings.push({
      code: 'SUITE_FAILED',
      message:
        `${step}: ${counts.suitesFailed} of ${counts.suitesTotal} suites ` +
        'reported failures. This is a failure regardless of every other ' +
        'number, including the passed-test total.',
    });
  }
  if (counts.testsFailed > 0) {
    findings.push({
      code: 'TEST_FAILED',
      message: `${step}: ${counts.testsFailed} tests reported failures.`,
    });
  }
  if (
    counts.suites != null &&
    (counts.suites.total == null ||
      counts.suitesAccountedFor !== counts.suites.total)
  ) {
    findings.push({
      code: 'SUITES_UNACCOUNTED',
      message:
        `${step}: ${counts.suitesPassed} passed + ${counts.suitesFailed} ` +
        `failed + ${counts.suitesSkipped} skipped is ` +
        `${counts.suitesAccountedFor}, but Jest reported ` +
        `${counts.suites.total} suites. Suites are unaccounted for.`,
    });
  }
  if (
    counts.tests != null &&
    (counts.tests.total == null ||
      counts.testsAccountedFor !== counts.tests.total)
  ) {
    findings.push({
      code: 'TESTS_UNACCOUNTED',
      message:
        `${step}: ${counts.testsPassed} passed + ${counts.testsFailed} failed ` +
        `+ ${counts.testsSkipped} skipped is ${counts.testsAccountedFor}, but ` +
        `Jest reported ${counts.tests.total} tests.`,
    });
  }
  if (counts.suitesTotal == null && counts.testsTotal != null) {
    findings.push({
      code: 'SUITE_LINE_MISSING',
      message:
        `${step}: the log has a "Tests:" line and no "Test Suites:" line. The ` +
        'suite count is UNKNOWN here, not zero, and an unknown suite count ' +
        'cannot be reported as a passing one.',
    });
  }
  if (counts.tests == null) {
    findings.push({
      code: 'TEST_LINE_MISSING',
      message: `${step}: the log has no "Tests:" line; the test count is unknown.`,
    });
  }
  if (exitCode == null) {
    findings.push({
      code: 'EXIT_CODE_MISSING',
      message:
        `${step}: no exit code was recorded. A step with no exit code has not ` +
        'been shown to have succeeded, and it is not reported as having done so.',
    });
  } else {
    const countsSayFailure = counts.suitesFailed > 0 || counts.testsFailed > 0;
    const exitSaysFailure = exitCode !== 0;
    if (countsSayFailure !== exitSaysFailure) {
      findings.push({
        code: 'EXIT_CODE_DISAGREES',
        message:
          `${step}: exit code ${exitCode} and counts ` +
          `(suites failed ${counts.suitesFailed}, tests failed ` +
          `${counts.testsFailed}) disagree about whether this step failed.`,
      });
    }
  }
  void text;

  return {
    step,
    verdict:
      findings.length === 0
        ? 'verified'
        : findings.some((f) =>
              [
                'SUITE_FAILED',
                'TEST_FAILED',
                'SUITES_UNACCOUNTED',
                'TESTS_UNACCOUNTED',
                'COUNTS_MISSING',
              ].includes(f.code),
            )
          ? 'failed'
          : 'incomplete',
    exitCode: exitCode ?? null,
    findings,
    counts,
  };
}

/**
 * Every step's integrity, and the overall verdict.
 *
 * `verified` requires that EVERY step is verified. A run with one unverified
 * step is `incomplete`, and a run with one failed step is `failed`; the two are
 * not collapsed, because "nothing failed" and "everything ran" are different
 * claims and a delivery that quotes one as the other is the defect this module
 * was written for.
 */
function assessRun(integrity) {
  const failed = integrity.filter((s) => s.verdict === 'failed');
  const incomplete = integrity.filter((s) => s.verdict === 'incomplete');
  const unverified = integrity.filter((s) => s.verdict === 'unverified');
  return {
    verdict:
      failed.length > 0
        ? 'failed'
        : incomplete.length + unverified.length > 0
          ? 'incomplete'
          : 'verified',
    stepsVerified: integrity.filter((s) => s.verdict === 'verified').length,
    stepsFailed: failed.map((s) => s.step),
    stepsIncomplete: incomplete.map((s) => s.step),
    stepsUnverified: unverified.map((s) => s.step),
    testsPassed: integrity.reduce(
      (n, s) => n + (s.counts?.testsPassed ?? 0),
      0,
    ),
    testsFailed: integrity.reduce(
      (n, s) => n + (s.counts?.testsFailed ?? 0),
      0,
    ),
    testsSkipped: integrity.reduce(
      (n, s) => n + (s.counts?.testsSkipped ?? 0),
      0,
    ),
    suitesPassed: integrity.reduce(
      (n, s) => n + (s.counts?.suitesPassed ?? 0),
      0,
    ),
    suitesFailed: integrity.reduce(
      (n, s) => n + (s.counts?.suitesFailed ?? 0),
      0,
    ),
    suitesSkipped: integrity.reduce(
      (n, s) => n + (s.counts?.suitesSkipped ?? 0),
      0,
    ),
    // The two populations behind those sums, named. Every count above is a sum
    // over the steps that RUN tests, and a reader who cannot see which steps
    // those were is reading a total whose denominator has been hidden from them.
    testSteps: integrity.filter((s) => s.kind === 'test').map((s) => s.step),
    nonTestSteps: integrity
      .filter((s) => s.kind != null && s.kind !== 'test')
      .map((s) => s.step),
  };
}

module.exports = {
  assessRun,
  assessSuiteIntegrity,
  parseCountLine,
  parseJestCounts,
};
