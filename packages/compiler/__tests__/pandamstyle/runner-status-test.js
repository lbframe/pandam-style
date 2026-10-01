/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

jest.autoMockOff();

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
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

/* ------------------------------------------------------------------------- *
 * The two evidence-integrity defects, tested against a throwaway repository.
 *
 * A fixture repository is used rather than this one because both properties are
 * about the state the runner *finds*. Asserting them here would be circular:
 * the checkout running the suite is already dirty (the suite's own files), and
 * its branch topology is fixed by the batch under test. The fixture below is a
 * real Git repository with a real branch topology, small enough to build in
 * milliseconds and to know exactly what its state is.
 * ------------------------------------------------------------------------- */

const FIXTURE_BASE_REF = 'feat/pandamstyle-native-compiler';

function git(cwd, ...args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (${result.status}): ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function commit(cwd, name) {
  fs.writeFileSync(path.join(cwd, name), `${name}\n`);
  git(cwd, 'add', name);
  git(cwd, 'commit', '-q', '-m', `add ${name}`);
  return git(cwd, 'rev-parse', 'HEAD');
}

/**
 * A Git repository the runner can be pointed at. verify-pms.sh resolves the
 * repository from its own location, so a copy of the script makes the fixture
 * the root.
 *
 * Two properties of the fixture are deliberate:
 *
 * - The base branch diverges, so the batch base is a fork point reachable only
 *   through a merge base, never through a position counted back from HEAD.
 * - The run directory is TRACKED and already holds a committed `run.log`, which
 *   is what the real repository looks like. The runner truncates that log, and
 *   Git reports a change to a tracked file regardless of .gitignore. This is
 *   the mechanism behind the original defect, so a fixture without it could
 *   not detect it: an untracked run directory would stay invisible to
 *   `git status` until real files landed in it, long after the measurement.
 *
 * The checkout is left genuinely clean: every file is committed, so "clean" is
 * a state the fixture can actually be in.
 */
function makeFixture() {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pms-runner-fixture-')),
  );
  git(dir, 'init', '-q', '-b', 'main');
  // The runner hashes the lockfile; a missing one would silently yield an
  // empty digest.
  fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
  git(dir, 'add', 'yarn.lock');
  git(dir, 'commit', '-q', '-m', 'lockfile');

  // The source branch forks here and never moves again.
  git(dir, 'branch', FIXTURE_BASE_REF);
  const forkPoint = git(dir, 'rev-parse', 'HEAD');

  const batchCommits = ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((n) =>
    commit(dir, n),
  );
  fs.copyFileSync(RUNNER, path.join(dir, 'verify-pms.sh'));
  // The runner now reads its Jest counts through `tools/pms/test-counts.js` and
  // judges each step through `tools/pms/step-contracts.js`, rather than parsing
  // them inline. Those files are part of the runner's SOURCE, not helpers the
  // fixture happens to need: without them the summary block throws, and a runner
  // that silently produced no summary would be worse than the inline parser it
  // replaced.
  //
  // They are DERIVED from the runner's own text rather than listed here. A list
  // is a second place to remember, and the day a third module is added the list
  // is what is forgotten - with the failure surfacing as `summary: null` in an
  // unrelated-looking assertion, which is exactly how this was found.
  fs.mkdirSync(path.join(dir, 'tools', 'pms'), { recursive: true });
  const runnerSource = fs.readFileSync(RUNNER, 'utf8');
  const required = [
    ...new Set(
      [...runnerSource.matchAll(/tools\/pms\/([\w.-]+\.js)/g)].map((m) => m[1]),
    ),
  ];
  expect(required.length).toBeGreaterThan(0);
  for (const name of required) {
    // Resolved from the RUNNER's own location rather than from this test's, so
    // the two stay together if the runner ever moves.
    fs.copyFileSync(
      path.resolve(path.dirname(RUNNER), 'tools', 'pms', name),
      path.join(dir, 'tools', 'pms', name),
    );
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'runner sources');

  // A committed run directory, mirroring evidence/<run>/ in the real checkout.
  fs.mkdirSync(path.join(dir, 'evidence'));
  fs.writeFileSync(path.join(dir, 'evidence', 'run.log'), 'seed\n');
  fs.writeFileSync(path.join(dir, 'evidence', 'REPORT.md'), '# seed\n');
  git(dir, 'add', 'evidence');
  git(dir, 'commit', '-q', '-m', 'seed run directory');

  return { dir, forkPoint, batchCommits, outDir: path.join(dir, 'evidence') };
}

/** Returns the fixture to a known-clean checkout, as a fresh clone would be. */
function resetFixture(fixture) {
  git(fixture.dir, 'checkout', '-q', '--', '.');
  git(fixture.dir, 'clean', '-qfdx');
  return git(fixture.dir, 'status', '--porcelain');
}

/**
 * Runs the runner inside the fixture with every heavy step filtered out, so the
 * run exercises the evidence bookkeeping only. The run directory is a tracked
 * directory inside the checkout, so the runner's own writes are visible to
 * `git status` and the ordering of the measurement is observable.
 */
function runFixture(fixture, env = {}) {
  const outDir = fixture.outDir;
  const result = spawnSync('bash', [path.join(fixture.dir, 'verify-pms.sh')], {
    cwd: fixture.dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PMS_OUT_DIR: outDir,
      PMS_ONLY_STEPS: 'summary',
      PMS_BATCH_BASE_REF: FIXTURE_BASE_REF,
      ...env,
    },
  });
  const read = (name) => {
    const p = path.join(outDir, name);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  };
  return {
    outDir,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    env: read('env.json'),
    summary: read('summary.json'),
  };
}

