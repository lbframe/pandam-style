# PandamStyle benchmark laboratory

**Batch: Spike 1 — performance baseline, benchmark harness, and measured work
elimination.**

This directory is the benchmark laboratory for PandamStyle. It exists to answer
one question with reproducible measurements:

> Where does PandamStyle actually spend time today, how much of that work is
> structurally unnecessary, and how far can the existing Babel compiler get
> before anyone replaces its frontend or its core?

It does **not** contain a Rust port, an Oxc frontend, an SWC frontend, a Salsa
database, a daemon, or a rewrite of the StyleX backend. Those are Spike 2 and
Spike 3. Adding one here would make it impossible to attribute a change to
removed work rather than to a port.

---

## The two engines

| engine | what it is | how it is anchored |
| --- | --- | --- |
| `babel_current` | the compiler at the official hygiene baseline `d5702374ac5a685499d14a53bf323d8533e6982d` | a git worktree at that SHA, plus the inert measurement hooks |
| `babel_work_eliminated` | the same compiler with the measured redundant work removed | this branch, `PMS_WORK_ELIMINATED=1` |

`babel_current` is **not** the superseded `e5ff62b4`. That SHA predates native
JS/TS/TSX compilation, binding-based provenance, `props()` provenance
enforcement, complete local module coverage, transactional publication, the Vite
pilot and the evidence-integrity fixes. Benchmarking it as "current" would
measure a compiler that no longer exists.

### Why the baseline carries the measurement hooks

A monkey patch could time `resolveRelativeFile`. It could not time
`buildRegistry` separately from `compileTokens`, could not say which pipeline
performed a parse, and could not attribute a diagnostic to the phase that
raised it. The architecture study asked for phase boundaries that are not
fabricated, and a boundary only the compiler can report honestly is a compiler
concern.

