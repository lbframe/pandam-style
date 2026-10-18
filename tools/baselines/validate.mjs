/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CE-00.3 record validator and mutation self-test.
//
//   node tools/baselines/validate.mjs [--self-test]
//
// Reads committed files and Git objects only (no store, no network). It
// checks that:
//   - the alpha1 manifest names the baseline commit and tree, the published
//     tarball integrities, a closure lockfile that pins exactly those
//     tarballs, reproducible source packs whose only differences from the
//     registry are documentation, the CE-00.2 engine, and corpora whose
//     digests match the Git objects;
//   - every workload re-materializes to its frozen digest, its plans and
//     edits are well formed, and the CE-00.2 derivation re-derives from the
//     pinned accounting and policy;
//   - every result run measured the unchanged alpha1 tarballs with the
//     committed harness, recorded load before and after, started quiet,
//     completed its plan without failures, and its summary re-derives;
//   - budgets.v1.json re-derives from its policy and the referenced runs,
//     the policy chain is valid, unknown metrics are explicit, and the
//     unchanged artifact (alpha1-replay) passes its own budgets;
//   - committed frozen files equal the version of the commit that added them.
//
// --self-test then applies mutations in memory; each must be rejected.

import fs from 'node:fs';
import path from 'node:path';
import { BENCH, REPO, git, gitBlob, readJson, sha256 } from './lib.mjs';
import { buildFiles, projectDigest } from './workloads.mjs';
import { summarizeRun } from './summarize.mjs';
import {
  deriveBudgets,
  evaluate,
  frozenFileChange,
  policyChainProblems,
} from './budgets.mjs';
import {
  ACCOUNTING,
  CORPUS_COMMIT,
  candidates,
  loadPolicy as loadAlpha1Policy,
  prune,
} from './derive-ce-corpus.mjs';
import { ALPHA1_POLICY } from '../coverage/classify.mjs';
import { COMMIT, CORPORA, PACKAGES, VERSION } from './archive.mjs';

const rel = (file) => path.relative(REPO, file);
const FILES = {
  manifest: path.join(BENCH, 'epochs/alpha1/manifest.v1.json'),
  closurePackage: path.join(BENCH, 'epochs/alpha1/closure/package.json'),
  closureLock: path.join(BENCH, 'epochs/alpha1/closure/package-lock.json'),
  workloads: path.join(BENCH, 'workloads.v1.json'),
  ceCorpus: path.join(BENCH, 'workloads/ce-corpus.v1.json'),
  policy: path.join(BENCH, 'budget-policy.v1.json'),
  budgets: path.join(BENCH, 'budgets.v1.json'),
};
const HARNESS = [
  'lib.mjs',
  'sample.mjs',
  'measure.mjs',
  'workloads.mjs',
  'summarize.mjs',
];
const CE002_ENGINE = 'tests/core-evolution/corpus/reference-check.v1.json';

// ------------------------------------------------------------------ loading

export function loadRecords() {
  const bytes = {};
  const json = {};
  for (const [key, file] of Object.entries(FILES)) {
    if (!fs.existsSync(file)) continue;
    bytes[rel(file)] = fs.readFileSync(file);
    json[key] = JSON.parse(bytes[rel(file)]);
  }
  const results = {};
  const resultsDir = path.join(BENCH, 'results');
  if (fs.existsSync(resultsDir))
    for (const label of fs.readdirSync(resultsDir).sort()) {
      const rawFile = path.join(resultsDir, label, 'raw.json');
      if (!fs.existsSync(rawFile)) continue;
      bytes[rel(rawFile)] = fs.readFileSync(rawFile);
      const summaryFile = path.join(resultsDir, label, 'summary.json');
      results[label] = {
        rawPath: rel(rawFile),
        raw: JSON.parse(bytes[rel(rawFile)]),
        summary: fs.existsSync(summaryFile) ? readJson(summaryFile) : null,
      };
    }
  return { bytes, json, results };
}

// Facts from Git objects, computed once and shared by every mutation run.
export async function loadContext() {
  const accountingBytes = gitBlob(CORPUS_COMMIT, ACCOUNTING);
  const policy = await loadAlpha1Policy();
  return {
    tree: git(['rev-parse', `${COMMIT}^{tree}`]).trim(),
    yarnLock: sha256(gitBlob(COMMIT, 'yarn.lock')),
    accountingSha256: sha256(accountingBytes),
    candidates: prune(candidates(JSON.parse(accountingBytes), policy)),
    ce002Engine: readJson(path.join(REPO, CE002_ENGINE)).engine,
    blob: (commit, file) => sha256(gitBlob(commit, file)),
    corpusFiles: (commit, prefixes) =>
      prefixes
        .flatMap((prefix) =>
          git(['ls-tree', '-r', '--name-only', commit, '--', prefix])
            .split('\n')
            .filter(Boolean),
        )
        .sort(),
  };
}

