/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * A verifier must be able to say a run was good.
 *
 * `tools/pms/test-counts.js` was written for the opposite failure: a run that
 * said it was good when it was not. It did that job, and in doing so it made a
 * good run unreportable - because it judged `install`, `build`, `pilot` and
 * `artifacts` by whether their logs carried Jest counts, and none of them runs
 * Jest. Phase D's verification came back with every step passed and the run
 * `incomplete`, and the honest reading of those two together is that a reader
 * who has seen the flag be wrong once will not read it again.
 *
 * So these tests are the other half of that module's job. Each is named after
 * the situation it pins, and the ones that matter most are the ones where the
 * answer is `verified`: a verifier that can only ever fail is not a verifier,
 * and the case that proved it was one where a green run could not be reported.
 *
 * These are the four Jest summary lines recorded by the Phase 4 run that
 * exposed the defect. Keeping the small parser fixtures here makes this test
 * independent of ignored, locally generated evidence files. They exercise the
 * summary parser only; current qualification comes from the current verifier
 * run and is never inferred from these historical counts.
 */

'use strict';

const { parseJestCounts } = require('../test-counts');
const {
  KIND_EVIDENCE,
  STEP_CONTRACTS,
  assessStep,
  contractFor,
} = require('../step-contracts');

const HISTORICAL_JEST_SUMMARIES = {
  pandamstyle:
    'Test Suites: 22 passed, 22 total\nTests: 500 passed, 500 total\n',
  'pandamstyle-core':
    'Test Suites: 1 passed, 1 total\nTests: 14 passed, 14 total\n',
  'semantic-oracle':
    'Test Suites: 20 passed, 20 total\nTests: 148 passed, 148 total\n',
  'tooling-tests':
    'Test Suites: 5 passed, 5 total\nTests: 76 passed, 76 total\n',
};

/** A compact parser fixture copied from the historical run's Jest summary. */
function historicalJestSummary(step) {
  return HISTORICAL_JEST_SUMMARIES[step] ?? null;
}

/** The historical run's step table exercises the current evidence contracts. */
const REAL_RUN = {
  install: { status: 'passed', exitCode: 0 },
  build: { status: 'passed', exitCode: 0 },
  pandamstyle: { status: 'passed', exitCode: 0 },
  'pandamstyle-core': { status: 'passed', exitCode: 0 },
  'semantic-oracle': { status: 'passed', exitCode: 0 },
  'tooling-tests': { status: 'passed', exitCode: 0 },
  pilot: { status: 'passed', exitCode: 0 },
  artifacts: { status: 'passed', exitCode: 0 },
  'donor-closure': { status: 'passed', exitCode: 0 },
  'package-qualification': { status: 'passed', exitCode: 0 },
  'next-qualification': { status: 'passed', exitCode: 0 },
};

const TEST_STEPS = [
  'pandamstyle',
  'pandamstyle-core',
  'semantic-oracle',
  'tooling-tests',
];
const NON_TEST_STEPS = [
  'install',
  'build',
  'pilot',
  'artifacts',
  'donor-closure',
  'package-qualification',
  'next-qualification',
];
const CURRENT_NON_TEST_STEPS = [...NON_TEST_STEPS, 'rsbuild-qualification'];

/**
 * The conjunction `summary.json`'s `complete` is computed from, restated here so
 * the tests assert the RULE rather than re-deriving it inline. Three separate
 * claims, and a reader who wants to know which is false can look.
 */
function completeFor({ skipped = [], failed = 0, runVerdict }) {
  return skipped.length === 0 && failed === 0 && runVerdict === 'verified';
}

/** Assess a step the way the summary block does, from a log rather than counts. */
function assessFromLog(
  step,
  { status = 'passed', exitCode = 0, artifactPresent } = {},
) {
  const kind = contractFor(step)?.kind;
  const counts =
    KIND_EVIDENCE[kind]?.requiresCounts === true
      ? parseJestCounts(historicalJestSummary(step) ?? '')
      : null;
  return assessStep({
    step,
    status,
    exitCode,
    counts,
    evidence: { acceptance: status, artifactPresent },
  });
}