So the hooks (`packages/@stylexjs/babel-plugin/pandamstyle/perf.js`) are added
to **both** trees. They are additive and inert without a collector: every call
is one null check. The baseline's copy of `perf.js` additionally hard-codes the
work-elimination gate to `false`, so no value of `PMS_WORK_ELIMINATED` can change
the baseline's behaviour — the baseline is the baseline *by construction*, not
by the absence of a flag.

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
│   └── differential.js    the semantic oracle
├── tests/bench.test.js    the harness's own tests
└── traces/                per-parse evidence, written by a run
```

Scratch output (corpora, per-job projects, raw observations) goes to
`.pms-bench/` at the repository root and is **not** committed. Committed
evidence goes to `evidence/performance/spike-1/`.

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

| metric | meaning |
| --- | --- |
| `diagnostics_complete_ms` | the verdict is known |
| `pms_generation_ready_ms` | every artifact is staged, nothing published |
| `pms_generation_committed_ms` | the commit marker is on disk |
| `bundler_ready_ms` | the bundler adapter settled (`unsupported` on the CLI path) |

### No-op is not edit

These are different quantities and are never averaged together:

- **`process_warm_no_edit`** resubmits identical bytes. It is a cache hit, it is
  labelled as one in every summary row, and it is never reported as edit latency.
- **`process_warm_edit`** submits bytes that differ from what was there before.

Every scenario is a real content revision. The test
`a scenario edit either changes bytes or is declared a no-op` fails the build if
a scenario ever rewrites a file with its own content, which is the single most
misleading number this harness could produce.

---

## Cache states

| state | process | output directory |
| --- | --- | --- |
| `process_cold_cache_empty` | never compiled this corpus | no published generation |
| `process_cold_cache_warm` | never compiled this corpus | a published generation is present, so the transactional snapshot and restore run |
| `process_warm_no_edit` | has compiled it | unchanged bytes resubmitted — **a cache hit** |
| `process_warm_edit` | has compiled it | a real revision on top |

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
  conditional, composition, barrel, TS wrapper, multi-namespace, condition block,
  wide, plain — distributed round-robin, so every transform path is exercised at
  scale;
- TypeScript on every component, because pass 2 has to strip it;
- an **isolated** negative root, one file per policy code, with its own build
  config. A forbidden channel inside the positive root would make every positive
  build fail.

### Determinism

Same `(components, tokens, recipes, seed, fanout)` ⇒ byte-identical source and a
byte-identical manifest. Randomness is a pinned SplitMix64 stream seeded only
by `seed`; `Math.random` and `Date.now` are never called. The only excluded
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

**Phases** (`*_ms`): `startup`, `io`, `resolve`, `parse`, `semantic`, `ir_lower`,
`policy`, `recipe`, `atomic_lower`, `hash_dedup`, `rule_sort`, `js_codegen`,
`sourcemap`, `css_serialize`, `cache_validate`, `cache_hydrate`, `boundary`,
`publish`, plus the design-system sub-phases (`ds_build_registry`,
`ds_token_compile`, `ds_theme_compile`, `ds_recipe_compile`, `ds_manifest`,
`ds_module_codegen`) and the CSS sub-phases (`css_lower`, `css_dedup`,
`css_sort`, `css_join`, `styleq`).

**Counters**: `parsed_files`, `parse_calls`, `semantic_builds`, `ast_clones`,
`read_bytes`, `written_bytes`, `read_calls`, `write_calls`, `stat_calls`, `atoms`,
`atom_contributions`, `diagnostics`, `covered_files`, `design_system_builds`,
`resolution_probes`, `resolution_positive_hits`, `resolution_negative_hits`,
`ds_module_walks`, `ds_module_walk_hits`, `pass1_calls`, `pass2_calls`.

**Memory**: `rss_peak_bytes`, `heap_peak_bytes`, `external_peak_bytes`,
`process_rss_end_bytes`. The scope is stated in the row: for this batch the
process group *is* the Node build process, because the CLI path spawns no
children.

### Phases that cannot be isolated are reported as unavailable

| metric | status | why |
| --- | --- | --- |
| `sourcemap_ms` | `unsupported` | source maps are not requested by either the CLI or the adapter, so there is no source-map work to time. Reporting `0` would understate the build. |
| `cache_hydrate_ms` | `unsupported` | the compiler persists no cache across processes. A persistent cache is a Spike 2 candidate, not a fact about this compiler. |
| `cache_validate_ms` | `unsupported` | the only cache is an in-process `Map` with no validation step. Its cost is reported as hit/miss counters instead. |

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

1. **Expectation.** The *reference* engine's verdict is asserted against the
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

`summarize.py` is the kit's summariser and must pass `--self-test` before use. It
reports count, min, median, **p95 by upper rank**, max, sample variance, status
counts, the number of distinct sessions behind each statistic, and the sessions
themselves.

It computes **no confidence intervals**, and says so in its own output. The
architecture study recommends session/block-level treatment because warm events
inside one session are correlated; a median over all observations silently gives
one session more votes than another. The script therefore preserves session ids
and flags any group resting on a single session as a measurement, not a
distribution. Raw observations are never destroyed.

Engines are **not ranked** when their correctness status differs. A faster engine
that does not do the same work has not won anything; the row is emitted with
`comparable: false` and the reason.

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
- **`bundler_ready_ms` is `unsupported` on the CLI path.** The bundler adapter is
  not driven in the latency campaign; driving Vite for every cell would measure
  Vite.
- **`cancel_and_retry` and `crash_during_publication` are `not_run`.** They stay
  in the protocol with a stated reason. The transactional guarantee they would
  touch is covered by the existing compiler tests, which is a correctness gate
  rather than a latency metric.
- **The generated corpus is one shape family.** Twelve component shapes over
  real tokens, conditions, recipes and barrels is representative of P0, not of
  every application that will use PandamStyle. The absolute numbers characterise
  *this* workload; the ratios between phases are the transferable result.
- **One machine, one Node, one filesystem.** Nothing here is a claim about other
  hardware. The machine identity is recorded precisely enough to re-check it.