// ---------------------------------------------------------------- validation

function checkManifest(records, ctx, errors) {
  const m = records.json.manifest;
  if (m == null) return errors.push('manifest: missing');
  const closureLockBytes = records.bytes[rel(FILES.closureLock)];
  const lock = JSON.parse(closureLockBytes);
  if (m.epoch !== 'alpha1' || m.epochKind !== 'baseline')
    errors.push('manifest: epoch must be the alpha1 baseline');
  if (m.source.commit !== COMMIT)
    errors.push('manifest: source commit is not the Alpha 1 baseline commit');
  if (m.source.tree !== ctx.tree)
    errors.push('manifest: source tree does not match the baseline commit');
  const names = m.packages.map((p) => p.name).sort();
  const expected = PACKAGES.map((p) => `@pandamstyle/${p}`).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected))
    errors.push('manifest: package set differs from the five Alpha 1 packages');
  for (const pkg of m.packages) {
    if (pkg.version !== VERSION)
      errors.push(`manifest: ${pkg.name} version is not ${VERSION}`);
    if (
      pkg.registry.integrity !== pkg.registry.registryIntegrity ||
      !pkg.registry.integrityMatchesRegistry
    )
      errors.push(
        `manifest: ${pkg.name} archived tarball integrity differs from the registry`,
      );
    const locked = lock.packages[`node_modules/${pkg.name}`];
    if (
      locked?.integrity !== pkg.registry.registryIntegrity ||
      pkg.closureLock.integrity !== pkg.registry.registryIntegrity
    )
      errors.push(
        `manifest: ${pkg.name} closure lock integrity differs from the registry tarball`,
      );
    if (
      !pkg.sourcePack.reproducible ||
      pkg.sourcePack.repeatSha256 !== pkg.sourcePack.sha256
    )
      errors.push(`manifest: ${pkg.name} source pack is not reproducible`);
    if (
      pkg.sourcePack.identicalToRegistry !==
      (pkg.sourcePack.contentDifferences.length === 0 &&
        pkg.sourcePack.sha256 === pkg.registry.sha256)
    )
      errors.push(
        `manifest: ${pkg.name} identicalToRegistry contradicts its differences`,
      );
    for (const d of pkg.sourcePack.contentDifferences)
      if (!/^package\/docs\//.test(d.file))
        errors.push(
          `manifest: ${pkg.name} source pack differs from the registry outside documentation (${d.file})`,
        );
  }
  const lockfiles = Object.fromEntries(m.lockfiles.map((l) => [l.path, l]));
  if (
    lockfiles['yarn.lock']?.sha256 !== ctx.yarnLock ||
    lockfiles['yarn.lock']?.commit !== COMMIT
  )
    errors.push(
      'manifest: yarn.lock digest does not match the baseline commit',
    );
  if (lockfiles[rel(FILES.closureLock)]?.sha256 !== sha256(closureLockBytes))
    errors.push(
      'manifest: closure lockfile digest does not match the committed lockfile',
    );
  if (
    lockfiles[rel(FILES.closurePackage)]?.sha256 !==
    sha256(records.bytes[rel(FILES.closurePackage)])
  )
    errors.push('manifest: closure package.json digest does not match');
  for (const host of [
    'vite',
    'next',
    '@rsbuild/core',
    '@rspack/core',
    'react',
    'react-dom',
    'playwright-core',
  ])
    if (
      lock.packages[`node_modules/${host}`]?.version !== m.closure.hosts[host]
    )
      errors.push(`manifest: host ${host} differs from the closure lockfile`);
  const chromium = m.engines.find((e) => e.name === 'chromium');
  if (
    chromium?.browserVersion !== ctx.ce002Engine.version ||
    chromium?.playwrightCore !== ctx.ce002Engine.playwrightCore
  )
    errors.push(
      'manifest: archived Chromium is not the CE-00.2 reference-check engine',
    );
  if (!m.node.some((n) => n.version === m.measurementNode.version))
    errors.push('manifest: measurement Node runtime is not archived');
  for (const corpus of [...m.corpora, m.assets]) {
    const recomputed = sha256(
      corpus.entries.map((f) => `${f.path} ${f.sha256}`).join('\n'),
    );
    if (recomputed !== corpus.sha256 || corpus.files !== corpus.entries.length)
      errors.push(`manifest: corpus ${corpus.id} digest is inconsistent`);
    const definition = [CORPORA.assets, ...CORPORA.corpora].find(
      (c) => c[0] === corpus.id,
    );
    if (definition == null || definition[1] !== corpus.commit) {
      errors.push(`manifest: corpus ${corpus.id} is not a defined input`);
      continue;
    }
    const prefixes = definition[2];
    const files = ctx.corpusFiles(corpus.commit, prefixes);
    if (
      JSON.stringify(files) !==
      JSON.stringify(corpus.entries.map((e) => e.path))
    )
      errors.push(`manifest: corpus ${corpus.id} file list differs from Git`);
    else
      for (const entry of corpus.entries)
        if (ctx.blob(corpus.commit, entry.path) !== entry.sha256)
          errors.push(
            `manifest: corpus ${corpus.id} ${entry.path} digest differs from Git`,
          );
  }
}

