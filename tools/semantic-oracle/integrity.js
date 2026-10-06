/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { isDeepStrictEqual } = require('util');

function outputDirectory(repo, out) {
  const absolute = path.resolve(out);
  const allowed = ['evidence', '.pms-bench'].some((name) =>
    absolute.startsWith(path.join(repo, name) + path.sep),
  );
  if (!allowed) throw new Error('SEMANTIC_OUTPUT_PROTECTS_EXPECTATIONS');
  for (let cursor = absolute; cursor !== repo; cursor = path.dirname(cursor)) {
    if (fs.existsSync(cursor) && fs.realpathSync(cursor) !== cursor)
      throw new Error('SEMANTIC_OUTPUT_SYMLINK_REJECTED');
  }
  return absolute;
}

function inventory(repo, manifest) {
  const expected = Object.keys(manifest.suites)
    .map((p) => path.join(repo, p))
    .sort();
  if (!expected.length) throw new Error('SEMANTIC_ZERO_SUITES');
  const tracked = spawnSync(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--',
      'tests/semantic/',
      'tools/semantic-oracle/',
    ],
    { cwd: repo, encoding: 'utf8' },
  );
  if (tracked.status !== 0)
    throw new Error('SEMANTIC_TRACKED_INVENTORY_FAILED');
  for (const p of [
    ...tracked.stdout.split('\0').filter(Boolean),
    ...Object.keys(manifest.suites),
  ]) {
    if (!fs.existsSync(path.join(repo, p)))
      throw new Error('SEMANTIC_TRACKED_ASSET_MISSING: ' + p);
  }
  const disk = fs
    .readdirSync(path.join(repo, 'tests/semantic/__tests__'))
    .filter((p) => p.endsWith('-test.js'))
    .map((p) => path.join(repo, 'tests/semantic/__tests__', p))
    .sort();
  if (!isDeepStrictEqual(expected, disk))
    throw new Error('SEMANTIC_INVENTORY_DISAGREES');
  return expected;
}
function discovery(expected, actual) {
  if (!isDeepStrictEqual([...expected].sort(), [...actual].sort()))
    throw new Error('SEMANTIC_DISCOVERY_DISAGREES');
}
function execution(repo, manifest, report) {
  const expected = Object.keys(manifest.suites).sort();
  const actual = report.testResults
    .map((s) => path.relative(repo, s.name))
    .sort();
  discovery(expected, actual);
  if (
    report.numTotalTestSuites !== expected.length ||
    report.numPassedTestSuites !== expected.length ||
    report.numFailedTestSuites !== 0 ||
    report.numPendingTestSuites !== 0
  )
    throw new Error('SEMANTIC_SUITES_UNACCOUNTED_OR_FAILED');
  let tests = 0;
  for (const result of report.testResults) {
    const contract = manifest.suites[path.relative(repo, result.name)];
    const ids = contract.caseIds;
    const actualIds = result.assertionResults
      .map((t) => t.title.split(' — ')[0])
      .sort();
    if (!isDeepStrictEqual([...ids].sort(), actualIds))
      throw new Error('SEMANTIC_TESTS_UNACCOUNTED: ' + result.name);
    if (
      result.status !== 'passed' ||
      result.assertionResults.some((t) => t.status !== 'passed')
    )
      throw new Error('SEMANTIC_SUITE_FAILED_OR_SKIPPED: ' + result.name);
    tests += ids.length;
  }
  if (
    !tests ||
    report.numTotalTests !== tests ||
    report.numPassedTests !== tests ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0 ||
    report.success !== true
  )
    throw new Error('SEMANTIC_TEST_TOTALS_DISAGREE');
  return { tests, suites: expected.length };
}
function catalog(manifest, cases, repo) {
  const expected = Object.values(manifest.suites)
    .flatMap((s) => (s.area === 'harness-integrity' ? [] : s.caseIds))
    .sort();
  const ids = cases.map((c) => c.id).sort();
  if (new Set(ids).size !== ids.length || !isDeepStrictEqual(expected, ids))
    throw new Error('SEMANTIC_CASE_POPULATION_DISAGREES');
  for (const spec of cases) {
    if (
      spec.schemaVersion !== 1 ||
      !['MUST_PRESERVE', 'KNOWN_GAP', 'DEFERRED'].includes(spec.status) ||
      !spec.title ||
      !spec.intent ||
      !Array.isArray(spec.contractReferences) ||
      !spec.contractReferences.length
    )
      throw new Error('SEMANTIC_CASE_SCHEMA_INVALID: ' + spec.id);
    if (
      Object.values(manifest.suites).find((s) => s.caseIds.includes(spec.id))
        ?.area !== spec.area
    )
      throw new Error('SEMANTIC_AREA_DISAGREES: ' + spec.id);
    for (const reference of spec.contractReferences)
      if (!fs.existsSync(path.join(repo, reference)))
        throw new Error('SEMANTIC_CONTRACT_MISSING: ' + reference);
    if (spec.status === 'DEFERRED') {
      if (
        spec.freshApplicable ||
        spec.incrementalApplicable ||
        spec.revisions.length ||
        !spec.contractReferences.includes(
          'docs/architecture/adr/0003-authoring-api.md',
        )
      )
        throw new Error('SEMANTIC_DEFERRED_WITHOUT_DECISION: ' + spec.id);
    } else {
      if (
        !spec.revisions.length ||
        (!spec.freshApplicable && !spec.incrementalApplicable)
      )
        throw new Error('SEMANTIC_CASE_NOT_EXECUTABLE: ' + spec.id);
      for (const step of spec.revisions)
        if (!step.expected.length)
          throw new Error('SEMANTIC_EXPECTATION_MISSING: ' + spec.id);
      if (
        spec.status === 'KNOWN_GAP' &&
        (!spec.gapId || !spec.gapReason || !spec.targetMismatchPaths.length)
      )
        throw new Error('SEMANTIC_GAP_UNBOUNDED: ' + spec.id);
      if (spec.status === 'KNOWN_GAP') {
        const register = fs.readFileSync(
          path.join(repo, 'docs/architecture/semantic-gap-register.md'),
          'utf8',
        );
        if (
          !register.includes(spec.gapId) ||
          !register.includes('`' + spec.id + '`')
        )
          throw new Error('SEMANTIC_GAP_UNREGISTERED: ' + spec.id);
      }
    }
  }
  return { caseCount: ids.length };
}
module.exports = { inventory, discovery, execution, catalog, outputDirectory };
