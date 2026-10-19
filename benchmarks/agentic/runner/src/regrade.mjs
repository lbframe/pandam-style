/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Re-grading from stored evidence (DESIGN.md sections 1.5 and 6.3). The
// result is labelled `exact` only when the attempt's evidence is complete;
// otherwise it is `non-exact`, whatever the re-grade says.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractArchive } from './evidence.mjs';
import { CORPUS_ROOT, readJson } from './util.mjs';

export function regradeAttempt({
  attemptDir,
  scratchRoot,
  trustedNodeModules = null,
}) {
  const record = readJson(path.join(attemptDir, 'record.json'));
  const work = fs.mkdtempSync(path.join(scratchRoot, 'regrade-'));
  try {
    const baseline = path.join(work, 'baseline');
    const workspace = path.join(work, 'workspace');
    extractArchive({
      archive: path.join(attemptDir, 'evidence/baseline'),
      dest: baseline,
    });
    extractArchive({
      archive: path.join(attemptDir, 'evidence/final'),
      dest: workspace,
    });
    const args = [
      path.join(CORPUS_ROOT, 'bin/pms-agentic.mjs'),
      'evaluate',
      record.task.id,
      '--baseline',
      baseline,
      '--workspace',
      workspace,
      '--response',
      path.join(attemptDir, 'final-message.txt'),
      '--transcript',
      path.join(attemptDir, 'transcript.jsonl'),
      '--observations',
      path.join(attemptDir, 'observations.json'),
      '--epoch',
      record.task.epoch,
      '--scratch',
      path.join(work, 'scratch'),
    ];
    if (trustedNodeModules)
      args.push('--trusted-node-modules', trustedNodeModules);
    fs.mkdirSync(path.join(work, 'scratch'));
    const r = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    if (r.status !== 0) return { label: 'error', error: r.stderr.slice(-1000) };
    const result = JSON.parse(r.stdout);
    const original = fs.existsSync(path.join(attemptDir, 'evaluation.json'))
      ? readJson(path.join(attemptDir, 'evaluation.json'))
      : null;
    const statuses = (x) => (x?.checks ?? []).map((c) => [c.id, c.status]);
    const identical =
      original != null &&
      JSON.stringify(statuses(original)) === JSON.stringify(statuses(result)) &&
      original.verdict === result.verdict;
    return {
      label:
        record.evidence.completeness === 'complete' ? 'exact' : 'non-exact',
      completeness: record.evidence.completeness,
      identical,
      verdict: result.verdict,
      originalVerdict: original?.verdict ?? null,
      checks: statuses(result),
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
