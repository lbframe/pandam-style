/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle benchmark worker: ONE job, in its own process.
 *
 * A process is the unit of a cache state. `process_cold_*` must be a process
 * that has never compiled this corpus; a process that already did cannot make
 * that claim. `process_warm_*` must be a process that HAS, because that is the
 * only state an agent loop is ever in.
 *
 * The worker receives a job description on argv, does exactly that job, writes
 * JSONL observations to the requested file, and exits. It never aggregates.
 *
 * Usage:
 *   node worker.js '<job json>'
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Captured BEFORE anything else, including the compiler require. This is the
// top of the process as far as this program is concerned, so
// `processLoadMs` below is the honest engine startup: module resolution,
// compilation of the bundle, and the initialization it performs. Process spawn
// overhead itself is NOT included, and is not claimed to be: it is reported
// separately by the parent as wall time, so the two are never conflated.
const PROCESS_ENTRY_NS = Number(process.hrtime.bigint());

const { CompileDriver, nowNs, STATUS } = require('./harness');
const { getScenario, resetScenarioState } = require('./scenarios');

/**
 * Times Babel's parser AT THE PARSE.
 *
 * The compiler cannot see its own parse: `@babel/core` calls `@babel/parser`
 * internally. Wrapping the parser's exported `parse` is the only place a parse
 * duration can be observed without inferring it from a transform boundary, and
 * the brief is explicit that phase boundaries must not be fabricated.
 *
 * The hook is installed BEFORE the engine bundle is required, and both engines
 * resolve `@babel/parser` through the same `node_modules`, so the same wrapped
 * module instance serves both. If the wrap ever failed, `parserHookInstalled`
 * stays false and the run is marked, rather than silently reporting 0 ms of
 * parse time.
 */
const parserStats = {
  installed: false,
  calls: 0,
  totalNs: 0,
  byOwner: new Map(),
  byOwnerCalls: new Map(),
  bytes: 0,
};

function installParserHook() {
  let parser;
  try {
    parser = require('@babel/parser');
  } catch {
    return false;
  }
  const original = parser.parse;
  if (typeof original !== 'function') return false;
  parser.parse = function patchedParse(input, ...rest) {
    const owner = globalThis.__PMS_PARSE_OWNER__ ?? 'unattributed';
    const start = Number(process.hrtime.bigint());
    try {
      return original.call(this, input, ...rest);
    } finally {
      const elapsed = Number(process.hrtime.bigint()) - start;
      parserStats.installed = true;
      parserStats.calls += 1;
      parserStats.totalNs += elapsed;
      parserStats.byOwner.set(
        owner,
        (parserStats.byOwner.get(owner) ?? 0) + elapsed,
      );
      parserStats.byOwnerCalls.set(
        owner,
        (parserStats.byOwnerCalls.get(owner) ?? 0) + 1,
      );
      if (typeof input === 'string') parserStats.bytes += input.length;
    }
  };
  return true;
}

const parserHookInstalled = installParserHook();

function parserSnapshot() {
  const out = {
    installed: parserHookInstalled,
    calls: 0,
    total_ms: 0,
    by_owner_ms: {},
    by_owner_calls: {},
    bytes: 0,
  };
  for (const [k, v] of parserStats.byOwner) {
    out.by_owner_ms[k] = v / 1e6;
    out.by_owner_calls[k] = parserStats.byOwnerCalls.get(k) ?? 0;
  }
  out.calls = parserStats.calls;
  out.total_ms = parserStats.totalNs / 1e6;
  out.bytes = parserStats.bytes;
  return out;
}

/**
 * What a given revision of a scenario is expected to produce.
 *
 * A scenario's `expect` describes its FINAL state. Intermediate revisions are
 * the setup for that state - a violation introduced, a token removed - and each
 * declares its own expectation in `revisionExpect`. Without this, "remove a
 * token, then put it back" would assert "ok" on the revision that removes it and
 * fail a correct engine.
 */
function expectForRevision(scenario, rev) {
  if (scenario.revisionExpect != null) {
    return scenario.revisionExpect[rev] ?? scenario.expect;
  }
  return rev === Math.max(1, scenario.revisions) - 1 ? scenario.expect : 'ok';
}

