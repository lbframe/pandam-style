# PandamStyle Spike 2 — incremental file-level compilation

**Branch:** `perf/pandamstyle-spike-2-incremental-2026-09`
**Base SHA:** `cffab61fc2d66dbd94a3fdf42c1088f0da9da847` (Spike 1 head)
**Plan version:** `1.2.0` (metrics extended, nothing renamed or reinterpreted)

---

## 1. Verdict

**PandamStyle Spike 2 incremental compilation demonstrated on the tested scope.**

Local revisions reuse valid unchanged-file results, incremental outputs are
equivalent to fresh full rebuilds across the tested revision traces, project
state remains bounded, and the remaining compiler costs are measured well enough
to decide whether a native frontend experiment is justified.

The measured answer to the question Spike 1 was built to ask:

> **On 1,000 components, a real one-file edit took 3,287.8 ms through the
> existing full rebuild and 307.6 ms through the project session — 10.7×. The
> revision re-parsed 1 file, recompiled 1 file, and reused 1,001. Total parses
> fell from 3,007 to 4. A no-change revision performs ZERO real source parses
> and takes 145.6 ms.**

And the answer to the question this batch was built to ask:

> **After file-level compilation disappears from the hot path, the dominant
> remaining cost is no longer the compiler — it is PUBLICATION.** At 1,000
> components, 122 ms of a 308 ms revision (40%) is `publish_ms`. At 10,000
> components, 2,142 ms of a 4,074 ms revision (53%) is `publish_ms`, and CSS
> aggregation adds another 220 ms. The *analysis* — everything that decides
> what to compile — is 42.9 ms at 1,000 components and 222.9 ms at 10,000,
> which is sub-linear in project size.

That inversion is the whole result. Spike 1 said "the frontend is the cost".
Spike 2 says "with a session, it no longer is, and what is left is the
publisher".

---

## 2. What was built

### The project session

`packages/@stylexjs/babel-plugin/pandamstyle/session.js` — production compiler
code, exported from `@pandamstyle/compiler` as `createProjectSession`. The
benchmark harness drives it; it does not exist for the benchmark, and
`buildProject` is **unchanged** and remains the semantic reference.

```js
const session = createProjectSession({ definition, roots, outDir });
session.initialize();                       // revision 1, the full analysis
session.validate();                         // the verdict for that revision
session.compile();                          // transactional publication

session.applyChanges({ addedFiles, removedFiles, config, definition });
const v = session.validate();               // { revisionId, ok, diagnostics, counters }
if (v.ok) session.compile();
session.close();
```

**Revision model.** `RevisionId` is monotonically increasing and every result
carries it — the `validate()` result, the build report's `incremental` block,
and the published generation's identity. `GenerationId` is separate and only
advances on a successful publication, so a revision that was prepared and never
published can never be mistaken for one that was. A result from revision N is
never reported as validation of N+1.

**File state.** One owned record per covered file: canonical path, role, source
content hash, module summary, edge resolutions, design-system view, validity
key, and its **own** contribution (compiled JS, its rules, its coverage entry,
its diagnostics). No Babel `NodePath` and no AST is retained. The module summary
is plain data, extracted before anything is handed to a transform that may
mutate it.

**Project state.** Covered roots, covered set, forward and reverse module
graphs, per-file result cache, per-file rule contributions, current
diagnostics, resolution state, current design-system identity, current
policy/config identity, and the current valid generation.

**Module summary schema.** `unreadable`, `edges[{request, form, local,
isStylesheet, computed, line}]`, `importSources[]`. Resolution is *not* stored
in the summary — it is derived per revision, because a summary that froze a
resolution would be a permanent negative resolution.

**Cache validity key** (never a path, never an mtime):

```
sourceHash, role, compilerContractVersion, projectSemanticEpoch,
engineOptionsDigest, useCSSLayers, runtimeModule,
resolutionDigest, designSystemViewDigest
```

