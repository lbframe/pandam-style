/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Harness identity and host facts (DESIGN.md sections 1.2 and 1.3). The
// commit identifies; content digests compare, so a new main commit that
// leaves the harness bytes unchanged does not break comparability.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { treeDigest } from '../../src/fs-tree.mjs';
import {
  CORPUS_ROOT,
  REPO_ROOT,
  RUNNER_ROOT,
  fileSha256,
  sha256,
} from './util.mjs';

function git(args) {
  const r = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function harnessIdentity() {
  const status = git(['status', '--porcelain', '--untracked-files=normal']);
  return {
    commit: git(['rev-parse', 'HEAD']),
    clean: status === '',
    corpusLockSha256: fileSha256(path.join(CORPUS_ROOT, 'corpus.lock.json')),
    runnerTreeDigest: treeDigest(RUNNER_ROOT, {
      exclude: ['node_modules/**', '**/node_modules/**'],
    }),
    harnessDepsLockSha256: sha256(
      [
        path.join(REPO_ROOT, 'yarn.lock'),
        path.join(CORPUS_ROOT, 'dom/yarn.lock'),
      ]
        .map((f) => fileSha256(f))
        .join('\0'),
    ),
  };
}

export function hostFacts() {
  const cpus = os.cpus();
  return {
    kernel: os.release(),
    cpuModel: cpus[0]?.model ?? 'unknown',
    cpus: cpus.length,
    memoryBytes: os.totalmem(),
  };
}

export function dockerVersion() {
  const r = spawnSync(
    'docker',
    ['version', '--format', '{{.Server.Version}}'],
    { encoding: 'utf8' },
  );
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Samples the 1-minute load average every `intervalMs` until stopped. */
export function startLoadSampler(intervalMs = 5000) {
  const samples = [];
  const take = () => samples.push(os.loadavg()[0]);
  take();
  const timer = setInterval(take, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      take();
      const s = [...samples].sort((a, b) => a - b);
      return {
        samples: samples.length,
        min: s[0] ?? null,
        max: s.at(-1) ?? null,
        median: s.length ? s[Math.floor(s.length / 2)] : null,
      };
    },
  };
}

export function corpusInfo(loaded, epoch) {
  const lock = JSON.parse(
    fs.readFileSync(path.join(CORPUS_ROOT, 'corpus.lock.json'), 'utf8'),
  );
  return {
    epoch,
    corpusVersion: loaded.corpus.corpusVersion,
    corpusLockSha256: fileSha256(path.join(CORPUS_ROOT, 'corpus.lock.json')),
    taskDigests: lock.development,
  };
}