function writeJsonl(file, rows) {
  fs.writeFileSync(
    file,
    rows.map((r) => JSON.stringify(r)).join('\n') +
      (rows.length > 0 ? '\n' : ''),
    'utf8',
  );
}

/**
 * Copies a generated corpus into a scratch project directory.
 *
 * The generated corpus is a READ-ONLY input: every run gets its own copy, so a
 * run can never see a previous run's edit, and the corpus's own content hash
 * stays the identity of the input rather than of whatever was last written.
 */
function materialiseProject(sourceDir, projectDir) {
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.mkdirSync(projectDir, { recursive: true });
  const copy = (rel) => {
    const from = path.join(sourceDir, rel);
    const to = path.join(projectDir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  };
  const walk = (dir, base = sourceDir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(base, abs);
      if (entry.isDirectory()) {
        if (rel.split(path.sep)[0] === 'node_modules') continue;
        walk(abs, base);
      } else if (entry.isFile()) {
        if (rel.split(path.sep)[0] === 'node_modules') continue;
        if (rel.startsWith('.pandamstyle')) continue;
        copy(rel);
      }
    }
  };
  walk(sourceDir);
  return projectDir;
}

/**
 * Links the compiler package into the project so a generated design system
 * resolves `@pandamstyle/compiler` exactly the way an installed application
 * does, instead of reaching into the monorepo sources.
 */
function linkCompiler(projectDir, compilerPkgDir) {
  const scope = path.join(projectDir, 'node_modules', '@pandamstyle');
  fs.mkdirSync(scope, { recursive: true });
  const link = path.join(scope, 'compiler');
  if (!fs.existsSync(link)) {
    fs.symlinkSync(compilerPkgDir, link, 'dir');
  }
  return link;
}

