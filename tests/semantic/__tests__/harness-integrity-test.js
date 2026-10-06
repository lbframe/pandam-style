/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';
const path = require('path');
const { evaluate } = require('../harness/assertions');
const {
  project,
  comparisonView,
  ruleProjection,
} = require('../harness/projection');
const {
  catalog,
  discovery,
  execution,
  inventory,
} = require('../../../tools/semantic-oracle/integrity');
const manifest = require('../inventory.json');
const { cases } = require('../cases');
const repo = path.resolve(__dirname, '../../..');
const expected = [{ path: 'accepted', value: false }];
const smallManifest = { suites: { 'suite.js': { caseIds: ['a'] } } };
function report() {
  return {
    numTotalTestSuites: 1,
    numPassedTestSuites: 1,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: 1,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    success: true,
    testResults: [
      {
        name: path.join(repo, 'suite.js'),
        status: 'passed',
        assertionResults: [{ title: 'a', status: 'passed' }],
      },
    ],
  };
}
function raw() {
  return {
    accepted: true,
    codes: [],
    diagnostics: [],
    css: { rules: [], variables: {}, themes: {} },
    artifactBytes: {},
    publication: { exists: true },
    manifest: {},
    revisionId: 1,
  };
}
test('independence.fresh-only-bug', () => {
  expect(evaluate({ accepted: true }, expected)[0].matches).toBe(false);
  expect(evaluate({ accepted: false }, expected)[0].matches).toBe(true);
});
test('independence.both-same-bug', () => {
  const fresh = { accepted: true };
  const incremental = { accepted: true };
  expect(fresh).toEqual(incremental);
  expect(evaluate(fresh, expected)[0].matches).toBe(false);
  expect(evaluate(incremental, expected)[0].matches).toBe(false);
});
test('projection.cascade-order', () => {
  const a = raw();
  a.css.rules = [
    { selector: '.a:hover', conditions: [], declarations: [['color', 'red']] },
    { selector: '.b:focus', conditions: [], declarations: [['color', 'blue']] },
  ];
  const b = structuredClone(a);
  b.css.rules.reverse();
  expect(comparisonView(project(a))).not.toEqual(comparisonView(project(b)));
});
test('projection.token-identity', () => {
  const css = {
    variables: { '--a': 'colors.a', '--b': 'colors.b' },
    themes: {},
  };
  const a = ruleProjection(
    { selector: '.x', conditions: [], declarations: [['color', 'var(--a)']] },
    css,
  );
  const b = ruleProjection(
    { selector: '.x', conditions: [], declarations: [['color', 'var(--b)']] },
    css,
  );
  expect(a).not.toEqual(b);
});
test('projection.theme-identity', () => {
  const css = { variables: {}, themes: { a: ['light'], b: ['dark'] } };
  expect(
    ruleProjection({ selector: '.a', conditions: [], declarations: [] }, css),
  ).not.toEqual(
    ruleProjection({ selector: '.b', conditions: [], declarations: [] }, css),
  );
});
test('projection.location', () => {
  const a = raw();
  a.diagnostics = [
    {
      code: 'PMS_FORBIDDEN_VALUE',
      source: 'src/a.js',
      location: { file: 'src/a.js', line: 2, column: 3, role: 'page' },
    },
  ];
  const b = structuredClone(a);
  b.diagnostics[0].location.column = 4;
  expect(comparisonView(project(a))).not.toEqual(comparisonView(project(b)));
});
test('assertions.unknown-op', () =>
  expect(() => evaluate({}, [{ path: 'x', op: 'record' }])).toThrow(
    'Unknown semantic assertion',
  ));
test('inventory.catalog', () =>
  expect(catalog(manifest, cases, repo).caseCount).toBe(135));
test('expectations.output-protected', () => {
  const {
    outputDirectory,
  } = require('../../../tools/semantic-oracle/integrity');
  expect(() =>
    outputDirectory(repo, path.join(repo, 'tests/semantic')),
  ).toThrow('SEMANTIC_OUTPUT_PROTECTS_EXPECTATIONS');
  expect(() =>
    outputDirectory(repo, path.join(repo, 'tests/semantic/expectations')),
  ).toThrow('SEMANTIC_OUTPUT_PROTECTS_EXPECTATIONS');
});
test('inventory.unknown-status', () => {
  const invalid = cases.map((spec) => ({ ...spec }));
  invalid[0].status = 'UNKNOWN';
  expect(() => catalog(manifest, invalid, repo)).toThrow(
    'SEMANTIC_CASE_SCHEMA_INVALID',
  );
});
test('inventory.missing-case', () =>
  expect(() => catalog(manifest, cases.slice(1), repo)).toThrow(
    'SEMANTIC_CASE_POPULATION_DISAGREES',
  ));
test('inventory.discovery', () =>
  expect(() => discovery(['a', 'b'], ['a'])).toThrow(
    'SEMANTIC_DISCOVERY_DISAGREES',
  ));
test('inventory.zero-suite', () =>
  expect(() => inventory(repo, { suites: {} })).toThrow(
    'SEMANTIC_ZERO_SUITES',
  ));
test('inventory.test-unaccounted', () => {
  const r = report();
  r.testResults[0].assertionResults = [];
  expect(() => execution(repo, smallManifest, r)).toThrow(
    'SEMANTIC_TESTS_UNACCOUNTED',
  );
});
test('inventory.suite-unaccounted', () => {
  const r = report();
  r.testResults = [];
  expect(() => execution(repo, smallManifest, r)).toThrow(
    'SEMANTIC_DISCOVERY_DISAGREES',
  );
});
test('inventory.suite-load-failure', () => {
  const r = report();
  r.numPassedTestSuites = 0;
  r.numFailedTestSuites = 1;
  expect(() => execution(repo, smallManifest, r)).toThrow(
    'SEMANTIC_SUITES_UNACCOUNTED_OR_FAILED',
  );
});
test('inventory.skipped-test', () => {
  const r = report();
  r.testResults[0].assertionResults[0].status = 'pending';
  expect(() => execution(repo, smallManifest, r)).toThrow(
    'SEMANTIC_SUITE_FAILED_OR_SKIPPED',
  );
});
test('inventory.zero-test', () => {
  const r = report();
  r.numTotalTests = 0;
  expect(() => execution(repo, smallManifest, r)).toThrow(
    'SEMANTIC_TEST_TOTALS_DISAGREE',
  );
});
test('gaps.phase-2-runtime-guard-promoted-with-target-intact', () => {
  const gap = cases.find((c) => c.id === 'props.runtime-malformed');
  expect(gap.status).toBe('MUST_PRESERVE');
  expect(gap.gapId).toBeUndefined();
  expect(
    gap.revisions[0].expected.find((c) => c.path === 'runtimeGuard').value,
  ).toEqual({ rejected: true, code: 'PMS_UNVERIFIED_PROPS_SOURCE' });
  expect(gap.revisions[0].observed).toBeUndefined();
});
