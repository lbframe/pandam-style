/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { isDeepStrictEqual } = require('util');
const { evaluate } = require('./assertions');
const { comparisonView } = require('./projection');

function execute(spec, lane, dir) {
  if (!spec[lane + 'Applicable']) return null;
  const output = path.join(dir, lane + '.json');
  const child = spawnSync(
    process.execPath,
    [path.join(__dirname, 'worker.js'), spec.id, lane, output],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 4, timeout: 60000 },
  );
  assert.strictEqual(
    child.status,
    0,
    `${spec.id}/${lane} failed to execute:\n${child.stderr}\n${child.stdout}`,
  );
  return JSON.parse(fs.readFileSync(output, 'utf8'));
}

function runCase(spec, reportDir = process.env.PMS_SEMANTIC_REPORT_DIR) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-oracle-results-'));
  let report;
  try {
    if (spec.status === 'DEFERRED') {
      assert(
        spec.contractReferences.includes(
          'docs/architecture/adr/0003-authoring-api.md',
        ),
      );
      assert.strictEqual(spec.freshApplicable, false);
      assert.strictEqual(spec.incrementalApplicable, false);
      report = {
        id: spec.id,
        area: spec.area,
        status: spec.status,
        fresh: null,
        incremental: null,
        freshMatchesExpected: null,
        incrementalMatchesExpected: null,
        freshMatchesIncremental: null,
        revisions: [],
        contractReferences: spec.contractReferences,
        classificationVerified: true,
      };
      return report;
    }
    const fresh = execute(spec, 'fresh', temp);
    const incremental = execute(spec, 'incremental', temp);
    const revisions = spec.revisions.map((step, i) => {
      function assess(lane, results) {
        if (!results) return null;
        const checks = [
          ...step.expected,
          ...(step[lane + 'Expected'] ?? []),
          ...(step.checks ?? []),
          ...(lane === 'incremental'
            ? [{ path: 'revisionId', value: i + spec.initialRevision }]
            : []),
        ];
        return evaluate(results[i], checks, results);
      }
      const freshChecks = assess('fresh', fresh);
      const incrementalChecks = assess('incremental', incremental);
      const equal =
        fresh && incremental
          ? isDeepStrictEqual(
              comparisonView(fresh[i]),
              comparisonView(incremental[i]),
            )
          : null;
      return {
        revision: i + 1,
        label: step.label,
        fresh: fresh?.[i] ?? null,
        incremental: incremental?.[i] ?? null,
        freshChecks,
        incrementalChecks,
        freshMatchesExpected: freshChecks?.every((c) => c.matches) ?? null,
        incrementalMatchesExpected:
          incrementalChecks?.every((c) => c.matches) ?? null,
        freshMatchesIncremental: equal,
      };
    });
    report = {
      id: spec.id,
      area: spec.area,
      status: spec.status,
      gapId: spec.gapId ?? null,
      fresh: fresh ? { applicable: true } : null,
      incremental: incremental ? { applicable: true } : null,
      freshMatchesExpected: fresh
        ? revisions.every((r) => r.freshMatchesExpected)
        : null,
      incrementalMatchesExpected: incremental
        ? revisions.every((r) => r.incrementalMatchesExpected)
        : null,
      freshMatchesIncremental:
        fresh && incremental
          ? revisions.every((r) => r.freshMatchesIncremental)
          : null,
      revisions,
      contractReferences: spec.contractReferences,
      classificationVerified: false,
    };
    const mismatches = revisions.flatMap((r) =>
      ['fresh', 'incremental'].flatMap((lane) =>
        (r[lane + 'Checks'] ?? [])
          .filter((c) => !c.matches)
          .map((c) => ({ revision: r.revision, lane, ...c })),
      ),
    );
    if (spec.status === 'MUST_PRESERVE') {
      assert.deepStrictEqual(
        mismatches,
        [],
        `${spec.id} differs from authored expectations: ${JSON.stringify(mismatches)}`,
      );
      assert(
        revisions.every((r) => r.freshMatchesIncremental !== false),
        `${spec.id}: fresh differs from incremental`,
      );
    } else {
      assert(spec.status === 'KNOWN_GAP' && spec.gapId && spec.gapReason);
      const allowed = spec.targetMismatchPaths;
      assert(
        mismatches.length > 0,
        `${spec.id}: target now matches; requires explicit review and MUST_PRESERVE promotion`,
      );
      assert(
        mismatches.every((m) => allowed.includes(m.path)),
        `${spec.id}: mismatch outside registered gap: ${JSON.stringify(mismatches)}`,
      );
      for (const row of revisions) {
        if (row.freshMatchesIncremental !== false) continue;
        const a = comparisonView(row.fresh),
          b = comparisonView(row.incremental);
        const differences = Object.keys(a).filter(
          (key) => !isDeepStrictEqual(a[key], b[key]),
        );
        assert(
          differences.every((key) =>
            (spec.comparisonMismatchPaths ?? []).includes(key),
          ),
          `${spec.id}: fresh/incremental difference outside registered gap: ${differences}`,
        );
      }
      for (let i = 0; i < revisions.length; i++) {
        for (const lane of ['fresh', 'incremental']) {
          const results = lane === 'fresh' ? fresh : incremental;
          if (!results) continue;
          const observed =
            spec.revisions[i][lane + 'Observed'] ??
            spec.revisions[i].observed ??
            [];
          assert(
            observed.length > 0,
            `${spec.id}: observed current evidence required for ${lane}`,
          );
          assert(
            evaluate(results[i], observed, results).every((c) => c.matches),
            `${spec.id}: registered current mismatch changed in ${lane}`,
          );
        }
      }
    }
    report.classificationVerified = true;
    return report;
  } catch (error) {
    if (report) report.failure = error.message;
    throw error;
  } finally {
    if (reportDir && report) {
      fs.mkdirSync(path.join(reportDir, 'cases'), { recursive: true });
      fs.writeFileSync(
        path.join(reportDir, 'cases', spec.id + '.json'),
        JSON.stringify(report, null, 2) + '\n',
      );
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
module.exports = { runCase };
