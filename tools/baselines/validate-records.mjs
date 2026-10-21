/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Committed CE-00.3 record validation.
//
//   node tools/baselines/validate-records.mjs [--json]
//   node tools/baselines/validate-records.mjs --mutations
//
// Rechecks, from Git objects and committed files only (no store, no network,
// full Git history required), through the existing commands:
//
// - manifest: `archive.mjs verify --committed`, the alpha1 manifest records
//   that Git can prove;
// - workloads: `workloads.mjs digest`, every frozen workload materializes to
//   its frozen digest;
// - ce-corpus derivation: the CE-00.2 corpus record is the pinned accounting
//   and policy candidates (derive-ce-corpus.mjs `candidates` and `prune`),
//   less its recorded exclusions;
// - results: every committed run's summary.json re-derives byte for byte
//   (`summarize.mjs`), and every committed gate report re-derives from its
//   runs at its recorded commit (`budgets.mjs gate`; only `provenance.rev`,
//   the revision name it was invoked with, is not compared);
// - budgets: every budgets.vN.json re-freezes byte for byte from its policy
//   and baseline runs (`budgets.mjs freeze`), and the gate at HEAD verifies
//   the budgets in force and passes on their own baseline runs;
// - frozen: every file ever added under benchmarks/core-evolution, except
//   README.md, is still present, with the bytes of the first-parent commit
//   that added it, at HEAD and in the working tree.
//
// Local-only, because they need the archived alpha1 store: the store digests
// (`archive.mjs verify --store <copy> --replay`), and the CE-00.2 corpus
// exclusions, which only the Alpha 1 compiler decides
// (`derive-ce-corpus.mjs --closure <store>/closure`, then `git diff`). The
// measurements themselves are evidence and cannot be re-observed.
//
// --mutations commits one edit per class to a temporary clone of HEAD and
// requires the validator of that clone to fail the checks of that class; an
// unmutated clone must pass. Uncommitted changes are not part of the clone.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BENCH, REPO, gitBlob, readJson, sha256 } from './lib.mjs';
import { ALPHA1_POLICY } from '../coverage/classify.mjs';
import {
  ACCOUNTING,
  CORPUS_COMMIT,
  POLICY_COMMIT,
  RECORD,
  candidates,
  loadPolicy,
  prune,
} from './derive-ce-corpus.mjs';

const BENCH_DIR = path.relative(REPO, BENCH);
const RESULTS = path.join(BENCH, 'results');
const GATE_KIND = 'pandamstyle-ce003-gate';

const tool = (script, args) =>
  spawnSync(
    process.execPath,
    [path.join(REPO, 'tools/baselines', script), ...args],
    {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 1 << 30,
    },
  );
const git = (args) =>
  spawnSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 30 });
const rel = (file) => path.relative(REPO, file);
const declarationsOf = (derivation) =>
  derivation.stylesheets.flatMap((s) => s.declarations);

// ----------------------------------------------------------------- checks

function manifestCheck() {
  const r = tool('archive.mjs', ['verify', '--committed']);
  const failed = r.stdout.split('\n').filter((l) => l.startsWith('FAIL'));
  return r.status === 0 && failed.length === 0
    ? []
    : failed.length > 0
      ? failed
      : [`archive.mjs verify --committed exited ${r.status}: ${r.stderr}`];
}

function workloadsCheck() {
  const ids = readJson(path.join(BENCH, 'workloads.v1.json')).workloads.map(
    (w) => w.id,
  );
  const r = tool('workloads.mjs', ['digest']);
  if (r.status !== 0)
    return [`workloads.mjs digest exited ${r.status}: ${r.stderr}`];
  const lines = r.stdout.split('\n').filter(Boolean);
  const problems = lines.filter((l) => !l.endsWith(' frozen'));
  const seen = lines.map((l) => l.split(' ')[0]);
  if (JSON.stringify(seen) !== JSON.stringify(ids))
    problems.push(`digested ${seen.join(', ')}; frozen ${ids.join(', ')}`);
  return problems;
}