describe('step-contracts: a test-bearing step is judged on its counts', () => {
  test('valid Jest counts and exit 0 verify the step', () => {
    // Case 1. Four Jest steps, using the summaries recorded by the verified
    // run: 500/22, 14/1, 148/20, and 76/5 tests/suites.
    for (const step of TEST_STEPS) {
      const counts = parseJestCounts(historicalJestSummary(step) ?? '');
      expect(counts).not.toBeNull();
      const verdict = assessStep({
        step,
        status: 'passed',
        exitCode: 0,
        counts,
        evidence: { acceptance: 'passed' },
      });
      expect(verdict.verdict).toBe('verified');
      expect(verdict.kind).toBe('test');
      expect(verdict.findings).toEqual([]);
      expect(verdict.counts).not.toBeNull();
    }
  });

  test('a test step with no suite counts is unverified, not passed', () => {
    // Case 2. The specific hole Phase D fell into: a step whose log carries
    // nothing to check. For a step that RUNS tests this is still a failure to
    // verify - a suite that contributes no tests makes the total look better,
    // which is what `test-counts.js` was written for and what must not be
    // relaxed here to make the other four steps pass.
    const verdict = assessStep({
      step: 'pandamstyle',
      status: 'passed',
      exitCode: 0,
      counts: null,
      evidence: { acceptance: 'passed' },
    });
    expect(verdict.verdict).toBe('failed');
    expect(verdict.findings.map((f) => f.code)).toContain('COUNTS_MISSING');
    expect(verdict.counts).toBeNull();
  });

  test('a failed suite fails the step even when every test that ran passed', () => {
    // Case 3. The Phase A/B defect, re-asserted through the new dispatcher so
    // that routing a test step through `assessStep` cannot quietly drop it.
    const verdict = assessStep({
      step: 'pandamstyle',
      status: 'passed',
      exitCode: 0,
      counts: parseJestCounts(`
PASS __tests__/a-test.js
FAIL __tests__/b-test.js
  ● Test suite failed to run

Test Suites: 1 failed, 41 passed, 42 of 43 total
Tests:       1007 passed, 1071 total
`),
      evidence: { acceptance: 'passed' },
    });
    expect(verdict.verdict).toBe('failed');
    const codes = verdict.findings.map((f) => f.code);
    // The suite failure, AND the disagreement with an exit code of 0 that says
    // the step passed. Both are findings, and neither is the other's substitute.
    expect(codes).toContain('SUITE_FAILED');
    expect(codes).toContain('EXIT_CODE_DISAGREES');
  });

  test('the Phase C integrity codes still fire for a test step', () => {
    // Every code Phase C's suite-count fix introduced, reachable through the
    // dispatcher. This is the regression guard for "do not weaken suite
    // integrity": if routing a test step through `assessStep` dropped one of
    // these, the count would look healthy again.
    const cases = [
      ['SUITE_FAILED', 'Test Suites: 2 failed, 2 total', 'Tests: 5 total'],
      [
        'TEST_FAILED',
        'Test Suites: 2 passed, 2 total',
        'Tests: 1 failed, 4 passed, 5 total',
      ],
      [
        'SUITES_UNACCOUNTED',
        'Test Suites: 2 passed, 4 total',
        'Tests: 5 total',
      ],
      [
        'TESTS_UNACCOUNTED',
        'Test Suites: 2 passed, 2 total',
        'Tests: 4 passed, 6 total',
      ],
      ['SUITE_LINE_MISSING', null, 'Tests: 5 passed, 5 total'],
      [
        'EXIT_CODE_DISAGREES',
        'Test Suites: 2 passed, 2 total',
        'Tests: 1 failed, 4 passed, 5 total',
      ],
    ];
    for (const [code, suiteLine, testLine] of cases) {
      const text = [suiteLine, testLine].filter((l) => l != null).join('\n');
      const verdict = assessStep({
        step: 'pandamstyle',
        // Exit 0 for every case, so the suite line is the only thing deciding.
        status: 'passed',
        exitCode: 0,
        counts: parseJestCounts(text),
        evidence: { acceptance: 'passed' },
      });
      expect(verdict.findings.map((f) => f.code)).toContain(code);
      expect(verdict.verdict).not.toBe('verified');
    }
  });

  test('a test step that exits non-zero fails even when its counts are clean', () => {
    const verdict = assessStep({
      step: 'pandamstyle',
      status: 'failed',
      exitCode: 1,
      counts: parseJestCounts(
        'Test Suites: 20 passed, 20 total\nTests: 460 passed, 460 total\n',
      ),
      evidence: { acceptance: 'failed' },
    });
    expect(verdict.verdict).toBe('failed');
    expect(verdict.findings.map((f) => f.code)).toContain('EXIT_CODE_NONZERO');
  });
});

