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

/** Completeness implied by a manifest's entries (section 6.3). */
export function manifestCompleteness(manifest) {
  const files = manifest.entries.filter((e) => e.type === 'file');
  if (files.some((e) => e.stored !== true)) return 'incomplete';
  if (files.some((e) => e.storedSha256 != null)) return 'redacted';
  return 'complete';
}

/**
 * Integrity of the stored attempt; returns the list of problems. Every
 * artifact and blob hash is checked, and each evidence manifest's bytes are
 * bound to the record (`evidence.manifests`), so extraction-driving
 * metadata (stored, storedSha256, mode, completeness) cannot change; the
 * completeness the entries imply must match both the manifest's and, for
 * the final tree, the record's.
 */
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
    const file = path.join(dir, 'manifest.json');
    if (!fs.existsSync(file)) {
      problems.push(`evidence ${name} manifest missing`);
      continue;
    }
    const recorded = record.evidence.manifests?.[name];
    if (recorded == null)
      problems.push(`evidence ${name} manifest digest not recorded`);
    else if (fileSha256(file) !== recorded)
      problems.push(`evidence ${name} manifest differs from the record`);
    const manifest = readJson(file);
    if (expected != null && setDigest(manifest.entries) !== expected)
      problems.push(`evidence ${name} set digest differs from the record`);
    if (expected != null && manifest.setDigest !== expected)
      problems.push(`evidence ${name} manifest digest differs from the record`);
    const implied = manifestCompleteness(manifest);
    if (implied !== manifest.completeness)
      problems.push(
        `evidence ${name} entries imply ${implied}, manifest says ${manifest.completeness}`,
      );
    if (
      name === 'final' &&
      record.evidence.completeness === 'complete' &&
      implied !== 'complete'
    )
      problems.push(
        `evidence final entries imply ${implied}, the record says complete`,
      );
    for (const e of manifest.entries)
      if (e.type === 'file' && e.stored) {
        const ref = e.storedSha256 ?? e.sha256;
        const blob = path.join(dir, 'blobs', String(ref));
        if (
          !/^[0-9a-f]{64}$/.test(String(ref)) ||
          !fs.existsSync(blob) ||
          fileSha256(blob) !== ref
        )
          problems.push(`evidence ${name} blob of ${e.path} differs`);
      }
  }
  return problems;
}

/**
 * Verifies that an extraction reproduces its manifest exactly: every entry
 * present with its type, bytes (original bytes for unredacted entries), link
 * target and file mode; unstored and special entries absent; nothing else.
 */
export function verifyExtraction(dest, manifest) {
  const problems = [];
  const seen = new Set();
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dest, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      seen.add(r);
      if (fs.lstatSync(path.join(dest, r)).isDirectory()) walk(r);
    }
  };
  walk('');
  const expected = new Set();
  for (const e of manifest.entries) {
    const abs = path.join(dest, e.path);
    const st = fs.existsSync(abs) || isLink(abs) ? fs.lstatSync(abs) : null;
    const present =
      (e.type === 'file' && e.stored) ||
      e.type === 'dir' ||
      e.type === 'symlink';
    if (present) expected.add(e.path);
    if (!present) {
      if (st != null) problems.push(`${e.path}: present but not reproducible`);
      continue;
    }
    if (st == null) problems.push(`${e.path}: missing from the extraction`);
    else if (e.type === 'dir' && !st.isDirectory())
      problems.push(`${e.path}: not a directory`);
    else if (
      e.type === 'symlink' &&
      (!st.isSymbolicLink() || fs.readlinkSync(abs) !== e.target)
    )
      problems.push(`${e.path}: link differs`);
    else if (e.type === 'file') {
      if (!st.isFile()) problems.push(`${e.path}: not a file`);
      else if (fileSha256(abs) !== (e.storedSha256 ?? e.sha256))
        problems.push(`${e.path}: bytes differ`);
      else if ((st.mode & 0o777) !== e.mode)
        problems.push(`${e.path}: mode differs`);
    }
  }
  for (const r of seen)
    if (!expected.has(r)) problems.push(`${r}: not in the manifest`);
  return problems;
}

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
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
    // The extraction must reproduce each manifest exactly before grading.
    const rebuilt = [
      ...verifyExtraction(
        baseline,
        readJson(path.join(attemptDir, 'evidence/baseline/manifest.json')),
      ).map((x) => `baseline ${x}`),
      ...verifyExtraction(
        workspace,
        readJson(path.join(attemptDir, 'evidence/final/manifest.json')),
      ).map((x) => `final ${x}`),
    ];
    if (rebuilt.length > 0)
      throw coded(
        'integrity',
        `regrade refused: extraction differs: ${rebuilt.slice(0, 8).join('; ')}`,
      );
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
