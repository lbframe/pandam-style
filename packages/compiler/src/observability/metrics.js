/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - measurement hooks (Spike 1, benchmark-only surface).
 *
 * WHAT THIS IS
 *
 * A zero-cost-when-unused collection point. Every compiler phase calls
 * `phase()` and `count()` here; when no collector is installed each call is one
 * null check and returns. Nothing about compilation depends on this module, so
 * a build that never installs a collector executes the same work in the same
 * order as a build that does not.
 *
 * WHY IT EXISTS AS SOURCE AND NOT AS A MONKEY PATCH
 *
 * A monkey patch could time `resolveRelativeFile`, but it could not time
 * `buildRegistry` separately from `compileTokens`, could not say which pipeline
 * performed a parse, and could not attribute a diagnostic to the phase that
 * raised it. The architecture study asked for phase boundaries that are not
 * fabricated. A boundary that only the compiler itself can report honestly is
 * therefore a compiler concern.
 *
 * THE TIMER
 *
 * `process.hrtime.bigint()`: a monotonic, nanosecond-resolution clock scoped to
 * the process. It is immune to wall-clock adjustment, so a duration measured
 * here is a duration and not a pair of timestamps that disagree. Wall-clock
 * timestamps remain available to the harness for event ordering only.
 *
 * WORK-ELIMINATION GATE
 *
 * `workEliminated()` is the single switch that turns the measured redundant
 * work off. It is read from the environment ONCE, so a process cannot change
 * engines half way through a campaign. Production keeps the default (`false`):
 * a measurement must never be able to change what a user's build does.
 */