function checkWorkloads(records, ctx, errors) {
  const w = records.json.workloads;
  const ids = new Set();
  for (const workload of w.workloads) {
    if (ids.has(workload.id))
      errors.push(`workloads: duplicate ${workload.id}`);
    ids.add(workload.id);
    let files;
    try {
      files = buildFiles(workload);
    } catch (error) {
      errors.push(
        `workloads: ${workload.id} cannot be built: ${error.message}`,
      );
      continue;
    }
    if (projectDigest(files) !== workload.contentSha256)
      errors.push(
        `workloads: ${workload.id} does not materialize to its frozen digest`,
      );
    for (const edit of workload.edits ?? [])
      if (
        edit.kind === 'source' &&
        !(files[edit.file] ?? '').includes(edit.from)
      )
        errors.push(
          `workloads: ${workload.id} edit ${edit.id} source text not found`,
        );
  }
  for (const [planId, plan] of Object.entries(w.plans))
    for (const [id, kinds] of Object.entries(plan.repetitions)) {
      const workload = w.workloads.find((x) => x.id === id);
      if (workload == null) {
        errors.push(`workloads: plan ${planId} names unknown workload ${id}`);
        continue;
      }
      for (const [kind, count] of Object.entries(kinds)) {
        const allowed =
          kind === 'consistency'
            ? workload.kinds.includes('compile')
            : workload.kinds.includes(kind);
        if (!allowed || !Number.isInteger(count) || count < 1)
          errors.push(
            `workloads: plan ${planId} ${id} ${kind} is not a measurable kind`,
          );
      }
    }
}

function checkCeCorpus(records, ctx, errors) {
  const c = records.json.ceCorpus;
  const included = c.stylesheets.reduce((n, s) => n + s.declarations.length, 0);
  const tokens = Object.values(c.tokens).reduce(
    (n, t) => n + Object.keys(t).length,
    0,
  );
  if (
    c.totals.included !== included ||
    c.totals.excluded !== c.excluded.length ||
    c.totals.candidates !== included + c.excluded.length ||
    c.totals.tokens !== tokens
  )
    errors.push('ce-corpus: totals are inconsistent');
  if (
    c.inputs.accounting.sha256 !== ctx.accountingSha256 ||
    c.inputs.accounting.commit !== CORPUS_COMMIT
  )
    errors.push('ce-corpus: accounting input is not the pinned CE-00.2 record');
  if (c.inputs.policy.sha256 !== ALPHA1_POLICY.sha256)
    errors.push('ce-corpus: policy input is not the pinned Alpha 1 policy');
  // Every candidate is either included unchanged or excluded with a code.
  const candidateById = new Map();
  for (const sheet of ctx.candidates.stylesheets)
    for (const d of sheet.declarations) candidateById.set(d.id, d);
  const seen = new Set();
  const tokenValue = (ref, table) => {
    const [category, name] = ref.split('.');
    return table[category]?.[name];
  };
  for (const sheet of c.stylesheets)
    for (const d of sheet.declarations) {
      seen.add(d.id);
      const candidate = candidateById.get(d.id);
      if (
        candidate == null ||
        candidate.property !== d.property ||
        candidate.literal !== d.literal ||
        candidate.token !== d.token ||
        (d.token != null &&
          tokenValue(d.token, c.tokens) !==
            tokenValue(candidate.token, ctx.candidates.tokens))
      )
        errors.push(
          `ce-corpus: ${d.id} does not re-derive from the pinned inputs`,
        );
    }
  for (const x of c.excluded) {
    seen.add(x.id);
    if (typeof x.code !== 'string' || x.code === '')
      errors.push(`ce-corpus: exclusion ${x.id} has no diagnostic code`);
  }
  for (const id of candidateById.keys())
    if (!seen.has(id))
      errors.push(
        `ce-corpus: candidate ${id} is neither included nor excluded`,
      );
  for (const id of seen)
    if (!candidateById.has(id))
      errors.push(`ce-corpus: ${id} is not a candidate`);
}

