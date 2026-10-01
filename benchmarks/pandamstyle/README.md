# PandamStyle benchmark laboratory

**Batch: Spike 4, Phase C — the agent loop and the split of audit metadata.**

This directory also holds the Spike 1 and Spike 2 harnesses, which are unchanged
and still runnable. The five tools Phase C added are documented first, because
the agent loop is the workload this batch is about; the rest of the document is
Spike 2's brief, still accurate for what it measured.

---

## The agent loop, and what Phase C measures

The loop an AI coding agent runs, end to end:

```
agent writes files
        ↓
session.applyAgentChanges({ changed: [...] })
        ↓
session.validate()          → complete diagnostics for that revision
        ↓
session.compile()           → generation committed
session.requestFullAudit()  → the full evidence, when it is wanted
```

The primary metric is **`agent_edit_to_diagnostics_ms`**: the mutation
transaction accepted, to complete authoritative diagnostics for that revision.
It is _not_ mutation → publication → audit report written, and the two are never
collapsed.

| tool                        | what it does                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agent-loop.js`         | the campaign. Four metadata policies × twelve scenarios × N iterations, one process per cell                                                   |
| `src/agent-loop-summary.js` | the tables. Headline milestones, work counters, byte counters, reuse-loop timing                                                               |
| `src/phase-c-oracle.js`     | the correctness gate. Semantic equality against a fresh rebuild in a separate process, and audit completeness against the pre-Phase-C artifact |
| `src/phase-c-rebuild.js`    | the oracle's fresh-rebuild child process. Never runs in the oracle's own process                                                               |
| `src/report-bytes.js`       | the byte audit. A deterministic breakdown of the published metadata, measured from the serialized bytes on disk                                |

### The four variants are one compiler and four metadata policies

| variant                                              | audit policy | publishes | audits |
| ---------------------------------------------------- | ------------ | --------- | ------ |
| `full_metadata`                                      | `inline`     | yes       | no     |
| `compact_agent_result`                               | `reference`  | no        | no     |
| `compact_agent_result_plus_compact_publish_metadata` | `reference`  | yes       | no     |
| `full_audit_requested`                               | `reference`  | yes       | yes    |

Same tree, same session, same analysis, same compiler. `full_metadata` produces
the pre-Phase-C artifact — the whole project-wide coverage array inline in
`build-report.json`, schema version 1 — so the difference between the rows is
the metadata policy and nothing else. A `full_metadata` row taken from a
_different checkout_ would confound the metadata with every compiler change
between the two, which is the mistake the Spike 2 engine split was made to avoid
and the mistake this design exists not to repeat.

Variants that do different amounts of work are labelled `comparable: false` in
the summary. `full_audit_requested` writes three megabytes of evidence that
`compact_agent_result` does not, so a faster number for less work has not won
anything.

### Why the harness is separate from `run-campaign.js`

The campaign matrix is five engines × four cache states × twenty-seven
scenarios. Adding two more axes to it would make every existing row mean two
things. The Phase C questions need cells with their own names.

### The scenarios are sequences, and every edit asserts its target

`no_change`, `one_file_existing_atoms`, `five_files_batch`,
`twenty_files_batch`, `forbidden_value`, `repair_forbidden_value`, `module_add`,
`module_remove`, `file_rename`, `import_change`,
`unresolved_import_then_file_appears`, `token_value_full_fallback`.

Each revision declares what the compiler is expected to answer, and a cell that
gets the wrong answer FAILS rather than reporting a fast wrong one. Every edit
asserts that the text it is about to change is present: a scenario that did not
find its target would apply an empty edit, and an empty edit is a no-op — the
single most misleading number this harness could report. The `no_change`
scenario is the one that submits identical bytes, and it is reported as
`declared / contentChanged / contentUnchanged` so it can never be read as an
edit.

### Running it

```bash
# The harness's own tests, on the smallest corpus.
PMS_AGENT_LOOP_CORPUS=$PWD/.pms-bench/corpora/c100-t100-r10-s101   node src/agent-loop.js --self-test

# The campaign.
node src/agent-loop.js   --corpus $PWD/.pms-bench/corpora/c1000-t1000-r100-s809   --out-dir ../.pms-bench/run --iterations 7

# The tables.
node src/agent-loop-summary.js   -i ../.pms-bench/run/c1000-t1000-r100-s809-agent-loop.jsonl   -o ../.pms-bench/run/c1000-agent-loop-summary.json

# Correctness.
node src/phase-c-oracle.js   --corpus $PWD/.pms-bench/corpora/c1000-t1000-r100-s809   --out ../.pms-bench/run/c1000-phase-c-oracle.json

