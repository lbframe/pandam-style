/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Crash recovery (DESIGN.md section 4.6): at start-up, every attempt left by
// a crashed runner is exported (mode B) and cleaned before anything else, and
// leftover private files (unredacted streams) are deleted.

import fs from 'node:fs';
import path from 'node:path';
import {
  PROVIDERS,
  decideRecoveryWriteBack,
  readCredentialFile,
} from './credentials.mjs';
import { docker, execArgs, NODE, HARNESS_DIR } from './docker.mjs';

export function recoverStale(runsRoot) {
  const report = [];
  if (!fs.existsSync(runsRoot)) return report;
  for (const matrix of fs.readdirSync(runsRoot)) {
    const privateRoot = path.join(runsRoot, matrix, '.private');
    if (!fs.existsSync(privateRoot)) continue;
    for (const attempt of fs.readdirSync(privateRoot)) {
      const dir = path.join(privateRoot, attempt);
      const stateFile = path.join(dir, 'state.json');
      const entry = { matrix, attempt, credential: 'not-applicable' };
      if (fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (state.credential != null) {
          const p = PROVIDERS[state.credential.provider];
          let exported;
          if (state.container != null) {
            docker(
              execArgs({
                container: state.container,
                command: [
                  NODE,
                  `${HARNESS_DIR}/signal-cli.mjs`,
                  'SIGKILL',
                  'all',
                ],
              }),
            );
            const target =
              state.cli === 'claude'
                ? `/run/agent/${p.containerFile}`
                : `/run/agent/${path.basename(p.containerFile)}`;
            const r = docker(
              execArgs({
                container: state.container,
                command: [NODE, `${HARNESS_DIR}/export-credential.mjs`, target],
              }),
            );
            exported =
              r.status === 0
                ? { bytes: Buffer.from(r.stdout.trim(), 'base64') }
                : { error: (r.stderr || 'export-failed').trim() };
            docker(['rm', '-f', state.container]);
          } else {
            try {
              exported = {
                bytes: readCredentialFile(
                  path.join(state.agentHome, p.containerFile),
                ).bytes,
              };
            } catch (error) {
              exported = { error: error.code ?? 'export-failed' };
            }
          }
          entry.credential = decideRecoveryWriteBack({
            state: state.credential,
            exported,
            hostPath: state.hostPath,
            backupDir: state.backupDir,
          }).outcome;
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
      report.push(entry);
    }
  }
  return report;
}
