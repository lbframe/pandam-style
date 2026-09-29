/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle benchmark harness.
 *
 * WHAT THIS IS
 *
 * A driver that, for one (engine, corpus, scenario, cache-state, iteration),
 * produces a set of OBSERVATIONS. An observation is one metric, one value, one
 * status. Nothing is aggregated here: aggregation is `summarize.py`'s job, and
 * a harness that averaged would destroy exactly the session structure the
 * architecture study says must be preserved.
 *
 * THE PRIMARY KPI
 *
 *   filesystem/source revision -> complete correct PandamStyle diagnostics
 *
 * measured as `filesystem_to_diagnostics_ms`. It starts when the harness has
 * finished WRITING the revision to disk and ends when the compiler has produced
 * a complete verdict for that revision. The sub-intervals are recorded
 * separately and never collapsed:
 *
 *   diagnostics_complete_ms       the verdict is known (pass or fail)
 *   pms_generation_ready_ms       every artifact is staged, nothing published
 *   pms_generation_committed_ms   the commit marker is on disk
 *   bundler_ready_ms              the bundler adapter is settled (where run)
 *
 * WHY A CHILD PROCESS PER (COLD) OBSERVATION
 *
 * `process_cold_cache_empty` and `process_cold_cache_warm` are claims about a
 * PROCESS, and a process that has already compiled a corpus cannot honestly
 * make them. So those states run in a fresh child. `process_warm_*` states run
 * in a long-lived child, because that is the only way they mean anything: JIT
 * state, module registry state and the compiler's own caches are all warm, and
 * the observation is a real edit on top of them.
 *
 * THE CRITICAL SEPARATION
 *
 * `process_warm_no_edit` re-submits identical bytes. `process_warm_edit`
 * submits DIFFERENT bytes. They are different metrics with different names and
 * they are never averaged together. A cache hit on unchanged source is not edit
 * latency and is never reported as such.
 *
 * THE TIMER
 *
 * `process.hrtime.bigint()` throughout: monotonic, nanosecond, process-scoped.
 * Wall-clock ISO timestamps appear only as event ORDER metadata, never as a
 * duration.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');

const SCHEMA_VERSION = 1;
const HARNESS_VERSION = 'pms-bench-harness/1.0.0';

const STATUS = Object.freeze({
  OK: 'ok',
  ERROR: 'error',
  TIMEOUT: 'timeout',
  UNSUPPORTED: 'unsupported',
});

const CACHE_STATES = Object.freeze([
  'process_cold_cache_empty',
  'process_cold_cache_warm',
  'process_warm_no_edit',
  'process_warm_edit',
]);

// The metrics this harness can produce. A phase the compiler cannot isolate
// honestly is emitted with a `null` value and a reason, never a fabricated
// boundary. See UNMEASURABLE below.
const UNMEASURABLE = Object.freeze({
  sourcemap_ms:
    'source maps are not requested by either the CLI or the adapter, so there ' +
    'is no source-map work to time; reporting 0 would understate the build.',
  cache_hydrate_ms:
    'the compiler persists no cache across processes, so there is no ' +
    'hydration phase; a persistent cache is a Spike 2 candidate, not a fact ' +
    'about this compiler.',
  cache_validate_ms:
    'the only cache is the in-process module parse cache, which is a Map with ' +
    'no validation step. Its cost is reported as cache hit/miss counters.',
});

function nowNs() {
  return Number(process.hrtime.bigint());
}