`projectSemanticEpoch` changes on every global mutation that currently causes a
full fallback. It is intentionally coarse: correct coarse invalidation beats
incorrect fine-grained invalidation, and Spike 1 measured the design system at
~1% of a build, which is not worth a fine-grained design graph's invalidation
surface.

**Why a file's result depends on so little.** Reading `compileFile` is the only
honest way to answer this, and the answer is narrow: a file's compiled output
depends on its own source, on the design system and engine options, on whether
its own local edges resolve, and on its own **design-system view** — which
module the design system is reached through, its generation marker, its
exports, and the relay chain in between, because that is what decides which
bindings are recognized. It does **not** depend on the content of any other
covered file. That fact is what makes file-level reuse possible at all.

### The invalidation algorithm

1. **Scan.** Walk the declared roots; read and content-hash every file the
   previous revision covered plus every root file. mtime is never consulted.
2. **Re-probe resolution.** Every `(directory, request)` key the session has
   ever resolved is re-probed once per revision, through a per-revision
   directory listing. This is the reason `"./foo" does not exist` is never a
   permanent fact, and it is a correctness requirement, not an optimization.
3. **Rebuild the coverage closure** from persistent module summaries, with the
   *same* traversal, order and queue discipline `collectCoveredFiles` uses —
   because the build report and the CSS rule order are both functions of that
   map's iteration order.
4. **Invalidate** a file when its content changed, when any of its own edge
   resolutions changed, when its design-system view changed, when it is new, or
   when a global fallback fired. A changed file can never be reused: a summary is
   only rebuilt when the bytes changed, and that marks the file invalid by
   construction.
5. **Propagate along relay chains.** A file's design-system view can only change
   if the file itself changed or if a module on its relay chain changed. The
   reverse index is chain membership, not the whole reverse graph, so a page
   importing a sibling never invalidates anything.
6. **Remove what left the covered set.** A deleted file's file state, compiled
   result, rules, coverage entry, diagnostics and reverse-index registration
   are dropped, not shadowed.
7. **Recompile** the invalid set, aggregate CSS from **all** contributions
   (reused included), and publish transactionally.

### Global fallback rules

Every one of these is a **counted** fallback, reported with its reason on the
revision and in `build-report.json`:

| reason | trigger |
| --- | --- |
| `design-system-definition` | the design system definition's content digest changed — token add/remove/value, category, visibility, semantic alias, theme, condition, recipe, and the four "value-only" design changes alike |
| `compiler-configuration` | `runtimeModule`, `designSystemFile`, `engineOptions` or `useCSSLayers` changed |
| `roots` | the declared roots changed |
| `output-directory` | the output directory changed |
| caller-supplied | `changes.fullFallback('<reason>')` — an input the session cannot observe (a lockfile, a package resolution context) |

### Negative resolution strategy

Persistent `(directory, request) → resolved | null` state, re-probed every
revision. `negative_resolutions_invalidated` counts keys that went from
unresolvable to resolvable, and the file that made the request is invalidated in
the same revision. The scenario `resolution_config_change` — an import whose
target does not exist, then the target appearing in the same session — is
covered by the oracle and by the campaign, and the counter is 1 at both scales.

### Transactional publication

Unchanged. `withGeneration` still stages everything and commits the marker
last. On a refused revision `validate()` returns the diagnostics, `compile()`
throws, **nothing is published**, and `session.current()` still names the
previous generation. A later repair revision publishes normally without
restarting the session. Covered by
`__tests__/pandamstyle/incremental-session-test.js` and by the
`forbidden_value → repair_forbidden_value` and `token_remove → token_restore`
pairs in the oracle.

### Concurrency

One session, one writer, synchronous. A second `applyChanges` while a revision
is prepared but unpublished **supersedes** it: the discarded revision never
reached the output directory, it is counted in `supersededRevisions`, and it is
never merged into the next one. Multi-writer project concurrency is explicitly
out of scope for this batch.

---

## 3. Correctness — the authoritative oracle

`benchmarks/pandamstyle/src/incremental-oracle.js`. For every revision of every
scenario, in one project whose revisions are **cumulative**:

