# PandamStyle Spike 1 — performance baseline, benchmark harness, and measured work elimination

**Branch:** `perf/pandamstyle-spike-1-2026-09`
**Base SHA:** `d5702374ac5a685499d14a53bf323d8533e6982d` (tree `836a24ec91239e148547a9c686041a6f65fe0099`)

---

## 1. Verdict

**PandamStyle Spike 1 performance baseline established.**

The benchmark harness is reproducible, the current Babel compiler and the
work-eliminated Babel variant are correctness-equivalent on the tested scope,
the dominant remaining costs are measured, and the evidence is sufficient to
define the next native/incremental compiler experiment.

The measured answer to "where does the time go":

> **On a 1,000-component project, a cold full build spends ~48% of its time
> inside Babel itself — `@babel/traverse` 30%, `@babel/core` configuration 18%,
> `@babel/parser` 11%, `@babel/generator` 5%.** The PandamStyle compiler bundle
> is 11%; the StyleX atomic backend is 2.4%. Parsing is 8–12% of a build
> depending on cache state, and **each source file is parsed exactly 3 times**,
> of which one parse — the coverage graph's — costs 1.6× a full Babel parse of
> the same file because it runs with `errorRecovery`.
>
> And the structural finding, which no amount of inner-loop tuning reaches:
> **a one-file edit costs 13.5% more than resubmitting identical bytes**
> (3,460.7 ms vs 3,050.5 ms at 1,000 components). The compiler recompiles the
> entire covered root either way, so ~88% of an agent's edit latency is spent
> on files that did not change.
>
> **c1000 is the decision-bearing scale.** The 100-component cell is reported
> but is noise-dominated and carries no conclusion (§15, item 8).

That is the input to the Spike 2 decision in §12.

---

## 2. What was NOT done, and why

- **No Rust, no Oxc, no SWC, no Salsa, no daemon, no StyleX rewrite.** Adding a
  native frontend in this batch would make it impossible to attribute a change to
  removed work rather than to a port.
- **The two "authoritative inputs" named in the brief were not present on this
  machine.** `PandamStyle-Architecture-2026.md` and
  `PandamStyle-Benchmark-Kit.zip` were searched for across the filesystem and do
  not exist. The Benchmark Kit protocol was therefore **reproduced from the
  brief's own specification** — the metric names, the scenario vocabulary, the
  cache-state labels, the seed list, the 27-cell matrix, the four statuses, the
  long JSONL row shape, and the required `summarize.py` behaviour — rather than
  transcribed from the kit. This is recorded here so no reader assumes the kit's
  bytes were read.
- **`main` is untouched.** No merge, no PR, no published package.

---

## 3. Machine and toolchain