/** A collector compatible with pandamstyle/perf.js. */
function makeCollector() {
  const durations = new Map();
  const counts = new Map();
  const parses = [];
  let peakRss = 0;
  let peakHeapUsed = 0;
  let peakExternal = 0;

  const sampleMemory = () => {
    const m = process.memoryUsage();
    if (m.rss > peakRss) peakRss = m.rss;
    if (m.heapUsed > peakHeapUsed) peakHeapUsed = m.heapUsed;
    if (m.external > peakExternal) peakExternal = m.external;
  };

  return {
    addDuration(metric, ns) {
      durations.set(metric, (durations.get(metric) ?? 0) + ns);
    },
    addCount(metric, n = 1) {
      counts.set(metric, (counts.get(metric) ?? 0) + n);
    },
    addParse(file, pipeline, durationNs) {
      sampleMemory();
      parses.push({ file, pipeline, duration_ns: durationNs });
    },
    sampleMemory,
    reset() {
      durations.clear();
      counts.clear();
      parses.length = 0;
      peakRss = 0;
      peakHeapUsed = 0;
      peakExternal = 0;
    },
    snapshot() {
      sampleMemory();
      const dur = {};
      for (const [k, v] of durations) dur[k] = v / 1e6;
      const cnt = {};
      for (const [k, v] of counts) cnt[k] = v;
      // Parse aggregation is DERIVED from the recorded events, never estimated:
      // per-file counts and per-pipeline counts are both computed from the same
      // event list, and the list is kept in the evidence.
      //
      // A CACHE HIT IS NOT A PARSE. `module-graph:cache-hit` records a lookup of
      // an already-parsed module, and counting it as a parse would answer "how
      // many times did the compiler consult its module cache" under the name
      // "how many times was a file parsed". The two are reported separately and
      // only non-lookup events feed `max_parses_per_file`.
      const byFile = new Map();
      const byPipeline = new Map();
      const lookupByFile = new Map();
      let realParses = 0;
      for (const p of parses) {
        const isLookup = p.pipeline.endsWith(':cache-hit');
        if (isLookup) {
          lookupByFile.set(p.file, (lookupByFile.get(p.file) ?? 0) + 1);
          continue;
        }
        realParses += 1;
        byFile.set(p.file, (byFile.get(p.file) ?? 0) + 1);
        byPipeline.set(p.pipeline, (byPipeline.get(p.pipeline) ?? 0) + 1);
      }
      const maxLookups =
        lookupByFile.size === 0 ? 0 : Math.max(...lookupByFile.values());
      return {
        durations_ms: dur,
        counters: cnt,
        parses: {
          total: realParses,
          by_pipeline: Object.fromEntries(byPipeline),
          distinct_files: byFile.size,
          max_parses_per_file:
            byFile.size === 0 ? 0 : Math.max(...byFile.values()),
          module_cache_lookups: parses.length - realParses,
          max_module_cache_lookups_per_file: maxLookups,
          most_consulted_module:
            [...lookupByFile.entries()].sort((a, b) => b[1] - a[1])[0] ?? null,
          events: parses,
        },
        memory: {
          peak_rss_bytes: peakRss,
          peak_heap_used_bytes: peakHeapUsed,
          peak_external_bytes: peakExternal,
        },
      };
    },
  };
}

