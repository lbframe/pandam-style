/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - what evidence each verification step is expected to produce.
 *
 * THE DEFECT THIS EXISTS TO FIX
 *
 * Phase D's verification run reported every one of its seven steps as passed,
 * with 1566 tests passed and no failures, and then reported the run itself as
 * `complete: false` with the verdict `incomplete`. The two statements came from
 * the same document.
 *
 * The cause was a single rule applied to every step alike: a step is verified
 * when its log carries Jest test and suite counts that add up. That rule is
 * correct for the Jest-bearing suite steps, which run Jest and do produce
 * those counts. It is not a rule that the command, pilot and artifact steps can
 * ever satisfy, because none of them runs a Jest suite, so none can emit a
 * `Tests:` line.
 *
 * So `complete: true` was unreachable. Not difficult to reach, not reachable:
 * a verifier that cannot report success is a verifier whose success report
 * means nothing, because a reader learns to ignore it and then ignores the
 * failure report too. The alternative - inventing zero counts for the four
 * steps so the rule would pass - would have been worse, and it is what this
 * module refuses to do.
 *
 * THE FIX: ASK EACH STEP FOR ITS OWN EVIDENCE
 *
 * Every step is classified, once, by what it actually does. The classification
 * is a table rather than a heuristic for two reasons. A heuristic - "require
 * counts if any are present" - makes the standard depend on the log, so the same
 * step is verified or not depending on what a build happened to print, and a
 * build tool that grew a line reading `Tests: 0 failed` would silently start
 * being believed. A table makes the standard a property of the step, so
 * changing it is a deliberate edit to this file, reviewable as one.
 *
 * The second reason is that the run's totals must mean something. The numbers a
 * delivery quotes - 1566 tests, 66 suites - are sums over the steps that ran
 * tests. If a non-test step's log were parsed for counts, a package whose build
 * output happened to contain the word would contribute numbers nobody ran. So
 * counts are read from test-bearing steps and from nothing else, and the other
 * steps record `counts: null`, which is a fact about them rather than a gap.
 *
 * THE VOCABULARY, AND WHY IT HAS THREE WORDS
 *
 *   passed     the command ran and exited zero. A statement about a process.
 *   verified   the step produced the evidence its kind is supposed to produce.
 *              A statement about whether that evidence establishes the claim.
 *   complete   every required step ran, none failed, and every one was verified.
 *              A statement about the run.
 *
 * Collapsing any two of them loses something real. "Passed" without "verified"
 * is the Phase A/B defect the suite counters exist to catch: a step whose exit
 * code was swallowed by a wrapper, reporting a green process over a red result.
 * "Verified" without "complete" is a partial run read as a whole one. Keeping
 * all three is what lets `summary.json` be quoted by a reader who is checking it.
 *
 * ON `acceptance`
 *
 * A non-test step's contract is "it executed, it exited zero, it passed, and the
 * artifact it owes is there". The middle two of those are the same fact in this
 * runner: `record_step` DERIVES the step-table status from the exit code, so
 * `acceptance === 'passed'` and `exitCode === 0` cannot disagree. Acceptance is
 * therefore recorded on every step and not cross-checked against the code - a
 * check between two values one derives from the other is a check that cannot
 * fire, and a check that cannot fire is the defect this module exists to remove.
 * The thing that CAN disagree with a zero exit code is a test step's counts, and
 * `EXIT_CODE_DISAGREES` is the finding that says so.
 */

'use strict';

const { assessSuiteIntegrity } = require('./test-counts');

/**
 * WHAT EVIDENCE EACH KIND OWES THE RUN
 *
 * `requiresCounts`  a Jest-style test/suite count is part of this step's
 *                   contract, and its absence is a finding rather than a pass.
 * `requiresArtifact` the step's job is to PRODUCE something, and the produced
 *                   thing is checked rather than the log being read.
 *
 * `command`  install, build. The work is the command; there is nothing to
 *            inspect afterwards, and pretending otherwise would be inventing a
 *            check. Exit code zero is the whole contract.
 *
 * `test`     the Jest suite steps. The full Phase C integrity rule
 *            applies and is not relaxed in any way here.
 *
 * `pilot`    an end-to-end build of a real application through the delivered
 *            package. `run-pilot.sh` fails non-zero when its own build fails, so
 *            the exit code is the acceptance. No artifact is required of it:
 *            whether a pilot produced a `dist` depends on the pilot's mode, and
 *            a rule that demanded one would fail runs that are correct.
 *
 * `artifact-check`  collects delivered artifacts or proves donor closure.
 *            Its contract names the evidence file, because that file IS the
 *            step's deliverable: a step that exits zero having written no
 *            evidence has reported success on work it did not do.
 */