# The metadata byte audit, from the bytes a publication wrote.
node src/report-bytes.js   --corpus $PWD/.pms-bench/corpora/c10000-t1000-r100-s307   --out ../.pms-bench/run/c10000-report-bytes.json
```

### What the byte audit measures, and how

`bytes(field) = size(serialize(document)) - size(serialize(document \ field))`,
applied to the document that was actually written. An exact marginal cost: it
includes the key, the punctuation around the value, and the pretty-printing,
because the difference is taken between two real serializations of the real
document. A "sum the parts" breakdown is used nowhere, because the parts do not
sum to the file — the braces, the commas and the newlines belong to no part, and
the residue is reported explicitly rather than spread around.

The audit publishes with the project as the working directory, because
`relativeToCwd` falls back to the absolute path outside it and the coverage
entries are mostly path strings; a project in `/tmp` therefore produces hundreds
of kilobytes more for reasons that have nothing to do with the report's content.

### Two oracles, and why they are not the same

**Semantic** — compared for EQUALITY against a fresh full rebuild in a separate
process: the verdict, the diagnostics and their locations, the coverage set, the
compiled JavaScript, the CSS, the generation's file set, the manifest, the
registry and system identity, and the runtime composition structure.

**Audit** — compared for COMPLETENESS, not byte equality. Demanding byte
equality between the old monolithic report and the new pair would demand that
Phase C changed nothing about the format, which is the opposite of what it is
for. `AUDIT_FIELD_MAP` names where every field version 1 carried lives in
version 2; a field with no entry is reported as **unaccounted** rather than
skipped, because a comparison that ignores fields it does not recognise passes
when information was lost.

---

# Spike 2 (unchanged)

**Batch: Spike 2 — incremental file-level compilation.**

This directory is the benchmark laboratory for PandamStyle. Spike 2 asks one
question with reproducible measurements:

> On a local one-file edit, can PandamStyle avoid recompiling the files that did
> not change — and produce a result **exactly equal** to a fresh full rebuild of
> the same revision?

It does **not** contain an Oxc frontend, an SWC frontend, a Rust compiler core,
a Salsa database, a daemon, a Node-API addon, or a new CSS backend. Those are
Spike 3 or later phases. Adding one here would make it impossible to attribute a
change to removed work rather than to a port.

Spike 1's harness, engines and evidence live here unchanged and are still
runnable; the Spike 2 additions are additive.

---

## The Spike 2 engines

| engine                              | what it is                                                                                                                                                                                                                                              | how it is anchored |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `babel_full`                        | the private fresh reference path (`buildProject`): every covered file is re-read, re-parsed and recompiled on every revision                                                                                                                            | this branch        |
| `babel_incremental`                 | the project session (`createProjectSession`) through compiler test support: a revision re-scans and re-hashes the covered set, rebuilds the coverage closure from persistent module summaries, and recompiles only the files whose validity key changed | this branch        |
| `babel_incremental_work_eliminated` | the factorial variant: the session **and** the Spike 1 work-elimination caches (`PMS_WORK_ELIMINATED=1`)                                                                                                                                                | this branch        |

**Both decision-bearing engines run the SAME tree.** That is deliberate: a
`babel_full` anchored to a different worktree would make a tree difference
indistinguishable from an incrementality difference, and this batch has exactly
one attribution to get right. The only difference between `babel_full` and
`babel_incremental` is which private measurement interface of the same compiler
tree is driven. These internals are not part of the published SDK.

`babel_incremental` does **not** set `PMS_WORK_ELIMINATED`, so the benefit of
invalidation is never conflated with the benefit of Spike 1 memoization. The
factorial variant exists so the two can be measured apart, and it is reported
separately.

`babel_current` and `babel_work_eliminated` — the Spike 1 pair — remain
available for continuity. `babel_current` is **not** the superseded `e5ff62b4`:
that SHA predates native JS/TS/TSX compilation, binding-based provenance,
`props()` provenance enforcement, complete local module coverage, transactional
publication, the Vite pilot and the evidence-integrity fixes, and benchmarking
it as "current" would measure a compiler that no longer exists.

### Why the compiler carries the measurement hooks

A monkey patch could time `resolveRelativeFile`. It could not time
`buildRegistry` separately from `compileTokens`, could not say which pipeline
performed a parse, and could not attribute a diagnostic to the phase that raised
it. A phase boundary only the compiler itself can report honestly is a compiler
concern, so the hooks live in
`packages/@stylexjs/babel-plugin/pandamstyle/perf.js`. They are additive and
inert without a collector: every call is one null check, and a build that
installs no collector executes the same work in the same order.

---

## The incremental differential oracle

`src/incremental-oracle.js` is the authoritative correctness gate for the
session. For every revision of every scenario, in one project whose revisions
are cumulative:

1. apply the revision to the source tree;
2. drive the project session and capture what it **published**;
3. rebuild the same bytes from scratch, **in a fresh process**, with the
   unchanged full rebuild, and capture what it published;
4. require the two to be identical.

Step 3 is a separate process on purpose. A "fresh full rebuild" in the same
process as the session would share the module registry, the compiler's caches
and the design system the session built, and would therefore not be a fresh
rebuild at all — it would be a second opinion from the same memory, and the
whole question is whether that memory is sound.

Compared, per revision: the verdict; diagnostics (code, phase, rule, severity,
line, column, role, source, context); every published artifact byte for byte;
the runtime composition structure; the CSS bytes **and** the CSS text, with
cascade-relevant ordering never normalised; the generated design-system module;
the manifest; and the build report's semantic state.

The one normalisation, applied to **both** sides by the same rule, removes the
session's own additive `incremental` block from `build-report.json` — the block
that states _how_ the generation was produced rather than _what_ it contains.

```bash
node src/incremental-oracle.js --corpus /tmp/c --components 24 --tokens 120 \
  --recipes 6
