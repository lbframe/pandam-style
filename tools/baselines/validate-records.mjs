/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Committed CE-00.3 record validation.
//
//   node tools/baselines/validate-records.mjs [--base <rev>] [--json]
//   node tools/baselines/validate-records.mjs --mutations [--base <rev>]
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
// - budgets: every budgets.vN.json re-freezes byte for byte from its policy
//   and baseline runs (`budgets.mjs freeze`). This couples the derivation to
//   the committed policies on purpose: a derivation change must keep every
//   committed version reproducible;
// - frozen: every file under benchmarks/core-evolution, except README.md,
//   that is published in the base is byte-identical at HEAD and in the
//   working tree. The base is `--base <rev>`, else the merge base of HEAD
//   and origin/main, or HEAD's first parent when HEAD is already on
//   origin/main. Files absent from the base are unpublished and unconstrained
//   by this rule.
//
// Committed results, summaries and gate reports are evidence: the frozen
// rule protects their bytes, and they are not recomputed with today's
// scripts.
//
// Local-only, because they need the archived alpha1 store: the store digests
// (`archive.mjs verify --store <copy> --replay`), and the CE-00.2 corpus
// exclusions, which only the Alpha 1 compiler decides
// (`derive-ce-corpus.mjs --closure <store>/closure`, then `git diff`).
//
// --mutations commits one edit per class to a temporary clone of HEAD and
// requires the validator of that clone, with the same base, to fail the
// checks of that class; an unmutated clone must pass. It then runs the frozen
// rule on temporary repositories built with real Git histories (branch,
// merge, squash, rebase, detached HEAD). Uncommitted changes are not part of
// the clone.

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
const README = `${BENCH_DIR}/README.md`;

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
const git = (args, root = REPO) =>
  spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30 });
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
  return problems;
}

// The base whose published files are frozen.
export function baseOf(root = REPO, explicit = null) {
  const commit = (spec) => {
    const r = git(
      ['rev-parse', '--verify', '--quiet', `${spec}^{commit}`],
      root,
    );
    return r.status === 0 ? r.stdout.trim() : null;
  };
  if (explicit != null) {
    const base = commit(explicit);
    if (base == null) throw new Error(`unknown base ${explicit}`);
    return base;
  }
  if (commit('origin/main') == null)
    throw new Error('no origin/main: fetch it or pass --base <rev>');
  const mb = git(['merge-base', 'HEAD', 'origin/main'], root);
  if (mb.status !== 0) throw new Error('HEAD and origin/main share no history');
  const base = mb.stdout.trim();
  if (base !== commit('HEAD')) return base;
  const parent = commit('HEAD^1');
  if (parent == null) throw new Error('HEAD has no first parent');
  return parent;
}

export function frozenProblems(root = REPO, explicitBase = null) {
  if (
    git(['rev-parse', '--is-shallow-repository'], root).stdout.trim() !==
    'false'
  )
    return ['shallow clone: the frozen check needs the full Git history'];
  let base;
  try {
    base = baseOf(root, explicitBase);
  } catch (error) {
    return [error.message];
  }
  const listing = git(['ls-tree', '-r', '-z', base, '--', BENCH_DIR], root);
  if (listing.status !== 0) return [`git ls-tree failed: ${listing.stderr}`];
  const published = listing.stdout
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [meta, name] = line.split('\t');
      return { name, blob: meta.split(' ')[2] };
    })
    .filter(({ name }) => name !== README);
  const problems = [];
  for (const { name, blob } of published) {
    const r = git(['rev-parse', '--verify', '--quiet', `HEAD:${name}`], root);
    const head = r.status === 0 ? r.stdout.trim() : null;
    const file = path.join(root, name);
    const tree = fs.existsSync(file)
      ? execFileSync('git', ['hash-object', '--', file], {
          cwd: root,
          encoding: 'utf8',
        }).trim()
      : null;
    if (head == null) problems.push(`${name} was removed or renamed`);
    else if (head !== blob)
      problems.push(`${name} differs from the base ${base.slice(0, 12)}`);
    else if (tree !== blob)
      problems.push(`${name} differs in the working tree`);
  }
  return problems;
}