let fixture;

beforeAll(() => {
  fixture = makeFixture();
});

afterAll(() => {
  if (fixture) fs.rmSync(fixture.dir, { recursive: true, force: true });
});

describe('the working tree is measured before the runner writes anything', () => {
  let result;
  let cleanBefore;

  beforeAll(() => {
    cleanBefore = resetFixture(fixture);
    result = runFixture(fixture);
  });

  test('the fixture really was a clean checkout before the run', () => {
    // Otherwise the assertions below would prove nothing about the runner.
    expect(cleanBefore).toBe('');
  });

  test('a clean checkout is reported clean in env.json', () => {
    // The defect: the runner truncated the tracked run.log and then measured
    // the tree it had just changed itself, so this read "dirty".
    expect(result.env).not.toBeNull();
    expect(result.env.workingTree).toBe('clean');
  });

  test('a clean checkout is reported clean in summary.json', () => {
    expect(result.summary).not.toBeNull();
    expect(result.summary.workingTree).toBe('clean');
  });

  test('the run really did change the checkout after measuring', () => {
    // Without this the assertions above could pass for the wrong reason: if
    // the runner wrote nothing, nothing could have been measured wrongly.
    expect(git(fixture.dir, 'status', '--porcelain')).not.toBe('');
  });

  test('the console names the measurement as taken before the run', () => {
    expect(result.stdout).toContain('before this run wrote anything');
  });
});

describe('a checkout that is already dirty is still reported dirty', () => {
  let result;

  beforeAll(() => {
    resetFixture(fixture);
    fs.writeFileSync(
      path.join(fixture.dir, 'a.txt'),
      'modified before the run\n',
    );
    result = runFixture(fixture);
  });

  afterAll(() => {
    resetFixture(fixture);
  });

  test('the fixture was genuinely dirty before the run', () => {
    expect(git(fixture.dir, 'status', '--porcelain')).not.toBe('');
  });

  test('a pre-existing modification is not laundered into clean', () => {
    expect(result.env.workingTree).toBe('dirty');
    expect(result.summary.workingTree).toBe('dirty');
  });
});

describe('the batch base is a Git relation, not a commit count', () => {
  let result;

  beforeAll(() => {
    resetFixture(fixture);
    result = runFixture(fixture);
  });

  test('the base is the merge base with the source branch', () => {
    // Computed here with Git, independently of the runner.
    const expected = git(fixture.dir, 'merge-base', 'HEAD', FIXTURE_BASE_REF);
    expect(result.env.pandamstyleBatchBase).toBe(expected);
    expect(result.summary.pandamstyleBatchBase).toBe(expected);
  });

  test('the base is the fork point, not a recent ancestor', () => {
    expect(result.env.pandamstyleBatchBase).toBe(fixture.forkPoint);
    // HEAD~1 was a commit of the batch. Any HEAD~N guess is refuted here.
    expect(result.env.pandamstyleBatchBase).not.toBe(
      fixture.batchCommits[fixture.batchCommits.length - 1],
    );
  });

  test('the ref the base was derived from is recorded', () => {
    expect(result.env.pandamstyleBatchBaseRef).toBe(FIXTURE_BASE_REF);
    expect(result.summary.pandamstyleBatchBaseRef).toBe(FIXTURE_BASE_REF);
  });

  test('the base is a real ancestor of both tips', () => {
    const base = result.env.pandamstyleBatchBase;
    expect(git(fixture.dir, 'merge-base', '--is-ancestor', base, 'HEAD')).toBe(
      '',
    );
    expect(
      git(fixture.dir, 'merge-base', '--is-ancestor', base, FIXTURE_BASE_REF),
    ).toBe('');
  });
});

describe('growing the batch does not move the base', () => {
  test('the same base is reported after two more commits', () => {
    // A HEAD~N implementation shifts when the branch grows; a merge base does
    // not. This is the property that makes the old count-based value wrong in
    // exactly the situation that produced the bad evidence.
    resetFixture(fixture);
    const before = runFixture(fixture);
    expect(before.env.pandamstyleBatchBase).toBe(fixture.forkPoint);

    const added = [commit(fixture.dir, 'e.txt'), commit(fixture.dir, 'f.txt')];
    const after = runFixture(fixture);

    try {
      expect(after.env.pandamstyleBatchBase).toBe(
        before.env.pandamstyleBatchBase,
      );
      // And it is still not a position counted back from the new HEAD.
      expect(after.env.pandamstyleBatchBase).not.toBe(added[added.length - 1]);
    } finally {
      resetFixture(fixture);
      git(fixture.dir, 'reset', '-q', '--hard', 'HEAD~2');
    }
  });
});

describe('an unverifiable base is refused rather than invented', () => {
  let result;
  let unusedDir;

  beforeAll(() => {
    resetFixture(fixture);
    // A run directory that must never be created: the refusal has to happen
    // before the runner writes anything at all.
    unusedDir = path.join(fixture.dir, 'never-created');
    result = runFixture(fixture, {
      PMS_OUT_DIR: unusedDir,
      PMS_BATCH_BASE_REF: 'no/such-branch',
    });
  });

  test('the runner fails instead of reporting a fallback SHA', () => {
    expect(result.status).toBe(2);
  });

  test('the refusal names the ref and says why', () => {
    expect(result.stderr).toContain('no/such-branch');
    expect(result.stderr).toMatch(/not a verified Git relation/);
  });

  test('no evidence is written, so no unverifiable SHA is left behind', () => {
    expect(fs.existsSync(unusedDir)).toBe(false);
    expect(result.env).toBeNull();
    expect(result.summary).toBeNull();
  });
});