function checkResults(records, ctx, errors) {
  const m = records.json.manifest;
  const w = records.json.workloads;
  const workloadsSha = sha256(records.bytes[rel(FILES.workloads)]);
  for (const [label, { raw, summary }] of Object.entries(records.results)) {
    const at = `results/${label}`;
    if (raw.kind !== 'pandamstyle-ce003-raw-results' || raw.label !== label)
      errors.push(`${at}: label or kind mismatch`);
    if (raw.workloadsRecord.sha256 !== workloadsSha)
      errors.push(`${at}: measured a different workloads record`);
    if (raw.repositoryDirty)
      errors.push(
        `${at}: measured with uncommitted harness or workload changes`,
      );
    for (const file of HARNESS) {
      let digest = null;
      try {
        digest = ctx.blob(raw.repositoryCommit, `tools/baselines/${file}`);
      } catch {}
      if (digest !== raw.harness[file])
        errors.push(
          `${at}: harness ${file} does not match its commit ${raw.repositoryCommit?.slice(0, 12)}`,
        );
    }
    const alpha1 = raw.epochs.find((e) => e.name === 'alpha1');
    if (alpha1 == null) errors.push(`${at}: no alpha1 epoch`);
    for (const epoch of raw.epochs.filter((e) => e.name.startsWith('alpha1')))
      for (const pkg of m.packages) {
        if (
          epoch.packages[pkg.name]?.integrity !== pkg.registry.registryIntegrity
        )
          errors.push(
            `${at}: ${epoch.name} did not run the unchanged ${pkg.name} tarball`,
          );
        if (
          epoch.installedPandamstyle.sha256 !==
          m.closure.installedPandamstyle.sha256
        )
          errors.push(
            `${at}: ${epoch.name} installed packages differ from the manifest`,
          );
      }
    if (!(raw.load.before?.length > 0) || raw.load.after == null)
      errors.push(`${at}: load is not recorded before and after the batch`);
    if (raw.plan.id === 'final' && raw.load.quietAtStart !== true)
      errors.push(`${at}: final batch did not start on a quiet machine`);
    if (raw.samples.some((s) => typeof s.loadavg1Before !== 'number'))
      errors.push(`${at}: a sample has no load record`);
    if (raw.environment.node !== `v${m.measurementNode.version}`)
      errors.push(`${at}: not measured with the archived Node runtime version`);
    const failed = raw.samples.filter((s) => !s.result.ok).length;
    if (failed > 0) errors.push(`${at}: ${failed} failed samples`);
    const plan = w.plans[raw.plan.id];
    for (const epoch of raw.epochs)
      for (const [id, kinds] of Object.entries(plan?.repetitions ?? {}))
        for (const [kind, count] of Object.entries(kinds)) {
          const n = raw.samples.filter(
            (s) =>
              s.epoch === epoch.name && s.workload === id && s.kind === kind,
          ).length;
          if (n !== count)
            errors.push(
              `${at}: ${epoch.name} ${id} ${kind} has ${n} samples, plan requires ${count}`,
            );
        }
    if (
      summary == null ||
      JSON.stringify(summary) !== JSON.stringify(summarizeRun(raw))
    )
      errors.push(`${at}: summary.json does not re-derive from raw.json`);
  }
}