const KIND_EVIDENCE = {
  command: { requiresCounts: false, requiresArtifact: false },
  test: { requiresCounts: true, requiresArtifact: false },
  pilot: { requiresCounts: false, requiresArtifact: false },
  'artifact-check': { requiresCounts: false, requiresArtifact: true },
};

/**
 * THE CLASSIFICATION
 *
 * One entry per step `verify-pms.sh` can run. `testSteps` is written as a list
 * rather than derived from a naming convention so that adding a suite step is an
 * edit a reviewer can see, and so a step cannot become test-bearing by accident.
 *
 * A step that is NOT in this table is a finding, not a default. The runner
 * growing a step without classifying it means that step would be judged by
 * whichever rule happened to fire; reporting it as unverified is the honest
 * outcome, and it is the outcome that makes this table load-bearing.
 */
const STEP_CONTRACTS = {
  install: { kind: 'command' },
  build: { kind: 'command' },
  pandamstyle: { kind: 'test' },
  'pandamstyle-core': { kind: 'test' },
  'semantic-oracle': { kind: 'test' },
  'tooling-tests': { kind: 'test' },
  pilot: { kind: 'pilot' },
  artifacts: { kind: 'artifact-check', artifact: 'artifacts/digests.txt' },
  'donor-closure': {
    kind: 'artifact-check',
    artifact: 'donor-closure/report.json',
  },
  'package-qualification': {
    kind: 'artifact-check',
    artifact: 'package-qualification/report.json',
  },
  'next-qualification': {
    kind: 'artifact-check',
    artifact: 'next-qualification/report.json',
  },
  'rsbuild-qualification': {
    kind: 'artifact-check',
    artifact: 'rsbuild-qualification/report.json',
  },
};

/**
 * Findings that mean the delivery is WRONG, as opposed to findings that mean
 * the claim could not be established. The distinction is the one `assessRun`
 * already draws between `failed` and `incomplete`, and it is load-bearing: a
 * run whose step failed and a run whose step could not be checked need different
 * fixes, and collapsing them tells the reader to go and look in the wrong place.
 *
 * `COUNTS_MISSING` is a failure and not a gap. A test-bearing step that emitted
 * no counts has not been shown to have run anything, and Phase C's suite-count
 * work exists for exactly that reason; it keeps its classification here.
 */
const FAILURE_CODES = new Set([
  'SUITE_FAILED',
  'TEST_FAILED',
  'SUITES_UNACCOUNTED',
  'TESTS_UNACCOUNTED',
  'COUNTS_MISSING',
  'EXIT_CODE_NONZERO',
  'ARTIFACT_MISSING',
  'STEP_UNCLASSIFIED',
]);

/** The three verdicts, and which of them can fail a run. */
function verdictFor(findings) {
  if (findings.length === 0) return 'verified';
  return findings.some((f) => FAILURE_CODES.has(f.code))
    ? 'failed'
    : 'incomplete';
}

/**
 * The contract for one step, or null when the runner has a step nobody
 * classified.
 */
function contractFor(step) {
  return STEP_CONTRACTS[step] ?? null;
}

/** What a kind owes the run. An unknown kind is asked for nothing, on purpose. */
function evidenceFor(kind) {
  return KIND_EVIDENCE[kind] ?? null;
}

/**
 * The verdict on ONE step, against the contract its kind declares.
 *
 * `counts` is expected to be null for every kind that does not require counts,
 * and is recorded as null in that case rather than defaulted to zeros. Zeros are
 * a claim - "no tests ran and none failed" - and for a step that runs no tests
 * it is a false one.
 *
 * Every code emitted by `assessSuiteIntegrity` passes through untouched for a
 * `test` step except `EXIT_CODE_MISSING`, which this module emits itself with
 * wording that names the step's contract. Nothing here relaxes a test-bearing
 * step's requirements, and the skipped case produces the same `STEP_SKIPPED`
 * finding it always did.
 *
 * `evidence` carries what the caller observed for the step rather than what the
 * log says: the status the shell recorded, and for an artifact-producing step,
 * whether the artifact is there. Keeping observation out of this module is what
 * lets the whole contract be tested without a filesystem.
 */
