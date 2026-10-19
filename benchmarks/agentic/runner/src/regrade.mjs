/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Re-grading from stored evidence (DESIGN.md sections 1.5 and 6.3). Before
// anything is evaluated, the attempt is verified: every stored artifact's
// sha256, every evidence blob against its manifest entry, the manifests' set
// digests against the record, the harness identity of this checkout against
// the record's, and, for records graded with the trusted tree, the supplied
// tree against the recorded digests. Provider-backed records are never
// re-graded through the ancestor fallback. The result is `exact` only when
// every check holds and the evidence is complete; a failed integrity check
// refuses the re-grade.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractArchive, setDigest } from './evidence.mjs';
import { harnessIdentity } from './identity.mjs';
import {
  assertNoAncestorNodeModules,
  checkTrustedTree,
} from './trusted-tree.mjs';
import { CORPUS_ROOT, fileSha256, readJson } from './util.mjs';

function coded(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** Integrity of the stored attempt; returns the list of problems. */
export function verifyAttemptIntegrity(attemptDir, record) {
  const problems = [];
  const purged = new Set(record.evidence.purged ?? []);
  for (const a of record.evidence.artifacts ?? []) {
    // Purged by the leak scan: recorded, and the evidence is incomplete.
    if (purged.has(a.file)) continue;
    const f = path.join(attemptDir, a.file);
    if (!fs.existsSync(f)) problems.push(`artifact ${a.file} missing`);
    else if (fileSha256(f) !== a.sha256)
      problems.push(`artifact ${a.file} sha256 differs`);
  }
  for (const [name, expected] of [
    ['final', record.evidence.gradedSetDigest],
    ['baseline', record.evidence.baselineSetDigest],
  ]) {
    const dir = path.join(attemptDir, 'evidence', name);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
      problems.push(`evidence ${name} manifest missing`);
      continue;
    }
    const manifest = readJson(path.join(dir, 'manifest.json'));
    if (expected != null && setDigest(manifest.entries) !== expected)
      problems.push(`evidence ${name} set digest differs from the record`);
    if (expected != null && manifest.setDigest !== expected)
      problems.push(`evidence ${name} manifest digest differs from the record`);
    for (const e of manifest.entries)
      if (e.type === 'file' && e.stored) {
        const blob = path.join(dir, 'blobs', e.storedSha256 ?? e.sha256);
        if (
          !fs.existsSync(blob) ||
          fileSha256(blob) !== (e.storedSha256 ?? e.sha256)
        )
          problems.push(`evidence ${name} blob of ${e.path} differs`);
      }
  }
  return problems;
}

/** Harness identity differences between the record and this checkout. */
export function harnessDifferences(record, current = harnessIdentity()) {
  const out = [];
  for (const k of [
    'runnerTreeDigest',
    'harnessDepsLockSha256',
    'corpusLockSha256',
  ])
    if (record.harness?.[k] !== current[k]) out.push(`harness.${k}`);
  return out;
}

export function regradeAttempt({
  attemptDir,
  scratchRoot,
  trustedNodeModules = null,
  currentHarness = null,
}) {
  const record = readJson(path.join(attemptDir, 'record.json'));
  const problems = verifyAttemptIntegrity(attemptDir, record);
  if (problems.length > 0)
    throw coded(
      'integrity',
      `regrade refused: ${problems.slice(0, 8).join('; ')}`,
    );
  const reasons = [];
  const harnessDiffs = harnessDifferences(
    record,
    currentHarness ?? harnessIdentity(),
  );
  reasons.push(...harnessDiffs);
  const trusted = record.trustedTree?.mode === 'trusted';
  if (record.kind === 'provider-backed' && !trusted)
    throw coded(
      'trusted-tree',
      'regrade refused: a provider-backed record graded without the trusted tree',
    );
  if (trusted) {
    if (trustedNodeModules == null)
      throw coded(
        'trusted-tree',
        'regrade refused: --trusted-node-modules is required for this record (no ancestor fallback)',
      );
    checkTrustedTree({
      nodeModules: trustedNodeModules,
      expected: record.trustedTree,
    });
  }
  if (record.evidence.completeness !== 'complete')
    reasons.push(`evidence ${record.evidence.completeness}`);

  // Trusted re-grades run outside any tree with node_modules above them.
  const base = trusted ? os.tmpdir() : scratchRoot;
  const work = fs.mkdtempSync(path.join(base, 'regrade-'));
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
    fs.mkdirSync(path.join(work, 'scratch'));
    if (trusted) assertNoAncestorNodeModules(path.join(work, 'scratch', 'x'));
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
    if (trusted) args.push('--trusted-node-modules', trustedNodeModules);
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
      label: reasons.length === 0 ? 'exact' : 'non-exact',
      reasons,
      completeness: record.evidence.completeness,
      compiler: trusted
        ? 'trusted-tree'
        : 'dev-ancestor (unbound; adapter fixtures only)',
      identical,
      verdict: result.verdict,
      originalVerdict: original?.verdict ?? null,
      checks: statuses(result),
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