1. apply the revision to the source tree;
2. drive the project session and capture what it **published**;
3. rebuild the same bytes from scratch, **in a fresh process**, with the
   unchanged full rebuild, and capture what it published;
4. require the two to be identical.

Step 3 is a separate process on purpose: a fresh rebuild inside the session's
process would share its module registry, its caches and its design system, and
would not be a fresh rebuild at all.

| corpus | revisions | mismatches | errors | verdict |
| --- | ---: | ---: | ---: | --- |
| 24 components / 120 tokens / 6 recipes | 54 | **0** | **0** | `equivalent` |
| 100 components / 100 tokens / 10 recipes | 54 | **0** | **0** | `equivalent` |

Compared per revision: the verdict; diagnostics (code, phase, rule, severity,
line, column, role, source, context); every published artifact byte for byte;
the runtime composition structure (class literals, `__pmsRecipe_*` references,
import specifiers); the CSS bytes **and** the CSS text with cascade-relevant
ordering never normalised; the generated design-system module; the manifest; and
the build report's semantic state (covered set, expected-vs-analysed verdict,
external requests, relay edges).

**The one normalisation**, applied to both sides by the same rule, removes the
session's own additive `incremental` block from `build-report.json` — the block
that states *how* the generation was produced rather than *what* it contains.
Nothing else is normalised.

The oracle starts each scenario with a `seed` revision on the pristine project,
so the session is established the way an agent loop establishes it and is then
compared for every subsequent revision.

### What each scenario proved

| scenario | reparsed | recompiled | reused | verdict |
| --- | ---: | ---: | ---: | --- |
| `no_change` | 0 | 0 | 26 | equivalent |
| `format_only` | 1 | 1 | 25 | equivalent |
| `one_file_existing_atoms` | 1 | 1 | 25 | equivalent |
| `one_file_new_atom` | 1 | 1 | 25 | equivalent |
| `five_files_batch` | 5 | 5 | 21 | equivalent |
| `forbidden_value` | 1 | 0 (refused) | 25 | equivalent, both refused |
| `repair_forbidden_value` | 1 | 1 | 25 | equivalent |
| `import_change` | 2 | 2 | 25 | equivalent, `revdep=1` |
| `reexport_change` | 1 | 1 | 25 | equivalent |
| `module_add` | 1 | 1 | 26 | equivalent |
| `module_remove` | 0 | 0 | 25 | equivalent |
| `file_rename` | 1 | 1 | 25 | equivalent |
| `resolution_config_change` | 1 | 0 → 2 | 26 → 25 | equivalent, `negres=1` on revision 1 |
| `policy_category` / `policy_global` | 1 / 15 | 0 (refused) | 25 / 11 | equivalent, both refused |
| `token_value`, `semantic_alias`, `theme_value`, `condition_value`, `condition_remove`, `recipe_branch`, `recipe_interface` | 1–3 | **all** | 0 | equivalent, each a counted `design-system-definition` fallback |
| `token_remove` / `token_restore` | 0 | 0 / all | all | equivalent; refusal then repair, no restart |
| `config_change` | 0 | all | 0 | equivalent, counted `compiler-configuration` fallback |

`module_remove` recompiles **nothing**: the removed file's contribution is
dropped from the aggregation in the same revision that removes it from the
covered set. That is the shape of "no stale rule from a deleted file" — the
rule is not recomputed, it is *gone*.

---

## 4. Measurements

`filesystem_to_diagnostics_ms`, median, warm OS page cache, Node 22.22.0.
Engines `babel_full` and `babel_incremental` run **the same tree** and the same
bundle; the only difference is which public API is driven.
`babel_incremental` does **not** set `PMS_WORK_ELIMINATED`, so the benefit of
invalidation is never conflated with the benefit of Spike 1 memoization.

### c1000-t1000-r100-s809 — decision-bearing