/** One observation row, in the Benchmark Kit long JSONL shape. */
function observation(fields) {
  return {
    engine: fields.engine,
    corpus: fields.corpus,
    scenario: fields.scenario,
    cache_state: fields.cache_state,
    session_id: fields.session_id,
    iteration: fields.iteration,
    metric: fields.metric,
    unit: fields.unit,
    status: fields.status,
    value: fields.value,
    // Beyond the kit's minimum, and deliberately additive: nothing the kit
    // defines is renamed or reinterpreted.
    schema_version: SCHEMA_VERSION,
    harness_version: HARNESS_VERSION,
    engine_variant_commit: fields.engine_variant_commit ?? null,
    corpus_manifest_hash: fields.corpus_manifest_hash ?? null,
    run_kind: fields.run_kind ?? 'qualification',
    detail: fields.detail ?? null,
  };
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * The compile driver. One instance per child process; it holds the compiler
 * module, the perf collector and the in-memory corpus, and it knows how to
 * apply a scenario's edit and measure the resulting verdict.
 */
class CompileDriver {
  constructor({
    engineModule,
    corpus,
    projectDir,
    engineName,
    engineVariantCommit,
    // 'full' drives the unchanged full rebuild; 'incremental' drives the
    // project session. Both go through the SAME public API of the SAME bundle,
    // so the difference between the two engines is project-session reuse and
    // nothing else - which is the only way the comparison can be attributed.
    mode = 'full',
    // Spike 3: the publication strategy. The three variants share this bundle,
    // this session and this compilation, and differ ONLY in how the result is
    // written to disk. That is what makes the attribution between publication
    // and CSS aggregation possible at all.
    publishVariant = 'session_full_publish',
  }) {
    // The engine bundle exposes the compiler API AND the perf surface directly;
    // there is no separate `compiler` sub-object.
    this.compiler = engineModule;
    this.perf = engineModule;
    this.corpus = corpus;
    this.projectDir = projectDir;
    this.engineName = engineName;
    this.engineVariantCommit = engineVariantCommit ?? null;
    this.mode = mode;
    this.publishVariant = publishVariant ?? 'session_full_publish';
    this.session = null;
    this.sessionRevision = null;
    this.collector = makeCollector();
    this.perf.setPerfEngineName(engineName);
    this.perf.installPerfCollector(this.collector);
  }

  dispose() {
    this.closeSession();
    this.perf.installPerfCollector(null);
  }

  closeSession() {
    if (this.session == null) return;
    try {
      this.session.close();
    } catch {
      /* a session that is already closed is not a measurement problem */
    }
    this.session = null;
    this.sessionRevision = null;
  }

  /**
   * Restores every corpus file to its generated content.
   *
   * @param dropSession       discard the session's per-file results with the
   *                          sources they described.
   * @param preservePublished leave the PUBLISHED GENERATION alone. Sources and
   *                          output are different things: restoring the sources
   *                          is this function's job, and deleting the output
   *                          directory as a side effect of it means a "warm"
   *                          measurement is taken against a generation that has
   *                          been thrown away.
   */
  resetSources({ dropSession = true, preservePublished = false } = {}) {
    // A session holds per-file results for the bytes it last saw. Restoring the
    // corpus underneath a live session would leave it believing the project
    // changed when nothing did, so the session is dropped with the sources -
    // UNLESS the caller knows the corpus is already pristine, in which case
    // keeping the session is the entire point of the measurement. Dropping it
    // after a warmup would turn `process_warm_no_edit` into a cold build and
    // report the full-rebuild latency under an incremental engine's name.
    if (dropSession) this.closeSession();
    // EVERY generated file is restored, including the design system. Skipping
    // the definition would let one scenario's token edit survive into the next
    // job, which shares nothing but the corpus directory.
    for (const file of this.corpus.manifest.files) {
      const abs = path.join(this.projectDir, file.path);
      const rel = path.relative(this.projectDir, abs);
      if (rel.startsWith('..')) continue;
      const content = fs.readFileSync(
        path.join(this.corpus.sourceDir, file.path),
        'utf8',
      );
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
    }
    if (preservePublished) return;

    // The published generation, the transaction's scratch directories, AND the
    // record of the current generation. The names are the ones `generation.js`
    // derives from the output directory; clearing a differently-named path would
    // leave them behind and only look like it worked.
    //
    // The state file matters here for the same reason the others do. It is the
    // record of a generation that is about to be deleted, so leaving it behind
    // would describe a generation that no longer exists - and the next job
    // would start by trying to reuse artifacts that are gone.
    const absOut = path.join(this.projectDir, '.pandamstyle');
    const parent = path.dirname(absOut);
    const base = path.basename(absOut);
    for (const target of [
      absOut,
      path.join(parent, `.${base}.pms-staging`),
      path.join(parent, `.${base}.pms-backup`),
      path.join(parent, `.${base}.pms-state.json`),
      path.join(parent, `.${base}.pms-state.pending.json`),
    ]) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }

  writeRevision(edits) {
    // The edit is APPLIED and FLUSHED before the clock starts. Otherwise the
    // measurement would include the harness's own write, which is not
    // compilation.
    //
    // `path.resolve`, not `path.join`: scenarios return ABSOLUTE paths, and
    // `path.join(base, '/abs/path')` silently produces `base/abs/path`, which
    // writes the edit to a file nothing compiles. The build then succeeds and
    // the scenario looks like a false negative.
    const abs = (p) => path.resolve(this.projectDir, p);
    for (const edit of edits) {
      const target = abs(edit.path);
      if (edit.delete === true) {
        fs.rmSync(target, { force: true });
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, edit.content, 'utf8');
    }
    // A real fsync of the written files, so "the revision is on disk" is a fact
    // and not an intention. Cheap relative to a build, and it removes the
    // largest source of variance in a write-triggered measurement.
    for (const edit of edits) {
      if (edit.delete === true) continue;
      const target = abs(edit.path);
      try {
        const fd = fs.openSync(target, 'r');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
      } catch {
        /* a file that vanished again has nothing to flush */
      }
    }
  }

  /**
   * Runs one revision and returns the KPI plus every sub-interval.
   *
   * `expect` states what the scenario asserts. A negative case that correctly
   * REFUSES the program is `ok`, not `error`: the compiler failing a build it
   * should fail is the correct outcome, and recording it as an error would make
   * a correct engine look broken.
   */
  runRevision({ sessionId, iteration, cacheState, expect, runKind }) {
    const observations = [];
    this.collector.reset();
    this.eventIndex = 0;
    const emit = (metric, value, unit, status, detail = null) => {
      observations.push(
        observation({
          engine: this.engineName,
          corpus: this.corpus.name,
          scenario: this.corpus.scenarioName,
          cache_state: cacheState,
          session_id: sessionId,
          iteration,
          metric,
          unit,
          status,
          value,
          engine_variant_commit: this.engineVariantCommit,
          corpus_manifest_hash: this.corpus.manifest.contentHash,
          run_kind: runKind ?? 'qualification',
          detail,
        }),
      );
    };

    const t0 = nowNs();
    let outcome;
    try {
      outcome = this.compileOnce();
    } catch (err) {
      outcome = { error: err };
    }
    const t1 = nowNs();

    const snapshot = this.collector.snapshot();
    const expectedFailure = expect === 'fail';

    if (outcome.error != null) {
      const isPms = Array.isArray(outcome.error.diagnostics);
      if (expectedFailure && isPms) {
        // The correct outcome for a negative scenario.
        emit('filesystem_to_diagnostics_ms', (t1 - t0) / 1e6, 'ms', STATUS.OK, {
          expected: 'fail',
          codes: [...new Set(outcome.error.diagnostics.map((d) => d.code))],
        });
        emit('diagnostics_complete_ms', (t1 - t0) / 1e6, 'ms', STATUS.OK);
      } else {
        emit('filesystem_to_diagnostics_ms', null, 'ms', STATUS.ERROR, {
          message: String(outcome.error?.message ?? outcome.error).slice(
            0,
            400,
          ),
          hasPmsDiagnostics: isPms,
        });
        emit('diagnostics_complete_ms', null, 'ms', STATUS.ERROR);
      }
      this.emitPhaseMetrics(
        emit,
        snapshot,
        cacheState,
        sessionId,
        iteration,
        runKind,
      );
      this.emitRevisionCounters(emit);
      return { observations, snapshot, verdict: isPms ? 'rejected' : 'error' };
    }

    // Success path. A negative scenario that SUCCEEDED is a real failure: the
    // engine failed to refuse a program it must refuse.
    if (expectedFailure) {
      emit(
        'filesystem_to_diagnostics_ms',
        (t1 - t0) / 1e6,
        'ms',
        STATUS.ERROR,
        {
          message:
            'the scenario expects this program to be refused, and the build succeeded',
        },
      );
      emit('diagnostics_complete_ms', null, 'ms', STATUS.ERROR);
      this.emitPhaseMetrics(
        emit,
        snapshot,
        cacheState,
        sessionId,
        iteration,
        runKind,
      );
      this.emitRevisionCounters(emit);
      return { observations, snapshot, verdict: 'unexpected-success' };
    }

    emit('filesystem_to_diagnostics_ms', (t1 - t0) / 1e6, 'ms', STATUS.OK);
    emit('diagnostics_complete_ms', (t1 - t0) / 1e6, 'ms', STATUS.OK);
    if (outcome.timings != null) {
      emit('pms_generation_ready_ms', outcome.timings.readyMs, 'ms', STATUS.OK);
      emit(
        'pms_generation_committed_ms',
        outcome.timings.committedMs,
        'ms',
        STATUS.OK,
      );
    }
    if (outcome.timings?.bundlerReadyMs != null) {
      emit('bundler_ready_ms', outcome.timings.bundlerReadyMs, 'ms', STATUS.OK);
    } else {
      emit('bundler_ready_ms', null, 'ms', STATUS.UNSUPPORTED, {
        reason:
          'this scenario drives the CLI/session path, not a bundler; the ' +
          'bundler adapter is exercised by the bundler_ready scenario family',
      });
    }

    this.emitPhaseMetrics(
      emit,
      snapshot,
      cacheState,
      sessionId,
      iteration,
      runKind,
    );
    this.emitRevisionCounters(emit);
    return { observations, snapshot, verdict: 'accepted' };
  }

  /**
   * The project's own revision accounting, as observations.
   *
   * These are REUSE counters, not work counters: a reused file cost one hash
   * comparison and no parse. They are emitted only for the session engine, and
   * only when the session produced a revision, so a row is never a fabricated
   * zero for an engine that has no such concept.
   */
  emitRevisionCounters(emit) {
    if (this.mode !== 'incremental') return;
    const counters = this.lastRevisionCounters();
    if (counters == null) return;
    const map = {
      affected_file_count: counters.filesChanged + counters.filesAdded,
      reparsed_file_count: counters.filesReparsed,
      recompiled_file_count: counters.filesRecompiled,
      reused_file_count: counters.filesReused,
      removed_file_count: counters.filesRemoved,
      coverage_summaries_reused: counters.coverageSummariesReused,
      coverage_summaries_rebuilt: counters.coverageSummariesRebuilt,
      reverse_dependents_invalidated: counters.reverseDependentsInvalidated,
      negative_resolutions_invalidated: counters.negativeResolutionsInvalidated,
      full_fallback_count: counters.fullFallback,
    };
    for (const [metric, value] of Object.entries(map)) {
      emit(metric, value, 'count', STATUS.OK, {
        revisionId: this.sessionRevision.revisionId,
        fullFallbackReason: counters.fullFallbackReason ?? null,
      });
    }
  }

  emitPhaseMetrics(emit, snapshot) {
    for (const [metric, value] of Object.entries(snapshot.durations_ms)) {
      emit(metric, value, 'ms', STATUS.OK);
    }
    for (const [metric, value] of Object.entries(snapshot.counters)) {
      emit(metric, value, 'count', STATUS.OK);
    }
    emit('parse_calls_total', snapshot.parses.total, 'count', STATUS.OK);
    emit(
      'parse_distinct_files',
      snapshot.parses.distinct_files,
      'count',
      STATUS.OK,
    );
    emit(
      'parse_max_per_file',
      snapshot.parses.max_parses_per_file,
      'count',
      STATUS.OK,
      {
        note:
          'maximum number of REAL parses of one file; a module-graph cache hit ' +
          'is a lookup and is counted separately',
        mostConsultedModule: snapshot.parses.most_consulted_module,
      },
    );
    emit(
      'module_cache_max_lookups_per_file',
      snapshot.parses.max_module_cache_lookups_per_file,
      'count',
      STATUS.OK,
    );
    for (const [pipeline, n] of Object.entries(snapshot.parses.by_pipeline)) {
      emit(`parse_calls:${pipeline}`, n, 'count', STATUS.OK);
    }
    emit('rss_peak_bytes', snapshot.memory.peak_rss_bytes, 'bytes', STATUS.OK);
    emit(
      'heap_peak_bytes',
      snapshot.memory.peak_heap_used_bytes,
      'bytes',
      STATUS.OK,
    );
    emit(
      'external_peak_bytes',
      snapshot.memory.peak_external_bytes,
      'bytes',
      STATUS.OK,
    );

    for (const [metric, reason] of Object.entries(UNMEASURABLE)) {
      if (snapshot.durations_ms[metric] != null) continue;
      emit(metric, null, 'ms', STATUS.UNSUPPORTED, { reason });
    }
  }

  /**
   * One real build through the public API of the engine's compiler bundle.
   *
   * This is the production entry point (`buildProject`), driven in-process. The
   * only thing the harness substitutes is the clock: it reads the generation's
   * own staging and commit points rather than the bundler.
   */
  /**
   * Loads the build configuration and the design-system definition.
   *
   * ASYNC, and cache-busted, on purpose.
   *
   * The definition is an ES module, and Node's ES module registry is keyed by
   * full URL and has no public invalidation API: `delete require.cache[...]` is
   * a no-op for it. Without the cache-busting query, a warm edit to the
   * definition - a token value, a removed token, a new condition, a recipe
   * branch - would be written to disk and then IGNORED. The build would
   * succeed, the scenario would report a false negative, and every
   * definition-level number in the campaign would describe a file that no
   * longer exists. The query does not change the module: the bare specifier it
   * imports still resolves against the same directory.
   */
  async loadConfig() {
    const configPath = path.join(this.projectDir, 'pandamstyle.config.js');
    delete require.cache[require.resolve(configPath)];
    const config = require(configPath);
    this.definitionNonce = (this.definitionNonce ?? 0) + 1;
    const href = pathToFileURL(
      path.resolve(path.dirname(configPath), config.definition),
    ).href;
    const mod = await import(`${href}?pmsRevision=${this.definitionNonce}`);
    const definition = mod != null && mod.default != null ? mod.default : mod;
    return { config, definition };
  }

  compileOnce() {
    if (this.mode === 'incremental') return this.compileOnceIncremental();
    const compiler = this.compiler;
    const config = this.config;
    const definition = this.definition;
    if (config == null || definition == null) {
      throw new Error(
        'compileOnce() was called before loadConfig() resolved; the design ' +
          'system definition would be whatever a previous require() left in the ' +
          'module cache',
      );
    }
    const rootDir = this.projectDir;
    const resolveRoot = (r) => (path.isAbsolute(r) ? r : path.join(rootDir, r));

    const timings = {};
    let readyAt = null;
    const outDirAbs = path.resolve(resolveRoot(config.outDir));

    // The staging point is observed by wrapping `withGeneration`'s callback
    // boundary: `onStage` is a documented test seam in the production API and
    // fires exactly once, after every source is compiled and before anything is
    // published. That is `pms_generation_ready`.
    const result = compiler.buildProject({
      definition,
      roots: (config.roots ?? []).map(resolveRoot),
      outDir: outDirAbs,
      runtimeModule: config.runtimeModule,
      designSystemFile: config.designSystemFile,
      engineOptions: config.engineOptions,
      useCSSLayers: config.useCSSLayers === true,
      onStage: () => {
        readyAt = nowNs();
      },
    });

    timings.readyMs = readyAt == null ? null : (readyAt - this.t0) / 1e6;
    timings.committedMs = (nowNs() - this.t0) / 1e6;
    this.lastBuild = result;
    return { timings, result };
  }

  /**
   * One revision through the PROJECT SESSION.
   *
   * The same three calls a build tool makes - applyChanges, validate, compile -
   * against the same public API the full rebuild uses. The only substitution
   * the harness makes is the clock: `validate()` returning is
   * `pms_generation_ready` (every artifact computed, nothing published yet) and
   * `compile()` returning is `pms_generation_committed`.
   */
  compileOnceIncremental() {
    const compiler = this.compiler;
    const config = this.config;
    const definition = this.definition;
    if (config == null || definition == null) {
      throw new Error(
        'compileOnceIncremental() was called before loadConfig() resolved.',
      );
    }
    const rootDir = this.projectDir;
    const resolveRoot = (r) => (path.isAbsolute(r) ? r : path.join(rootDir, r));
    const outDirAbs = path.resolve(resolveRoot(config.outDir));
    const options = {
      definition,
      roots: (config.roots ?? []).map(resolveRoot),
      outDir: outDirAbs,
      runtimeModule: config.runtimeModule,
      designSystemFile: config.designSystemFile,
      engineOptions: config.engineOptions,
      useCSSLayers: config.useCSSLayers === true,
      // Which publication strategy this engine drives. The three Spike 3
      // variants differ ONLY here: same bundle, same session, same compilation,
      // different publication. Nothing else selects the path.
      publishVariant: this.publishVariant ?? 'session_full_publish',
    };

    const initial = this.session == null;
    if (initial) this.session = compiler.createProjectSession(options);

    this.session.applyChanges(
      initial
        ? { initial: true }
        : {
            config: {
              roots: options.roots,
              outDir: options.outDir,
              runtimeModule: options.runtimeModule,
              designSystemFile: options.designSystemFile,
              engineOptions: options.engineOptions,
              useCSSLayers: options.useCSSLayers,
            },
            definition,
          },
    );
    const validation = this.session.validate();
    this.sessionRevision = validation;

    const timings = { readyMs: (nowNs() - this.t0) / 1e6, committedMs: null };
    let result = null;
    let error = null;
    if (validation.ok) {
      result = this.session.compile();
      timings.committedMs = (nowNs() - this.t0) / 1e6;
      this.lastBuild = result;
    } else {
      // A refused revision does not publish. The driver reports the refusal
      // through the SAME error shape the full rebuild produces, so the
      // observation layer cannot tell the two engines apart by their failure
      // path - only by their latency.
      error = new Error('pms incremental revision refused');
      error.diagnostics = validation.diagnostics;
    }
    return { timings, result, error, revision: validation };
  }

  /** The counters of the last session revision, for the observation layer. */
  lastRevisionCounters() {
    return this.sessionRevision == null ? null : this.sessionRevision.counters;
  }
}

/**
 * Environment capture. Enough to reproduce a number, not "a MacBook".
 */
function captureEnvironment(repoRoot) {
  const cpus = os.cpus();
  let lockfileDigest = null;
  try {
    lockfileDigest = sha256(fs.readFileSync(path.join(repoRoot, 'yarn.lock')));
  } catch {
    lockfileDigest = null;
  }
  // `findmnt` first, `stat` only as a fallback.
  //
  // `stat -f -c %T` reports the ext FAMILY label (`ext2/ext3`) for ext2, ext3
  // and ext4 alike - all three share magic 0xEF53 - so it cannot answer the
  // question this field is asking. An earlier run of this campaign recorded
  // `ext2/ext3` on what is in fact an ext4 volume; `findmnt -no FSTYPE` gives
  // the real type, so it is preferred and the stat label is kept only as a
  // fallback with the limitation recorded next to it.
  let fsType = 'unknown';
  let fsSource = 'none';
  try {
    const out = spawnSync('findmnt', ['-no', 'FSTYPE', '--target', repoRoot], {
      encoding: 'utf8',
    });
    if (out.status === 0 && out.stdout.trim() !== '') {
      fsType = out.stdout.trim();
      fsSource = 'findmnt -no FSTYPE';
    }
  } catch {
    /* fall through to stat */
  }
  if (fsType === 'unknown') {
    try {
      const out = spawnSync('stat', ['-f', '-c', '%T', repoRoot], {
        encoding: 'utf8',
      });
      if (out.status === 0) {
        fsType = out.stdout.trim();
        fsSource =
          'stat -f -c %T (ext-family label; cannot distinguish ext2/ext3/ext4)';
      }
    } catch {
      /* recorded as unknown rather than guessed */
    }
  }
  let powerMode = null;
  try {
    const out = spawnSync(
      'bash',
      ['-lc', 'cat /sys/class/power_supply/AC*/online 2>/dev/null | head -1'],
      {
        encoding: 'utf8',
      },
    );
    if (out.status === 0 && out.stdout.trim() !== '') {
      powerMode = out.stdout.trim() === '1' ? 'ac' : 'battery';
    }
  } catch {
    powerMode = null;
  }
  return {
    captured_at: new Date().toISOString(),
    machine: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      os_release: safeRead('/etc/os-release', 'PRETTY_NAME'),
    },
    cpu: {
      model: cpus.length > 0 ? cpus[0].model : 'unknown',
      logical_cores: cpus.length,
      speed_mhz: cpus.length > 0 ? cpus[0].speed : null,
    },
    memory: {
      total_bytes: os.totalmem(),
      free_bytes_at_start: os.freemem(),
    },
    runtime: {
      node: process.version,
      node_execpath: process.execPath,
      v8: process.versions.v8,
      uv: process.versions.uv ?? null,
      npm: safeCommand('npm', ['--version']),
      yarn: safeCommand('yarn', ['--version']),
      worker_count: os.cpus().length,
    },
    storage: {
      filesystem: fsType,
      filesystem_source: fsSource,
      repo_root: repoRoot,
      lockfile_sha256: lockfileDigest,
    },
    power_mode: powerMode,
    build_settings: {
      source_maps: 'disabled',
      minification: 'disabled',
      target: 'node-22',
      node_icu:
        process.config.variables.icu_small === undefined ? null : 'default',
    },
  };
}

function safeRead(file, key) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const line = text.split('\n').find((l) => l.startsWith(`${key}=`));
    return line == null ? null : line.slice(key.length + 1).replace(/"/g, '');
  } catch {
    return null;
  }
}

function safeCommand(cmd, args) {
  try {
    const out = spawnSync(cmd, args, { encoding: 'utf8' });
    return out.status === 0 ? out.stdout.trim() : null;
  } catch {
    return null;
  }
}

module.exports = {
  HARNESS_VERSION,
  SCHEMA_VERSION,
  STATUS,
  CACHE_STATES,
  UNMEASURABLE,
  CompileDriver,
  makeCollector,
  observation,
  captureEnvironment,
  nowNs,
  sha256,
};
