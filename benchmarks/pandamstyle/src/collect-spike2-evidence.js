#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - assemble the Spike 2 evidence directory.
 *
 * It copies the committed artefacts, digests every one of them, and writes an
 * INDEX that states, for each raw stream, WHERE it is, HOW BIG it is, WHAT ITS
 * SHA256 IS, and WHETHER IT IS DURABLE.
 *
 * That last field is the one Spike 1 got wrong by implication and Spike 2
 * states explicitly: the raw observation streams live in a gitignored scratch
 * directory on the same physical volume as the repository. They are
 * `ignored-local-scratch` and **NOT DURABLE**. They survive as long as this
 * workspace does. What is durable is the committed evidence here, together
 * with the digest of every raw stream the summaries were computed from — so a
 * future run can prove whether it is looking at the same bytes.
 *
 * Usage:
 *   node src/collect-spike2-evidence.js --out <dir> \
 *        --c1000 <jsonl> --c10000 <jsonl> --oracle <json> \
 *        --long-session <json> [--parse-accounting <json>]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const EVIDENCE = path.join(REPO_ROOT, 'evidence', 'performance', 'spike-2');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const eq = argv[i].indexOf('=');
    if (eq !== -1) out[argv[i].slice(2, eq)] = argv[i].slice(eq + 1);
    else {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function sha256File(file) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex');
}

function describe(file, durability, note) {
  if (file == null || !fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  return {
    name: path.basename(file),
    bytes: stat.size,
    sha256: sha256File(file),
    durability,
    note,
  };
}

function copyInto(src, dir) {
  if (src == null || !fs.existsSync(src)) return null;
  const dest = path.join(dir, path.basename(src));
  fs.copyFileSync(src, dest);
  return dest;
}

function main() {
  const args = parseArgs(process.argv);
  const out = args.out ? path.resolve(args.out) : EVIDENCE;
  for (const sub of ['', 'campaigns', 'correctness', 'memory', 'corpora']) {
    fs.mkdirSync(path.join(out, sub), { recursive: true });
  }

  const index = {
    documentKind: 'pandamstyle-evidence-index',
    batch: 'spike-2',
    generated_by: 'benchmarks/pandamstyle/src/collect-spike2-evidence.js',
    durability_policy: {
      committed:
        'Everything under evidence/performance/spike-2/ is committed and is ' +
        'the durable record. It is small on purpose: corpus manifests, ' +
        'campaign metadata, summaries, oracle verdicts, the long-session ' +
        'trace, and the report.',
      'ignored-local-scratch':
        'The raw observation streams (JSONL), the per-job parse traces and ' +
        'the generated corpora live under the gitignored .pms-bench/ tree, ' +
        'on the SAME physical volume as the repository. They are NOT an ' +
        'archive and NOT durable. Each is listed below with its size and ' +
        'sha256 so a later run can prove whether it is looking at the same ' +
        'bytes; what survives them is the committed evidence.',
    },
    corpora: [],
    campaigns: [],
    correctness: [],
    memory: [],
    raw: [],
  };

  // Corpus manifests: small, and the IDENTITY of every number taken against
  // them. Committed.
  for (const dir of fs.existsSync(path.join(REPO_ROOT, '.pms-bench', 'corpora'))
    ? fs.readdirSync(path.join(REPO_ROOT, '.pms-bench', 'corpora'))
    : []) {
    const manifest = path.join(
      REPO_ROOT,
      '.pms-bench',
      'corpora',
      dir,
      'corpus-manifest.json',
    );
    const d = describe(
      manifest,
      'committed',
      'corpus identity and content hash',
    );
    if (d == null) continue;
    copyInto(manifest, path.join(out, 'corpora'));
    const spike1 = path.join(
      REPO_ROOT,
      'evidence',
      'performance',
      'spike-1',
      'corpora',
      dir,
      'corpus-manifest.json',
    );
    if (fs.existsSync(spike1)) {
      const a = fs.readFileSync(spike1, 'utf8');
      const b = fs.readFileSync(manifest, 'utf8');
      d.identical_to_spike_1 =
        crypto.createHash('sha256').update(a).digest('hex') ===
        crypto.createHash('sha256').update(b).digest('hex');
    }
    index.corpora.push(d);
  }

  const copy = (file, sub, durability, note) => {
    const dest = copyInto(file, path.join(out, sub));
    const d = describe(file, durability, note);
    if (d != null && dest != null)
      d.committed_copy = path.relative(REPO_ROOT, dest);
    return d;
  };

  // `parseArgs` strips the leading dashes, so the lookup keys are bare. Using
  // the dashed spelling here would silently collect nothing and produce an
  // index that looks complete and is empty.
  for (const [flag, label] of [
    ['c1000', 'c1000-t1000-r100-s809'],
    ['c10000', 'c10000-t1000-r100-s307'],
  ]) {
    if (args[flag] == null) continue;
    const stream = path.resolve(args[flag]);
    index.raw.push(
      describe(
        stream,
        'ignored-local-scratch',
        `raw observation stream, ${label}`,
      ),
    );
    for (const suffix of [
      '-metadata.json',
      '-summary.json',
      '-report-data.json',
    ]) {
      const f = `${stream.replace(/\.jsonl$/, '')}${suffix}`;
      const d = copy(
        f,
        'campaigns',
        'committed',
        suffix === '-metadata.json'
          ? 'every job, its engine anchor, the run kind and the order seed'
          : 'aggregated statistics and the cross-engine tables',
      );
      if (d != null) index.campaigns.push({ corpus: label, ...d });
    }
  }

  if (args.oracle != null) {
    const d = copy(
      path.resolve(args.oracle),
      'correctness',
      'committed',
      'the incremental-vs-fresh-rebuild differential verdict, per revision',
    );
    if (d != null) index.correctness.push(d);
  }
  if (args.spike1Oracle != null) {
    const d = describe(
      path.resolve(args.spike1Oracle),
      'ignored-local-scratch',
      'the Spike 1 engine-vs-engine oracle, re-run for continuity',
    );
    if (d != null) index.correctness.push(d);
  }
  if (args['long-session'] != null) {
    const d = copy(
      path.resolve(args['long-session']),
      'memory',
      'committed',
      'the 1,000-revision memory and reuse trace',
    );
    if (d != null) index.memory.push(d);
  }
  if (args['parse-accounting'] != null) {
    const d = copy(
      path.resolve(args['parse-accounting']),
      'campaigns',
      'committed',
      'per-pipeline parse accounting derived from the per-parse evidence',
    );
    if (d != null) index.campaigns.push({ corpus: 'all', ...d });
  }

  for (const flag of ['--environment', '--tests']) {
    if (args[flag] == null) continue;
    const d = copy(
      path.resolve(args[flag]),
      '',
      'committed',
      flag === '--environment'
        ? 'the toolchain, machine and lockfile the numbers were taken on'
        : 'the verification record',
    );
    if (d != null) index.raw.push(d);
  }

  const indexPath = path.join(out, 'INDEX.json');
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
  process.stdout.write(`${JSON.stringify(index, null, 2)}\n`);
}

if (require.main === module) {
  main();
}