const RESERVED = Object.freeze({
  // Durations, milliseconds.
  startup_ms: 0,
  io_ms: 0,
  resolve_ms: 0,
  parse_ms: 0,
  // Pass 2 lowers an already parsed PandamStyle AST; it is deliberately kept
  // separate from parse time so an AST-fed Babel transform is not counted as a
  // parse.
  babel_pass2_ast_ms: 0,
  semantic_ms: 0,
  ir_lower_ms: 0,
  policy_ms: 0,
  recipe_ms: 0,
  atomic_lower_ms: 0,
  hash_dedup_ms: 0,
  rule_sort_ms: 0,
  js_codegen_ms: 0,
  sourcemap_ms: 0,
  css_serialize_ms: 0,
  cache_validate_ms: 0,
  cache_hydrate_ms: 0,
  boundary_ms: 0,
  publish_ms: 0,
  // Sub-phase durations that have no Benchmark Kit name.
  ds_build_registry_ms: 0,
  ds_snapshot_build_ms: 0,
  ds_token_compile_ms: 0,
  ds_theme_compile_ms: 0,
  ds_recipe_compile_ms: 0,
  ds_manifest_ms: 0,
  ds_manifest_codegen_ms: 0,
  ds_module_codegen_ms: 0,
  ds_types_codegen_ms: 0,
  ds_artifact_set_ms: 0,
  coverage_graph_ms: 0,
  css_lower_ms: 0,
  css_dedup_ms: 0,
  css_sort_ms: 0,
  css_join_ms: 0,
  styleq_ms: 0,
  // Project-session phases (Spike 2).
  session_scan_ms: 0,
  session_resolve_ms: 0,
  session_closure_ms: 0,
  session_dsv_view_ms: 0,
  session_compile_files_ms: 0,
  session_aggregate_ms: 0,
  session_incremental_ms: 0,
  // Publication sub-phases (Spike 3). `publish_ms` stays the aggregate, so the
  // Spike 2 series remains comparable; these say WHERE it went. The sub-phases
  // overlap `publish_ms` and must not be summed against it.
  publish_io_ms: 0,
  publish_prepare_ms: 0,
  publish_materialize_ms: 0,
  publish_metadata_ms: 0,
  publish_commit_ms: 0,
  publish_cleanup_ms: 0,
  // Counters.
  parsed_files: 0,
  parse_calls: 0,
  parse_lookups: 0,
  parse_cache_hits: 0,
  unreadable_modules: 0,
  semantic_builds: 0,
  validity_checks: 0,
  validity_input_hashes: 0,
  files_invalidated: 0,
  publication_candidates: 0,
  publication_output_paths: 0,
  ast_clones: 0,
  read_bytes: 0,
  written_bytes: 0,
  read_calls: 0,
  write_calls: 0,
  stat_calls: 0,
  atoms: 0,
  atom_contributions: 0,
  diagnostics: 0,
  covered_files: 0,
  design_system_builds: 0,
  design_system_cache_hits: 0,
  resolution_probes: 0,
  resolution_positive_hits: 0,
  resolution_negative_hits: 0,
  ds_module_walks: 0,
  ds_module_walk_hits: 0,
  rule_invocations: 0,
  pass1_calls: 0,
  pass2_calls: 0,
  pass2_ast_calls: 0,
  // Project-session counters (Spike 2). These count REUSE, which is a
  // different quantity from work done: a file that is reused costs one hash
  // comparison and no parse, and counting it as work would be counting the
  // wrong thing.
  session_revisions: 0,
  files_changed: 0,
  files_added: 0,
  files_removed: 0,
  files_reparsed: 0,
  files_recompiled: 0,
  files_reused: 0,
  coverage_summaries_reused: 0,
  coverage_summaries_rebuilt: 0,
  reverse_dependents_invalidated: 0,
  negative_resolutions_invalidated: 0,
  negative_resolutions: 0,
  full_fallback: 0,
  session_file_states: 0,
  session_resolution_keys: 0,
  session_resolution_dirs: 0,
  // Publication delta (Spike 3). These count WORK, not projection: a file is
  // `output_files_written` because a byte was written for it, `reused` because
  // verified bytes were retained or linked, `removed` because its record left.
  output_files_added: 0,
  output_files_changed: 0,
  output_files_reused: 0,
  output_files_removed: 0,
  output_bytes_written: 0,
  output_bytes_reused: 0,
  output_bytes_deleted: 0,
  // 1 when a new generation directory was installed, 1 when the current one was
  // already byte-identical and was kept.
  generation_materialized: 0,
  generation_reused: 0,
  // Which reuse strategy actually ran. A filesystem without link support is
  // correct but O(total bytes), and a run on it must say so.
  publication_hardlinks: 0,
  publication_copies: 0,
  // Incremental CSS (Spike 3, Phase B).
  css_incremental_update_ms: 0,
  css_order_maintenance_ms: 0,
  css_final_serialize_ms: 0,
  css_rules_added: 0,
  css_rules_removed: 0,
  css_rules_reused: 0,
  css_rules_refcount_changed: 0,
  css_bytes_written: 0,
  css_generation_reused: 0,
  css_full_fallback: 0,
  // Dirty-file input (Spike 4). The three mode counters are named rather than
  // encoded so a row says WHICH provenance produced it, and
  // `dirty_input_mode` in the build report says the same thing in words.
  dirty_input_mode_verified_explicit: 0,
  dirty_input_mode_watcher: 0,
  dirty_input_mode_full_discovery: 0,
  dirty_files_declared: 0,
  dirty_files_read: 0,
  dirty_files_hashed: 0,
  dirty_files_unchanged: 0,
  project_files_scanned: 0,
  project_files_skipped: 0,
  resolution_keys_rechecked: 0,
  resolution_keys_scoped: 0,
  negative_resolution_keys_rechecked: 0,
  full_discovery_fallback: 0,
  mutation_set_audits: 0,
  mutation_set_discrepancies: 0,
  // Agent-loop metadata (Spike 4, Phase C). These are DURATION names for
  // numbers that are not phases of a build, so they are fed to `count()` with a
  // millisecond value rather than added through `phase()`. That asymmetry is
  // deliberate: a phase is a boundary the compiler owns, and these are
  // measurements of intervals the SPIKE defined across several of them.
  agent_result_bytes: 0,
  agent_result_build_ms: 0,
  agent_result_serialize_ms: 0,
  build_report_bytes: 0,
  build_report_build_ms: 0,
  build_report_serialize_ms: 0,
  build_report_write_ms: 0,
  coverage_report_bytes: 0,
  coverage_report_build_ms: 0,
  coverage_report_serialize_ms: 0,
  coverage_report_write_ms: 0,
  full_report_bytes: 0,
  full_report_serialize_ms: 0,
  full_report_write_ms: 0,
  full_report_requested: 0,
  full_report_deferred: 0,
  metadata_bytes_written: 0,
  // The O(total) half of `analyseCoveredFiles`, split from the O(affected)
  // half. `session_compile_affected_ms` is the work the edit caused;
  // `session_reuse_iteration_ms` is what visiting the untouched files costs.
  session_compile_affected_ms: 0,
  session_reuse_iteration_ms: 0,
  session_coverage_entries_ms: 0,
  covered_entries_iterated: 0,
  dirty_input_apply_ms: 0,
  filesystem_discovery_ms: 0,
  metadata_hotpath_ms: 0,
  project_service_queue_wait_ms: 0,
  project_service_queue_run_ms: 0,
  // Watcher (Spike 4, Phase B).
  watch_events_seen: 0,
  watch_events_coalesced: 0,
  watch_resyncs: 0,
  watch_ignored_events: 0,
  watch_journal_depth: 0,
});