async function main() {
  const job = JSON.parse(process.argv[2]);
  const engineRoot = job.engineRoot;

  const compilerPkgCandidates = [
    path.join(engineRoot, 'packages', 'compiler'),
    path.join(engineRoot, 'packages', '@pandamstyle', 'compiler'),
  ];
  const compilerPkgDir = compilerPkgCandidates.find((candidate) =>
    fs.existsSync(path.join(candidate, 'package.json')),
  );
  if (compilerPkgDir == null) {
    throw new Error(
      `No PandamStyle compiler package found under ${engineRoot}`,
    );
  }
  const testSupportPath = path.join(
    engineRoot,
    '.pms-test-support',
    'compiler-inspection.cjs',
  );
  const engineModulePath = fs.existsSync(testSupportPath)
    ? testSupportPath
    : path.join(compilerPkgDir, 'lib', 'index.js');

  const projectDir = materialiseProject(job.corpusDir, job.projectDir);
  linkCompiler(projectDir, compilerPkgDir);

  const engineModule = require(engineModulePath);

  // Engine startup: everything between the top of this process and the moment
  // the compiler bundle is loaded and its own caches are cold. This is what a
  // cold build pays before it compiles anything.
  const processLoadMs =
    (Number(process.hrtime.bigint()) - PROCESS_ENTRY_NS) / 1e6;

  const manifest = JSON.parse(
    fs.readFileSync(path.join(job.corpusDir, 'corpus-manifest.json'), 'utf8'),
  );

  const corpus = {
    name: job.corpus,
    manifest,
    sourceDir: job.corpusDir,
    scenarioName: job.scenario,
  };

  // The engine NAME selects the compilation path, and only that. Both paths
  // load the same test-support bundle and call the same measurement interface;
  // `babel_incremental`
  // adds the project session and nothing else, so the difference between the
  // two engines is reuse and cannot be attributed to a different compiler.
  // The engine DECLARES its mode, and the job carries the declaration through.
  // This used to be a string equality against exactly one engine name, so every
  // other engine silently ran a full rebuild while its metadata claimed
  // `mode: 'incremental'`.
  const mode = job.mode ?? 'full';
  const publishVariant = job.publishVariant ?? 'session_full_publish';

  const driver = new CompileDriver({
    engineModule,
    corpus,
    projectDir,
    engineName: job.engine,
    engineVariantCommit: job.engineVariantCommit ?? null,
    mode,
    publishVariant,
  });

  const scenario = getScenario(job.scenario);
  // A multi-revision scenario carries state between its revisions ("remove a
  // token, then put it back"). Resetting it here means a replay in a fresh
  // process and a replay in a used one produce the same edits.
  resetScenarioState(job.scenario);
  const rows = [];
  const trace = [];
  let pendingParser = null;

  // The startup cost of the ENGINE: this process loading the compiler bundle
  // and reaching a state where it can compile, with its own caches cold. It is
  // recorded for the COLD states only: a warm process has already paid it, and
  // reporting it again would be double counting the same milliseconds.
  const startupMs = job.cacheState.startsWith('process_cold')
    ? processLoadMs
    : null;

  // Per-parse evidence, written as its own document because the brief asks for
  // WHICH files were parsed, HOW MANY TIMES, and BY WHICH PIPELINE, and a
  // counter cannot answer that. The list is the evidence; the counters are
  // derived from it.
  const parseEvidence = [];
  // The parser hook is process-global, so a measured run's contribution is the
  // DELTA across that run. Accumulated across the warmup and the measured run
  // alike, each run reports only its own parses.
  let parserMark = parserSnapshot();

  const measure = (fn) => {
    parserMark = parserSnapshot();
    const out = fn();
    const after = parserSnapshot();
    pendingParser = {
      total_ms: after.total_ms - parserMark.total_ms,
      calls: after.calls - parserMark.calls,
      by_owner_ms: {},
      by_owner_calls: {},
      installed: after.installed,
    };
    for (const k of Object.keys(after.by_owner_ms)) {
      pendingParser.by_owner_ms[k] =
        after.by_owner_ms[k] - (parserMark.by_owner_ms[k] ?? 0);
      pendingParser.by_owner_calls[k] =
        after.by_owner_calls[k] - (parserMark.by_owner_calls[k] ?? 0);
    }
    return out;
  };

  const emitParser = (cacheState, sessionId, iteration, runKind) => {
    if (pendingParser == null) return;
    const base = {
      engine: job.engine,
      corpus: job.corpus,
      scenario: job.scenario,
      cache_state: cacheState,
      session_id: sessionId,
      iteration,
      unit: 'ms',
      run_kind: runKind,
      corpus_manifest_hash: manifest.contentHash,
      engine_variant_commit: job.engineVariantCommit ?? null,
      schema_version: 1,
    };
    if (!pendingParser.installed) {
      rows.push({
        ...base,
        metric: 'parse_ms',
        status: STATUS.UNSUPPORTED,
        value: null,
        detail: {
          reason:
            'the @babel/parser hook did not install, so parse time is not ' +
            'observable at the parse site. It is recorded as unavailable rather ' +
            'than derived from a transform boundary, which would be a fabricated ' +
            'phase boundary.',
        },
      });
      return;
    }
    rows.push({
      ...base,
      metric: 'parse_ms',
      status: STATUS.OK,
      value: pendingParser.total_ms,
      detail: null,
    });
    for (const [owner, v] of Object.entries(pendingParser.by_owner_ms)) {
      rows.push({
        ...base,
        metric: `parse_ms:${owner}`,
        status: STATUS.OK,
        value: v,
        detail: { parseCalls: pendingParser.by_owner_calls[owner] ?? 0 },
      });
    }
  };

  const record = (r) => {
    rows.push(...r.observations);
    emitParser(
      r.observations[0]?.cache_state ?? job.cacheState,
      r.observations[0]?.session_id ?? job.sessionId,
      r.observations[0]?.iteration ?? job.iteration,
      job.runKind,
    );
    parseEvidence.push({
      index: driver.eventIndex++,
      verdict: r.verdict,
      parses: r.snapshot.parses,
      reuse: driver.lastRevisionCounters(),
    });
    trace.push({
      index: driver.eventIndex,
      verdict: r.verdict,
      parses: r.snapshot.parses.total,
      reuse: driver.lastRevisionCounters(),
    });
  };

  /**
   * Reloads the configuration and the design-system definition for ONE
   * revision, cache-busted. Called immediately before every measured build so
   * the compiler sees the bytes on disk and not a cached module.
   */
  const reloadDefinition = async () => {
    const loaded = await driver.loadConfig();
    driver.config = loaded.config;
    driver.definition = loaded.definition;
  };

  const runOne = async (spec) => {
    await reloadDefinition();
    return measure(() => driver.runRevision(spec));
  };

  try {
    if (startupMs != null) {
      rows.push({
        engine: job.engine,
        corpus: job.corpus,
        scenario: job.scenario,
        cache_state: job.cacheState,
        session_id: job.sessionId,
        iteration: job.iteration,
        metric: 'startup_ms',
        unit: 'ms',
        status: STATUS.OK,
        value: startupMs,
        schema_version: 1,
        engine_variant_commit: job.engineVariantCommit ?? null,
        corpus_manifest_hash: manifest.contentHash,
        run_kind: job.runKind,
        detail: {
          scope:
            'process entry to compiler bundle loaded, caches cold; process ' +
            'spawn overhead is excluded and is reported as wall time instead',
        },
      });
    }

    // `process_cold_cache_warm` differs from `process_cold_cache_empty` by the
    // STATE OF THE OUTPUT DIRECTORY, not by the process: a previous generation
    // is present, so the transactional snapshot and restore paths run. That is
    // what "warm cache" means for a published-artifact pipeline, and conflating
    // it with a process-warm state is how a benchmark ends up claiming a cache
    // hit it never measured.
    if (job.cacheState === 'process_cold_cache_warm') {
      // Produce one real generation first, in THIS process, so the scratch
      // project has a published generation before the measured build.
      await runOne({
        sessionId: `${job.sessionId}-seed`,
        iteration: 0,
        cacheState: 'process_cold_cache_empty',
        // The seed build runs on the PRISTINE corpus, for the same reason as
        // the warmup: it exists to establish a state, not to be measured.
        expect: 'ok',
        runKind: job.runKind,
      });
      pendingParser = null;
      driver.resetSources();
    }

    if (job.cacheState === 'process_warm_no_edit') {
      // A warmup build whose observations are DISCARDED, not averaged away: the
      // policy (one warmup, kept out of measurement, identical for both
      // engines) is recorded in the campaign metadata so it can be checked.
      await runOne({
        sessionId: `${job.sessionId}-warmup`,
        iteration: 0,
        cacheState: 'process_cold_cache_empty',
        // The warmup runs on the PRISTINE corpus, before any edit, so it is
        // always expected to succeed. Its observations are discarded; this
        // assertion exists only so a warmup that fails loudly is visible in
        // the job record rather than silently warming nothing.
        expect: 'ok',
        runKind: job.runKind,
      });
      pendingParser = null;
      // The warmup ran on the PRISTINE corpus, so restoring the sources is a
      // no-op on disk and the session is still warm. It is kept on purpose:
      // dropping it here would measure a cold build and label it a cache hit.
      //
      // The published generation is kept too, and that is the point of this
      // state. "Warm, no edit" means the generation already exists and the same
      // bytes are being submitted again; discarding the output first would
      // measure the cost of building generation N+1 from nothing, which is a
      // different question and the one `process_cold_cache_empty` answers.
      //
      // Full-publish engines are unaffected by this either way: they rewrite
      // every artifact whether or not the previous one is there. It is the
      // delta publisher that depends on it, and it would be measuring nothing
      // if the generation were removed underneath it.
      driver.resetSources({ dropSession: false, preservePublished: true });
      // The measured event: the SAME bytes, submitted again, with NO edit
      // applied. This is a cache hit and is labelled as one, forever. A
      // scenario that only declares this state does so because its measured
      // quantity is the cost of resubmitting identical bytes.
      record(
        await runOne({
          sessionId: job.sessionId,
          iteration: job.iteration,
          cacheState: job.cacheState,
          expect: scenario.expect,
          runKind: job.runKind,
        }),
      );
    } else if (job.cacheState === 'process_warm_edit') {
      await runOne({
        sessionId: `${job.sessionId}-warmup`,
        iteration: 0,
        cacheState: 'process_cold_cache_empty',
        // The warmup runs on the PRISTINE corpus, before any edit, so it is
        // always expected to succeed. Its observations are discarded; this
        // assertion exists only so a warmup that fails loudly is visible in
        // the job record rather than silently warming nothing.
        expect: 'ok',
        runKind: job.runKind,
      });
      pendingParser = null;
      // The real revision sequence, on top of a WARM process. A scenario with
      // several revisions runs all of them here, in the same process, exactly
      // as the cold path does: running only the first would measure half a
      // scenario and, for a remove/restore pair, would report the removal's
      // failure as the scenario's result.
      // Revisions are CUMULATIVE. A pair like "introduce a violation, then
      // repair it" or "turn a flag on, then turn it off" is a statement about
      // one project's history; restoring the corpus between revisions would
      // make revision 1 a different scenario, and the second half of every pair
      // would be measuring a pristine tree.
      for (let rev = 0; rev < Math.max(1, scenario.revisions); rev++) {
        const edits = scenario.edit(projectDir, {
          iteration: job.iteration,
          revision: rev,
        });
        driver.writeRevision(edits);
        driver.t0 = nowNs();
        record(
          await runOne({
            sessionId: job.sessionId,
            iteration: job.iteration * 100 + rev,
            cacheState: job.cacheState,
            expect: expectForRevision(scenario, rev),
            runKind: job.runKind,
          }),
        );
      }
    } else {
      // A cold process, one revision. A multi-revision scenario runs its
      // revisions in sequence inside the same cold process, because "remove a
      // token, then put it back" is a statement about ONE process's memory.
      // Cumulative, for the same reason as the warm path.
      for (let rev = 0; rev < Math.max(1, scenario.revisions); rev++) {
        const edits = scenario.edit(projectDir, {
          iteration: job.iteration,
          revision: rev,
        });
        driver.writeRevision(edits);
        driver.t0 = nowNs();
        record(
          await runOne({
            sessionId: job.sessionId,
            iteration: job.iteration * 100 + rev,
            cacheState: job.cacheState,
            expect: expectForRevision(scenario, rev),
            runKind: job.runKind,
          }),
        );
      }
    }
  } catch (err) {
    // A harness or scenario failure is a FAILURE OF THE RUN, not of the engine.
    // It is recorded as such and never silently dropped: a campaign that hides
    // its own errors is a campaign whose numbers cannot be trusted.
    rows.push({
      engine: job.engine,
      corpus: job.corpus,
      scenario: job.scenario,
      cache_state: job.cacheState,
      session_id: job.sessionId,
      iteration: job.iteration,
      metric: 'filesystem_to_diagnostics_ms',
      unit: 'ms',
      status: STATUS.ERROR,
      value: null,
      schema_version: 1,
      engine_variant_commit: job.engineVariantCommit ?? null,
      corpus_manifest_hash: manifest.contentHash,
      run_kind: job.runKind,
      detail: {
        harnessFailure: true,
        message: String(err?.message ?? err).slice(0, 600),
        stack: String(err?.stack ?? '').slice(0, 1200),
      },
    });
  }

  // Memory of the whole process group, sampled by the worker at the end: for
  // this batch the group IS the Node build process, because the CLI path spawns
  // no children. Recorded with that scope stated, not implied.
  const mem = process.memoryUsage();
  rows.push({
    engine: job.engine,
    corpus: job.corpus,
    scenario: job.scenario,
    cache_state: job.cacheState,
    session_id: job.sessionId,
    iteration: job.iteration,
    metric: 'process_rss_end_bytes',
    unit: 'bytes',
    status: STATUS.OK,
    value: mem.rss,
    schema_version: 1,
    engine_variant_commit: job.engineVariantCommit ?? null,
    corpus_manifest_hash: manifest.contentHash,
    run_kind: job.runKind,
    detail: {
      scope: 'node build process (single process, no children spawned)',
    },
  });

  writeJsonl(job.outFile, rows);
  fs.writeFileSync(
    `${job.outFile}.trace.json`,
    JSON.stringify({ trace, pid: process.pid }, null, 2),
  );
  fs.writeFileSync(
    `${job.outFile}.parses.json`,
    JSON.stringify(
      {
        documentKind: 'pandamstyle-benchmark-parse-evidence',
        engine: job.engine,
        corpus: job.corpus,
        scenario: job.scenario,
        cache_state: job.cacheState,
        note:
          'every parse and every module-cache lookup the compiler performed, ' +
          'in order. Cache hits are NOT parses and are labelled as lookups.',
        events: parseEvidence,
      },
      null,
      2,
    ),
  );
  driver.dispose();
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`worker failed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