function checkBudgets(records, ctx, errors) {
  const policyJson = records.json.policy;
  const budgets = records.json.budgets;
  if (policyJson == null) return errors.push('budgets: policy missing');
  if (budgets == null) return errors.push('budgets: budgets.v1.json missing');
  const policy = {
    ...policyJson,
    __path: rel(FILES.policy),
    __sha256: sha256(records.bytes[rel(FILES.policy)]),
  };
  const refs = budgets.baseline.results;
  const raws = [];
  for (const ref of refs) {
    const label = Object.keys(records.results).find(
      (l) => records.results[l].rawPath === ref.path,
    );
    if (label == null || sha256(records.bytes[ref.path]) !== ref.sha256) {
      errors.push(`budgets: baseline result ${ref.path} is missing or altered`);
      continue;
    }
    const raw = records.results[label].raw;
    if (raw.plan.id !== 'final' || raw.load.quietAtStart !== true)
      errors.push(`budgets: ${ref.path} is not a quiet final run`);
    raws.push(raw);
  }
  if (raws.length < 2)
    errors.push(
      'budgets: at least two baseline runs are required to observe repeat noise',
    );
  if (raws.length === 0) return;
  let derived;
  try {
    derived = deriveBudgets(policy, raws, refs);
  } catch (error) {
    return errors.push(`budgets: cannot re-derive: ${error.message}`);
  }
  if (JSON.stringify(derived) !== JSON.stringify(budgets))
    errors.push(
      'budgets: budgets.v1.json does not re-derive from its policy and baseline results',
    );
  for (const id of policy.budgetedMetrics) {
    const covered =
      id === 'incremental.*'
        ? budgets.budgets.some((b) => b.metric.startsWith('incremental.'))
        : budgets.budgets.some((b) => b.metric === id);
    if (!covered) errors.push(`budgets: budgeted metric ${id} has no budget`);
  }
  if (!(budgets.unknown?.length > 0))
    errors.push('budgets: unknown metrics must be listed explicitly');
  for (const u of budgets.unknown ?? []) {
    if (!u.id || !u.scope || !u.reason || !u.owner)
      errors.push(
        `budgets: unknown metric ${u.id ?? '?'} lacks scope, reason or owner`,
      );
    if (budgets.budgets.some((b) => b.metric === u.id))
      errors.push(`budgets: ${u.id} is both unknown and budgeted`);
  }
  const loadPrevious = (p) =>
    JSON.parse(records.bytes[p] ?? fs.readFileSync(path.join(REPO, p)));
  const digestPrevious = (p) =>
    sha256(records.bytes[p] ?? fs.readFileSync(path.join(REPO, p)));
  for (const problem of policyChainProblems(
    budgets,
    loadPrevious,
    digestPrevious,
  ))
    errors.push(`budgets: ${problem}`);
  for (const raw of raws) {
    const nullGate = evaluate(budgets, [raw], {
      candidate: 'alpha1-replay',
      reference: 'alpha1',
      manifest: records.json.manifest,
    });
    if (nullGate.verdict !== 'pass')
      errors.push(
        `budgets: the unchanged artifact fails its own budgets in ${raw.label} (${nullGate.problems[0] ?? nullGate.results.find((r) => r.status !== 'pass')?.metric})`,
      );
  }
}

function checkFrozen(records, errors) {
  const frozen = [
    rel(FILES.manifest),
    rel(FILES.closurePackage),
    rel(FILES.closureLock),
    rel(FILES.workloads),
    rel(FILES.ceCorpus),
    rel(FILES.policy),
    rel(FILES.budgets),
    ...Object.values(records.results).map((r) => r.rawPath),
  ];
  for (const file of frozen) {
    if (records.bytes[file] == null) continue;
    const change = frozenFileChange(file, (p) => records.bytes[p]);
    if (change != null) errors.push(`frozen: ${change}`);
  }
}

export function validate(records, ctx) {
  const errors = [];
  const guard = (name, fn) => {
    try {
      fn();
    } catch (error) {
      errors.push(`${name}: ${error.message}`);
    }
  };
  guard('manifest', () => checkManifest(records, ctx, errors));
  guard('workloads', () => checkWorkloads(records, ctx, errors));
  guard('ce-corpus', () => checkCeCorpus(records, ctx, errors));
  guard('results', () => checkResults(records, ctx, errors));
  guard('budgets', () => checkBudgets(records, ctx, errors));
  guard('frozen', () => checkFrozen(records, errors));
  return errors;
}

// ----------------------------------------------------------------- self-test

