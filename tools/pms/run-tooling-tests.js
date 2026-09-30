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
const { globSync } = require('glob');

// Repository qualification only. Nothing in the compiler/runtime imports this.
function runToolingTests(repoRoot, outDir) {
  const testDir = path.join(repoRoot, 'tools/pms/__tests__');
  const expected = globSync('**/*-test.js', {
    cwd: testDir,
    absolute: true,
    nodir: true,
  }).sort();
  fs.writeFileSync(
    path.join(outDir, 'tooling-inventory.json'),
    JSON.stringify(
      expected.map((p) => path.relative(repoRoot, p)),
      null,
      2,
    ) + '\n',
  );
  if (expected.length === 0) {
    throw new Error('TOOLING_INVENTORY_EMPTY: no tooling suites found');
  }
  // A missing tracked suite must not redefine the expected population downward.
  // Git supplies the source inventory; new suites on disk still join the run.
  const tracked = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--', 'tools/pms/__tests__/'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
  if (tracked.error) throw tracked.error;
  if (tracked.status !== 0)
    throw new Error(
      'TOOLING_SOURCE_INVENTORY_FAILED: cannot inspect tracked tooling suites',
    );
  const missing = tracked.stdout
    .split('\0')
    .filter((p) => p.endsWith('-test.js'))
    .map((p) => path.join(repoRoot, p))
    .filter((p) => !expected.includes(p));
  if (missing.length !== 0) {
    throw new Error(
      `TOOLING_TRACKED_SUITE_MISSING: ${JSON.stringify(missing)}`,
    );
  }
  const jest = path.join(repoRoot, 'node_modules/jest/bin/jest.js');
  const args = [jest, '--runInBand', '--ci', 'tools/pms/__tests__'];
  const listed = spawnSync(
    process.execPath,
    [...args, '--listTests', '--json'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
  if (listed.error) throw listed.error;
  if (listed.status !== 0) {
    process.stderr.write(listed.stderr ?? '');
    throw new Error(`TOOLING_DISCOVERY_FAILED: Jest exit ${listed.status}`);
  }
  const discovered = JSON.parse(listed.stdout).sort();
  if (JSON.stringify(discovered) !== JSON.stringify(expected)) {
    throw new Error(
      `TOOLING_INVENTORY_DISAGREES: expected ${JSON.stringify(expected)}, discovered ${JSON.stringify(discovered)}`,
    );
  }
  const reportPath = path.join(outDir, 'tooling-jest-results.json');
  // Never accept a stale report from an earlier run in the same output folder.
  fs.rmSync(reportPath, { force: true });
  const result = spawnSync(
    process.execPath,
    [...args, '--json', '--outputFile', reportPath],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) return result.status ?? 1;
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const executed = report.testResults.map((s) => s.name).sort();
  if (
    JSON.stringify(executed) !== JSON.stringify(expected) ||
    report.numTotalTestSuites !== expected.length ||
    report.numPassedTestSuites !== expected.length ||
    report.numFailedTests !== 0 ||
    report.success !== true
  ) {
    throw new Error(
      'TOOLING_EXECUTION_INCOMPLETE: Jest did not pass the intended suite population',
    );
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = runToolingTests(
      path.resolve(__dirname, '../..'),
      process.argv[2],
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = { runToolingTests };
