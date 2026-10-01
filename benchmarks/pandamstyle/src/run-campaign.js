#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle benchmark campaign runner.
 *
 * Executes a matrix of (engine x corpus x scenario x cache-state x iteration)
 * jobs, one child process per cold job, and appends every observation to a
 * JSONL file. Aggregation is NOT done here.
 *
 * Usage:
 *   node run-campaign.js --plan plan.json --engines babel_current,babel_work_eliminated \
 *        --corpora c100-t100-r10 --scenarios one_file_new_atom --iterations 5
 *
 * Flags:
 *   --plan <file>        plan.json (required)
 *   --engines <a,b>      engines to run (default: both)
 *   --corpora <a,b>      corpus cells (default: the plan's `campaign` set)
 *   --scenarios <a,b>    scenarios (default: all in the plan's `scenarios`)
 *   --cache-states <a,b> cache states (default: all the plan allows)
 *   --iterations <n>     measured iterations per cell (default: plan)
 *   --repetitions <n>    independent session blocks per cell (default: 1)
 *   --run-kind <k>       debug | qualification  (default: qualification)
 *   --out <file>         observations JSONL (default: stdout)
 *   --work-dir <dir>     scratch root (default: <repo>/.pms-bench)
 *   --timeout-ms <n>     per-job wall clock cap (default: 900000)
 *
 * FAILURE HANDLING
 *
 * A job that crashes, times out, or produces an unexpected verdict is recorded
 * with a non-`ok` status and INCLUDED. It is never dropped: an engine that
 * fails 10% of its runs has a real 10% failure rate, and a benchmark that
 * removes those runs reports a number for a program nobody runs.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { captureEnvironment, sha256, nowNs } = require('./harness');
const { getScenario, allScenarioNames } = require('./scenarios');
const { generate, MANIFEST_NAME } = require('./generate-corpus');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      out[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function csv(v) {
  return String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function log(msg) {
  process.stderr.write(`[campaign] ${msg}\n`);
}

function readPlan(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * The engines. Each names a repository root, so `babel_current` is literally a
 * checkout of the official baseline and `babel_work_eliminated` is this branch.
 */
function resolveEngines(names) {
  const all = {
    babel_current: {
      name: 'babel_current',
      root:
        process.env.PMS_BASELINE_ROOT ??
        path.join(REPO_ROOT, '..', 'pms-baseline'),
      description:
        'the compiler at the official hygiene baseline d5702374, unmodified ' +
        'except for the measurement hooks, which are inert without a collector',
      workEliminated: false,
    },
    babel_work_eliminated: {
      name: 'babel_work_eliminated',
      root: REPO_ROOT,
      description:
        'the same compiler with the measured redundant work removed, behind ' +
        'PMS_WORK_ELIMINATED=1; production keeps the default',
      workEliminated: true,
    },
    // Spike 2 engines. Both run THIS tree, so the only difference between them
    // is which private measurement interface from the same test-support bundle
    // is driven: `buildProject` (a full rebuild, every file every time) or
    // `createProjectSession` (the project session, which reuses every file
    // whose validity key still holds).
    // Anchoring `babel_full` to a separate worktree would make a tree
    // difference indistinguishable from an incrementality difference, which is
    // the one attribution this batch has to get right.
    babel_full: {
      name: 'babel_full',
      root: REPO_ROOT,
      description:
        'the private full-rebuild reference path: every covered file is ' +
        're-read, re-parsed and recompiled on every revision. This is the ' +
        'existing compiler semantics and the semantic reference.',
      workEliminated: false,
      mode: 'full',
    },
    babel_incremental: {
      name: 'babel_incremental',
      root: REPO_ROOT,
      description:
        'the project session: a revision re-scans and re-hashes the covered ' +
        'set, rebuilds the coverage closure from persistent module summaries, ' +
        'and recompiles only the files whose validity key changed. No ' +
        'Spike 1 work-elimination flag is involved.',
      workEliminated: false,
      mode: 'incremental',
    },
    // Spike 3 engines. These are NOT another compiler: they are the SAME
    // project session, driving three publication strategies, so every
    // difference between their rows is publication work and nothing else.
    //
    //   session_full_publish          Spike 2 behaviour: full generation
    //                                 publication, full CSS aggregation.
    //   session_incremental_publish   delta output publication (unchanged
    //                                 artifacts reused, not rewritten), full
    //                                 CSS aggregation.
    //   session_incremental_publish_css
    //                                 as above, plus incremental CSS.
    session_full_publish: {
      name: 'session_full_publish',
      root: REPO_ROOT,
      description:
        'the project session with Spike 2 publication: every artifact is ' +
        'rewritten on every revision and CSS is re-aggregated from every ' +
        'contribution. The reference the other two are measured against.',
      workEliminated: false,
      mode: 'incremental',
      publishVariant: 'session_full_publish',
    },
    session_incremental_publish: {
      name: 'session_incremental_publish',
      root: REPO_ROOT,
      description:
        'the project session publishing only the output delta: an artifact ' +
        'whose content digest matches the published one is reused rather ' +
        'than rewritten, and an artifact no longer claimed is removed. CSS ' +
        'is still aggregated in full, so this row isolates publication.',
      workEliminated: false,
      mode: 'incremental',
      publishVariant: 'session_incremental_publish',
    },
    session_incremental_publish_css: {
      name: 'session_incremental_publish_css',
      root: REPO_ROOT,
      description:
        'the project session with delta publication AND incremental CSS ' +
        'aggregation: the stylesheet is re-derived from the changed rule ' +
        'contributions rather than from the whole atom population.',
      workEliminated: false,
      mode: 'incremental',
      publishVariant: 'session_incremental_publish_css',
    },
    babel_incremental_work_eliminated: {
      name: 'babel_incremental_work_eliminated',
      root: REPO_ROOT,
      description:
        'the factorial variant: the project session AND the Spike 1 ' +
        'work-elimination caches. Reported separately, never as the headline, ' +
        'so the benefit of invalidation is never conflated with the benefit ' +
        'of memoization.',
      workEliminated: true,
      mode: 'incremental',
    },
  };
  const out = {};
  for (const n of names) {
    if (all[n] == null) throw new Error(`unknown engine: ${n}`);
    out[n] = all[n];
  }
  return out;
}

function gitCommit(root) {
  const out = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  });
  return out.status === 0 ? out.stdout.trim() : null;
}

function gitTree(root) {
  const out = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD^{tree}'], {
    encoding: 'utf8',
  });
  return out.status === 0 ? out.stdout.trim() : null;
}

function gitDirty(root) {
  const out = spawnSync('git', ['-C', root, 'status', '--porcelain'], {
    encoding: 'utf8',
  });
  if (out.status !== 0) return null;
  return out.stdout.trim() === '' ? 'clean' : 'dirty';
}

/**
 * A corpus cell is `c<components>-t<tokens>-r<recipes>` and is bound to a seed
 * from the plan. The seed is what makes the corpus deterministic, so it is
 * recorded in the corpus name rather than left implicit.
 */
function cellName(cell) {
  return `c${cell.components}-t${cell.tokens}-r${cell.recipes}-s${cell.seed}`;
}

function ensureCorpus(cell, workDir, generatorCommit) {
  const dir = path.join(workDir, 'corpora', cellName(cell));
  const manifestPath = path.join(dir, MANIFEST_NAME);
  if (fs.existsSync(manifestPath)) {
    const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (existing.contentHash != null) {
      return { dir, manifest: existing, reused: true };
    }
  }
  const manifest = generate({
    components: cell.components,
    tokens: cell.tokens,
    recipes: cell.recipes,
    seed: cell.seed,
    fanout: cell.fanout ?? 0,
    outDir: dir,
    negative: true,
    generatorCommit,
  });
  return { dir, manifest, reused: false };
}

function main() {
  const args = parseArgs(process.argv);
  const planFile = path.resolve(
    args.plan ?? path.join(__dirname, '..', 'plan.json'),
  );
  const plan = readPlan(planFile);

  const runKind = args['run-kind'] ?? 'qualification';
  if (runKind !== 'debug' && runKind !== 'qualification') {
    throw new Error(
      `--run-kind must be debug or qualification, got ${runKind}`,
    );
  }

  const engineNames = csv(
    args.engines ?? 'babel_current,babel_work_eliminated',
  );
  const engines = resolveEngines(engineNames);

  const workDir = path.resolve(
    args['work-dir'] ?? path.join(REPO_ROOT, '.pms-bench'),
  );
  fs.mkdirSync(workDir, { recursive: true });

  const cells =
    csv(args.corpora).length > 0
      ? csv(args.corpora).map((name) => {
          const m = /^c(\d+)-t(\d+)-r(\d+)$/.exec(name);
          if (m == null) {
            throw new Error(
              `corpus cell must look like c100-t100-r10, got ${name}`,
            );
          }
          const components = Number(m[1]);
          const tokens = Number(m[2]);
          const recipes = Number(m[3]);
          const seed = seedForCell(plan, components, tokens, recipes);
          const fanout = fanoutForCell(components);
          return { components, tokens, recipes, seed, fanout };
        })
      : (plan.campaign ?? []).map((c) => ({
          ...c,
          fanout: c.fanout ?? fanoutForCell(c.components),
        }));

  const requestedScenarios =
    csv(args.scenarios).length > 0 ? csv(args.scenarios) : allScenarioNames();

  // `--cache-states` is applied HERE, to the job list, and not only recorded in
  // the metadata. Recording a filter in the metadata while building the matrix
  // from the plan anyway means a campaign that says it measured warm states has
  // in fact also run cold ones - and doubles its cost doing it.
  const selectedCacheStates =
    csv(args['cache-states'] ?? '').length > 0
      ? csv(args['cache-states'])
      : plan.cacheStates;
  const unknownCacheStates = selectedCacheStates.filter(
    (c) => !plan.cacheStates.includes(c),
  );
  if (unknownCacheStates.length > 0) {
    throw new Error(
      `unknown --cache-states ${unknownCacheStates.join(', ')}; the plan declares ${plan.cacheStates.join(', ')}`,
    );
  }

  const iterations = Number(
    args.iterations ?? plan.iterations?.qualification ?? 7,
  );
  const repetitions = Number(args.repetitions ?? 1);
  const timeoutMs = Number(args['timeout-ms'] ?? 900000);

  const outFile = args.out
    ? path.resolve(args.out)
    : path.join(workDir, `observations-${runKind}.jsonl`);
  fs.writeFileSync(outFile, '', 'utf8');

  const environment = captureEnvironment(REPO_ROOT);
  const generatorCommit = gitCommit(REPO_ROOT);

  const metadata = {
    documentKind: 'pandamstyle-benchmark-campaign-metadata',
    schemaVersion: 1,
    run_kind: runKind,
    started_at: new Date().toISOString(),
    // Recorded, not hidden: a run that removed each job's copy of the corpus
    // to stay inside the filesystem says so, and a reader who wants to know
    // whether a per-job tree still exists on disk does not have to guess.
    retention: {
      discard_job_project_copy: process.env.PMS_DISCARD_JOB_PROJECT === '1',
      note:
        'the per-job project copy is a regenerable input: the corpus is ' +
        'byte-identical for every job of a cell and is identified by its ' +
        'content hash. Observations, traces and per-parse evidence are kept.',
    },
    plan: {
      file: path.relative(REPO_ROOT, planFile),
      version: plan.planVersion,
      baseline_commit: plan.baseline_commit,
      sha256: sha256(fs.readFileSync(planFile)),
    },
    engines: Object.fromEntries(
      Object.entries(engines).map(([k, v]) => [
        k,
        {
          description: v.description,
          repo_root: v.root,
          commit: gitCommit(v.root),
          tree: gitTree(v.root),
          working_tree: gitDirty(v.root),
          mode: v.mode ?? 'full',
          publishVariant: v.publishVariant ?? 'session_full_publish',
          work_elimination_env: v.workEliminated
            ? 'PMS_WORK_ELIMINATED=1'
            : 'unset',
        },
      ]),
    ),
    this_branch: {
      commit: generatorCommit,
      tree: gitTree(REPO_ROOT),
      working_tree: gitDirty(REPO_ROOT),
    },
    environment,
    policy: {
      // Stated once, applied to every engine identically, and recorded so a
      // reader can check the comparison was not warmed asymmetrically.
      warmup_iterations: 1,
      warmup_kept_out_of_measurement: true,
      cold_scenarios_warmed: false,
      engine_order_randomisation:
        'per (cell, scenario, cache-state, iteration): the two engines are ' +
        'shuffled with a seed derived from the job identity, so thermal and ' +
        'order bias do not systematically favour one engine',
      repetition_blocks: repetitions,
      timer: {
        api: 'process.hrtime.bigint()',
        resolution: '1 ns',
        scope: 'the process performing the compile',
        monotonic: true,
        wall_clock_used_for: 'event ordering metadata only, never a duration',
      },
      os_cache_state: 'not_run',
      os_cache_state_reason:
        'dropping the OS page cache requires privileges this environment does ' +
        'not grant, and faking it with posix_fadvise would not reproduce a cold ' +
        'cache. Every number here is a WARM-OS-cache number and is labelled so.',
    },
    matrix: {
      cells: cells.map(cellName),
      scenarios: requestedScenarios,
      cache_states: selectedCacheStates,
      iterations,
      repetitions,
      engines: engineNames,
    },
    jobs: [],
  };

  const metaPath = outFile.replace(/\.jsonl$/, '') + '-metadata.json';
  fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2) + '\n', 'utf8');

  const materialised = new Map();
  for (const cell of cells) {
    const name = cellName(cell);
    log(`corpus ${name}`);
    const r = ensureCorpus(cell, workDir, generatorCommit);
    materialised.set(name, r);
    log(
      `  ${r.manifest.files.length} files, contentHash=${r.manifest.contentHash.slice(0, 16)}${r.reused ? ' (reused)' : ''}`,
    );
  }

  // The job list, built first so the ordering decision is auditable.
  //
  const jobs = [];
  for (const cell of cells) {
    const corpus = cellName(cell);
    for (const scenarioName of requestedScenarios) {
      const scenario = getScenario(scenarioName);
      for (const cacheState of selectedCacheStates) {
        if (!scenario.cacheStates.includes(cacheState)) continue;
        for (let rep = 0; rep < repetitions; rep++) {
          for (let it = 0; it < iterations; it++) {
            const sessionId = `s${String(rep + 1).padStart(2, '0')}`;
            for (const engineName of engineNames) {
              jobs.push({
                corpus,
                scenarioName,
                cacheState,
                engineName,
                sessionId,
                iteration: it,
                rep,
              });
            }
          }
        }
      }
    }
  }

  // Order randomisation, per job identity, seeded so it is REPRODUCIBLE rather
  // than merely random: the same command produces the same execution order.
  const orderSeed = parseInt(
    sha256(
      Buffer.from(`${plan.planVersion}|${runKind}|${engineNames.join(',')}`),
    ).slice(0, 8),
    16,
  );
  let ordState = orderSeed >>> 0;
  const ordRand = () => {
    ordState = (ordState * 1664525 + 1013904223) >>> 0;
    return ordState / 0x100000000;
  };
  for (let i = jobs.length - 1; i > 0; i--) {
    const j = Math.floor(ordRand() * (i + 1));
    [jobs[i], jobs[j]] = [jobs[j], jobs[i]];
  }

  log(`${jobs.length} jobs (order seed ${orderSeed})`);

  let completed = 0;
  const started = Date.now();
  for (const job of jobs) {
    const engine = engines[job.engineName];
    const corpusInfo = materialised.get(job.corpus);
    const jobId =
      `${job.engineName}__${job.corpus}__${job.scenarioName}__${job.cacheState}__${job.sessionId}__${job.iteration}`.replace(
        /[^A-Za-z0-9._-]/g,
        '_',
      );
    const jobDir = path.join(workDir, 'jobs', jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    const outFileJob = path.join(jobDir, 'observations.jsonl');

    const jobSpec = {
      repoRoot: REPO_ROOT,
      engineRoot: engine.root,
      engine: job.engineName,
      engineVariantCommit: gitCommit(engine.root),
      // Carried onto the job so the child selects its path from the ENGINE's
      // declaration rather than from a name comparison.
      mode: engine.mode ?? 'full',
      publishVariant: engine.publishVariant ?? 'session_full_publish',
      corpus: job.corpus,
      corpusDir: corpusInfo.dir,
      projectDir: path.join(jobDir, 'project'),
      scenario: job.scenarioName,
      cacheState: job.cacheState,
      sessionId: job.sessionId,
      iteration: job.iteration,
      runKind,
      outFile: outFileJob,
    };

    // Wall time for the whole child, INCLUDING process spawn. It is recorded
    // separately from `startup_ms` (which the child measures internally) so the
    // two are never added together and never confused.
    const tStart = nowNs();
    const res = spawnSync(
      process.execPath,
      [path.join(__dirname, 'worker.js'), JSON.stringify(jobSpec)],
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        env: {
          ...process.env,
          PMS_WORK_ELIMINATED: engine.workEliminated ? '1' : '',
        },
      },
    );
    const wallMs = (nowNs() - tStart) / 1e6;

    const jobRecord = {
      ...job,
      scenario: job.scenarioName,
      engine_commit: jobSpec.engineVariantCommit,
      job_id: jobId,
      wall_ms: wallMs,
      status: 'ok',
      child_exit: res.status,
      child_signal: res.signal ?? null,
    };

    if (res.status !== 0 || res.signal != null) {
      jobRecord.status = res.signal === 'SIGTERM' ? 'timeout' : 'error';
      jobRecord.stderr_tail = String(res.stderr ?? '').slice(-1500);
    }

    // The per-job directory holds a FULL COPY of the corpus, which is the
    // single largest thing this runner writes: at 10,000 components that is
    // tens of megabytes per job, and a campaign of ninety of them will fill a
    // filesystem. The copy exists only to be read by the worker, and the
    // worker is finished with it, so `PMS_DISCARD_JOB_PROJECT=1` removes the
    // copy and keeps everything the run actually produces: the observations,
    // the trace and the per-parse evidence. The flag is recorded in the
    // campaign metadata, so a run that used it says so rather than looking
    // like a run that never wrote it.
    if (process.env.PMS_DISCARD_JOB_PROJECT === '1') {
      fs.rmSync(path.join(jobDir, 'project'), { recursive: true, force: true });
    }

    // The per-parse evidence is kept beside the observations. It is large, so
    // it is collected into the run's evidence tree rather than appended to the
    // observation stream, and its digest is recorded in the metadata.
    const parseEvidenceFile = `${outFileJob}.parses.json`;
    if (fs.existsSync(parseEvidenceFile)) {
      const dest = path.join(
        workDir,
        'parse-evidence',
        `${path.basename(jobId)}.parses.json`,
      );
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(parseEvidenceFile, dest);
      jobRecord.parse_evidence = path.relative(workDir, dest);
      jobRecord.parse_evidence_sha256 = sha256(fs.readFileSync(dest));
      fs.rmSync(parseEvidenceFile, { force: true });
    }

    if (fs.existsSync(outFileJob)) {
      fs.appendFileSync(outFile, fs.readFileSync(outFileJob, 'utf8'), 'utf8');
      const rows = readJsonl(outFileJob);
      const errs = rows.filter((r) => r.status === 'error');
      if (errs.length > 0)
        jobRecord.status =
          jobRecord.status === 'ok' ? 'error' : jobRecord.status;
      jobRecord.observations = rows.length;
      jobRecord.error_observations = errs.length;
      if (errs.length > 0) {
        jobRecord.error_detail = errs.slice(0, 3).map((e) => e.detail);
      }
    } else {
      jobRecord.status = jobRecord.status === 'ok' ? 'error' : jobRecord.status;
      jobRecord.error_detail = 'the worker produced no observation file';
    }

    // The scratch project of a completed job is dead weight: the corpus is the
    // reproducible input and the project is a copy of it.
    fs.rmSync(jobSpec.projectDir, { recursive: true, force: true });

    metadata.jobs.push(jobRecord);
    completed++;
    if (completed % 10 === 0 || jobRecord.status !== 'ok') {
      const elapsed = ((Date.now() - started) / 1000).toFixed(0);
      log(
        `${completed}/${jobs.length} (${elapsed}s) ${jobRecord.status !== 'ok' ? `FAILED ${jobRecord.status}: ${jobId}` : jobId}`,
      );
    }
    if (runKind === 'debug') {
      fs.writeFileSync(
        metaPath,
        JSON.stringify(metadata, null, 2) + '\n',
        'utf8',
      );
    }
  }

  metadata.finished_at = new Date().toISOString();
  metadata.summary = {
    jobs_total: metadata.jobs.length,
    jobs_ok: metadata.jobs.filter((j) => j.status === 'ok').length,
    jobs_error: metadata.jobs.filter((j) => j.status === 'error').length,
    jobs_timeout: metadata.jobs.filter((j) => j.status === 'timeout').length,
    wall_seconds: (Date.now() - started) / 1000,
  };
  metadata.observations_sha256 = sha256(fs.readFileSync(outFile));

  fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
  log(`observations -> ${outFile}`);
  log(`metadata    -> ${metaPath}`);
  log(JSON.stringify(metadata.summary));
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((r) => r != null);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`campaign failed: ${err?.stack ?? err}\n`);
    process.exit(1);
  }
}

module.exports = {
  cellName,
  seedForCell,
  fanoutForCell,
  resolveEngines,
  parseArgs,
};

function seedForCell(plan, components, tokens, recipes) {
  // The plan binds a seed to each cell. A cell the plan does not name gets a
  // seed DERIVED from its parameters, deterministically, and the derivation is
  // recorded, so an unnamed cell is still reproducible.
  const named = (plan.cells ?? []).find(
    (c) =>
      c.components === components &&
      c.tokens === tokens &&
      c.recipes === recipes,
  );
  if (named != null) return named.seed;
  return (
    (components * 7919 + tokens * 104729 + recipes * 1299709) % 100000 >>> 0
  );
}

function fanoutForCell(components) {
  // A module graph with a declared fanout, so the closure is a graph and not a
  // flat list. Fixed per scale, recorded in the cell name.
  return components >= 1000 ? 8 : components >= 100 ? 4 : 2;
}