const clone = (records) => ({
  bytes: { ...records.bytes },
  json: structuredClone(records.json),
  results: structuredClone(records.results),
});
const firstLabel = (r) => Object.keys(r.results)[0];
const firstRaw = (r) => r.results[firstLabel(r)].raw;
const sampleOf = (r, kind) =>
  firstRaw(r).samples.find((s) => s.kind === kind && s.epoch === 'alpha1');

// A candidate epoch made from the unchanged replay samples of one run, with
// one metric scaled: the gate must reject it.
function gateCandidate(records, mutate) {
  const raw = structuredClone(firstRaw(records));
  raw.epochs.push({
    ...structuredClone(raw.epochs.find((e) => e.name === 'alpha1-replay')),
    name: 'candidate',
  });
  for (const s of raw.samples
    .filter((x) => x.epoch === 'alpha1-replay')
    .map((x) => structuredClone(x))) {
    s.epoch = 'candidate';
    mutate(s);
    raw.samples.push(s);
  }
  return evaluate(records.json.budgets, [raw], {
    candidate: 'candidate',
    reference: 'alpha1',
    manifest: records.json.manifest,
  });
}

export const MUTATIONS = [
  [
    'registry integrity altered',
    'archived tarball integrity',
    (r) => {
      r.json.manifest.packages[1].registry.registryIntegrity = 'sha512-x';
    },
  ],
  [
    'closure lock integrity altered',
    'closure lock integrity',
    (r) => {
      r.json.manifest.packages[0].closureLock.integrity = 'sha512-y';
    },
  ],
  [
    'baseline commit replaced',
    'source commit',
    (r) => {
      r.json.manifest.source.commit = '0'.repeat(40);
    },
  ],
  [
    'package dropped',
    'package set',
    (r) => {
      r.json.manifest.packages.pop();
    },
  ],
  [
    'product difference hidden as source pack',
    'outside documentation',
    (r) => {
      r.json.manifest.packages[1].sourcePack.contentDifferences.push({
        file: 'package/lib/index.mjs',
      });
    },
  ],
  [
    'corpus digest altered',
    'corpus ce-00.2-proof-corpus',
    (r) => {
      r.json.manifest.corpora[0].entries[0].sha256 = '0'.repeat(64);
    },
  ],
  [
    'engine replaced',
    'CE-00.2 reference-check engine',
    (r) => {
      r.json.manifest.engines[0].browserVersion = '149.0.0.0';
    },
  ],
  [
    'closure lockfile edited',
    'closure lockfile digest',
    (r) => {
      r.bytes[
        'benchmarks/core-evolution/epochs/alpha1/closure/package-lock.json'
      ] = Buffer.concat([
        r.bytes[
          'benchmarks/core-evolution/epochs/alpha1/closure/package-lock.json'
        ],
        Buffer.from(' '),
      ]);
    },
  ],
  [
    'synthetic seed changed',
    'frozen digest',
    (r) => {
      r.json.workloads.workloads.find(
        (w) => w.source.kind === 'synthetic',
      ).source.seed = 308;
    },
  ],
  [
    'workload digest changed',
    'frozen digest',
    (r) => {
      r.json.workloads.workloads[0].contentSha256 = '0'.repeat(64);
    },
  ],
  [
    'edit text absent',
    'source text not found',
    (r) => {
      r.json.workloads.workloads[0].edits[0].from = 'absent text';
    },
  ],
  [
    'plan names unknown workload',
    'unknown workload',
    (r) => {
      r.json.workloads.plans.final.repetitions.ghost = { compile: 1 };
    },
  ],
  [
    'corpus declaration dropped',
    'neither included nor excluded',
    (r) => {
      r.json.ceCorpus.stylesheets[0].declarations.pop();
      r.json.ceCorpus.totals.included -= 1;
      r.json.ceCorpus.totals.candidates -= 1;
    },
  ],
  [
    'corpus token value changed',
    're-derive from the pinned inputs',
    (r) => {
      const c = r.json.ceCorpus.tokens;
      const cat = Object.keys(c)[0];
      c[cat][Object.keys(c[cat])[0]] = '13px';
    },
  ],
  [
    'corpus totals inflated',
    'totals are inconsistent',
    (r) => {
      r.json.ceCorpus.totals.candidates += 1;
    },
  ],
  [
    'load after missing',
    'load is not recorded',
    (r) => {
      firstRaw(r).load.after = null;
    },
  ],
  [
    'batch not quiet',
    'quiet machine',
    (r) => {
      firstRaw(r).load.quietAtStart = false;
    },
  ],
  [
    'sample value edited',
    'summary.json does not re-derive',
    (r) => {
      sampleOf(r, 'compile').result.full.totalMs *= 0.5;
    },
  ],
  [
    'baseline measured another tarball',
    'did not run the unchanged',
    (r) => {
      firstRaw(r).epochs[0].packages['@pandamstyle/compiler'].integrity =
        'sha512-z';
    },
  ],
  [
    'samples removed',
    'plan requires',
    (r) => {
      const raw = firstRaw(r);
      raw.samples = raw.samples.filter(
        (s) => !(s.kind === 'runtime' && s.epoch === 'alpha1'),
      );
    },
  ],
  [
    'failed sample kept',
    'failed samples',
    (r) => {
      sampleOf(r, 'vite').result.ok = false;
      sampleOf(r, 'vite').result.error = 'x';
    },
  ],
  [
    'harness digest forged',
    'harness sample.mjs',
    (r) => {
      firstRaw(r).harness['sample.mjs'] = '0'.repeat(64);
    },
  ],
  [
    'budget loosened',
    'does not re-derive from its policy',
    (r) => {
      r.json.budgets.budgets.find(
        (b) => b.limit.maxMedianRatio != null,
      ).limit.maxMedianRatio += 0.5;
    },
  ],
  [
    'baseline median edited',
    'does not re-derive from its policy',
    (r) => {
      r.json.budgets.budgets.find(
        (b) => b.baseline.median != null,
      ).baseline.median *= 2;
    },
  ],
  [
    'unknown metric dropped',
    'does not re-derive from its policy',
    (r) => {
      r.json.budgets.unknown.pop();
    },
  ],
  [
    'policy rule weakened',
    'does not re-derive from its policy',
    (r) => {
      r.json.policy.thresholdRule.timing.minMedianRatio = 2;
    },
  ],
  [
    'budget relabelled unknown',
    'both unknown and budgeted',
    (r) => {
      r.json.budgets.unknown.push({
        id: 'full.totalMs',
        scope: 's',
        reason: 'r',
        owner: 'o',
      });
    },
  ],
  [
    'version 2 without predecessor',
    'must name its predecessor',
    (r) => {
      r.json.budgets.policyVersion = 2;
    },
  ],
  [
    'version 2 reusing the baseline',
    'new comparable baseline',
    (r) => {
      const b = r.json.budgets;
      b.policyVersion = 2;
      b.supersedes = {
        path: 'benchmarks/core-evolution/budgets.v1.json',
        sha256: sha256(r.bytes['benchmarks/core-evolution/budgets.v1.json']),
      };
    },
  ],
  [
    'version 2 loosening silently',
    'loosened without a justified relaxation',
    (r) => {
      const b = r.json.budgets;
      b.policyVersion = 2;
      b.supersedes = {
        path: 'benchmarks/core-evolution/budgets.v1.json',
        sha256: sha256(r.bytes['benchmarks/core-evolution/budgets.v1.json']),
      };
      b.baseline.results = b.baseline.results.map((x) => ({
        ...x,
        sha256: '1'.repeat(64),
      }));
      b.budgets[0].limit = {
        ...b.budgets[0].limit,
        maxMedianRatio: 9,
        maxValue: 1e12,
      };
    },
  ],
  [
    'short justification',
    'needs a justification',
    (r) => {
      r.json.budgets.justification = 'ok';
    },
  ],
  [
    'frozen workloads edited after commit',
    'differs from the version frozen',
    (r) => {
      r.bytes['benchmarks/core-evolution/workloads.v1.json'] = Buffer.from(
        `${r.bytes['benchmarks/core-evolution/workloads.v1.json']} `,
      );
    },
  ],
];

