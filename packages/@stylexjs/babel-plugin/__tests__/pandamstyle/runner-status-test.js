/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

jest.autoMockOff();

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const RUNNER = path.join(REPO_ROOT, 'verify-pms.sh');

jest.setTimeout(120000);

/**
 * The runner refuses an output directory outside the repository, so the test's
 * run directory is a real directory inside it, removed afterwards.
 */
function runRunner(env = {}) {
  const outDir = fs.mkdtempSync(path.join(REPO_ROOT, '.pms-runner-test-'));
  try {
    const result = spawnSync('bash', [RUNNER], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PMS_OUT_DIR: outDir,
        PMS_ONLY_STEPS: 'summary',
        ...env,
      },
    });
    const summaryPath = path.join(outDir, 'summary.json');
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      summary: fs.existsSync(summaryPath)
        ? JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
        : null,
      stepsTsv: fs.existsSync(path.join(outDir, 'steps.tsv'))
        ? fs.readFileSync(path.join(outDir, 'steps.tsv'), 'utf8')
        : null,
    };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

describe('BC-7: an unexecuted step is never reported as passed', () => {
  let result;

  beforeAll(() => {
    result = runRunner({
      PMS_SKIP_INSTALL: '1',
      PMS_SKIP_PILOT: '1',
    });
  });

  test('the runner itself succeeded, so only the bookkeeping is under test', () => {
    expect(result.status).toBe(0);
    expect(result.summary).not.toBeNull();
  });

  test('a skipped pilot is reported as skipped', () => {
    expect(result.summary.steps.pilot.status).toBe('skipped');
  });

  test('a skipped install is reported as skipped', () => {
    expect(result.summary.steps.install.status).toBe('skipped');
  });

  test('a skipped step has NO exit code', () => {
    // This is the precise defect: `exitCode: 0` on a step that never ran.
    for (const name of ['pilot', 'install']) {
      expect(result.summary.steps[name].exitCode).toBeNull();
    }
  });

  test('the acceptance vocabulary says not_run, not passed', () => {
    for (const name of ['pilot', 'install']) {
      expect(result.summary.steps[name].acceptance).toBe('not_run');
    }
  });

  test('no step is marked passed in this run', () => {
    const passed = Object.entries(result.summary.steps)
      .filter(([, v]) => v.status === 'passed')
      .map(([k]) => k);
    expect(passed).toEqual([]);
  });

  test('the run is explicitly not complete', () => {
    expect(result.summary.complete).toBe(false);
    expect(result.summary.skippedSteps).toEqual(
      expect.arrayContaining(['pilot', 'install']),
    );
    expect(result.summary.failedSteps).toEqual([]);
  });

  test('the console says INCOMPLETE and names the skipped steps', () => {
    expect(result.stdout).toContain('VERIFICATION INCOMPLETE');
    expect(result.stdout).toContain('NOT a complete verification');
    expect(result.stdout).not.toContain('VERIFICATION OK');
  });

  test('the raw step table records the status too', () => {
    // steps.tsv is what a human reads; it must not disagree with summary.json.
    const lines = result.stepsTsv
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => l.split('\t'));
    const pilot = lines.find((l) => l[0] === 'pilot');
    expect(pilot[1]).toBe('skipped');
    expect(pilot[2]).toBe('-');
  });
});

describe('the skip flag is not the only way a step goes unrun', () => {
  let result;

  beforeAll(() => {
    // No PMS_SKIP_* at all: the steps are unrun because PMS_ONLY_STEPS excluded
    // them. The runner must still say so, not default them to passed.
    result = runRunner({ PMS_SKIP_INSTALL: '', PMS_SKIP_PILOT: '' });
  });

  test('a step excluded by the filter is skipped, with the reason', () => {
    expect(result.summary.steps.build.status).toBe('skipped');
    expect(result.summary.steps.build.note).toMatch(/PMS_ONLY_STEPS/);
  });

  test('the reason distinguishes a skip from a filter exclusion', () => {
    expect(result.summary.steps.pilot.note).toMatch(/PMS_ONLY_STEPS/);
    expect(result.summary.steps.pilot.note).not.toMatch(/PMS_SKIP_PILOT/);
  });
});