| scenario | cache state | `babel_full` (ms) | `babel_incremental` (ms) | speedup |
| --- | --- | ---: | ---: | ---: |
| `one_file_new_atom` | warm edit | 3,287.8 | **307.6** | 10.7× |
| `one_file_existing_atoms` | warm edit | 3,255.4 | 384.7 | 8.5× |
| `format_only` | warm edit | 3,756.3 | 297.7 | 12.6× |
| `five_files_batch` | warm edit | 3,246.6 | 330.6 | 9.8× |
| `import_change` | warm edit | 3,363.3 | 314.7 | 10.7× |
| `reexport_change` | warm edit | 3,290.5 | 398.9 | 8.2× |
| `module_add` | warm edit | 3,250.8 | 299.0 | 10.9× |
| `module_remove` | warm edit | 3,247.8 | 337.4 | 9.6× |
| `file_rename` | warm edit | 3,279.2 | 367.8 | 8.9× |
| `resolution_config_change` | warm edit | 1,947.1 | 173.1 | 11.2× |
| `forbidden_value` | warm edit | 3,251.3 | 33.3 | 97.8× |
| `repair_forbidden_value` | warm edit | 3,293.4 | 164.7 | 20.0× |
| `policy_global` | warm edit | 3,251.6 | 93.6 | 34.7× |
| `token_value` | warm edit | 3,526.7 | 3,140.4 | 1.1× |
| `semantic_alias` | warm edit | 3,296.6 | 3,132.5 | 1.1× |
| `theme_value` | warm edit | 3,335.8 | 3,339.9 | 1.0× |
| `condition_value` | warm edit | 4,024.2 | 3,084.2 | 1.3× |
| `recipe_interface` | warm edit | 3,346.3 | 3,088.5 | 1.1× |
| `config_change` | warm edit | 3,307.9 | 3,465.7 | 1.0× |
| `no_change` | **warm no edit** | 3,118.1 | **145.6** | 21.4× |
| `one_file_existing_atoms` | warm no edit | 3,836.3 | 130.9 | 29.3× |
| `module_remove` | warm no edit | 3,068.4 | 128.2 | 23.9× |

The 1.0–1.3× rows are the **global fallbacks**, and they are the honest
outcome: a design-system change recompiles everything, by design, and is
reported as a counted fallback rather than hidden.

### c10000-t1000-r100-s307 — decision-bearing

| scenario | cache state | `babel_full` (ms) | `babel_incremental` (ms) | speedup |
| --- | --- | ---: | ---: | ---: |
| `one_file_new_atom` | warm edit | 31,558.0 | **4,073.7** | 7.7× |
| `five_files_batch` | warm edit | 30,569.0 | 4,109.2 | 7.4× |
| `import_change` | warm edit | 31,779.7 | 4,544.4 | 7.0× |
| `module_remove` | warm edit | 30,745.4 | 8,285.3 | 3.7× |
| `token_value` | warm edit (fallback) | 30,839.8 | 30,474.1 | 1.0× |
| `no_change` | **warm no edit** | 28,295.2 | **1,222.0** | 23.2× |
| `one_file_new_atom` | cold, empty | 29,978.0 | 29,573.5 | 1.0× |

### The reuse counters

`process_warm_edit` unless stated. These count **reuse**, not work: a reused
file cost one content-hash comparison and no parse.

| corpus | scenario | parses | reparsed | recompiled | reused | rev-dep | neg-res | fallback |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| c1000 | `one_file_new_atom` | **4** | 1 | **1** | 1,001 | 0 | 0 | 0 |
| c1000 | `five_files_batch` | 17 | 5 | 5 | 997 | 0 | 0 | 0 |
| c1000 | `no_change` (warm no edit) | **0** | 0 | **0** | 1,002 | 0 | 0 | 0 |
| c1000 | `module_remove` | 0 | 0 | 0 | 1,001 | 0 | 0 | 0 |
| c1000 | `import_change` | 9 | 2 | 2 | 1,001 | 1 | 0 | 0 |
| c1000 | `token_value` | 2,007 | 1 | 1,002 | 0 | 0 | 0 | **1** |
| c10000 | `one_file_new_atom` | **4** | 1 | **1** | 10,001 | 0 | 0 | 0 |
| c10000 | `five_files_batch` | 17 | 5 | 5 | 9,997 | 0 | 0 | 0 |
| c10000 | `no_change` (warm no edit) | **0** | 0 | **0** | 10,002 | 0 | 0 | 0 |
| c10000 | `module_remove` | 0 | 0 | 0 | 10,001 | 0 | 0 | 0 |
| c10000 | `import_change` | 9 | 2 | 2 | 10,001 | 1 | 0 | 0 |
| c10000 | `token_value` | 20,007 | 1 | 10,002 | 0 | 0 | 0 | **1** |