// Gate-behaviour mutations: evaluated directly rather than through validate().
export const GATE_MUTATIONS = [
  [
    '30% slower full compile fails',
    (r) =>
      gateCandidate(r, (s) => {
        if (s.kind === 'compile') s.result.full.totalMs *= 1.3;
      }),
    (g) =>
      g.verdict === 'fail' &&
      g.results.some((x) => x.metric === 'full.totalMs' && x.status === 'fail'),
  ],
  [
    '10% larger CSS fails',
    (r) =>
      gateCandidate(r, (s) => {
        if (s.kind === 'compile')
          s.result.output.css.bytes = Math.ceil(
            s.result.output.css.bytes * 1.1,
          );
      }),
    (g) =>
      g.verdict === 'fail' &&
      g.results.some((x) => x.metric === 'css.bytes' && x.status === 'fail'),
  ],
  [
    'grown selection domain fails',
    (r) =>
      gateCandidate(r, (s) => {
        if (s.kind === 'compile')
          s.result.output.variants.recipeSelections += 1;
      }),
    (g) =>
      g.results.some(
        (x) => x.metric === 'variants.recipeSelections' && x.status === 'fail',
      ),
  ],
  [
    'slower runtime selection fails',
    (r) =>
      gateCandidate(r, (s) => {
        if (s.kind === 'runtime' && s.result.propsNsPerCall != null)
          s.result.propsNsPerCall *= 1.5;
      }),
    (g) =>
      g.results.some(
        (x) => x.metric === 'runtime.propsNsPerCall' && x.status === 'fail',
      ),
  ],
  [
    'canonical mismatch fails',
    (r) =>
      gateCandidate(r, (s) => {
        if (s.kind === 'consistency') s.result.canonical[0].equal.css = false;
      }),
    (g) =>
      g.results.some(
        (x) =>
          x.metric === 'consistency.incrementalEqualsCanonical' &&
          x.status === 'fail',
      ),
  ],
  [
    'unrun budget is incomplete, never pass',
    (r) =>
      gateCandidate(r, (s) => {
        if (s.kind === 'vite') s.kind = 'skipped';
      }),
    (g) =>
      g.verdict === 'incomplete' &&
      g.results.some((x) => x.status === 'not-run'),
  ],
  [
    'failed candidate sample fails',
    (r) =>
      gateCandidate(r, (s) => {
        if (s.kind === 'runtime') {
          s.result.ok = false;
          s.result.error = 'x';
        }
      }),
    (g) => g.verdict === 'fail',
  ],
  [
    'unknown metrics stay unknown',
    (r) => gateCandidate(r, () => {}),
    (g) =>
      g.verdict === 'pass' &&
      g.unknown.length > 0 &&
      g.unknown.every((u) => u.status === 'unknown'),
  ],
  [
    'altered reference artifact fails',
    (r) => {
      const raw = structuredClone(firstRaw(r));
      raw.epochs.find((e) => e.name === 'alpha1').packages[
        '@pandamstyle/core'
      ].integrity = 'sha512-q';
      return evaluate(r.json.budgets, [raw], {
        candidate: 'alpha1-replay',
        manifest: r.json.manifest,
      });
    },
    (g) => g.verdict === 'fail',
  ],
  [
    'candidate absent from the run fails',
    (r) =>
      evaluate(r.json.budgets, [firstRaw(r)], {
        candidate: 'missing',
        manifest: r.json.manifest,
      }),
    (g) => g.verdict === 'fail',
  ],
];