describe('step-contracts: a step that runs no tests is judged on what it owes', () => {
  // Cases 4 through 7. The four steps Phase D could not verify, each with the
  // evidence its kind actually declares: it executed, it passed, and - for the
  // one step whose deliverable is a file - the file is there.
  test.each(CURRENT_NON_TEST_STEPS)(
    '%s verifies on exit 0 and acceptance, with counts null',
    (step) => {
      const verdict = assessFromLog(step, { artifactPresent: true });
      expect(verdict.verdict).toBe('verified');
      expect(verdict.findings).toEqual([]);
      // The load-bearing part: null, and specifically not zeros. A fabricated zero
      // would enter every total in the run as though a suite had run and reported
      // nothing.
      expect(verdict.counts).toBeNull();
    },
  );

  test('every runner step has an explicit evidence contract', () => {
    // The classification is a table, and this asserts the table's shape rather
    // than the runner's behaviour: every step `verify-pms.sh` can run has a
    // contract, and each contract names a kind whose evidence requirements are
    // stated. A step added to the runner without a contract is reported
    // unverified rather than judged by whichever rule fires first.
    const classified = Object.entries(STEP_CONTRACTS);
    expect(classified.map(([name]) => name).sort()).toEqual([
      'artifacts',
      'build',
      'donor-closure',
      'install',
      'next-qualification',
      'package-qualification',
      'pandamstyle',
      'pandamstyle-core',
      'pilot',
      'rsbuild-qualification',
      'semantic-oracle',
      'tooling-tests',
    ]);
    for (const [, { kind }] of classified) {
      expect(KIND_EVIDENCE[kind]).toBeDefined();
    }
    // And the split the whole fix turns on.
    expect(
      classified
        .filter(([, c]) => c.kind === 'test')
        .map(([n]) => n)
        .sort(),
    ).toEqual([...TEST_STEPS].sort());
    expect(
      classified
        .filter(([, c]) => c.kind !== 'test')
        .map(([n]) => n)
        .sort(),
    ).toEqual([...CURRENT_NON_TEST_STEPS].sort());
  });

  test('a step with no contract is unverified rather than judged by a default', () => {
    const verdict = assessStep({
      step: 'a-step-nobody-classified',
      status: 'passed',
      exitCode: 0,
      counts: null,
      evidence: { acceptance: 'passed' },
    });
    expect(verdict.verdict).toBe('unverified');
    expect(verdict.findings.map((f) => f.code)).toEqual(['STEP_UNCLASSIFIED']);
    expect(verdict.kind).toBeNull();
  });

  test('the artifact step fails when its deliverable is absent', () => {
    // The one step-specific invariant in the runner. `collect_artifacts`'s
    // output IS its deliverable, so a step that exited zero having written no
    // digests has reported success on work it did not do - and the generic rule
    // of "it exited 0" would have believed it.
    const verdict = assessFromLog('artifacts', { artifactPresent: false });
    expect(verdict.verdict).toBe('failed');
    expect(verdict.findings.map((f) => f.code)).toContain('ARTIFACT_MISSING');
  });

  test('donor closure fails when its structural report is absent', () => {
    const verdict = assessFromLog('donor-closure', { artifactPresent: false });
    expect(verdict.verdict).toBe('failed');
    expect(verdict.findings.map((f) => f.code)).toContain('ARTIFACT_MISSING');
  });

  test('package qualification fails when its consumer report is absent', () => {
    const verdict = assessFromLog('package-qualification', {
      artifactPresent: false,
    });
    expect(verdict.verdict).toBe('failed');
    expect(verdict.findings.map((f) => f.code)).toContain('ARTIFACT_MISSING');
    expect(STEP_CONTRACTS['package-qualification'].artifact).toBe(
      'package-qualification/report.json',
    );
  });

  test('the pilot step does not require a dist, and the reason is recorded', () => {
    // The pilot's own script fails when its build fails, so the exit code is
    // its acceptance. Whether a pilot produced a `dist` depends on the mode it
    // ran in, and a rule that demanded one would fail runs that are correct -
    // so the pilot requires no artifact, and this says so rather than leaving it
    // as an absence someone might "fix" later.
    expect(KIND_EVIDENCE.pilot.requiresArtifact).toBe(false);
    expect(assessFromLog('pilot', { artifactPresent: false }).verdict).toBe(
      'verified',
    );
  });
});