The full build parses **3,007** files at c1000 and **30,009** at c10000 on the
same scenarios. The session parses **4**.

### Where the remaining time goes

`one_file_new_atom`, `process_warm_edit`, median ms.

| phase | c1000 full | c1000 incr | c10000 full | c10000 incr |
| --- | ---: | ---: | ---: | ---: |
| `publish_ms` | 121.5 | **122.4** | 1,656.2 | **2,141.7** |
| `css_serialize_ms` | 61.4 | 28.0 | 438.1 | 219.5 |
| `session_scan_ms` | - | 11.7 | - | 111.7 |
| `io_ms` | 15.3 | 6.9 | 147.9 | 64.5 |
| `session_compile_files_ms` | - | 9.2 | - | 48.6 |
| `session_closure_ms` | - | 4.2 | - | 39.2 |
| `parse_ms:module-graph` | 100.4 | 12.9 | 697.0 | 9.7 |
| `session_dsv_view_ms` | - | 12.7 | - | 9.6 |
| `parse_ms` (total) | 285.9 | 13.2 | 2,473.8 | 9.9 |
| `semantic_ms` | 390.3 | 0.3 | 3,791.4 | 0.3 |
| `ir_lower_ms` | 309.3 | 0.4 | 2,740.7 | 0.3 |
| `policy_ms` | 151.7 | 0.2 | 1,219.5 | 0.2 |
| `boundary_ms` (design system) | 35.8 | **0.0** | 31.0 | **0.0** |
| `coverage_graph_ms` | 200.7 | **0.0** | 1,546.2 | **0.0** |

The session's analysis is **42.9 ms** at c1000 (`pms_generation_ready_ms`) and
**222.9 ms** at c10000 — 5.2× for 10× the files, i.e. sub-linear, because the
fixed costs (resolution re-probe, design-system view) dominate once the
affected set is O(1).

### The two numbers the brief asks for, in one line

| | 1,000 components | 10,000 components |
| --- | ---: | ---: |
| one-file edit, full rebuild | 3,287.8 ms | 31,558.0 ms |
| one-file edit, project session | 307.6 ms | 4,073.7 ms |
| no-change revision, project session | 145.6 ms | 1,222.0 ms |
| `pms_generation_ready_ms` (analysis only) | 42.9 ms | 222.9 ms |
| publication share of the revision | 40% | 53% |

---

## 5. Phase A and Phase B

### Phase A — file-level invalidation

**Implemented, measured, and correctness-proven before Phase B was considered.**
That ordering is the gate the brief sets, and it was followed: every number in
§4 is a Phase A number, taken before any parse-sharing idea was written down.

Phase A is the whole of §2–§4. The decision gate — `incremental == fresh
rebuild` across all required traces — passed at 54 revisions on two corpora,
with 0 mismatches and 0 errors.

### Phase B — the redundant coverage parse

**Not implemented. Measured first, and the measurement says it does not matter
on the path that matters.**

The brief's Spike 1 prize was ~918 ms of coverage parsing on a 10,000-component
**cold build**. Measured on the incremental path, the same parse is:

| | coverage parse (`parse_ms:module-graph`) | share of the revision |
| --- | ---: | ---: |
| c1000 one-file edit | 12.9 ms | 4.2% |
| c10000 one-file edit | 9.7 ms | 0.2% |
| c1000 no-change revision | 0.0 ms | 0% |
| c10000 no-change revision | 0.0 ms | 0% |