export async function validate({ base = null } = {}) {
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
    await run('budgets', () => budgetsCheck(work));
    await run('frozen', () => frozenProblems(REPO, base));
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
    expect: ['frozen'],
    edit: (dir) =>
      editJson(dir, `${B}/results/gate-injected-slowdown/raw.json`, (raw) => {
        raw.samples[0].result.moduleLoadMs *= 2;
      }),
  },
  {
    name: 'result sample of a baseline run',
    expect: ['budgets', 'frozen'],
    edit: (dir) =>
      editJson(dir, `${B}/results/alpha1-v3-sk-c1/raw.json`, (raw) => {
        raw.samples[0].result.moduleLoadMs *= 2;
      }),
  },
  {
    name: 'committed summary',
    expect: ['frozen'],
    edit: (dir) =>
      editJson(dir, `${B}/results/alpha1-final-1/summary.json`, (summary) => {
        summary.sampleCount += 1;
      }),
  },
  {
    name: 'committed gate report',
    expect: ['frozen'],
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
    expect: ['budgets', 'frozen'],
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

// ------------------------------------------------ frozen-rule topologies

// Each fixture is a temporary repository with a real history: `main`
// publishes A (and the README), then the scenario runs. `origin/main` is a
// real ref set to the published tip, as a fetch would leave it.
const FA = `${BENCH_DIR}/a.json`;
const FB = `${BENCH_DIR}/b.json`;

function fixtureRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const g = (...args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', ...args],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const commit = (message, files = {}) => {
    for (const [file, text] of Object.entries(files)) write(file, text);
    g('add', '--all');
    g('commit', '--quiet', '--allow-empty', '-m', message);
  };
  g('init', '--quiet', '--initial-branch=main');
  commit('publish', { [FA]: 'a1\n', [README]: 'r1\n' });
  const publish = () => g('update-ref', 'refs/remotes/origin/main', 'main');
  publish();
  return { g, write, commit, publish };
}

const TOPOLOGIES = [
  {
    name: 'branch: published file edited',
    expect: 'reject',
    because: 'differs from the base',
    run: ({ g, commit }) => {
      g('checkout', '--quiet', '-b', 'topic');
      commit('edit A', { [FA]: 'a2\n' });
    },
  },
  {
    name: 'branch: file added then edited before merge',
    expect: 'accept',
    run: ({ g, commit }) => {
      g('checkout', '--quiet', '-b', 'topic');
      commit('add B', { [FB]: 'b1\n' });
      commit('edit B', { [FB]: 'b2\n' });
    },
  },
  {
    name: 'branch: README edited',
    expect: 'accept',
    run: ({ g, commit }) => {
      g('checkout', '--quiet', '-b', 'topic');
      commit('edit README', { [README]: 'r2\n' });
    },
  },
  {
    name: 'branch: published file removed',
    expect: 'reject',
    because: 'removed or renamed',
    run: ({ g, commit }) => {
      g('checkout', '--quiet', '-b', 'topic');
      g('rm', '--quiet', FA);
      commit('remove A');
    },
  },
  {
    name: 'branch: published file renamed',
    expect: 'reject',
    because: 'removed or renamed',
    run: ({ g, commit }) => {
      g('checkout', '--quiet', '-b', 'topic');
      g('mv', FA, `${BENCH_DIR}/renamed.json`);
      commit('rename A');
    },
  },
  {
    name: 'branch: published file edited, not committed',
    expect: 'reject',
    because: 'differs in the working tree',
    run: ({ g, commit, write }) => {
      g('checkout', '--quiet', '-b', 'topic');
      commit('other', { 'other.txt': 'o\n' });
      write(FA, 'a2\n');
    },
  },
  {
    name: 'PR merge ref: published file edited on the branch',
    expect: 'reject',
    because: 'differs from the base',
    run: ({ g, commit }) => {
      g('checkout', '--quiet', '-b', 'topic');
      commit('edit A', { [FA]: 'a2\n' });
      g('checkout', '--quiet', '--detach', 'main');
      g('merge', '--quiet', '--no-ff', '-m', 'merge ref', 'topic');
    },
  },
  {
    name: 'merge commit on main: file added then edited before merge',
    expect: 'accept',
    run: ({ g, commit, publish }) => {
      g('checkout', '--quiet', '-b', 'topic');
      commit('add B', { [FB]: 'b1\n' });
      commit('edit B', { [FB]: 'b2\n' });
      g('checkout', '--quiet', 'main');
      g('merge', '--quiet', '--no-ff', '-m', 'merge topic', 'topic');
      publish();
    },
  },
  {
    name: 'merge commit on main, then the merged file edited',
    expect: 'reject',
    because: 'differs from the base',
    run: ({ g, commit, publish }) => {
      g('checkout', '--quiet', '-b', 'topic');
      commit('add B', { [FB]: 'b1\n' });
      g('checkout', '--quiet', 'main');
      g('merge', '--quiet', '--no-ff', '-m', 'merge topic', 'topic');
      publish();
      commit('edit B', { [FB]: 'b2\n' });
      publish();
    },
  },
  {
    name: 'squash on main: file added then edited before merge',
    expect: 'accept',
    run: ({ g, commit, publish }) => {
      g('checkout', '--quiet', '-b', 'topic');
      commit('add B', { [FB]: 'b1\n' });
      commit('edit B', { [FB]: 'b2\n' });
      g('checkout', '--quiet', 'main');
      g('merge', '--quiet', '--squash', 'topic');
      commit('squash topic');
      publish();
    },
  },
  {
    name: 'squash on main: published file edited',
    expect: 'reject',
    because: 'differs from the base',
    run: ({ g, commit, publish }) => {
      g('checkout', '--quiet', '-b', 'topic');
      commit('edit A', { [FA]: 'a2\n' });
      g('checkout', '--quiet', 'main');
      g('merge', '--quiet', '--squash', 'topic');
      commit('squash topic');
      publish();
    },
  },
  {
    name: 'rebased branch: published file edited in an earlier commit',
    expect: 'reject',
    because: 'differs from the base',
    run: ({ g, commit, publish }) => {
      g('checkout', '--quiet', '-b', 'topic');
      commit('edit A', { [FA]: 'a2\n' });
      commit('other', { 'other.txt': 'o\n' });
      g('checkout', '--quiet', 'main');
      commit('main moves', { 'main.txt': 'm\n' });
      publish();
      g('checkout', '--quiet', 'topic');
      g('rebase', '--quiet', 'main');
    },
  },
  {
    name: 'rebased branch: file added then edited before merge',
    expect: 'accept',
    run: ({ g, commit, publish }) => {
      g('checkout', '--quiet', '-b', 'topic');
      commit('add B', { [FB]: 'b1\n' });
      commit('edit B', { [FB]: 'b2\n' });
      g('checkout', '--quiet', 'main');
      commit('main moves', { 'main.txt': 'm\n' });
      publish();
      g('checkout', '--quiet', 'topic');
      g('rebase', '--quiet', 'main');
    },
  },
  {
    name: 'rebase merge pushed to main, published file edited in an earlier commit, --base <tip before the push>',
    expect: 'reject',
    because: 'differs from the base',
    run: ({ g, commit, publish }) => {
      const before = g('rev-parse', 'main');
      commit('edit A', { [FA]: 'a2\n' });
      commit('other', { 'other.txt': 'o\n' });
      publish();
      return before;
    },
  },
  {
    name: 'detached HEAD: published file edited',
    expect: 'reject',
    because: 'differs from the base',
    run: ({ g, commit }) => {
      g('checkout', '--quiet', '-b', 'topic');
      commit('edit A', { [FA]: 'a2\n' });
      g('checkout', '--quiet', '--detach', 'topic');
    },
  },
  {
    name: 'detached HEAD: unchanged',
    expect: 'accept',
    run: ({ g, commit }) => {
      g('checkout', '--quiet', '-b', 'topic');
      commit('other', { 'other.txt': 'o\n' });
      g('checkout', '--quiet', '--detach', 'topic');
    },
  },
  {
    name: 'no origin/main and no --base',
    expect: 'reject',
    because: 'no origin/main',
    run: ({ g }) => {
      g('update-ref', '-d', 'refs/remotes/origin/main');
    },
  },
];