async function main() {
  const records = loadRecords();
  const ctx = await loadContext();
  const errors = validate(records, ctx);
  for (const error of errors) console.log(`FAIL ${error}`);
  if (errors.length > 0) {
    console.log(`baseline records: ${errors.length} problems`);
    process.exitCode = 1;
    return;
  }
  const b = records.json.budgets;
  console.log(
    `baseline records valid: ${records.json.manifest.packages.length} packages, ${records.json.workloads.workloads.length} workloads, ${Object.keys(records.results).length} result runs, ${b.budgets.length} budgets, ${b.unknown.length} unknown metrics`,
  );
  if (!process.argv.includes('--self-test')) return;
  let failures = 0;
  for (const [name, expected, mutate] of MUTATIONS) {
    const mutated = clone(records);
    mutate(mutated);
    const found = validate(mutated, ctx);
    const ok = found.some((e) => e.includes(expected));
    if (!ok) failures++;
    console.log(
      `${ok ? 'ok  ' : 'MISS'} ${name}${ok ? '' : ` (expected "${expected}", got ${JSON.stringify(found.slice(0, 3))})`}`,
    );
  }
  for (const [name, run, accept] of GATE_MUTATIONS) {
    const report = run(clone(records));
    const ok = accept(report);
    if (!ok) failures++;
    console.log(
      `${ok ? 'ok  ' : 'MISS'} gate: ${name}${ok ? '' : ` (verdict ${report.verdict})`}`,
    );
  }
  console.log(
    `self-test: ${MUTATIONS.length + GATE_MUTATIONS.length - failures}/${MUTATIONS.length + GATE_MUTATIONS.length} mutations rejected as expected`,
  );
  if (failures > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  });
