/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Runs every oracle fixture: each known-good solution must reach its expected
// verdict and each known-bad solution must be rejected by the expected checks.
// Requires the built compiler (`yarn build`); fixtures materialize under the
// gitignored .pms-bench/ so workspace packages resolve.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  CORPUS_ROOT,
  findTask,
  heldoutPaths,
  loadCorpus,
} from '../src/corpus.mjs';
import { copyTree } from '../src/fs-tree.mjs';
import { validate } from '../src/json-schema.mjs';
import { compileInPlace, materializeTask } from '../src/materialize.mjs';
import {
  listOracleFixtures,
  runOracleFixture,
} from '../src/oracle-fixtures.mjs';
import { evaluateTask, stateFileFor } from '../src/oracles/evaluate.mjs';

const REPO = path.resolve(CORPUS_ROOT, '../..');
const SCRATCH = path.join(REPO, '.pms-bench/agentic-test');
const resultSchema = JSON.parse(
  fs.readFileSync(
    path.join(CORPUS_ROOT, 'schema/evaluation-result.schema.json'),
    'utf8',
  ),
);
const compilerBuilt = fs.existsSync(
  path.join(REPO, 'packages/compiler/lib/index.mjs'),
);

const plaintext = heldoutPaths().plaintextTasks;
const loaded = loadCorpus(CORPUS_ROOT, {
  heldoutTasksDir: fs.existsSync(plaintext) ? plaintext : null,
});

test('the compiler is built', () => {
  assert.ok(
    compilerBuilt,
    'packages/compiler/lib is missing: run `yarn build` first',
  );
});

for (const entry of loaded.development) {
  for (const fixture of listOracleFixtures(entry)) {
    test(
      `oracle fixture ${entry.name}/${fixture.name}`,
      { skip: !compilerBuilt && 'compiler not built' },
      async () => {
        fs.mkdirSync(SCRATCH, { recursive: true });
        const r = await runOracleFixture({
          loaded,
          taskEntry: entry,
          fixture,
          scratchRoot: SCRATCH,
        });
        assert.deepEqual(validate(resultSchema, r.result), []);
        assert.deepEqual(r.mismatches, []);
      },
    );
  }
}

test('every development task with an application outcome has a known-good oracle fixture', () => {
  for (const entry of loaded.development) {
    const kind = entry.task.expectations.alpha1.intendedOutcome.kind;
    const good = listOracleFixtures(entry).filter(
      (f) =>
        f.spec.expectedVerdict === 'pass' ||
        f.spec.expectedVerdict === 'unmeasured',
    );
    assert.ok(
      good.length > 0,
      `${entry.name} (${kind}) has no known-good fixture`,
    );
  }
});

// A consumer project ignores the compiler's generation state file, so a
// rebuild leaves nothing for an agent to "clean up". The oracle never reads
// git: deleting the file still fails generated integrity.
test(
  'the generation state file is gitignored in every fixture, and deleting it still fails',
  { skip: !compilerBuilt && 'compiler not built' },
  async () => {
    const root = path.join(SCRATCH, 'state-file-ignored');
    fs.rmSync(root, { recursive: true, force: true });
    const status = (dir) =>
      spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: dir,
        encoding: 'utf8',
      }).stdout;
    const withProject = [...loaded.fixtures.values()].filter(
      (f) => f.meta.project != null,
    );
    assert.equal(withProject.length, 5);
    for (const fixture of withProject) {
      const entry = loaded.development.find(
        (t) => t.task.workspace.fixture === fixture.meta.id,
      );
      const dir = path.join(root, fixture.meta.id);
      materializeTask({ taskEntry: entry, fixture, dest: dir });
      compileInPlace({ dir, project: fixture.meta.project });
      const state = stateFileFor(fixture.meta.project.outDir);
      assert.ok(fs.existsSync(path.join(dir, state)), state);
      assert.equal(status(dir), '', `${fixture.meta.id}: ${state} is listed`);
    }
    const entry = findTask(loaded, 'composition-positive-order-summary');
    const fixture = loaded.fixtures.get(entry.task.workspace.fixture);
    const baselineDir = path.join(root, 'trial/baseline');
    const workspaceDir = path.join(root, 'trial/workspace');
    materializeTask({ taskEntry: entry, fixture, dest: baselineDir });
    copyTree(baselineDir, workspaceDir, { includeEmptyDirs: true });
    copyTree(path.join(entry.dir, 'oracle-fixtures/good/files'), workspaceDir, {
      includeEmptyDirs: true,
    });
    compileInPlace({ dir: workspaceDir, project: fixture.meta.project });
    const before = status(workspaceDir);
    fs.rmSync(
      path.join(workspaceDir, stateFileFor(fixture.meta.project.outDir)),
    );
    assert.equal(status(workspaceDir), before, 'the deletion is not listed');
    assert.doesNotMatch(before, /pms-state/);
    const r = await evaluateTask({
      task: entry.task,
      fixture: fixture.meta,
      epoch: 'alpha1',
      baselineDir,
      workspaceDir,
      scratchRoot: path.join(root, 'trial'),
      options: { hostCommands: false },
    });
    const check = r.checks.find((c) => c.id === 'generated-untouched');
    assert.equal(check.status, 'fail', check.reason);
    assert.equal(r.verdict, 'fail');
    fs.rmSync(root, { recursive: true, force: true });
  },
);

test(
  'held-out oracle fixtures (only where plaintext is staged locally)',
  {
    skip:
      loaded.heldout.length === 0 &&
      'held-out plaintext not present (expected in CI)',
  },
  async () => {
    fs.mkdirSync(SCRATCH, { recursive: true });
    for (const entry of loaded.heldout) {
      for (const fixture of listOracleFixtures(entry)) {
        const r = await runOracleFixture({
          loaded,
          taskEntry: entry,
          fixture,
          scratchRoot: SCRATCH,
        });
        assert.deepEqual(r.mismatches, [], `${entry.name}/${fixture.name}`);
      }
    }
  },
);