function assessStep({ step, status, exitCode, counts = null, evidence = {} }) {
  const contract = contractFor(step);
  if (contract == null) {
    return {
      step,
      kind: null,
      verdict: 'unverified',
      exitCode: exitCode ?? null,
      findings: [
        {
          code: 'STEP_UNCLASSIFIED',
          message:
            `${step}: the runner has a step with no declared contract, so what ` +
            'this step was supposed to produce is unknown. Classify it in ' +
            'tools/pms/step-contracts.js rather than letting it be judged by ' +
            'whichever rule happens to fire.',
        },
      ],
      counts: null,
    };
  }

  const kind = contract.kind;
  const required = evidenceFor(kind);

  // A step that did not run is not a step that passed. This is the finding that
  // keeps a partial run from reading as a whole one, and it is checked before
  // anything else so that no other rule can talk a skipped step into a verdict.
  if (status === 'skipped') {
    return {
      step,
      kind,
      verdict: 'unverified',
      exitCode: null,
      findings: [
        {
          code: 'STEP_SKIPPED',
          message: `${step}: the step did not run, so nothing about it is verified`,
        },
      ],
      counts: null,
    };
  }

  const findings = [];

  // The process's own answer, for every kind. A step that exited non-zero has
  // failed whatever kind it is, and reporting otherwise is the defect the
  // `complete` flag is meant to be able to rule out.
  if (exitCode == null) {
    findings.push({
      code: 'EXIT_CODE_MISSING',
      message:
        `${step}: no exit code was recorded. A step with no exit code has not ` +
        'been shown to have succeeded, and it is not reported as having done so.',
    });
  } else if (exitCode !== 0) {
    findings.push({
      code: 'EXIT_CODE_NONZERO',
      message: `${step}: exited ${exitCode}. The step did not do its work.`,
    });
  }

  // The shell's acceptance vocabulary is recorded, and deliberately NOT
  // cross-checked against the exit code here. `record_step` derives `status`
  // FROM the code, so the two cannot disagree, and a check that cannot fire is
  // the same defect as a counter that can never be non-zero: it reads as
  // coverage and is not. What DOES catch a swallowed exit code is the counts -
  // a Jest step whose tests failed while its wrapper reported success - and that
  // is `EXIT_CODE_DISAGREES` below, which is why it is not filtered.

  if (kind === 'test') {
    // The Phase C integrity rule, verbatim. `counts` is passed through as it
    // came off the log: a missing count line stays a missing count line, and
    // every rule that reads the three totals still reads them.
    //
    // Only `EXIT_CODE_MISSING` is taken from the block above, because this
    // module emits its own with wording that names the step's contract.
    // `EXIT_CODE_DISAGREES` passes through untouched - it is the finding that
    // catches a wrapper swallowing a real failure - as is every count finding.
    const suiteVerdict = assessSuiteIntegrity({ step, exitCode, counts });
    findings.push(
      ...suiteVerdict.findings.filter((f) => f.code !== 'EXIT_CODE_MISSING'),
    );
  }

  if (
    required?.requiresArtifact === true &&
    evidence.artifactPresent !== true
  ) {
    findings.push({
      code: 'ARTIFACT_MISSING',
      message:
        `${step}: the step exited ${exitCode} but ` +
        `${String(evidence.artifactPath ?? contract.artifact ?? 'its artifact')} is absent. This ` +
        "step's deliverable IS that artifact, so a run without it has not " +
        'been shown to have done the work the step exists to do.',
    });
  }

  // Counts are recorded only where they mean something. For a kind that does not
  // run tests they are null - not zero, and not whatever a build log happened
  // to contain.
  const recordCounts = required?.requiresCounts === true ? counts : null;

  return {
    step,
    kind,
    verdict: verdictFor(findings),
    exitCode: exitCode ?? null,
    findings,
    counts: recordCounts,
  };
}

module.exports = {
  FAILURE_CODES,
  KIND_EVIDENCE,
  STEP_CONTRACTS,
  assessStep,
  contractFor,
  evidenceFor,
};