function topologies(work) {
  return TOPOLOGIES.map((t, i) => {
    let problems;
    try {
      const base = t.run(fixtureRepo(path.join(work, `topology-${i}`)));
      problems = frozenProblems(path.join(work, `topology-${i}`), base ?? null);
    } catch (error) {
      problems = [`fixture error: ${error.message}`];
      return { t, ok: false, problems };
    }
    // A rejection counts only for its expected reason.
    const ok =
      t.expect === 'reject'
        ? problems.length > 0 && problems.every((p) => p.includes(t.because))
        : problems.length === 0;
    return { t, ok, problems };
  });
}

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

async function mutations(explicitBase) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ce003-records-mut-'));
  try {
    const base = baseOf(REPO, explicitBase);
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
          [
            path.join(dir, 'tools/baselines/validate-records.mjs'),
            '--json',
            '--base',
            base,
          ],
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
    const fixtures = topologies(work);
    for (const { t, ok, problems } of fixtures)
      console.log(
        `${ok ? 'ok  ' : 'FAIL'} ${t.name}: expected ${t.expect}, ${problems.length === 0 ? 'accepted' : `rejected (${problems[0]})`}`,
      );
    const badFixtures = fixtures.filter((f) => !f.ok).length;
    console.log(
      `frozen-rule topologies: ${fixtures.length - badFixtures}/${fixtures.length} as expected`,
    );
    return bad === 0 && badFixtures === 0;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------------- cli

async function main() {
  const at = process.argv.indexOf('--base');
  const base = at >= 0 ? process.argv[at + 1] : null;
  if (process.argv.includes('--mutations')) {
    if (!(await mutations(base))) process.exitCode = 1;
    return;
  }
  const groups = await validate({ base });
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