async function derivationCheck() {
  const problems = [];
  const record = readJson(path.join(BENCH, RECORD));
  const accountingBytes = gitBlob(CORPUS_COMMIT, ACCOUNTING);
  const same = (name, actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      problems.push(`${name} differs from the derivation`);
  };
  same('inputs.accounting', record.inputs?.accounting, {
    commit: CORPUS_COMMIT,
    path: ACCOUNTING,
    sha256: sha256(accountingBytes),
  });
  same('inputs.policy', record.inputs?.policy, {
    commit: POLICY_COMMIT,
    ...ALPHA1_POLICY,
  });
  const all = prune(
    candidates(JSON.parse(accountingBytes), await loadPolicy()),
  );
  const ids = new Set(declarationsOf(all).map((d) => d.id));
  const excluded = (record.excluded ?? []).map((e) => e.id);
  for (const id of excluded)
    if (!ids.has(id)) problems.push(`excluded ${id} is not a candidate`);
  if (new Set(excluded).size !== excluded.length)
    problems.push('an exclusion is listed twice');
  const out = new Set(excluded);
  const expected = prune({
    ...all,
    stylesheets: all.stylesheets.map((s) => ({
      ...s,
      declarations: s.declarations.filter((d) => !out.has(d.id)),
    })),
  });
  same('tokens', record.tokens, expected.tokens);
  same('stylesheets', record.stylesheets, expected.stylesheets);
  same('totals', record.totals, {
    candidates: ids.size,
    included: declarationsOf(expected).length,
    excluded: out.size,
    tokens: Object.values(expected.tokens).reduce(
      (n, t) => n + Object.keys(t).length,
      0,
    ),
  });
  return problems;
}

function resultFiles(dir = RESULTS) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? resultFiles(path.join(dir, e.name))
        : [path.join(dir, e.name)],
    )
    .sort();
}

function resultsCheck(work) {
  const problems = [];
  const files = resultFiles();
  for (const raw of files.filter((f) => path.basename(f) === 'raw.json')) {
    const summary = path.join(path.dirname(raw), 'summary.json');
    const out = path.join(
      work,
      `summary-${problems.length}-${Date.now()}.json`,
    );
    const r = tool('summarize.mjs', [raw, '--out', out]);
    if (r.status !== 0 || !fs.existsSync(out))
      problems.push(`${rel(raw)}: summarize.mjs exited ${r.status}`);
    else if (!fs.existsSync(summary))
      problems.push(`${rel(summary)} is not committed`);
    else if (!fs.readFileSync(out).equals(fs.readFileSync(summary)))
      problems.push(`${rel(summary)} does not re-derive from ${rel(raw)}`);
  }
  const reports = files.filter((f) => {
    if (!f.endsWith('.json') || /\/(raw|summary)\.json$/.test(f)) return false;
    try {
      return readJson(f).kind === GATE_KIND;
    } catch {
      return false;
    }
  });
  if (reports.length === 0) problems.push('no committed gate report');
  for (const file of reports) {
    const report = readJson(file);
    const args = [
      'gate',
      '--rev',
      String(report.provenance?.commit),
      '--candidate',
      String(report.candidate),
      '--reference',
      String(report.reference),
    ];
    for (const { label } of report.load ?? [])
      args.push('--results', path.join(RESULTS, String(label), 'raw.json'));
    const r = tool('budgets.mjs', args);
    let regenerated = null;
    try {
      regenerated = JSON.parse(r.stdout);
      regenerated.provenance.rev = report.provenance.rev;
    } catch {
      problems.push(`${rel(file)}: the gate produced no report (${r.stderr})`);
      continue;
    }
    if (JSON.stringify(regenerated) !== JSON.stringify(report))
      problems.push(
        `${rel(file)} does not re-derive from its runs at ${String(report.provenance?.commit).slice(0, 12)}`,
      );
  }
  return problems;
}

