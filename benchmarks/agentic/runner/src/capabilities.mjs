/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Capability enforcement matrix (DESIGN.md section 4.5, decision Q12) and
// held-out refusal (section 4.9). A withheld capability is prevented when its
// exercise could change graded evidence, reach outside the container or
// affect credentials; capabilities that can only be detected are
// detect-and-fail; anything else refuses the task.

import fs from 'node:fs';
import path from 'node:path';
import { CORPUS_ROOT, digestJson } from './util.mjs';

export const MATRIX_VERSION = 'capability-enforcement/v1';

/** Unconditional in AG-00.2 (F1): no purpose or environment unlocks it. */
export function heldoutRefusal({ taskId, task, argv = [] }) {
  const manifestPath = path.join(CORPUS_ROOT, 'heldout/MANIFEST.json');
  const ids = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')).tasks.map((t) => t.id)
    : [];
  if (ids.includes(taskId)) return `held-out task ${taskId} is refused (F1)`;
  if (task?.split === 'heldout') return `task ${taskId} has split heldout`;
  if (argv.some((a) => a === '--heldout-dir' || a.startsWith('--heldout-dir=')))
    return '--heldout-dir is refused (F1)';
  return null;
}

/** Refusals of unsupported task features (sections 4.2 and 4.5). */
export function taskRefusals(task) {
  const out = [];
  if (task.environment.network === 'package-registry')
    out.push('network package-registry needs the local mirror (Q2)');
  if ((task.workspace.services ?? []).length > 0)
    out.push('workspace services are not supported');
  if (task.environment.browser === true)
    out.push('browser tasks are not supported');
  for (const e of task.workspace.events ?? [])
    if (e.steps.some((s) => s.step === 'compile'))
      out.push(
        `event ${e.id} has a compile step (agent-writable node_modules)`,
      );
  return out;
}

const HOST_BUILD =
  /(^|\s|\/)(vite build|next build|rsbuild build|webpack( |$)(?!serve)|(npm|pnpm|yarn)( run)? build)\b/;
const DEV_SERVER =
  /(^|\s|\/)(vite( dev| serve| preview)?\s*$|vite (dev|serve|preview)\b|next (dev|start)\b|rsbuild (dev|preview)\b|webpack serve\b|webpack-dev-server\b|(npm|pnpm|yarn)( run)? (dev|start|serve|preview)\b)/;
const INSTALL =
  /(^|\s|\/)((npm|pnpm) (i|install|ci|add|update|link)\b|yarn( install| add| upgrade| link)?\s*$|yarn (install|add|upgrade|link)\b|npx\b|pnpm dlx\b|yarn dlx\b)/;

/**
 * The enforcement plan of one task: mounts that prevent, detectors that
 * detect-and-fail, and the matrix digest that enters the comparability key.
 */
export function enforcementPlan(task, fixtureMeta) {
  const withheld = new Set(task.capabilities.withheld);
  const granted = new Set(task.capabilities.granted);
  const project = task.project ?? fixtureMeta?.project ?? null;
  const rows = [];
  const mounts = {
    workspaceReadOnly: false,
    gitReadOnly: false,
    readOnlyPaths: [],
  };
  const detectors = [];

  if (!granted.has('workspace.write')) {
    mounts.workspaceReadOnly = true;
    rows.push(['workspace.write', 'read-only workspace mount', 'prevent']);
  }
  if (!granted.has('git.write')) {
    mounts.gitReadOnly = true;
    rows.push(['git.write', 'read-only .git bind mount', 'prevent']);
  }
  if (withheld.has('design-system.edit') && project?.definition) {
    mounts.readOnlyPaths.push(project.definition);
    rows.push([
      'design-system.edit',
      `read-only bind of ${project.definition}; generated output and other definition modules detected by oracles`,
      'prevent+detect',
    ]);
  }
  if (!granted.has('network.registry'))
    rows.push([
      'network.registry',
      'no route but the provider allowlist',
      'prevent',
    ]);
  if (!granted.has('package.install')) {
    rows.push([
      'package.install',
      'network prevented; local installs detected (command pattern, node_modules digest)',
      'prevent+detect-and-fail',
    ]);
    detectors.push('local-install');
  }
  if (!granted.has('host.build')) {
    rows.push([
      'host.build',
      'detected from the transcript',
      'detect-and-fail',
    ]);
    detectors.push('host-build');
  }
  if (!granted.has('host.dev-server')) {
    rows.push([
      'host.dev-server',
      'detected from the transcript',
      'detect-and-fail',
    ]);
    detectors.push('dev-server');
  }
  rows.push([
    'web-tools',
    'tool configuration; stream detection',
    'prevent+detect-and-fail',
  ]);
  rows.push([
    'subagents',
    'tool configuration; stream detection',
    'prevent+detect-and-fail',
  ]);
  detectors.push('tool-policy');

  const matrix = rows.map(([capability, mechanism, cls]) => ({
    capability,
    mechanism,
    class: cls,
  }));
  return {
    version: MATRIX_VERSION,
    refusals: taskRefusals(task),
    mounts,
    detectors,
    matrix,
    matrixSha256: digestJson({ version: MATRIX_VERSION, matrix }),
  };
}

/**
 * Detect-and-fail breaches after the agent phase (Q12). Inputs are the
 * normalized tool calls and harness observations, never the verdict.
 */
export function detectBreaches({
  plan,
  toolCalls,
  policyEvents = [],
  nodeModules = null,
}) {
  const breaches = [];
  const commands = toolCalls.filter((c) => c.kind === 'command');
  if (plan.detectors.includes('host-build'))
    for (const c of commands)
      if (HOST_BUILD.test(c.command))
        breaches.push({
          kind: 'host-build',
          source: 'transcript',
          enforcement: 'detected',
          detail: c.command.slice(0, 200),
        });
  if (plan.detectors.includes('dev-server'))
    for (const c of commands)
      if (DEV_SERVER.test(c.command))
        breaches.push({
          kind: 'dev-server',
          source: 'transcript',
          enforcement: 'detected',
          detail: c.command.slice(0, 200),
        });
  if (plan.detectors.includes('local-install')) {
    for (const c of commands)
      if (INSTALL.test(c.command))
        breaches.push({
          kind: 'local-install',
          source: 'transcript',
          enforcement: 'detected',
          detail: c.command.slice(0, 200),
        });
    if (
      nodeModules != null &&
      (nodeModules.before ?? null) !== (nodeModules.after ?? null)
    )
      breaches.push({
        kind: 'local-install',
        source: 'filesystem',
        enforcement: 'detected',
        detail: 'node_modules digest changed',
      });
  }
  if (plan.detectors.includes('tool-policy'))
    for (const e of policyEvents)
      breaches.push({
        kind: e.kind.startsWith('subagent') ? 'subagent-use' : 'web-use',
        source: 'stream',
        enforcement: 'detected',
        detail: e.detail,
      });
  return breaches;
}