The reason is structural, not incidental: the session already owns the module
summary and reuses it whenever the source hash is unchanged, so **the coverage
parse is already gone for every unchanged file**. What remains on a one-file
edit is two parses — the changed file's own summary, and the generated
design-system module during the relay-chain walk. Eliminating both, which
requires sharing one AST between a parse the session does and a transform that
mutates it, buys at most 4% of a 308 ms revision at c1000 and 0.2% of a 4,074 ms
revision at c10000.

The prize that genuinely remains is on the **cold** `initialize()` path
(`coverage_graph_ms` 200.7 ms at c1000, 1,546.2 ms at c10000), where every file
is genuinely new. That is the one-time cost of establishing a session, it is
paid once per session rather than once per edit, and it is the same work a full
rebuild does anyway.

The `errorRecovery` question the brief raises is therefore also answered by
measurement rather than by experiment: the flag is on the coverage parse, the
coverage parse is no longer on the edit path, and the remaining cold-path
benefit is not worth an AST-ownership change whose whole risk profile is
"Do not reuse a mutated AST as evidence of original-source policy". **Not
implemented, on the record, with the number that justifies it.**

---

## 6. Memory

`long-session.js`, `c1000-t1000-r100-s809`, 1,000 sequential revisions in one
process, mixed on purpose: 300 local edits, 100 invalid revisions, 100 repairs,
100 module adds, 100 module removes, 100 renames, 100 global fallbacks, 100
no-change revisions. 901 published, 100 refused, 100 superseded.

| | value |
| --- | ---: |
| cold RSS (revision 1) | 277.2 MB |
| warm RSS after 1,000 revisions | 574.2 MB |
| peak RSS | 574.2 MB |
| cold heap used | 42.1 MB |
| warm heap used (after a forced collection) | 96.7 MB |
| file states, cold → warm | 1,003 → **1,004** |
| resolution keys, cold → warm | 5 → **5** |
| reverse-index modules, cold → warm | 2 → **2** |
| superseded revisions | 100 (counted, never merged) |
| median local-edit revision | 260.2 ms |
| median no-change revision | 249.1 ms |
| final no-change revision | 254.2 ms |

**The structural state is flat, and that is the leak test.** The session
retains state per *covered file* and per *resolution key*, and both are flat
across 1,000 revisions that added, removed and renamed 100 modules each.
Heap used shows a GC sawtooth (54 → 445 → 145 → 208 MB) with no trend; RSS
grew 297 MB over the run and, in a second run of the same trace, plateaued at
1.23 GB from revision ~500 to revision 1,000.

**Reported honestly as a limit:** RSS did not return to its cold size, and the
growth is not a per-revision *session* quantity but it is also not proven to be
nothing. 1,000 revisions is what the brief asks for and what was run; a session
expected to run for tens of thousands of revisions should be measured further
before that is claimed.

---

## 7. The 14 questions

