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
const { execFileSync } = require('child_process');
const { inventory } = require('../../semantic-oracle/integrity');
const { assessStep } = require('../step-contracts');

test.each(['disk deletion', 'index deletion'])(
  '%s cannot shrink the tracked semantic suite population',
  (mode) => {
    const repo = fs.mkdtempSync(
      path.join(os.tmpdir(), 'pms-semantic-inventory-'),
    );
    const relative = 'tests/semantic/__tests__/a-test.js';
    const manifest = {
      suites: { [relative]: { area: 'tokens', caseIds: ['token.a'] } },
    };
    const git = (...args) =>
      execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    try {
      fs.mkdirSync(path.join(repo, 'tests/semantic/__tests__'), {
        recursive: true,
      });
      fs.writeFileSync(path.join(repo, relative), '// tracked suite\n');
      git('init', '-q');
      git('add', relative);
      if (mode === 'index deletion') git('rm', '--cached', relative);
      fs.rmSync(path.join(repo, relative));
      expect(() => inventory(repo, manifest)).toThrow(
        'SEMANTIC_TRACKED_ASSET_MISSING',
      );
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  },
);

test('an unclassified oracle step cannot fall back to command acceptance', () => {
  const result = assessStep({
    step: 'semantic-oracle-unclassified',
    status: 'passed',
    exitCode: 0,
  });
  expect(result.verdict).toBe('unverified');
  expect(result.findings[0].code).toBe('STEP_UNCLASSIFIED');
});

test('the official oracle requires real suite counts', () => {
  const result = assessStep({
    step: 'semantic-oracle',
    status: 'passed',
    exitCode: 0,
  });
  expect(result.kind).toBe('test');
  expect(result.verdict).toBe('failed');
  expect(result.findings.map((f) => f.code)).toContain('COUNTS_MISSING');
});