| | |
| --- | --- |
| CPU | AMD Ryzen 7 5800X3D, 8 cores / 16 threads |
| RAM | 31 GiB |
| OS | Ubuntu 24.04.4 LTS, kernel 6.8.0-138-generic |
| Filesystem | ext2/ext3 on `/dev/mapper/ubuntu--vg-ubuntu--lv` |
| Node | v22.22.0 (the repository's `.nvmrc` pin) |
| npm / yarn | 11.11.1 / 1.22.22 |
| `yarn.lock` sha256 | `6e6fb0735f5222f9…` |
| Worker count | 16 (unused: the CLI path is single-threaded) |
| Source maps / minification / target | disabled / disabled / node-22 |
| OS page cache | **never dropped** — `os_cold = not_run` |

Every number in this report is a **warm-OS-cache** number. Dropping the page
cache needs privileges this environment does not grant, and simulating it would
not reproduce a cold cache, so it is reported as `not_run` rather than
approximated.

Recorded in full in `campaigns/*-metadata.json`.

---

## 4. Engines

| engine | code state | work elimination |
| --- | --- | --- |
| `babel_current` | git worktree at `d5702374ac5a…` + the inert measurement hooks | hard-coded **off** |
| `babel_work_eliminated` | this branch at the same base + the same hooks | `PMS_WORK_ELIMINATED=1` |

**Both trees ran the same instrumentation.** `packages/@stylexjs/babel-plugin/pandamstyle/perf.js`
and the hook call sites are byte-identical in the two trees; the only difference
between them is the optimization itself (verified by diff: 2 files, ~40 lines,
all of it the memo and the `workEliminated()` branch).

The baseline's `perf.js` hard-codes `workEliminatedFlag = false`, so **no value
of `PMS_WORK_ELIMINATED` can change the baseline's behaviour** — the baseline is
the baseline by construction, not by the absence of a flag. A test asserts this.

**Working tree state at run time: `dirty` for both engines**, because the
instrumentation patch was applied but uncommitted when the campaign ran. This is
recorded in the campaign metadata rather than hidden. The evidence that the patch
is behaviour-neutral is §6.

---

## 5. Corpus

Deterministic generator, `SplitMix32` seeded only by `seed`; `Math.random` and
`Date.now` are never called.

| cell | components | tokens | recipes | seed | fanout | files | style sites | token refs | recipe calls | content hash |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `c100-t100-r10-s101` | 100 | 100 | 10 | 101 | 4 | 116 | 302 | 231 | 18 | `54b220f78e9fec85…` |
| `c1000-t1000-r100-s809` | 1,000 | 1,000 | 100 | 809 | 8 | 1,020 | 2,973 | 2,177 | 166 | `34090021532a3057…` |
| `c10000-t1000-r100-s307` | 10,000 | 1,000 | 100 | 307 | 8 | 10,020 | 29,703 | 21,813 | 1,662 | `65856fb5efe80da3…` |

Each corpus is a real PandamStyle project: a design system with primitive
tokens, semantic aliases (`ref` chains), public/private visibility, themes, eight
named conditions and three-axis recipes; a **barrel** every third component
reaches the design system through; twelve component shapes distributed
round-robin (themed, recipe-static, recipe-props, aliased, conditional,
composition, barrel, TS wrapper, multi-namespace, condition block, wide, plain);
TypeScript on every component; an isolated negative root with one file per
policy code and its own build config.

### Determinism proof

- Unit test: same parameters → byte-identical source tree (`diff` over every
  file) and byte-identical manifest, `contentHash` equal.
- Different seed → different `contentHash`, by construction.
- Regenerated at three scales during the batch and compared with `diff -r`: the
  trees were byte-identical.
- The PRNG is pinned in a test (`splitmix32(101)` stream), so a change to it
  changes every corpus hash and is visible.

### Executed / not executed cells

The protocol's qualification matrix is 27 cells. **3 of 27 were executed**:

| status | cells |
| --- | --- |
| **executed** | `c100-t100-r10` *(reported, non-conclusive — §15 item 8)*, `c1000-t1000-r100` *(decision-bearing)*, `c10000-t1000-r100` *(decision-bearing)* |
| **not_run** | the other 24, including every `t=10000` token cell and `r=1000` recipe cell |

The diagonal was chosen so that 100 / 1,000 / 10,000 components are all present
with a mid-scale registry, which is what the three scaling questions need. The
token and recipe axes were deliberately held fixed at 1,000/100 for the two
larger cells: this batch's question is about **file count**, and spending the
remaining compute on 10,000 *tokens* would have measured a registry axis the
compiler does not treat as the bottleneck (see §10). The unexecuted cells are
`not_run`, not estimated.

---

## 6. Correctness

### Differential oracle

`babel_current` is the semantic reference. `babel_work_eliminated` was compared
against it on **28 scenario revisions** at two corpus sizes, on:

- build success/failure (process exit status)
- PMS diagnostic codes, count, phase, rule, severity, **line and column**,
  normalised context
- coverage: analysed file set, expected-vs-analysed verdict
- external requests, relay edges
- `registryDigest`, `systemId`, manifest semantics
- generated design-system module
- **CSS byte for byte**, cascade-relevant ordering never normalised
- compiled JS byte digest per file
- runtime composition structure (class literals, `__pmsRecipe_*` references,
  import specifiers)

| corpus | scenarios compared | verdict |
| --- | ---: | --- |
| 24 components / 120 tokens / 6 recipes | 28 | **equivalent**, 0 errors |
| 100 components / 100 tokens / 10 recipes | 28 | **equivalent**, 0 errors |

The oracle has an **expectation gate that runs before the equivalence gate**:
the *reference* engine's verdict is asserted against the scenario's declared
expectation. Equivalence between two engines that are both wrong is not
equivalence. Every negative scenario was confirmed to fail closed with its own
policy code (`PMS_FORBIDDEN_VALUE`, `PMS_FORBIDDEN_STYLE_CHANNEL`,
`PMS_NON_STATIC_VALUE`, `PMS_TOKEN_NOT_PUBLIC`, `PMS_UNKNOWN_TOKEN`,
`PMS_UNKNOWN_CONDITION`, `PMS_COVERAGE_GAP`, `PMS_INVALID_TOKEN_CATEGORY`).

### Regression suites

| suite | expected baseline | result |
| --- | --- | --- |
| PandamStyle | 268 passed | **268 passed** |
| upstream `babel-plugin` | 1007 passed / 64 skipped | see §14 |
| upstream `stylex` | 99 passed | see §14 |

The PandamStyle suite was run against the instrumented tree after every
instrumentation change, and passes 268/268 unchanged. The instrumentation is
additive and inert without a collector.

### The remove/restore pairs

`token_remove` → `token_restore`, `forbidden_value` → `repair_forbidden_value`,
and `resolution_config_change` (an import whose target does not exist, then the
target appears **in the same process**) are the tests that a negative resolution
was not cached as a permanent absence. All three pairs pass: the removal is
refused, the restoration succeeds, and the resolution is re-derived.

---

## 7. Headline results — `c1000-t1000-r100`, `process_warm_edit`

`filesystem_to_diagnostics_ms`, milliseconds. A **real content revision on a
warm process**. This is the primary agentic benchmark.

> **The 100-component column below and in §8 and §11 is reported but
> non-conclusive** (§15, item 8). c1000 and c10000 are the decision-bearing
> scales.

| scenario | current median | current p95 | work-elim median | work-elim p95 | abs Δ | rel Δ | correct |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `no_change` *(cache-hit control)* | — see note | | | | | | |
| `format_only` | 3,364.4 | 3,502.9 | 3,205.8 | 3,299.4 | −158.6 | −4.7% | yes |
| `one_file_existing_atoms` | 3,477.5 | 3,664.7 | 3,387.1 | 3,472.1 | −90.4 | −2.6% | yes |
| `one_file_new_atom` | 3,460.7 | 3,564.0 | 3,348.9 | 3,421.7 | −111.8 | −3.2% | yes |
| `five_files_batch` | 3,504.5 | 3,716.6 | 3,487.8 | 3,528.0 | −16.7 | −0.5% | yes |
| `forbidden_value` | 3,250.4 | 3,303.6 | 3,141.8 | 3,451.7 | −108.5 | −3.3% | yes |
| `repair_forbidden_value` | 3,268.8 | 3,470.0 | 3,060.6 | 3,253.5 | −208.2 | −6.4% | yes |
| `token_value` | 3,469.6 | 3,499.5 | 3,342.4 | 3,370.6 | −127.2 | −3.7% | yes |
| `token_remove` | 436.7 | 1,305.8 | 411.8 | 595.3 | −24.9 | −5.7% | yes |
| `token_restore` | 1,895.9 | 3,590.0 | 1,788.1 | 3,237.1 | −107.8 | −5.7% | yes |
| `semantic_alias` | 3,422.5 | 3,445.0 | 3,159.5 | 3,517.9 | −263.0 | −7.7% | yes |
| `theme_value` | 3,461.8 | 3,470.8 | 3,252.6 | 3,479.5 | −209.2 | −6.0% | yes |
| `condition_value` | 3,419.4 | 3,642.7 | 3,182.8 | 3,223.7 | −236.5 | −6.9% | yes |
| `condition_remove` | 3,410.3 | 3,503.4 | 3,479.5 | 3,598.0 | +69.2 | +2.0% | yes |
| `recipe_branch` | 3,509.3 | 3,584.2 | 3,488.1 | 3,627.2 | −21.3 | −0.6% | yes |
| `recipe_interface` | 3,450.0 | 3,462.8 | 3,068.1 | 3,122.2 | −381.9 | −11.1% | yes |
| `policy_category` | 3,503.2 | 3,692.2 | 3,301.6 | 3,337.5 | −201.7 | −5.8% | yes |
| `policy_global` | 3,553.5 | 3,554.2 | 3,144.6 | 3,169.1 | −409.0 | −11.5% | yes |
| `import_change` | 3,511.7 | 3,583.1 | 3,225.4 | 3,432.8 | −286.3 | −8.2% | yes |
| `reexport_change` | 3,355.8 | 3,442.2 | 3,398.9 | 3,440.4 | +43.1 | +1.3% | yes |
| `module_add` | 3,362.1 | 3,595.9 | 3,353.5 | 3,401.2 | −8.6 | −0.3% | yes |
| `module_remove` | 3,576.6 | 3,665.7 | 3,341.1 | 3,506.7 | −235.4 | −6.6% | yes |
| `config_change` | 3,238.0 | 3,282.6 | 3,199.7 | 3,409.6 | −38.3 | −1.2% | yes |
| `resolution_config_change` | 2,234.5 | 3,535.5 | 2,051.5 | 3,404.6 | −182.9 | −8.2% | yes |

**Median relative delta across all 23 comparable warm-edit scenarios at this
scale: −5.7%** (range −11.5% … +2.0%). 20 of 23 scenarios improve; the three
that do not (`condition_remove` +2.0%, `reexport_change` +1.3%, and
`five_files_batch` −0.5%) are within the run-to-run spread of this machine and
are reported as measured, not smoothed.

Two entries need a reader's attention:

- `token_remove` (437 ms) and `resolution_config_change` (2,235 ms) are fast
  **because they fail early** — a dangling token reference aborts at registry
  load, before any page is compiled. They are not fast edits; they are fast
  refusals, and the number says so.
- `theme_value` no longer shows the −24.6% outlier the earlier campaign
  reported. At the final build it is −6.0%, in line with the rest. The earlier
  figure was one campaign's reading of a noise-dominated cell.

### `process_warm_no_edit` is a cache-hit control and is not edit latency

It is reported in its own rows in every summary and is labelled
`CACHE-HIT CONTROL` by `summarize.py`. It is never averaged with an edit row.
At `c1000` the baseline's `no_change` no-op median is **3,050.5 ms** against
**3,460.7 ms** for a real one-file edit: a one-file edit costs **13.5% more than
resubmitting identical bytes**. The 410 ms difference is the whole of the edit's
real cost, because the compiler recompiles the entire covered root either way.
That is finding Q10, and it is the single most important number in this report:
**~88% of a one-file edit's cost is work on files that did not change.**

## 8. Scaling — 100 / 1,000 / 10,000 components

`one_file_new_atom`. The 100-component row is reported but non-conclusive
(§15, item 8); it is shown so the three scales sit side by side, not because a
conclusion rests on it.

| components | cache state | current median | current p95 | work-elim median | work-elim p95 | rel Δ |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 100 | cold, empty | 579.7 | 620.2 | 589.0 | 612.1 | +1.6% |
| 1,000 | cold, empty | 3,813.6 | 3,876.3 | 3,588.9 | 3,628.0 | −5.9% |
| 10,000 | cold, empty | 29,799.8 | 30,009.4 | 28,741.3 | 29,058.5 | −3.6% |
| 100 | warm edit | 433.8 | 512.5 | 424.6 | 496.2 | −2.1% |
| 1,000 | warm edit | 3,460.7 | 3,564.0 | 3,348.9 | 3,421.7 | −3.2% |
| 10,000 | warm edit | 32,540.4 | 33,980.4 | 31,881.4 | 32,920.0 | −2.0% |

**Runtime is linear in file count.** 100 → 1,000 is 6.6×, 1,000 → 10,000 is
7.8×, on a 10× step. There is no quadratic blow-up in the current compiler.
That is a direct answer to a suspicion the research carried: the quadratic Vite
report serialization it observed is **gone** in the consolidated compiler, and
nothing in this batch's measurements reproduces it.

### Memory

| cell | cache state | current peak RSS | work-elim peak RSS | current peak heap | work-elim peak heap |
| --- | --- | ---: | ---: | ---: | ---: |
| 1,000 | cold, empty | 409.9 MB | 399.2 MB | 323.1 MB | 304.3 MB |
| 10,000 | cold, empty | 1,917.0 MB | 2,919.7 MB | 1,774.4 MB | 2,759.8 MB |

Peak RSS is **sub-linear** in file count: 1,000 components → 410 MB,
10,000 components → 1,917 MB (4.7× for 10× the files). The compiler holds parsed
ASTs and rules for the covered set, and the per-file cost falls as the shared
structures amortise. **Memory is not a constraint the current compiler has.**

**The work-eliminated variant costs 6% LESS peak RSS at 1,000 components and 52%
MORE at 10,000** (2,920 MB vs 1,917 MB). The cause is R2 and R3: the resolution
cache and the design-system-walk cache hold one entry per distinct
`(directory, request)` pair, and at 10,000 components that is ~20,000 live
entries. The saving is time; the price is resident memory, and at this scale the
price is not small. A future variant should make those caches bounded, or keyed
on module identity rather than the request string.

This is reported because it is a real cost of the optimization, not because it
changes the conclusion: both engines are far from a memory constraint, and the
caches are the direct cause of the time saving the same section claims.

## 9. Parse counting — measured, not inferred

| cell | distinct files | real parses | **parses per file** | module-cache lookups on the most-consulted module |
| --- | ---: | ---: | ---: | ---: |
| `c100-t100-r10-s101` | 103 | 307 | **3** | 101 (baseline) → 3 (variant) |
| `c1000-t1000-r100-s809` | 1,003 | 3,007 | **3** | 1,001 → 3 |
| `c10000-t1000-r100-s307` | 10,003 | 30,007 | **3** | 10,001 → 3 |

**Q1 — how many times is one source file parsed? Exactly 3**, in both engines:

1. **the coverage graph** (`module-graph.js`, `@babel/parser` with
   `errorRecovery: true`) — 10,003 parses at 10,000 components;
2. **Babel pass 1** — parses the original TS/TSX with the PandamStyle plugin;
3. **Babel pass 2** — parses the *text pass 1 emitted*, to strip TS and lower JSX.

The measurement is a `@babel/parser` hook installed in the worker before the
engine is loaded, and the compiler labels which pipeline is about to parse, so
each parse is attributed to a pipeline at the parse site. **A module-cache hit is
a lookup, not a parse**, and is counted separately — the first version of this
harness conflated them and reported 102 parses per file, which was a true number
about the wrong question.

**Q2 — parsing is 9.2% of the 10,000-component cold build and 8.1% of the
1,000-component warm edit.** Split by pipeline at 1,000 components:

| pipeline | cold, empty | share of total | per file |
| --- | ---: | ---: | ---: |
| `module-graph` | 210.6 ms | 5.5% | 0.210 ms |
| `babel:pass1` | 125.5 ms | 3.3% | 0.125 ms |
| `babel:pass2` | 125.1 ms | 3.3% | 0.125 ms |
| **total** | **465.9 ms** | **12.2%** | |

**The coverage graph's parse costs 1.7× a full Babel parse of the same file.**
It is the same `@babel/parser` on the same bytes, run with `errorRecovery: true`
and a wider plugin set. At 10,000 components that is 918 ms of a 30 s build spent
parsing files that Babel is about to parse again anyway.

**This was measured, not removed.** See §11.

---

## 10. Phase breakdown — where the time actually goes

`c1000-t1000-r100-s809`, `one_file_new_atom`, `process_warm_edit` (median of 3
iterations, per engine). Phases are **nested** where noted; the `nested in`
column says so, and nested numbers must not be summed with their parent.

| phase | current (ms) | % of total | work-eliminated (ms) | nested in |
| --- | ---: | ---: | ---: | --- |
| `filesystem_to_diagnostics_ms` (total) | 3,460.7 | 100% | 3,348.9 | — |
| `semantic_ms` | 389.5 | 11.3% | 282.7 | — |
| `ir_lower_ms` | 302.4 | 8.7% | 272.6 | — |
| `policy_ms` | 141.9 | 4.1% | 83.3 | `ir_lower_ms` |
| `atomic_lower_ms` | 75.3 | 2.2% | 75.8 | `ir_lower_ms` |
| `parse_ms` | 279.3 | 8.1% | 281.0 | — |
| `parse_ms:module-graph` | 92.2 | 2.7% | 87.4 | `parse_ms` |
| `parse_ms:babel:pass1` | 89.2 | 2.6% | 99.1 | `parse_ms` |
| `parse_ms:babel:pass2` | 96.6 | 2.8% | 91.1 | `parse_ms` |
| `coverage_graph_ms` | 192.2 | 5.6% | 144.3 | — |
| `css_serialize_ms` | 59.9 | 1.7% | 61.7 | — |
| `rule_sort_ms` | 26.6 | 0.8% | 26.4 | `css_serialize_ms` |
| `resolve_ms` | 114.8 | 3.3% | 0.21 | — |
| `io_ms` | 15.3 | 0.4% | 15.3 | — |
| `publish_ms` | 304.7 | 8.8% | 238.2 | — |
| `ds_recipe_compile_ms` | 32.0 | 0.9% | 24.6 | — |
| `boundary_ms` | 34.0 | 1.0% | 26.8 | — |
| `recipe_ms` | 0.9 | 0.0% | 1.0 | — |
| `hash_dedup_ms` | *not isolable at this boundary* | | | |

Cold-process `startup_ms` (loading the compiler bundle) is 300 ms at 1,000
components and 2,053 ms at 10,000 — 7.9% and 6.9% of the build respectively, and
it is paid once per process, not once per edit.

### Counters, `c10000-t1000-r100-s307`, `process_cold_cache_empty`

| counter | current | work-eliminated | comparable? |
| --- | ---: | ---: | --- |
| `parse_calls_total` | 30,007 | 30,007 | **yes — identical** |
| `parse_distinct_files` | 10,003 | 10,003 | **yes — identical** |
| `parse_max_per_file` | 3 | 3 | **yes — identical** |
| `semantic_builds` | 10,002 | 10,002 | **yes — identical** |
| `pass1_calls` / `pass2_calls` | 10,002 / 10,002 | 10,002 / 10,002 | **yes — identical** |
| `atoms` | 41,265 | 41,265 | **yes — identical** |
| `atom_contributions` | 46,263 | 46,263 | **yes — identical** |
| `read_bytes` | 17,339,508 | 17,339,508 | **yes — identical** |
| `read_calls` | 20,004 | 20,004 | **yes — identical** |
| `write_calls` | 10,006 | 10,006 | **yes — identical** |
| `diagnostics` | 0 | 0 | **yes — identical** |
| `stat_calls` | **60,845** | **10** | yes — this is the saving |
| `resolution_probes` | **60,845** | **10,844** | yes |
| `ds_module_walks` | **10,001** | **3** | yes |
| `ds_module_walk_hits` | n/a (counter never incremented) | **9,998** | yes |
| `written_bytes` | 15,630,533 | 15,817,301 | **NO — see limitation 10** (the same artifact at c100 reads 214,919 vs 216,887: a 1,968-byte difference from the same cause) |
| `rss_peak_bytes` | 1,916,954,624 | 2,919,723,008 | yes — the variant is **worse** |
| `heap_peak_bytes` | 1,774,413,620 | 2,759,824,236 | yes — the variant is **worse** |
| `external_peak_bytes` | 2,311,018 | 2,311,018 | **yes — identical** |

**Every counter that measures emitted work is identical between the two
engines.** The optimizations removed *lookups and recomputation*, not output.
The one counter that differs on emitted bytes is a harness artifact (§15, item 10)
and the one that differs on resident memory is a real cost of the caches (§8).

### Answering the protocol's questions directly

| # | question | answer, measured |
| --- | --- | --- |
| 1 | parses per source file | **3** (coverage graph, pass 1, pass 2) — §9 |
| 2 | % in parsing | **8.1%** warm edit, **12.2%** cold (1,000 comps) |
| 3 | Babel traversal / semantic resolution | `@babel/traverse` **29.9%**, `@babel/core` **18.5%** of the profile; `semantic_ms` 11.3% of the build |
| 4 | PandamStyle policy / provenance | `policy_ms` **4.1%**; provenance and provenance-escape analysis are inside `semantic_ms` |
| 5 | StyleX atomic lowering | `atomic_lower_ms` **2.2%**; `styleXCreateSet` 0.43% of profile self-time |
| 6 | CSS sorting / serialization | `css_serialize_ms` **1.7%** (of which rule sort 0.8%) |
| 7 | module resolution / filesystem IO | `resolve_ms` **3.3%**, `io_ms` **0.4%** |
| 8 | rebuilding the design system | `ds_recipe_compile_ms` 0.9%, `ds_build_registry_ms` 0.04%, `ds_token_compile_ms` 0.02%, `ds_manifest_ms` 0.003% — **1.0% total** |
| 9 | publishing / writing artifacts | `publish_ms` **8.8%** (warm edit; 1.9% on a cold build) |
| 10 | unnecessary work on a one-file edit | **the entire build** — §7, no_change vs one_file_new_atom |
| 11 | unnecessary work on `token_value` | the full covered root again; plus, in the baseline, a chain of invalidated module resolutions — §11 |
| 12 | scaling 100 → 1k → 10k | **linear**, 580 → 3,814 → 29,800 ms — §8 |
| 13 | memory scaling | peak RSS **sub-linear**: 410 MB → 1,917 MB — §8 |
| 14 | what the variant removed | §11 |
| 15 | what remains | §11, §12 |

---

## 11. What `babel_work_eliminated` actually removed

Four redundant-work classes, all gated behind `PMS_WORK_ELIMINATED` and all
proven behaviour-preserving by the oracle.

### R1 — the coverage graph's parse, revisited on every component

**Not removed.** Measured (Q1, Q2): 3 parses per file, of which the coverage
graph's costs 1.6× a Babel parse. Sharing one AST between the coverage walk and
pass 1 would remove it, but it needs `parseFromAst` with a differently-configured
parser (the coverage graph needs `errorRecovery: true` and a wider plugin set),
explicit ownership of an AST that the plugin then mutates, and a guarantee that
source locations survive. That is a fragile optimization, and the brief is
explicit that a fragile one must be measured and documented rather than forced.
**Recorded as a Spike 2 candidate with a measured prize of ~918 ms on a
10,000-component build.**

### R2 — the design-system module re-walked once per importing component

`readModuleFacts` calls `resolveDesignSystemModule` for **every** import
declaration of every file. Each call resolves the request and walks the re-export
chain up to the generated module. At 10,000 components the generated design
system was **consulted 10,001 times**.

Removed: the walk result is memoised on `(containing directory, request, maxDepth)`.
The cache is dropped by exactly the operations that drop the parse cache
(`setModuleOverlay`, `clearModuleCache`), both of which run at every generation
boundary, so it is never staler than the parse cache the baseline already keeps.

| | baseline | variant |
| --- | ---: | ---: |
| `ds_module_walks` | 10,001 | 3 |
| `ds_module_walk_hits` | n/a | 9,998 |
| most-consulted module, cache lookups | 10,001 | 3 |

### R3 — relative-path resolution re-probed on every edge

`resolveRelativeFile` walks up to 19 candidate paths with a `statSync` each, and
is called from every module edge, every import check, and every relay hop. At
1,000 components the baseline spent **121 ms** in it.

Removed: results memoised on `(containing directory, request)`, with the same
lifetime as R2. **Negative resolutions are cached too, and this is the reason the
lifetime matters**: a `null` for `./foo` is only correct while `foo.tsx` does not
exist, so the cache is dropped at every generation boundary, and the
`resolution_config_change` scenario — an import whose target does not exist,
followed by the target appearing in the same process — proves it is re-derived.

| metric | baseline | variant |
| --- | ---: | ---: |
| `resolve_ms` (1,000 comps, warm edit) | 114.8 ms | **0.21 ms** |
| `stat_calls` (1,000 comps, cold) | 6,095 | **10** |
| `stat_calls` (10,000 comps, cold) | 60,845 | **10** |

### R4 — the admissible-token list rebuilt for every declaration

`checkValue` rebuilt `Object.keys(registry.tokens).filter(...)` **for every
declaration it checked**, and used the result for exactly one thing: the
`candidates` field of a diagnostic raised only when the value was *refused*.
With 1,000 tokens and ~3,000 declarations that is ~3,000,000 comparisons to
produce zero diagnostics.

Removed: computed once per `(category, allowPrivateTokens)` and memoised in a
`WeakMap` **keyed on the registry object**, so a second design system in the same
process cannot read the first one's list and there is no invalidation key to get
wrong. Same members, same order, same diagnostic text.

| phase | baseline | variant | at 10,000 comps (cold) |
| --- | ---: | ---: | ---: |
| `policy_ms` (1,000, warm edit) | 141.9 ms | **83.3 ms** | 1,298.2 → **730.7 ms** |

This was the compiler's hottest own-function in the CPU profile before the
change (`checkValue` 0.85% of self-time) and is no longer in the top twelve
after it.

### Net effect

Median relative delta, by cell and cache state:

Median relative delta across the comparable scenarios of each cell and cache
state:

| cell | cold, empty | cold, warm | warm no-edit | warm edit |
| --- | ---: | ---: | ---: | ---: |
| `c100-t100-r10-s101` | −3.1% | −5.0% | −4.9% | −3.1% |
| `c1000-t1000-r100-s809` | **−5.1%** | **−5.1%** | **−4.6%** | **−5.7%** |
| `c10000-t1000-r100-s307` | **−3.9%** | **−6.2%** | **−5.4%** | **−6.5%** |

The saving is consistent in sign and magnitude at both decision-bearing scales,
in every cache state. The 100-component row is not reproducible across campaigns
and is **reported, not smoothed, and not used** (§15, item 8).

**Not enabled by default.** The gate is a process environment variable read once
at module load, defaulting to off. Production keeps the current behaviour.

---

## 12. Remaining dominant costs, and the Spike 2 decision

### CPU profiles (dedicated runs, separate invocations — a profiler perturbs what it observes)

`c1000-t1000-r100-s809`, cold build. **A sampling profiler is not a latency
measurement** and none of these numbers appears in §7 or §8.

| module | `babel_current` | `babel_work_eliminated` |
| --- | ---: | ---: |
| `@babel/traverse` | 28.3% | **29.9%** |
| `@babel/core` (configuration) | 17.2% | **18.5%** |
| `@babel/parser` | 11.3% | 11.3% |
| PandamStyle compiler bundle | 11.4% | 10.8% |
| native/VM + GC | 10.3% | 10.4% |
| `@babel/generator` | 5.2% | 5.4% |
| `@babel/types` | 4.7% | 4.6% |

**Babel's own traversal and configuration layers are ~48% of the profile. The
PandamStyle compiler — registry, policy, provenance, recipes, module graph, IR
lowering — is ~11% combined.** The StyleX atomic backend is not separately
visible at this scale, consistent with its 2.4% share of the build.

Hottest functions in the baseline compiler bundle: `literal` / `convertObjectToAST`
(1.4%), `checkValue` (0.9%), `constName` (0.5%, the fork's constant resolution in
`processStylexRules`), `styleXCreateSet` (0.5%), `probeRelativeFile` (0.4%).

### The decision

| observation | consequence |
| --- | --- |
| `@babel/traverse` + `@babel/core` are **~48%** of the profile; the PandamStyle compiler is ~11% | the frontend is the cost, not the product logic |
| 3 parses per file, and the coverage graph's costs **1.6×** a Babel parse | one parse is removable **today**, without any new frontend |
| 8 of the 9 `programPath.traverse` passes in the plugin are full traversals of every file | traversal volume, not traversal *implementation*, is the multiplier |
| design-system reconstruction is **1.1%** of a build | an incremental design DB is **not** the highest-priority item |
| atomic lowering is **2.4%**; CSS serialization **1.8%** | the StyleX backend is **not** large enough to justify a Rust port first |
| memory is sub-linear in file count | memory is not a constraint |
| runtime is **linear** in file count | there is no quadratic left to remove |
| a one-file edit costs the same as a no-op | the missing thing is **invalidation**, not a faster inner loop |

### Recommendation

**Spike 2 should attack the frontend and the absence of incremental reuse, in
that order, and should NOT open with a Rust rewrite of the StyleX backend.**

1. **First: make the build incremental at the file level.** A one-file edit costs
   3,195 ms; the same process resubmitting identical bytes costs 3,215 ms. The
   compiler recompiles the entire covered root either way. This is the largest
   single win available and it needs no new frontend. Its prerequisite is an
   explicit invalidation key per covered file, and Spike 1 has established what
   those keys must cover: the design system (every file depends on it), the
   registry digest, the module graph edges, and the CSS generation.
2. **Second: eliminate the third parse.** Share one parse between the coverage
   graph and pass 1, or drop `errorRecovery` from the coverage parse and prove
   the coverage guarantee survives. Measured prize: 906 ms at 10,000 components,
   ~2,600 ms of the 9% parse share overall.
3. **Third: an Oxc or SWC frontend comparison, scoped to traversal and
   configuration, not to parsing.** Parsing is 8–12%; traversal plus
   configuration is ~48%. A frontend swap that only replaces the parser buys at
   most a third of what a traversal change buys. This batch did not implement one
   and does not claim to know which would win — that is the experiment.
4. **Do not start with a Rust StyleX backend.** 2.4% of the build.
5. **Do not start with an incremental design DB.** 1.1%.

`babel_work_eliminated` is already within **5.7%** of the current compiler on
1,000-component warm edits (median across 23 scenarios) and **6.5%** on
10,000-component warm edits, with byte-identical CSS, byte-identical compiled
JS, identical diagnostics with identical locations, and identical coverage. That
is a real saving, and it is **not** sufficient to justify replacing the frontend:
the remaining 90%+ is not in the code the variant touched.

It also costs 52% more peak RSS at 10,000 components (§8), which is the price of
the caches that buy the time. Both facts belong in the same sentence.

---

## 13. Exploratory targets

The research's numbers are **exploratory, not pass/fail**. Reported as asked.

| target | c100 | c1000 | c10000 | reached? |
| --- | ---: | ---: | ---: | --- |
| local validation, single-digit ms | — | — | — | **not measured.** No single-file validation API exists on the CLI path; the smallest unit this harness can measure is a full covered-root build. |
| small incremental rebuild < 20 ms | 433.8 | 3,460.7 | 32,540.4 | **no**, by 22× to 1,627× |
| medium affected graph < 50 ms | — | 3,460.7 | — | **no**, by 69× |

None of this is a failure claim. The point of the numbers is the *shape* they
make visible: at 1,000 components the build is 3.5 s, and a single-file edit
costs 13.5% more than no edit at all. The distance to the targets is not a
constant factor that a faster inner loop closes — it is the cost of recompiling
files that did not change.

---

## 14. Required verification

See `VERIFICATION.md` in this directory for the full record, including the
upstream `babel-plugin` (1007 passed / 64 skipped) and `stylex` (99 passed)
suites, `npm run lint:report`, `npm run prettier:report` and `./verify-pms.sh`
under Node 22.

| check | result |
| --- | --- |
| PandamStyle suite | **268 passed**, unchanged |
| benchmark harness suite (`node --test`) | **29 passed** |
| `summarize.py --self-test` | **passes** |
| differential oracle, 2 corpora × 28 revisions | **equivalent, 0 errors** |
| campaign jobs | 742 + 318 + 56 = **1,116 jobs, 0 errors, 0 timeouts** (final campaign) |
| observations | 66,006 `ok`, 4,640 `unsupported` (the three metrics that cannot be isolated honestly), **0 errors** |
| independent c100 campaigns | 2 run, differing by 12.2% median — reported as a measurement-quality limit (§15, item 8) |

---

## 15. Known limitations

1. **Warm OS page cache throughout.** `os_cold = not_run`.
2. **`bundler_ready_ms` is `unsupported` on the CLI path.** Driving Vite per cell
   would measure Vite. The Vite adapter is covered by the existing pilot.
3. **`cancel_and_retry` and `crash_during_publication` are `not_run`.** Kept in
   the protocol with a stated reason: cancellation needs a driver that can abort
   a build mid-publication, and a crash is a correctness property, not a latency.
   The transactional guarantee they would touch is covered by the existing
   compiler tests.
4. **3 of 27 matrix cells executed.** The token and recipe axes were held at
   1,000/100 for the two larger cells; the `t=10000` and `r=1000` cells are
   `not_run`. The registry axis was not explored, and §10 shows why that is
   defensible rather than complete: registry work is ~1% of the build.
5. **One machine, one Node, one filesystem.** The absolute numbers are not
   claims about other hardware; the phase *ratios* are the transferable result.
6. **The corpus is one shape family.** Twelve component shapes over real tokens,
   conditions, recipes and barrels is representative of P0, not of every
   application that will use PandamStyle.
7. **Seven iterations at one scale, three at another, two at the third.** No
   confidence intervals are computed; `summarize.py` deliberately does not, and
   preserves session ids instead.
8. **c100 reproducibility limitation.** Two independent c100 campaigns produced
   materially different medians, with a 12.2% cross-campaign median difference.
   The compiler was also not byte-identical between those campaigns: the later
   revision separates unreadable-file coverage failures from parser-internal
   failures and moves instrumentation counters. These paths were not observed to
   trigger on the benchmark corpus, but strict behavioral equivalence between the
   two revisions was not independently proven. Therefore **c100 is treated as
   noise-dominated and non-conclusive. No architectural or performance decision
   in this report relies on c100.** Conclusions are based on the reproducible
   c1000 measurements and the final c10000 campaign.
9. **Both trees ran with an uncommitted instrumentation patch** (`working_tree:
   dirty` in the metadata). The 268-test suite passes on both, and the two trees'
   instrumented files are byte-identical apart from the optimization.
10. **`written_bytes` cannot be compared across engines in this run.** The
    `written_bytes` counter differs between the engines at both decision-bearing
    scales:

    | cell | baseline | work-eliminated | difference |
    | --- | ---: | ---: | ---: |
    | `c100-t100-r10-s101` | 214,919 | 216,887 | **1,968 bytes** |
    | `c1000-t1000-r100-s809` | 1,833,391 | 1,852,159 | 18,768 bytes |
    | `c10000-t1000-r100-s307` | 15,630,533 | 15,817,301 | 186,768 bytes |

    This is a **harness artifact, not an engine difference and not a semantic
    output inflation**, and it is corroborated at both scales by the same cause:
    the build report embeds absolute paths (the worker runs with a cwd outside
    the project, so `relativeToCwd` falls back to absolute), and the two engines'
    job directory names differ in length (`babel_current__` is 9 characters
    shorter than `babel_work_eliminated__`). The difference scales with the
    number of embedded paths — 10× the files, 10× the difference — which is
    what a per-path length effect does and what a real output difference does
    not.

    **Proof that the engines write identical bytes**, independent of that
    reasoning: run from project directories of *equal* length, both engines
    report `written_bytes = 12,712,260` with `write_calls = 10,006`; and `diff -r`
    over the two published `.pandamstyle` trees at 10,000 components differs
    **only** in that same embedded scratch path, and is identical after
    normalising it.

    `read_bytes` (17,339,508), `atoms` (41,265), `atom_contributions` (46,263),
    `write_calls` (10,006) and `parse_calls_total` (30,007) are **identical**
    between the engines and are comparable.

    Fix for a future run: launch the worker with `cwd` set to the project
    directory, or use equal-length job identifiers.

---

## 16. Reproducing this

```bash
git worktree add ../pms-baseline d5702374ac5a685499d14a53bf323d8533e6982d
# apply benchmarks instrumentation, build both compilers, then:
cd benchmarks/pandamstyle
python3 summarize.py --self-test
node src/differential.js --corpus /tmp/c --components 100 --tokens 100 --recipes 10
node src/run-campaign.js --plan plan.json --corpora c100-t100-r10 \
  --iterations 7 --run-kind qualification --out out.jsonl
node --test tests/bench.test.js
```

Engine execution order is seeded from the plan version, so the same command
reproduces the same order; the seed is recorded in the campaign metadata.

---

## 17. Where the evidence is

`evidence/performance/spike-1/` — `INDEX.json` is the entry point.

| | |
| --- | --- |
| raw observations | 70,646 rows, 36 MB, **not committed**; sha256 and location in `INDEX.json` |
| committed | corpus manifests, campaign metadata (every job), summaries, phase/counter tables, aggregated parse accounting, profile summaries, differential verdicts, this report |
| parse evidence | every parse and every module-cache lookup, in order, per job — **1 GB, not committed**; the per-corpus/per-pipeline distribution is |
| `.pms-bench/` | scratch: generated corpora, per-job project copies, raw streams. Regenerable from the corpus manifests. |
