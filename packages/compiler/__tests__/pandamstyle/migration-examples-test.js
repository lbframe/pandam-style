/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * CE-02.2 (#47) AC3: the executable migration examples M1-M5 and M7
 * (fixtures/ce022-migrations/examples.json), run by
 * tools/policy/migration-examples.mjs through the public Project Service.
 *
 * The CE-02.2 side (the refusal, its rule, reason, canonical spelling or
 * candidates, and the repaired output) always runs against the workspace
 * build. The baselines need installed compilers outside the repository:
 *
 *   PMS_ALPHA1_CLOSURE  the CE-00.3 alpha1 store closure (digest-verified)
 *   PMS_CE021_PACK      a CE-02.1 candidate pack of b1b2ab4 (#132 merged)
 *
 * Without them, the baseline checks (the `before` outcome and every
 * byte-equality with the baseline) are skipped loudly: the suite prints the
 * skipped checks and their reason, and the tool reports each one.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '../../../..');
const examples = require('./fixtures/ce022-migrations/examples.json');

function runTool() {
  const args = [path.join(REPO, 'tools/policy/migration-examples.mjs')];
  if (process.env.PMS_ALPHA1_CLOSURE) {
    args.push('--alpha1', process.env.PMS_ALPHA1_CLOSURE);
  }
  if (process.env.PMS_CE021_PACK) {
    args.push('--ce021', process.env.PMS_CE021_PACK);
  }
  const result = spawnSync(process.execPath, args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status === 2) throw new Error(result.stderr);
  return { status: result.status, report: JSON.parse(result.stdout) };
}

const { status, report } = runTool();
const baselinesGiven = {
  alpha1: Boolean(process.env.PMS_ALPHA1_CLOSURE),
  ce021: Boolean(process.env.PMS_CE021_PACK),
};
if (report.skipped.length > 0) {
  // eslint-disable-next-line no-console
  console.warn(
    `CE-02.2 migration examples: ${report.skipped.length} baseline checks SKIPPED (set PMS_ALPHA1_CLOSURE and PMS_CE021_PACK to run them):\n  ${report.skipped.join('\n  ')}`,
  );
}

describe('CE-02.2 migration examples', () => {
  test('cover M1-M5 and M7 against their stated baselines', () => {
    expect(examples.examples.map((e) => [e.id, e.baseline])).toEqual([
      ['M1', 'alpha1'],
      ['M2', 'alpha1'],
      ['M3', 'alpha1'],
      ['M4', 'ce021'],
      ['M5-margin', 'alpha1'],
      ['M5-padding', 'alpha1'],
      ['M7', 'ce021'],
    ]);
  });

  test('no check fails', () => {
    expect(report.failures).toEqual([]);
    expect(status).toBe(0);
  });

  test.each(report.results.map((r) => [r.id, r]))(
    '%s: the CE-02.2 side ran',
    (_, result) => {
      const ce022 = result.checks.filter(
        (c) => c.step !== 'before' && c.skipped == null,
      );
      expect(ce022.length).toBeGreaterThan(0);
      expect(ce022.every((c) => c.ok === true)).toBe(true);
    },
  );

  test.each(report.results.map((r) => [r.id, r]))(
    '%s: the baseline ran when given, and is skipped with a reason otherwise',
    (_, result) => {
      const before = result.checks.filter((c) => c.step === 'before');
      if (baselinesGiven[result.baseline]) {
        expect(result.baselineIdentity).not.toBe(null);
        expect(before.every((c) => c.ok === true)).toBe(true);
        expect(result.checks.some((c) => c.skipped != null)).toBe(false);
      } else {
        expect(before).toEqual([
          expect.objectContaining({ skipped: expect.any(String) }),
        ]);
      }
    },
  );
});
