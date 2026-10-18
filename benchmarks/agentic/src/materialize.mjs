/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Builds the starting workspace of a task. Order (the runner must follow it):
//
//   1. materializeFiles: fixture project, then the task's committed overlays.
//   2. dependency installation, when environment.install is before-agent
//      (runner responsibility; packages come from the candidate under test).
//   3. prepareWorkspace: deterministic `prepare` steps (compile, replace,
//      delete, write), then the baseline commit, then the uncommitted overlay.
//   4. snapshot the result as the scope baseline, start services, run agent.
//   5. events: `applyEvent` while the agent runs; the runner records which
//      events were applied and applies the same steps to the scope baseline.
//
// Nothing from the corpus outside `project/`, the named overlays and step
// sources is copied: oracle fixtures, expectations and metadata never reach
// the evaluated agent.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { copyTree } from './fs-tree.mjs';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'pms-harness',
  GIT_AUTHOR_EMAIL: 'harness@pandamstyle.invalid',
  GIT_COMMITTER_NAME: 'pms-harness',
  GIT_COMMITTER_EMAIL: 'harness@pandamstyle.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

function git(cwd, args) {
  const r = spawnSync(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...GIT_ENV },
    },
  );
  if (r.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function inside(root, rel) {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep))
    throw new Error(`path escapes workspace: ${rel}`);
  return abs;
}

export function materializeFiles({ taskEntry, fixture, dest }) {
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
    throw new Error(`Refusing to materialize into non-empty ${dest}`);
  }
  fs.mkdirSync(dest, { recursive: true });
  copyTree(fixture.projectDir, dest);
  for (const overlay of taskEntry.task.workspace.overlays ?? []) {
    copyTree(path.join(taskEntry.dir, overlay), dest);
  }
  return dest;
}

/** Regenerates compiler output in place through the public SDK (worker). */
export function compileInPlace({ dir, project }) {
  const worker = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'oracles/project-worker.mjs',
  );
  const request = path.join(dir, '.pms-prepare-request.json');
  const response = `${request}.out`;
  fs.writeFileSync(
    request,
    JSON.stringify({
      workspaceDir: dir,
      compile: true,
      probe: false,
      project,
      renders: [],
      tokenProbes: [],
    }),
  );
  const r = spawnSync(process.execPath, [worker, request, response], {
    encoding: 'utf8',
  });
  const out = fs.existsSync(response)
    ? JSON.parse(fs.readFileSync(response, 'utf8'))
    : null;
  for (const f of [request, response]) fs.rmSync(f, { force: true });
  if (r.status !== 0 || out?.compile?.ok !== true) {
    throw new Error(
      `compile step failed: ${r.stderr || JSON.stringify(out?.compile?.diagnostics)}`,
    );
  }
}

export function applySteps({ taskEntry, steps, dest, project }) {
  for (const s of steps) {
    if (s.step === 'compile') compileInPlace({ dir: dest, project });
    else if (s.step === 'delete')
      fs.rmSync(inside(dest, s.path), { recursive: true, force: true });
    else if (s.step === 'write') {
      const target = inside(dest, s.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(taskEntry.dir, s.source), target);
    } else if (s.step === 'replace') {
      const target = inside(dest, s.path);
      const text = fs.readFileSync(target, 'utf8');
      if (!text.includes(s.find))
        return { applied: false, reason: `${s.path}: find text not present` };
      fs.writeFileSync(target, text.split(s.find).join(s.replace));
    }
  }
  return { applied: true };
}

export function prepareWorkspace({ taskEntry, fixture, dest }) {
  const task = taskEntry.task;
  const project = task.project ?? fixture.meta.project;
  const prepared = applySteps({
    taskEntry,
    steps: task.workspace.prepare ?? [],
    dest,
    project,
  });
  if (!prepared.applied) throw new Error(`prepare failed: ${prepared.reason}`);
  if ((task.workspace.git ?? 'baseline-commit') === 'baseline-commit') {
    git(dest, ['init', '-q', '-b', 'main']);
    git(dest, ['add', '-A']);
    git(dest, ['commit', '-q', '-m', 'baseline']);
  }
  if (task.workspace.uncommittedOverlay != null) {
    copyTree(path.join(taskEntry.dir, task.workspace.uncommittedOverlay), dest);
  }
  return dest;
}

/** Convenience for workspaces whose dependencies resolve without install. */
export function materializeTask({ taskEntry, fixture, dest }) {
  materializeFiles({ taskEntry, fixture, dest });
  return prepareWorkspace({ taskEntry, fixture, dest });
}

/**
 * Applies a concurrent-edit event. Returns `{ applied: false }` when a
 * `replace` no longer finds its anchor; the runner must record that outcome.
 */
export function applyEvent({ taskEntry, fixture, eventId, dest }) {
  const event = (taskEntry.task.workspace.events ?? []).find(
    (e) => e.id === eventId,
  );
  if (event == null) throw new Error(`Unknown event ${eventId}`);
  const project = taskEntry.task.project ?? fixture.meta.project;
  return applySteps({ taskEntry, steps: event.steps, dest, project });
}

/**
 * Full prompt given to the evaluated agent: task prompt, the location of
 * mounted agent resources (when the task declares any) and the report
 * contract. `docsPath` is the runner's read-only mount of the product's agent
 * documentation; it is never inside the workspace.
 */
export function buildPrompt({
  corpusRoot,
  taskEntry,
  docsPath = '<PMS_AGENT_DOCS>',
}) {
  const body = fs
    .readFileSync(path.join(taskEntry.dir, taskEntry.task.prompt), 'utf8')
    .trim();
  const contract = fs
    .readFileSync(path.join(corpusRoot, 'harness/report-contract.md'), 'utf8')
    .trim();
  const resources = (taskEntry.task.environment.resources ?? []).includes(
    'pandamstyle-agent-docs',
  )
    ? `\n\nPandamStyle agent documentation (contracts, API reference and the Alpha 1 reference benchmark dataset) is available read-only at ${docsPath}.`
    : '';
  return `${body}${resources}\n\n${contract}\n`;
}