| # | question | answer, measured |
| --- | --- | --- |
| 1 | how many files are reparsed for a one-file edit? | **1** at c1000 and c10000 (5 for a five-file batch, 2 for an import that newly covers a module) |
| 2 | how many are recompiled? | **1** — the same file, and nothing else |
| 3 | how many are reused? | **1,001** at c1000, **10,001** at c10000; **0 parses** on a no-change revision |
| 4 | what causes reverse-dependent invalidation? | only a change to a file's **design-system view**, propagated along the **relay chain**: a re-export edit that changes what a consumer resolves, or a relay that stops reaching the design system. A style-only edit invalidates nothing but the file. Observed: `import_change` `revdep=1`; a barrel edit `revdep=0` because no page consumed it through the barrel |
| 5 | which scenarios trigger a full fallback? | `token_value`, `token_remove`, `token_restore`, `semantic_alias`, `theme_value`, `condition_value`, `condition_remove`, `recipe_branch`, `recipe_interface` (all `design-system-definition`) and `config_change` (`compiler-configuration`) |
| 6 | one-file edit latency at c1000? | **307.6 ms**, from 3,287.8 ms |
| 7 | and at c10000? | **4,073.7 ms**, from 31,558.0 ms |
| 8 | does edit latency still scale with project size? | **the analysis does not** — 42.9 ms → 222.9 ms for 10× the files, sub-linear. **the revision still does**, because publication writes every compiled artifact: 307.6 ms → 4,073.7 ms. The scaling is now in the publisher, not in the compiler |
| 9 | what remains after file-level compilation disappears? | publication (40% at c1000, 53% at c1000), CSS aggregation (9% / 5%), the source scan (4% / 3%), the closure walk (1% / 1%), the design-system view walk (4% / 0.2%) |
| 10 | how much time remains in CSS aggregation and publication? | `css_serialize_ms` 28.0 ms + `publish_ms` 122.4 ms = **150 ms of 308 ms (49%)** at c1000; 219.5 + 2,141.7 = **2,361 ms of 4,074 ms (58%)** at c10000 |
| 11 | did eliminating the coverage parse matter after incrementality? | **no, and it is already eliminated.** The coverage parse costs 12.9 ms of a 308 ms revision at c1000 (4.2%) and 9.7 ms of 4,074 ms at c10000 (0.2%), because the session reuses the module summary. The remaining prize is on the one-time cold path |
| 12 | what is the memory cost of the session? | +55 MB of retained heap for 1,004 file states at c1000 (compiled JS plus every file's rule contribution, retained because a publication must be able to emit them) |
| 13 | does memory stay bounded over 1,000 revisions? | **the session's own state does**: file states 1,003 → 1,004, resolution keys 5 → 5, reverse index 2 → 2, with 100 module adds, removes and renames. RSS grew 297 MB over the run and plateaued in a repeat; that residue is not claimed to be nothing |
| 14 | which workload justifies an Oxc/SWC frontend experiment? | **the cold build, not the edit.** Affected-file work is 9.2 ms of a 308 ms revision at c1000 and 48.6 ms of 4,074 ms at c10000; there is no frontend prize left on that path. The cold `initialize()` is still 29.6 s at 10,000 components, and there the frontend IS ~48% of it. See §8 |

---

## 8. Spike 3 decision

The brief's decision rule, applied:

**"If local incremental latency is already near the target — prefer keeping
Babel for now, return investment to product/P0."**

| target | c1000 | c10000 | reached? |
| --- | ---: | ---: | --- |
| local validation, single-digit ms | 42.9 (analysis) | 222.9 | no |
| small incremental rebuild < 20 ms | 42.9 | 222.9 | no, by 2× and 11× |
| medium affected graph < 50 ms | 42.9 | 222.9 | ~at 1,000 components |

**Recommendation: DO NOT open an Oxc/SWC frontend experiment. Return the
investment to product/P0, and keep the coverage-parse work closed.**

The reasoning, in the order the decision rule asks for it:

1. **On the affected-file path there is nothing left for a frontend to win.**
   48.6 ms of a 4,074 ms revision at 10,000 components, and 9.2 ms of 308 ms at
   1,000. A frontend that halves traversal and configuration would save tens of
   milliseconds on a path that is now dominated by writing files. Spike 1's
   "the frontend is 48% of the profile" remains true of a **cold** build and is
   irrelevant to a warm one.
2. **CSS aggregation and publication are now the dominant costs**, so the next
   investigation, if there is one, is **incremental CSS buckets and an
   incremental publication path** — not a parser. The measurement points at it
   directly: `publish_ms` is 53% of the revision and grows linearly with file
   count, and the session already has the per-file contributions an incremental
   publisher would need.
3. **Global design changes are expensive, but they are rare and they are
   counted.** 9 of 25 scenarios fall back; the other 16 do not. That is a
   signal to keep a design graph on the list as a *product* question (how often
   do real teams change a token?), not to build one now. No evidence in this
   batch says it is common.
4. **The cold build remains strategically expensive** — 29.6 s at 10,000
   components — and that is the one workload a native frontend would help. It
   is not the agent edit loop, and it is paid once per session. If cold-build
   time becomes a product problem, that is the experiment, scoped to
   traversal and configuration rather than to parsing, exactly as Spike 1
   advised.

---

## 9. Known limitations

1. **RSS did not return to its cold size over 1,000 revisions** (§6). The
   session's *own* state is flat and provably so; the process footprint grew
   297 MB and, in a repeat, plateaued. Which of those is a V8 heap-sizing
   artefact and which is real accumulation is not established beyond 1,000
   revisions.
2. **The resolution re-probe is O(directories with edges) per revision.** It is
   one directory read per distinct containing directory, which is negligible in
   these corpora (5 resolution keys) and would not be in a project with one
   directory per component. Recorded as a known cost of the negative-
   resolution guarantee, not hidden by it.
3. **The design system is invalidated as a whole.** A token VALUE change costs a
   full fallback and recompiles every covered file, even though the compiled JS
   of an unchanged page barely depends on a token's value. Reported as
   `full_fallback`, per the brief, and left as a design-graph question.
4. **CSS is re-aggregated from all contributions every revision.** O(total
   atoms). Explicitly allowed by the brief; measured at 28 ms / 220 ms.
5. **A published output directory keeps files from earlier generations.** A
   deleted source's previously published JS file stays on disk. This is the
   existing transactional publisher's behaviour, identical in both engines, and
   it is why the `module_remove` oracle row compares equal. Fixing it is a
   change to publication semantics, out of scope here.
6. **The coverage guarantee is unchanged, not weakened.** Coverage is still
   every file under a declared root plus the local-import closure. A reused
   analysis is a **certificate** with a validity key, never an import filter:
   the fixture test `a deleted file leaves no stale rule` removes a file that
   imports the design system and asserts the stylesheet shrinks.
7. **Two iterations at c10000, three at c1000.** c10000 ran a focused
   six-scenario set; the c1000 campaign is the full 25-scenario matrix at three
   iterations. Reported as measured, not smoothed.
8. **The c10000 campaign discarded each job's copy of the corpus** to stay
   inside the filesystem (`PMS_DISCARD_JOB_PROJECT=1`, recorded in the campaign
   metadata). Observations, traces and per-parse evidence were kept; the corpus
   is byte-identical for every job of a cell and is identified by its content
   hash.
9. **The machine's filesystem was at ~100% capacity** during this batch. It
   forced the c10000 campaign to be scoped to six scenarios and to drop per-job
   corpus copies. It did not affect any measurement — no job errored and no job
   timed out — but it is why the c10000 cell is narrower than the c1000 one.
10. **`PMS_DISCARD_JOB_PROJECT` and the `PMS_BASELINE_ROOT` worktree are
    environment prerequisites, not code.** The Spike 1 oracle test needs a
    baseline worktree with a `node_modules` symlink; without one it fails with
    a clear "module not found" rather than a divergence.

---

## 10. Where the evidence is

`evidence/performance/spike-2/` — `INDEX.json` is the entry point.

| | |
| --- | --- |
| correctness | `correctness/oracle-c100.json` — 54 revisions, 0 mismatches, 0 errors, with every per-revision verdict and counter |
| memory | `memory/long-session-c1000.json` — the 1,000-revision trace, its samples, its light RSS trace and its per-phase table |
| campaigns | `campaigns/c1000-summary.json`, `campaigns/c10000-summary.json`, `campaigns/report-data.json` — every median, p95, count and status breakdown, plus the cross-engine and phase tables |
| corpora | `corpora/<cell>-corpus-manifest.json` — the identity of every number above; each is verified byte-identical to its Spike 1 manifest |
| raw observations | 22,614 rows (c1000) and 3,980 rows (c10000), **not committed**; `INDEX.json` records each stream's size and sha256 |
| raw retention | `ignored-local-scratch` — the raw JSONL, the per-parse traces and the generated corpora live under the gitignored `.pms-bench/` tree, on the same physical volume as the repository. **NOT an archive and NOT durable.** The committed evidence and the digests are what survive |