```

---

## The long-session memory trace

`src/long-session.js` runs a hostile mix of revisions — local edits, invalid
edits, repairs, module adds and removes, a rename, global fallbacks and
no-change revisions — and records memory together with the structural counts
(file states, resolution keys, design-system consumers), because those are the
quantities a leak would move and RSS is a noisy witness.

```bash
node --expose-gc src/long-session.js --corpus /tmp/c --edits 1000
```

---

## Layout

```
benchmarks/pandamstyle/
├── README.md              this file
├── plan.json              the protocol: baseline, cells, engines, scenarios, metrics
├── summarize.py           statistics + self-test (the kit's summariser)
├── src/
│   ├── generate-corpus.js deterministic corpus generator
│   ├── harness.js         the compile driver, collector, observation writer
│   ├── worker.js          one job in one process (a cache state is a process)
│   ├── run-campaign.js    the matrix runner
│   ├── scenarios.js       the scenario vocabulary: real content revisions
│   ├── differential.js    the Spike 1 semantic oracle (engine vs engine)
│   ├── incremental-oracle.js  the Spike 2 oracle: session vs fresh rebuild
│   ├── long-session.js    the 1,000-revision memory and reuse trace
│   └── make-spike2-report.py  the Spike 2 evidence tables
├── tests/bench.test.js    the harness's own tests
└── traces/                per-parse evidence, written by a run
```

Scratch output (corpora, per-job projects, raw observations) goes to
`.pms-bench/` at the repository root and is **not** committed. Committed
evidence goes to `evidence/performance/spike-1/` and
`evidence/performance/spike-2/`.

---

## The primary KPI

```
filesystem / source revision
        ↓
complete, correct PandamStyle diagnostics
```

measured as **`filesystem_to_diagnostics_ms`**. The clock starts after the
revision has been written **and fsynced**, so the harness's own write is never
counted as compilation. It ends when the compiler has produced a complete
verdict, pass or fail.

The sub-intervals are recorded separately and are never collapsed into it:

| metric                        | meaning                                                     |
| ----------------------------- | ----------------------------------------------------------- |
| `diagnostics_complete_ms`     | the verdict is known                                        |
| `pms_generation_ready_ms`     | every artifact is staged, nothing published                 |
| `pms_generation_committed_ms` | the commit marker is on disk                                |
| `bundler_ready_ms`            | the bundler adapter settled (`unsupported` on the CLI path) |

### No-op is not edit

These are different quantities and are never averaged together:

- **`process_warm_no_edit`** resubmits identical bytes. It is a cache hit, it is
  labelled as one in every summary row, and it is never reported as edit
  latency.
- **`process_warm_edit`** submits bytes that differ from what was there before.

Every scenario is a real content revision. The test
`a scenario edit either changes bytes or is declared a no-op` fails the build if
a scenario ever rewrites a file with its own content, which is the single most
misleading number this harness could produce.

---

## Cache states

| state                      | process                    | output directory                                                                 |
| -------------------------- | -------------------------- | -------------------------------------------------------------------------------- |
| `process_cold_cache_empty` | never compiled this corpus | no published generation                                                          |
| `process_cold_cache_warm`  | never compiled this corpus | a published generation is present, so the transactional snapshot and restore run |
| `process_warm_no_edit`     | has compiled it            | unchanged bytes resubmitted — **a cache hit**                                    |
| `process_warm_edit`        | has compiled it            | a real revision on top                                                           |

`os_cold` is **`not_run`**. Dropping the OS page cache needs privileges this
environment does not grant, and faking it would not reproduce a cold cache.
Every number in the report is a warm-OS-cache number and says so.

---

## Corpora

`generate-corpus.js` produces a real PandamStyle project, not a pile of repeated
files:

- a design system with primitive tokens, semantic aliases, public/private
  visibility, themes, named conditions, recipes with three axes, and recipe
  variants;
- a **barrel** that pages reach the design system through, so the re-export walk
  is on the hot path of every component;
- twelve component shapes — themed, recipe-static, recipe-props, aliased,
  conditional, composition, barrel, TS wrapper, multi-namespace, condition
  block, wide, plain — distributed round-robin, so every transform path is
  exercised at scale;
- TypeScript on every component, because pass 2 has to strip it;
- an **isolated** negative root, one file per policy code, with its own build
  config. A forbidden channel inside the positive root would make every positive
  build fail.

### Determinism

Same `(components, tokens, recipes, seed, fanout)` ⇒ byte-identical source and a
byte-identical manifest. Randomness is a pinned SplitMix64 stream seeded only by
`seed`; `Math.random` and `Date.now` are never called. The only excluded
metadata is the generator commit.

Proven by `the same parameters produce byte-identical source and manifest`, and
by regenerating at three scales during the batch and comparing trees with
`diff -r`.

Corpora are named `c<components>-t<tokens>-r<recipes>-s<seed>-f<fanout>`, so a
corpus name always implies its seed and its fanout.

---

## Instrumentation

`perf.js` exposes a collector the driver installs. With no collector, every hook
is a null check and the compilation is the compilation.

**Phases** (`*_ms`): `startup`, `io`, `resolve`, `parse`, `semantic`,
`ir_lower`, `policy`, `recipe`, `atomic_lower`, `hash_dedup`, `rule_sort`,
`js_codegen`, `sourcemap`, `css_serialize`, `cache_validate`, `cache_hydrate`,
`boundary`, `publish`, plus the design-system sub-phases (`ds_build_registry`,
`ds_token_compile`, `ds_theme_compile`, `ds_recipe_compile`, `ds_manifest`,
`ds_module_codegen`) and the CSS sub-phases (`css_lower`, `css_dedup`,
`css_sort`, `css_join`, `styleq`).

**Counters**: `parsed_files`, `parse_calls`, `semantic_builds`, `ast_clones`,
`read_bytes`, `written_bytes`, `read_calls`, `write_calls`, `stat_calls`,
`atoms`, `atom_contributions`, `diagnostics`, `covered_files`,
`design_system_builds`, `resolution_probes`, `resolution_positive_hits`,
`resolution_negative_hits`, `ds_module_walks`, `ds_module_walk_hits`,
`pass1_calls`, `pass2_calls`.

**Memory**: `rss_peak_bytes`, `heap_peak_bytes`, `external_peak_bytes`,
`process_rss_end_bytes`. The scope is stated in the row: for this batch the
process group _is_ the Node build process, because the CLI path spawns no
children.

### Phases that cannot be isolated are reported as unavailable

| metric              | status        | why                                                                                                                                               |
| ------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sourcemap_ms`      | `unsupported` | source maps are not requested by either the CLI or the adapter, so there is no source-map work to time. Reporting `0` would understate the build. |
| `cache_hydrate_ms`  | `unsupported` | the compiler persists no cache across processes. A persistent cache is a Spike 2 candidate, not a fact about this compiler.                       |
| `cache_validate_ms` | `unsupported` | the only cache is an in-process `Map` with no validation step. Its cost is reported as hit/miss counters instead.                                 |

A phase boundary that cannot be observed is recorded `null` with a reason. It is
never inferred from a neighbouring boundary.

### Parse counting is measured, not inferred

Babel's parser is wrapped in the worker, **before** the engine is loaded, so a
parse duration is observed at the parse site. The compiler labels which pipeline
is about to parse, so a parse is attributed to `module-graph`, `babel:pass1` or
`babel:pass2` rather than to "somebody".

A **cache hit is not a parse**. `module-graph:cache-hit` records a lookup of an
already-parsed module and is counted separately; only non-lookup events feed
`parse_max_per_file`. Conflating them would answer "how many times was a file
parsed" with "how many times was the module cache consulted", under the same
name.

Every parse event, in order, is written to a per-job `.parses.json` and kept as
evidence. The counters are derived from that list.

---

## The differential oracle

`babel_current` is the semantic reference. `babel_work_eliminated` is compared
against it on:

- build success/failure (exit status)
- PMS diagnostic codes, count, phase, rule, severity, **line and column**, and
  normalised context
- coverage: which files were analysed, and the expected-vs-analysed verdict
- external requests and relay edges
- `registryDigest` and `systemId`
- manifest semantics
- generated design-system module
- **CSS byte for byte**, with cascade-relevant ordering never normalised away
- compiled JS byte digests, per file
- runtime composition structure: the class literals, `__pmsRecipe_*` references
  and import specifiers the runtime actually consumes

Two gates, in this order:

1. **Expectation.** The _reference_ engine's verdict is asserted against the
   scenario's declared expectation. Equivalence between two engines that are
   both wrong is not equivalence, and a negative scenario where both quietly
   accepted the program would otherwise compare as "equivalent" while the policy
   guarantee was broken.
2. **Equivalence.** The two engines must then agree on everything above.

A failure is a failure: the oracle exits non-zero and prints the differences. It
never reports a "close enough" verdict.

---

## What `babel_work_eliminated` removes

Read the report for the measured effect. The optimizations are gated behind
`PMS_WORK_ELIMINATED`, read once at module load, **defaulting to off**: a
measurement must never be able to change what a user's build does. Production
stays on the current behaviour until the batch explicitly proves and documents
otherwise.

---

## Running it

```bash
# Stage A: prove the harness. Debug runs publish no performance conclusion.
node src/run-campaign.js --plan plan.json \
  --corpora c100-t100-r10 --iterations 2 --run-kind debug

# Stage B: measure.
node src/run-campaign.js --plan plan.json \
  --corpora c100-t100-r10 --iterations 7 --repetitions 1 --run-kind qualification \
  --out ../.pms-bench/qualification/c100.jsonl

# Statistics.
python3 summarize.py --self-test
python3 summarize.py -i <observations>.jsonl -o <summary>.json

# Correctness.
node src/differential.js --corpus /tmp/corpus --components 100 --tokens 100 --recipes 10

# The harness's own tests.
node --test tests/bench.test.js
```

Useful flags: `--scenarios`, `--cache-states`, `--engines`, `--work-dir`,
`--timeout-ms`, `--run-kind`.

### The baseline worktree

`babel_current` needs a checkout of the baseline:

```bash
git worktree add ../pms-baseline d5702374ac5a685499d14a53bf323d8533e6982d
```

Apply the instrumentation patch from this branch to that worktree (it is
additive), give it the same `node_modules` (a symlink is enough), and build
`packages/@pandamstyle/compiler`. `PMS_BASELINE_ROOT` overrides the path.

---

## Statistics

`summarize.py` is the kit's summariser and must pass `--self-test` before use.
It reports count, min, median, **p95 by upper rank**, max, sample variance,
status counts, the number of distinct sessions behind each statistic, and the
sessions themselves.

It computes **no confidence intervals**, and says so in its own output. The
architecture study recommends session/block-level treatment because warm events
inside one session are correlated; a median over all observations silently gives
one session more votes than another. The script therefore preserves session ids
and flags any group resting on a single session as a measurement, not a
distribution. Raw observations are never destroyed.

Engines are **not ranked** when their correctness status differs. A faster
engine that does not do the same work has not won anything; the row is emitted
with `comparable: false` and the reason.

---

## Failure handling

A job that crashes, times out, produces an unexpected verdict, or whose scenario
cannot find a target **fails the run and stays in the evidence** with a non-`ok`
status. Nothing is dropped to make a number look better. A scenario that cannot
find the source construct it claims to edit raises rather than applying an empty
edit, because an empty edit measures a no-op and would be reported as an edit.

---

## Known limitations of the harness

- **OS page cache is never cold.** Every number is a warm-OS-cache number.
- **`bundler_ready_ms` is `unsupported` on the CLI path.** The bundler adapter
  is not driven in the latency campaign; driving Vite for every cell would
  measure Vite.
- **`cancel_and_retry` and `crash_during_publication` are `not_run`.** They stay
  in the protocol with a stated reason. The transactional guarantee they would
  touch is covered by the existing compiler tests, which is a correctness gate
  rather than a latency metric.
- **The generated corpus is one shape family.** Twelve component shapes over
  real tokens, conditions, recipes and barrels is representative of P0, not of
  every application that will use PandamStyle. The absolute numbers characterise
  _this_ workload; the ratios between phases are the transferable result.
- **One machine, one Node, one filesystem.** Nothing here is a claim about other
  hardware. The machine identity is recorded precisely enough to re-check it.