describe('step-contracts: a non-test step that fails, fails', () => {
  // Case 8, for every kind that is not a test step. This is the case that makes
  // the relaxation a contract rather than a loophole: dropping the count
  // requirement must not have dropped the failure requirement with it.
  test.each(CURRENT_NON_TEST_STEPS)('%s exits non-zero => failed', (step) => {
    const verdict = assessFromLog(step, {
      status: 'failed',
      exitCode: 2,
      artifactPresent: true,
    });
    expect(verdict.verdict).toBe('failed');
    expect(verdict.findings.map((f) => f.code)).toContain('EXIT_CODE_NONZERO');
  });

  test('a swallowed exit code is caught by the counts, and named as disagreement', () => {
    // The wrapper that runs `|| true` and reports success over a red result. The
    // exit code cannot catch it - the code IS zero - so the counts are what
    // catch it, and the disagreement between them is reported as itself.
    //
    // Note which step this can happen to: only a test step has counts to
    // disagree with. A non-test step's acceptance is its exit code, because it
    // runs no work whose result could be hidden. `record_step` derives the
    // step-table status FROM the code, so status and code cannot disagree either,
    // and a cross-check between them would be a check that cannot fire - the
    // same defect as a counter that is always zero, so there isn't one.
    const verdict = assessStep({
      step: 'pandamstyle',
      status: 'passed',
      exitCode: 0,
      counts: parseJestCounts(
        'Test Suites: 1 failed, 19 passed, 20 total\nTests: 1 failed, 459 passed, 460 total\n',
      ),
      evidence: { acceptance: 'passed' },
    });
    expect(verdict.verdict).toBe('failed');
    const codes = verdict.findings.map((f) => f.code);
    expect(codes).toContain('SUITE_FAILED');
    expect(codes).toContain('TEST_FAILED');
    expect(codes).toContain('EXIT_CODE_DISAGREES');
  });
});

