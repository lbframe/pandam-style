/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Known-good and known-bad solutions that prove each oracle discriminates.
//
// tasks/<id>/oracle-fixtures/<name>/
//   fixture.json   expected verdict and per-check statuses for an epoch
//   files/         final content of files the simulated agent wrote
//   response.md    simulated final message (optional)
//
// fixture.json may also list `delete` paths, `steps` (replace/delete applied
// after files), `regenerate` (simulate the agent running the compiler),
// `appliedEvents`, a normalized `transcript` and runner `observations`.

import fs from 'node:fs';
import path from 'node:path';
import { copyTree, readJson, sha256 } from './fs-tree.mjs';
import {
  applyEvent,
  applySteps,
  compileInPlace,
  materializeTask,
} from './materialize.mjs';
import { evaluateTask, stateFileFor } from './oracles/evaluate.mjs';

export function listOracleFixtures(taskEntry) {
  const dir = path.join(taskEntry.dir, 'oracle-fixtures');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .sort()
    .map((name) => ({
      name,
      dir: path.join(dir, name),
      spec: readJson(path.join(dir, name, 'fixture.json')),
    }));
}

/**
 * Runs one oracle fixture. `scratchRoot` must be a location from which the
 * workspace's packages resolve (inside the repository for local checks, or a
 * runner workspace with installed dependencies).
 */
export async function runOracleFixture({
  loaded,
  taskEntry,
  fixture,
  scratchRoot,
}) {
  const meta = loaded.fixtures.get(taskEntry.task.workspace.fixture);
  const base = path.join(scratchRoot, `${taskEntry.name}--${fixture.name}`);
  fs.rmSync(base, { recursive: true, force: true });
  const baselineDir = path.join(base, 'baseline');
  const workspaceDir = path.join(base, 'workspace');
  materializeTask({ taskEntry, fixture: meta, dest: baselineDir });
  for (const eventId of fixture.spec.appliedEvents ?? []) {
    const r = applyEvent({
      taskEntry,
      fixture: meta,
      eventId,
      dest: baselineDir,
    });
    if (!r.applied)
      throw new Error(`event ${eventId} did not apply: ${r.reason}`);
  }
  copyTree(baselineDir, workspaceDir, { includeEmptyDirs: true });
  const filesDir = path.join(fixture.dir, 'files');
  if (fs.existsSync(filesDir))
    copyTree(filesDir, workspaceDir, { includeEmptyDirs: true });
  for (const rel of fixture.spec.delete ?? [])
    fs.rmSync(path.join(workspaceDir, rel), { recursive: true, force: true });
  const project = taskEntry.task.project ?? meta.meta.project;
  for (const link of fixture.spec.symlinks ?? []) {
    const target = link.target.startsWith('baseline:')
      ? path.join(baselineDir, link.target.slice('baseline:'.length))
      : link.target;
    fs.rmSync(path.join(workspaceDir, link.path), { force: true });
    fs.symlinkSync(target, path.join(workspaceDir, link.path));
  }
  if (fixture.spec.regenerate === 'before-steps')
    compileInPlace({ dir: workspaceDir, project });
  if (fixture.spec.steps != null) {
    const r = applySteps({
      taskEntry,
      steps: fixture.spec.steps,
      dest: workspaceDir,
      project,
    });
    if (!r.applied) throw new Error(`fixture step did not apply: ${r.reason}`);
  }
  if (fixture.spec.regenerate === true)
    compileInPlace({ dir: workspaceDir, project });
  // Agent-style tampering with a generation, keeping the generation's own
  // state file consistent with the tampered bytes.
  for (const edit of fixture.spec.generationEdits ?? []) {
    const outDir = path.join(workspaceDir, project.outDir);
    const statePath = path.join(workspaceDir, stateFileFor(project.outDir));
    if (edit.op === 'delete-all') {
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.rmSync(statePath, { force: true });
      continue;
    }
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (edit.op === 'rewrite') {
      fs.writeFileSync(path.join(outDir, edit.rel), edit.content);
      state.files[edit.rel] = {
        ...state.files[edit.rel],
        digest: sha256(edit.content),
        size: Buffer.byteLength(edit.content),
      };
    } else if (edit.op === 'delete-entry') {
      fs.rmSync(path.join(outDir, edit.rel), { force: true });
      delete state.files[edit.rel];
    }
    fs.writeFileSync(statePath, JSON.stringify(state));
  }
  const responsePath = path.join(fixture.dir, 'response.md');
  const result = await evaluateTask({
    task: taskEntry.task,
    fixture: meta.meta,
    epoch: fixture.spec.epoch,
    baselineDir,
    workspaceDir,
    responseText: fs.existsSync(responsePath)
      ? fs.readFileSync(responsePath, 'utf8')
      : null,
    transcript: fixture.spec.transcript ?? null,
    observations: fixture.spec.observations ?? null,
    scratchRoot: base,
    options: { hostCommands: false },
  });
  const mismatches = [];
  if (result.verdict !== fixture.spec.expectedVerdict) {
    mismatches.push(
      `verdict ${result.verdict} != expected ${fixture.spec.expectedVerdict}`,
    );
  }
  for (const [id, status] of Object.entries(
    fixture.spec.expectedStatuses ?? {},
  )) {
    const check = result.checks.find((c) => c.id === id);
    if (check == null) mismatches.push(`check ${id} not evaluated`);
    else if (check.status !== status)
      mismatches.push(
        `check ${id}: ${check.status} != expected ${status} (${check.reason ?? ''})`,
      );
  }
  fs.rmSync(base, { recursive: true, force: true });
  return {
    task: taskEntry.name,
    fixture: fixture.name,
    verdict: result.verdict,
    mismatches,
    result,
  };
}
