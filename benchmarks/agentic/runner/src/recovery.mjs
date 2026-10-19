/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Crash recovery (DESIGN.md section 4.6). At start-up, before anything else,
// every attempt left by a crashed runner is handled from its recovery state,
// whatever its credential mode: agent processes killed, the credential
// exported and written back by compare-and-swap (mode B, source policy
// re-checked first), the agent container, proxy and network removed and
// their removal verified, and every private and working file deleted.
// Resources carrying the runner's labels but no state are removed too. Any
// failure is a durable refusal of the provider (refusals.mjs).

import fs from 'node:fs';
import path from 'node:path';
import {
  PROVIDERS,
  checkSourcePolicy,
  decideRecoveryWriteBack,
  readCredentialFile,
} from './credentials.mjs';
import * as dockerModule from './docker.mjs';
import { recordRefusal } from './refusals.mjs';
import { removeOwned } from './safefs.mjs';

const { HARNESS_DIR, NODE, execArgs } = dockerModule;

const removeDockerResources = (resources, docker) =>
  dockerModule.removeVerified(resources, docker);

function killLocalGroup(pgid) {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // Already gone.
  }
  // Killed members stay visible until reaped: wait (bounded) for the group
  // to be gone, as the local executor's own cleanup does.
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 40; i += 1) {
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return true;
    }
    Atomics.wait(pause, 0, 0, 50);
  }
  return false;
}

function recoverOne(state, { docker, stateDir }) {
  const entry = {
    credential: 'not-applicable',
    cleanup: 'verified',
    problems: [],
  };
  const res = state.resources ?? {};
  const p =
    state.credential != null ? PROVIDERS[state.credential.provider] : null;
  let exported = null;
  if (res.container) {
    docker(
      execArgs({
        container: res.container,
        command: [NODE, `${HARNESS_DIR}/signal-cli.mjs`, 'SIGKILL', 'all'],
      }),
    );
    if (p) {
      const r = docker(
        execArgs({
          container: res.container,
          command: [
            NODE,
            `${HARNESS_DIR}/export-credential.mjs`,
            `/run/agent/${p.containerFile}`,
          ],
        }),
      );
      exported =
        r.status === 0
          ? { bytes: Buffer.from(r.stdout.trim(), 'base64') }
          : { error: (r.stderr || 'export-failed').trim().slice(0, 40) };
    }
  }
  if (res.pgid != null && !killLocalGroup(res.pgid))
    entry.problems.push(`process group ${res.pgid} survives`);
  if (p && exported == null)
    try {
      exported = {
        bytes: readCredentialFile(path.join(state.agentHome, p.containerFile))
          .bytes,
      };
    } catch (error) {
      exported = { error: error.code ?? 'export-failed' };
    }
  if (p) {
    let policyOk = true;
    try {
      if (state.synthetic) {
        if (state.kind !== 'adapter-fixture')
          throw new Error('synthetic source outside an adapter-fixture matrix');
      } else
        checkSourcePolicy({
          provider: state.credential.provider,
          hostPath: state.hostPath,
          synthetic: false,
        });
    } catch (error) {
      policyOk = false;
      entry.problems.push(`source policy: ${error.message}`);
    }
    entry.credential = policyOk
      ? decideRecoveryWriteBack({
          state: state.credential,
          exported,
          hostPath: state.hostPath,
          backupDir: state.backupDir,
        }).outcome
      : 'not-written';
    if (
      entry.credential !== 'unchanged' &&
      entry.credential !== 'host-replaced'
    )
      entry.problems.push(`credential ${entry.credential}`);
  }
  if (res.container || res.proxy || res.network) {
    const remaining = removeDockerResources(res, docker);
    if (remaining.length > 0) {
      entry.cleanup = 'failed';
      entry.problems.push(`not removed: ${remaining.join(', ')}`);
    }
  }
  if (entry.problems.length > 0)
    recordRefusal(stateDir, state.provider ?? state.cli, {
      reason: `crash recovery: ${entry.problems.join('; ')}`,
      attempt: state.attempt ?? null,
    });
  return entry;
}

/**
 * Recovers every stale attempt under `runsRoot`. `docker` is injectable for
 * tests; without Docker state, no Docker command runs.
 */
export function recoverStale(
  runsRoot,
  { stateDir, docker = dockerModule.docker, sweepLabels = false } = {},
) {
  const report = [];
  if (!fs.existsSync(runsRoot)) return report;
  for (const matrix of fs.readdirSync(runsRoot)) {
    const privateRoot = path.join(runsRoot, matrix, '.private');
    const workRoot = path.join(runsRoot, matrix, '.work');
    for (const attempt of fs.existsSync(privateRoot)
      ? fs.readdirSync(privateRoot)
      : []) {
      const dir = path.join(privateRoot, attempt);
      const stateFile = path.join(dir, 'state.json');
      let entry = {
        matrix,
        attempt,
        credential: 'not-applicable',
        cleanup: 'no-state',
      };
      if (fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        entry = { matrix, attempt, ...recoverOne(state, { docker, stateDir }) };
      }
      // Private files (unredacted streams, agent home) never survive.
      removeOwned(dir);
      report.push(entry);
    }
    // Working copies of the workspace never survive either.
    removeOwned(workRoot);
    removeOwned(privateRoot);
  }
  if (sweepLabels) {
    const stale = dockerModule.staleResources(docker);
    const remaining = [];
    for (const c of stale.containers)
      remaining.push(...removeDockerResources({ container: c }, docker));
    for (const n of stale.networks)
      remaining.push(...removeDockerResources({ network: n }, docker));
    if (stale.containers.length + stale.networks.length > 0)
      report.push({
        matrix: null,
        attempt: null,
        swept: [...stale.containers, ...stale.networks],
        cleanup: remaining.length ? 'failed' : 'verified',
      });
    if (remaining.length > 0)
      recordRefusal(stateDir, 'docker', {
        reason: `labelled resources not removed: ${remaining.join(', ')}`,
      });
  }
  return report;
}
