/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const {
  inventory,
  discovery,
  execution,
  catalog,
  outputDirectory,
} = require('./integrity');
const repo = path.resolve(__dirname, '../..');
const manifest = require('../../tests/semantic/inventory.json');
const { cases } = require('../../tests/semantic/cases');

function report(out) {
  const rows = cases.map((spec) => {
    const p = path.join(out, 'cases', spec.id + '.json');
    return fs.existsSync(p)
      ? JSON.parse(fs.readFileSync(p, 'utf8'))
      : {
          id: spec.id,
          area: spec.area,
          status: spec.status,
          failure: 'Case produced no execution report',
          classificationVerified: false,
        };
  });
  const preserve = rows.filter((c) => c.status === 'MUST_PRESERVE');
  function totals(field) {
    const applicable = preserve.filter(
      (c) => c[field] !== null && c[field] !== undefined,
    );
    return {
      applicable: applicable.length,
      passed: applicable.filter((c) => c[field] === true).length,
      failed: applicable.filter((c) => c[field] !== true).length,
    };
  }
  const revisions = preserve.flatMap((c) => c.revisions ?? []);
  function revisionTotals(field) {
    const applicable = revisions.filter(
      (r) => r[field] !== null && r[field] !== undefined,
    );
    return {
      applicable: applicable.length,
      passed: applicable.filter((r) => r[field] === true).length,
      failed: applicable.filter((r) => r[field] !== true).length,
    };
  }
  const result = {
    schemaVersion: 1,
    documentKind: 'pandamstyle-semantic-oracle',
    sourceMatchesTestedTree:
      execFileSync(
        'git',
        [
          'status',
          '--porcelain',
          '--',
          'tests/semantic/',
          'tools/semantic-oracle/',
          'tools/pms/',
          'verify-pms.sh',
          'docs/architecture/',
        ],
        { cwd: repo, encoding: 'utf8' },
      ).trim() === '',
    testedCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim(),
    testedTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim(),
    caseCount: rows.length,
    mustPreserveCount: preserve.length,
    knownGapCount: rows.filter((c) => c.status === 'KNOWN_GAP').length,
    deferredCount: rows.filter((c) => c.status === 'DEFERRED').length,
    failedCount: rows.filter((c) => !c.classificationVerified).length,
    unknownCount: rows.filter(
      (c) => !['MUST_PRESERVE', 'KNOWN_GAP', 'DEFERRED'].includes(c.status),
    ).length,
    mustPreserve: {
      freshVsExpected: totals('freshMatchesExpected'),
      incrementalVsExpected: totals('incrementalMatchesExpected'),
      freshVsIncremental: totals('freshMatchesIncremental'),
      revisions: {
        freshVsExpected: revisionTotals('freshMatchesExpected'),
        incrementalVsExpected: revisionTotals('incrementalMatchesExpected'),
        freshVsIncremental: revisionTotals('freshMatchesIncremental'),
      },
    },
    // Known gaps remain semantic mismatches; successful registration is not a pass.
    knownGapsAreSemanticPasses: false,
    cases: rows,
  };
  fs.writeFileSync(
    path.join(out, 'semantic-oracle.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  return result;
}

function run(out) {
  out = outputDirectory(repo, out);
  fs.mkdirSync(out, { recursive: true });
  fs.rmSync(path.join(out, 'semantic-oracle.json'), { force: true });
  fs.rmSync(path.join(out, 'cases'), { recursive: true, force: true });
  catalog(manifest, cases, repo);
  const expected = inventory(repo, manifest);
  fs.writeFileSync(
    path.join(out, 'semantic-inventory.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  const jest = path.join(repo, 'node_modules/jest/bin/jest.js');
  const args = [
    jest,
    '--config',
    path.join(__dirname, 'jest.config.js'),
    '--ci',
    '--runInBand',
  ];
  const listed = spawnSync(
    process.execPath,
    [...args, '--listTests', '--json'],
    { cwd: repo, encoding: 'utf8' },
  );
  if (listed.status !== 0)
    throw new Error('SEMANTIC_DISCOVERY_FAILED: ' + listed.stderr);
  discovery(expected, JSON.parse(listed.stdout));
  const json = path.join(out, 'semantic-jest-results.json');
  fs.rmSync(json, { force: true });
  const result = spawnSync(
    process.execPath,
    [...args, '--json', '--outputFile', json],
    {
      cwd: repo,
      stdio: 'inherit',
      env: { ...process.env, PMS_SEMANTIC_REPORT_DIR: out },
    },
  );
  const data = report(out);
  if (result.status !== 0) return result.status ?? 1;
  const counts = execution(
    repo,
    manifest,
    JSON.parse(fs.readFileSync(json, 'utf8')),
  );
  data.execution = counts;
  fs.writeFileSync(
    path.join(out, 'semantic-oracle.json'),
    JSON.stringify(data, null, 2) + '\n',
  );
  if (data.failedCount !== 0 || data.unknownCount !== 0)
    throw new Error('SEMANTIC_ORACLE_NOT_QUALIFIED');
  return 0;
}
if (require.main === module) {
  try {
    process.exitCode = run(
      path.resolve(
        process.argv[2] ?? path.join(repo, '.pms-bench/semantic-development'),
      ),
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
module.exports = { run, report };