describe('step-contracts: a whole run', () => {
  // Case 9. The run that exposed the defect, reconstructed from the logs and
  // the step table the verified run produced. Before the fix this shape produced
  // `complete: false` with `incomplete`, which is the defect.
  test('eleven green steps with four sets of counts are verified', () => {
    const { assessRun } = require('../test-counts');
    const integrity = Object.entries(REAL_RUN).map(([step, s]) =>
      assessFromLog(step, { ...s, artifactPresent: true }),
    );
    expect(integrity.map((s) => s.verdict)).toEqual(Array(11).fill('verified'));
    const run = assessRun(integrity);
    expect(run.verdict).toBe('verified');
    expect(run.stepsVerified).toBe(11);
    expect(run.stepsFailed).toEqual([]);
    expect(run.stepsIncomplete).toEqual([]);
    expect(run.stepsUnverified).toEqual([]);
    // No step was skipped and none failed, so `complete` reduces to the verdict.
    expect(completeFor({ failed: 0, runVerdict: run.verdict })).toBe(true);
    // The totals are sums over the four steps that run tests, and the run says
    // which three so the denominator is not hidden from a reader.
    expect(run.testSteps.sort()).toEqual([...TEST_STEPS].sort());
    expect(run.nonTestSteps.sort()).toEqual([...NON_TEST_STEPS].sort());
    // Historical Phase 4 logs: 500 + 14 + 148 + 76 = 738 tests across 48 suites.
    expect(run.testsPassed).toBe(738);
    expect(run.testsFailed).toBe(0);
    expect(run.testsSkipped).toBe(0);
    expect(run.suitesPassed).toBe(48);
    expect(run.suitesFailed).toBe(0);
    expect(run.suitesSkipped).toBe(0);
  });

  test('the five non-test steps contribute no counts to the totals', () => {
    // If a non-test step's log were parsed and found a `Tests:` line - a build
    // tool that printed one, a lockfile entry - its numbers would enter a
    // delivery's totals as though suites had run. Asserted against a log that
    // HAS the line, which is the case that would catch it.
    const { assessRun } = require('../test-counts');
    const counts = parseJestCounts(
      'Test Suites: 9 passed, 9 total\nTests: 900 passed, 900 total\n',
    );
    expect(counts.testsPassed).toBe(900);
    const verdict = assessStep({
      step: 'install',
      status: 'passed',
      exitCode: 0,
      counts,
      evidence: { acceptance: 'passed' },
    });
    // The counts are present in the input and absent from the record, and the
    // run they must not reach.
    expect(verdict.counts).toBeNull();
    expect(verdict.verdict).toBe('verified');
    const run = assessRun([verdict]);
    expect(run.testsPassed).toBe(0);
    expect(run.suitesPassed).toBe(0);
  });

  // Case 10. A skipped step is not a passed step, and the run is not complete.
  test('a skipped required step makes the run incomplete and not complete', () => {
    const { assessRun } = require('../test-counts');
    const integrity = Object.entries(REAL_RUN).map(([step]) =>
      assessStep({
        step,
        status: 'passed',
        exitCode: 0,
        counts:
          KIND_EVIDENCE[contractFor(step)?.kind]?.requiresCounts === true
            ? parseJestCounts(historicalJestSummary(step) ?? '')
            : null,
        evidence: { acceptance: 'passed', artifactPresent: true },
      }),
    );
    integrity[0] = assessStep({
      step: 'install',
      status: 'skipped',
      exitCode: null,
      counts: null,
      evidence: { acceptance: 'not_run' },
    });
    const run = assessRun(integrity);
    expect(integrity[0].verdict).toBe('unverified');
    expect(integrity[0].findings.map((f) => f.code)).toEqual(['STEP_SKIPPED']);
    expect(run.verdict).toBe('incomplete');
    expect(run.stepsUnverified).toEqual(['install']);
    // One skipped required step is enough, and it does so through the `skipped`
    // claim rather than the verdict claim - which is why both are asserted and
    // why `complete` is a conjunction rather than the verdict alone.
    expect(completeFor({ skipped: ['install'], runVerdict: run.verdict })).toBe(
      false,
    );
    expect(completeFor({ skipped: [], runVerdict: 'incomplete' })).toBe(false);
  });

  test('one failed step makes the run failed whatever else is green', () => {
    const { assessRun } = require('../test-counts');
    const integrity = Object.entries(REAL_RUN).map(([step, s]) =>
      assessFromLog(step, { ...s, artifactPresent: true }),
    );
    integrity[1] = assessFromLog('build', {
      status: 'failed',
      exitCode: 1,
      artifactPresent: true,
    });
    const run = assessRun(integrity);
    expect(run.verdict).toBe('failed');
    expect(run.stepsFailed).toEqual(['build']);
  });
});