function budgetsCheck(work) {
  const problems = [];
  const versions = fs
    .readdirSync(BENCH)
    .filter((f) => /^budgets\.v\d+\.json$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (versions.length === 0) problems.push('no committed budgets');
  for (const name of versions) {
    const file = path.join(BENCH, name);
    const budgets = readJson(file);
    const out = path.join(work, `re-frozen-${name}`);
    const args = ['freeze', '--policy', path.join(REPO, budgets.policy.path)];
    for (const ref of budgets.baseline.results)
      args.push('--results', path.join(REPO, ref.path));
    const r = tool('budgets.mjs', [...args, '--out', out]);
    if (r.status !== 0 || !fs.existsSync(out))
      problems.push(`${rel(file)}: budgets.mjs freeze exited ${r.status}`);
    else if (!fs.readFileSync(out).equals(fs.readFileSync(file)))
      problems.push(`${rel(file)} does not re-freeze byte for byte`);
  }
  // The gate at HEAD verifies the budgets in force back to version 1 from
  // Git; a null comparison of their own baseline runs must pass.
  const inForce = versions.at(-1);
  if (inForce != null) {
    const refs = readJson(path.join(BENCH, inForce)).baseline.results;
    const raws = refs.map((ref) => readJson(path.join(REPO, ref.path)));
    const candidates = [
      ...new Set(
        raws.flatMap((raw) =>
          raw.epochs.map((e) => e.name).filter((n) => n !== 'alpha1'),
        ),
      ),
    ];
    if (candidates.length !== 1)
      problems.push(
        `${inForce}: baseline runs name ${candidates.length} candidates`,
      );
    else {
      const args = ['gate', '--rev', 'HEAD', '--candidate', candidates[0]];
      for (const ref of refs) args.push('--results', path.join(REPO, ref.path));
      const r = tool('budgets.mjs', args);
      let verdict = null;
      try {
        verdict = JSON.parse(r.stdout).verdict;
      } catch {}
      if (verdict !== 'pass')
        problems.push(
          `gate at HEAD on the ${inForce} baseline runs: ${verdict ?? r.stderr.trim()}`,
        );
    }
  }
  return problems;
}

function frozenCheck() {
  if (git(['rev-parse', '--is-shallow-repository']).stdout.trim() !== 'false')
    return ['shallow clone: the frozen check needs the full Git history'];
  const log = git([
    'log',
    '--first-parent',
    '--diff-merges=first-parent',
    '--no-renames',
    '--diff-filter=A',
    '--format=%x00%H',
    '--name-only',
    'HEAD',
    '--',
    BENCH_DIR,
  ]);
  if (log.status !== 0) return [`git log failed: ${log.stderr}`];
  // Newest first: the last commit seen for a path is the one that added it.
  const added = new Map();
  for (const chunk of log.stdout.split('\0').filter(Boolean)) {
    const [commit, ...names] = chunk.split('\n').filter(Boolean);
    for (const name of names) added.set(name, commit);
  }
  added.delete(`${BENCH_DIR}/README.md`);
  if (added.size === 0) return ['no frozen file in the first-parent history'];
  const blob = (spec) => {
    const r = git(['rev-parse', '--verify', '--quiet', spec]);
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const problems = [];
  for (const [name, commit] of [...added].sort()) {
    const first = blob(`${commit}:${name}`);
    const head = blob(`HEAD:${name}`);
    const file = path.join(REPO, name);
    const tree = fs.existsSync(file)
      ? execFileSync('git', ['hash-object', '--', file], {
          cwd: REPO,
          encoding: 'utf8',
        }).trim()
      : null;
    if (head == null) problems.push(`${name} was removed`);
    else if (head !== first)
      problems.push(`${name} changed since ${commit.slice(0, 12)}`);
    if (tree !== first && head === first)
      problems.push(`${name} differs in the working tree`);
  }
  return problems;
}

export async function validate() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ce003-records-'));
  try {
    const groups = [];
    const run = async (name, fn) => {
      let problems;
      try {
        problems = await fn();
      } catch (error) {
        problems = [`error: ${error.message}`];
      }
      groups.push({ name, ok: problems.length === 0, problems });
    };
    await run('manifest', manifestCheck);
    await run('workloads', workloadsCheck);
    await run('ce-corpus derivation', derivationCheck);
    await run('results', () => resultsCheck(work));
    await run('budgets', () => budgetsCheck(work));
    await run('frozen', frozenCheck);
    return groups;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------- mutations

const editJson = (dir, file, fn) => {
  const target = path.join(dir, file);
  const value = JSON.parse(fs.readFileSync(target, 'utf8'));
  fn(value);
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
};
const B = BENCH_DIR;
const flip = (hex) => `${hex[0] === '0' ? '1' : '0'}${hex.slice(1)}`;
const corpusEdit = (record) => {
  const d = declarationsOf(record).find((x) => typeof x.literal === 'number');
  d.literal += 1;
};

const MUTATIONS = [
  { name: 'control: no edit', expect: [] },
  {
    name: 'manifest corpus entry digest',
    expect: ['manifest'],
    edit: (dir) =>
      editJson(dir, `${B}/epochs/alpha1/manifest.v1.json`, (m) => {
        m.corpora[0].entries[0].sha256 = flip(m.corpora[0].entries[0].sha256);
      }),
  },
  {
    name: 'manifest source tree',
    expect: ['manifest'],
    edit: (dir) =>
      editJson(dir, `${B}/epochs/alpha1/manifest.v1.json`, (m) => {
        m.source.tree = flip(m.source.tree);
      }),
  },
  {
    name: 'frozen workload: ce-corpus declaration',
    expect: ['workloads', 'ce-corpus derivation'],
    edit: (dir) => editJson(dir, `${B}/${RECORD}`, corpusEdit),
  },
  {
    name: 'frozen workload: ce-corpus declaration, digest re-bound',
    expect: ['ce-corpus derivation'],
    edit: (dir) => {
      editJson(dir, `${B}/${RECORD}`, corpusEdit);
      const digest = execFileSync(
        process.execPath,
        [
          path.join(dir, 'tools/baselines/workloads.mjs'),
          'digest',
          'ce-corpus',
        ],
        { cwd: dir, encoding: 'utf8' },
      ).split(' ')[1];
      editJson(dir, `${B}/workloads.v1.json`, (w) => {
        w.workloads.find((x) => x.id === 'ce-corpus').contentSha256 = digest;
      });
    },
  },
  {
    name: 'frozen workload: synthetic seed',
    expect: ['workloads'],
    edit: (dir) =>
      editJson(dir, `${B}/workloads.v1.json`, (w) => {
        w.workloads.find((x) => x.source.kind === 'synthetic').source.seed += 1;
      }),
  },
  {
    name: 'result sample of a gate run',
    expect: ['results'],
    edit: (dir) =>
      editJson(dir, `${B}/results/gate-injected-slowdown/raw.json`, (raw) => {
        raw.samples[0].result.moduleLoadMs *= 2;
      }),
  },
  {
    name: 'result sample of a baseline run',
    expect: ['results', 'budgets'],
    edit: (dir) =>
      editJson(dir, `${B}/results/alpha1-v3-sk-c1/raw.json`, (raw) => {
        raw.samples[0].result.moduleLoadMs *= 2;
      }),
  },
  {
    name: 'committed summary',
    expect: ['results'],
    edit: (dir) =>
      editJson(dir, `${B}/results/alpha1-final-1/summary.json`, (summary) => {
        summary.sampleCount += 1;
      }),
  },
  {
    name: 'committed gate report',
    expect: ['results'],
    edit: (dir) =>
      editJson(
        dir,
        `${B}/results/gate-null-alpha1-replay-v3.json`,
        (report) => {
          report.results[0].pairedRatio.upper += 0.01;
        },
      ),
  },
  {
    name: 'budget limit',
    expect: ['budgets'],
    edit: (dir) =>
      editJson(dir, `${B}/budgets.v3.json`, (b) => {
        b.budgets.find((x) => x.limit?.maxRatio != null).limit.maxRatio += 0.05;
      }),
  },
  {
    name: 'frozen file edited',
    expect: ['frozen'],
    edit: (dir) =>
      fs.appendFileSync(
        path.join(dir, B, 'results/gate-injected-slowdown/make-candidate.mjs'),
        '// edited\n',
      ),
  },
  {
    name: 'frozen file edited, not committed',
    expect: ['frozen'],
    commit: false,
    edit: (dir) =>
      fs.appendFileSync(
        path.join(dir, B, 'results/gate-injected-slowdown/make-candidate.mjs'),
        '// edited\n',
      ),
  },
  {
    name: 'frozen file removed',
    expect: ['frozen'],
    edit: (dir) =>
      fs.rmSync(path.join(dir, B, 'epochs/alpha1/npm-cache.v1.json')),
  },
];

function runAsync(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function mutations() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ce003-records-mut-'));
  try {
    const outcomes = await Promise.all(
      MUTATIONS.map(async (m, i) => {
        const dir = path.join(work, `clone-${i}`);
        execFileSync('git', ['clone', '--quiet', '--shared', REPO, dir]);
        if (fs.existsSync(path.join(REPO, 'node_modules')))
          fs.symlinkSync(
            path.join(REPO, 'node_modules'),
            path.join(dir, 'node_modules'),
          );
        if (m.edit != null) m.edit(dir);
        if (m.edit != null && m.commit !== false) {
          const commit = [
            '-c',
            'user.name=mutation',
            '-c',
            'user.email=mutation@invalid',
            'commit',
            '--quiet',
            '-m',
            m.name,
          ];
          execFileSync('git', ['add', '--all'], { cwd: dir });
          execFileSync('git', commit, { cwd: dir });
        }
        const r = await runAsync(
          [path.join(dir, 'tools/baselines/validate-records.mjs'), '--json'],
          dir,
        );
        let groups;
        try {
          groups = JSON.parse(r.stdout);
        } catch {
          return {
            m,
            ok: false,
            failed: [`no report: ${r.stderr.trim().split('\n').at(-1)}`],
          };
        }
        const failed = groups.filter((g) => !g.ok).map((g) => g.name);
        const ok =
          m.expect.length === 0
            ? failed.length === 0 && r.status === 0
            : m.expect.every((name) => failed.includes(name)) && r.status !== 0;
        return { m, ok, failed };
      }),
    );
    for (const { m, ok, failed } of outcomes)
      console.log(
        `${ok ? 'ok  ' : 'FAIL'} ${m.name}: expected failing [${m.expect.join(', ')}], failed [${failed.join(', ')}]`,
      );
    const bad = outcomes.filter((o) => !o.ok).length;
    console.log(
      `record mutations: ${outcomes.length - bad}/${outcomes.length} as expected`,
    );
    return bad === 0;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------------- cli

async function main() {
  if (process.argv.includes('--mutations')) {
    if (!(await mutations())) process.exitCode = 1;
    return;
  }
  const groups = await validate();
  if (process.argv.includes('--json'))
    process.stdout.write(`${JSON.stringify(groups)}\n`);
  else {
    for (const g of groups) {
      console.log(`${g.ok ? 'ok  ' : 'FAIL'} ${g.name}`);
      for (const p of g.problems) console.log(`     ${p}`);
    }
    const failed = groups.filter((g) => !g.ok).length;
    console.log(
      `committed records: ${groups.length - failed}/${groups.length} checks passed`,
    );
  }
  if (groups.some((g) => !g.ok)) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  });
