/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Local executor for `adapter-fixture` attempts only (DESIGN.md section 9.1).
// It runs a fake CLI as a local process group, with a private directory
// standing in for the agent tmpfs. It provides NO isolation and therefore
// refuses provider-backed runs and never runs host commands.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readCredentialFile } from '../credentials.mjs';

export class LocalFixtureExecutor {
  constructor({ fakeBinary, scenario, extraEnv = {} }) {
    this.name = 'local-fixture';
    this.isolated = false;
    this.fakeBinary = fakeBinary;
    this.scenario = scenario;
    this.extraEnv = extraEnv;
  }

  /**
   * Starts the CLI. `credential` is `{ files: [{ rel, bytes }], env }` written
   * into the simulated tmpfs (`agentHome`).
   */
  start({ kind, cli, argv, env, stdinText, workspace, agentHome, credential }) {
    if (kind !== 'adapter-fixture')
      throw new Error('the local executor runs adapter fixtures only');
    fs.mkdirSync(agentHome, { recursive: true, mode: 0o700 });
    for (const f of credential?.files ?? []) {
      const abs = path.join(agentHome, f.rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
      fs.writeFileSync(abs, f.bytes, { mode: 0o600 });
    }
    const configDir =
      cli === 'claude' ? path.join(agentHome, '.claude') : agentHome;
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const child = spawn(process.execPath, [this.fakeBinary, ...argv.slice(1)], {
      cwd: workspace,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: agentHome,
        ...(cli === 'claude'
          ? { CLAUDE_CONFIG_DIR: configDir }
          : { CODEX_HOME: configDir }),
        ...env,
        ...(credential?.env ?? {}),
        PMS_FAKE_CLI: cli,
        PMS_FAKE_SCENARIO: this.scenario,
        PMS_FAKE_CREDENTIAL_DIR: configDir,
        ...this.extraEnv,
      },
    });
    if (stdinText != null) child.stdin.end(stdinText);
    else child.stdin.end();
    const exited = new Promise((resolve) =>
      child.on('exit', (code, signal) => resolve({ code, signal })),
    );
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      wait: () => exited,
      interrupt: () => signalGroup(child, 'SIGINT'),
      terminate: () => signalGroup(child, 'SIGTERM'),
      killAll: () => signalGroup(child, 'SIGKILL'),
      exportCredential: (rel) => {
        try {
          return { bytes: readCredentialFile(path.join(agentHome, rel)).bytes };
        } catch (error) {
          return { error: error.code ?? 'export-failed' };
        }
      },
      destroy: () => fs.rmSync(agentHome, { recursive: true, force: true }),
      cgroup: () => null,
    };
  }
}

function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is already gone.
  }
}