let collector = null;
let engine = 'babel_current';
let workEliminatedFlag = false;

try {
  workEliminatedFlag = process.env.PMS_WORK_ELIMINATED === '1';
} catch {
  workEliminatedFlag = false;
}

/** Is the work-elimination variant active in this process? */
export function workEliminated() {
  return workEliminatedFlag;
}

/** Installs a collector. Returns the teardown function. */
export function installPerfCollector(next) {
  collector = next ?? null;
  return () => {
    collector = null;
  };
}

export function perfCollector() {
  return collector;
}

export function perfEngineName() {
  return engine;
}

export function setPerfEngineName(name) {
  engine = name;
}

export function perfSnapshot() {
  if (collector == null) return null;
  return collector.snapshot();
}

/** Monotonic nanoseconds. Never a wall-clock timestamp. */
export function perfNow() {
  return Number(process.hrtime.bigint());
}

/**
 * Labels the pipeline that is about to parse.
 *
 * The compiler cannot time Babel's internal parse from the inside, so a driver
 * that wants that number hooks `@babel/parser` itself. This label is how the
 * hooked parser knows WHICH pipeline it is serving, so a parse is attributed to
 * `module-graph`, `babel:pass1` or `babel:pass2` rather than to "somebody".
 *
 * It is a global rather than an argument because the hook lives in a different
 * module instance from the compiler: the compiler is a bundle, the hook is the
 * driver. Passing it through `require` would couple the driver to the bundle's
 * internals; a global says the same thing without the coupling.
 */
export function withParseOwner(label, fn) {
  const previous = globalThis.__PMS_PARSE_OWNER__;
  globalThis.__PMS_PARSE_OWNER__ = label;
  try {
    return fn();
  } finally {
    globalThis.__PMS_PARSE_OWNER__ = previous;
  }
}

export function parseOwner() {
  return globalThis.__PMS_PARSE_OWNER__ ?? 'unattributed';
}

/**
 * Times `fn` and adds the elapsed duration to `metric`.
 * A throw is still accounted for: an aborted phase consumed time.
 */
export function phase(metric, fn) {
  if (collector == null) return fn();
  const start = perfNow();
  try {
    return fn();
  } finally {
    collector.addDuration(metric, perfNow() - start);
  }
}

/** Same as `phase`, for an async `fn`. */
export function phaseAsync(metric, fn) {
  if (collector == null) return fn();
  const start = perfNow();
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      collector.addDuration(metric, perfNow() - start);
    });
}

export function count(metric, n = 1) {
  if (collector == null) return;
  collector.addCount(metric, n);
}

/** Records an already measured duration without including it in a build phase. */
export function recordDuration(metric, durationNs) {
  if (collector == null) return;
  collector.addDuration(metric, durationNs);
}

/**
 * Records one parse of `file` by `pipeline`, with its own duration when the
 * caller measured one. Parse ownership is reported, never inferred.
 */
export function recordParse(file, pipeline, durationNs = null) {
  if (collector == null) return;
  collector.addParse(file, pipeline, durationNs);
}

/** The metric names this build can produce, for schema documentation. */
export function perfMetricNames() {
  return Object.keys(RESERVED);
}

export function perfCounterNames() {
  return Object.keys(RESERVED).filter((k) => k.endsWith('_ms') === false);
}
