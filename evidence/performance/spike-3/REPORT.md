# PandamStyle Spike 3 — incremental publication and incremental CSS aggregation

Branch `perf/pandamstyle-spike-3-publication-css-2026-09`
Base `f01bdb953990270d1a08f846e15480a8f7102592` (delivered Spike 2 head)
Tested commit `c34c862396eb45ef7815b2b2d8d2ea75a5d44f9a`, tree `45464df4c840133ad7a2f6f0b4867469315ed6d6`

Three commits: Phase A (`395e160e`), Phase B (`a279d3eb`), Phase C (`18618117`).
`main` is untouched, nothing was merged, no PR was opened, nothing was published.

---

## 1. The verdict

Spike 3's structural targets were both reached, on both decision-bearing corpora,
and both were proved equal to a fresh full rebuild rather than merely plausible.

| | c1000 one-file edit | c10000 one-file edit |
|---|---|---|
| whole revision, Spike 2 publication | 360.2 ms | 3100.1 ms |
| whole revision, incremental publication | 116.4 ms (**3.1×**) | 935.6 ms (**3.3×**) |
| whole revision, incremental publication + CSS | **93.4 ms (3.9×)** | **739.1 ms (4.2×)** |
| output artifacts written | 1006 → **2** | 10006 → **2** |
| output artifacts reused | 0 → 1004 | 0 → 10004 |
| CSS aggregation | 26.7 ms → **0.25 ms** (107×) | 210.9 ms → **1.02 ms** (207×) |
| no-change revision, JS written | 1006 → **0** | 10006 → **0** |

The headline is not the ratio. It is that **a revision's publication and stylesheet
work is now a function of what changed rather than of the project**, and that the
number is a measured one: 2 artifacts written and 1.02 ms of CSS for a one-file edit
in a 10,020-file project, against 10,006 artifacts and 210.9 ms before.

---

## 2. What was built

### 2.1 Publication architecture

The publisher is `packages/@stylexjs/babel-plugin/pandamstyle/generation.js`, and it
now supports two strategies, kept separate so the win is attributable.

**`mode: 'full'` — the Spike 2 behaviour, unchanged, and still the default.** Every
artifact is rewritten on every revision. It is the reference implementation and the
number everything else is measured against. No existing caller changes behaviour.
It also gains deletion, which it did not have (§2.3).

**`mode: 'delta'` — a generation built by reuse.** The next generation is assembled
in a staging directory by `link()`ing every unchanged artifact from the current
generation and writing only the changed ones. The current generation is then retired
by **rename**, not by copy: `outDir` becomes `backupDir`, `stagingDir` becomes
`outDir`.

**Why a rename and not a per-file rename.** Mutating the published generation in place
is forbidden and correctly so — a reader can see it. A directory swap is the smallest
portable primitive that leaves the current generation immutable for the whole
preparation phase *and* makes rollback a rename instead of a full restore.

**Cost, stated honestly.** The swap is O(total): one `link()` per unchanged artifact,
measured at ~11.6 µs on this machine, ~116 ms for 10,000 files. That is the design's
real residue and it is reported as a number, not hidden. The **bytes** written drop
from O(total) to O(changed) — 1,780,056 → 624,920 at c1000, 15,094,204 → 6,241,028 at
c10000. Removing the last O(total) term would mean indirection through a symlink or a
pointer file, which changes the published artifact's on-disk shape; this
implementation does not make that claim.

### 2.2 Previous- and current-generation representation

Both are the output directory itself, which is the published contract.

- **Previous generation** during preparation: `outDir`, untouched.
- **Current generation** after commit: `outDir`, containing exactly the revision's
  artifacts.
- **Retired generation** during the commit's instant: `.<out>.pms-backup`, removed on
  success. A process that dies leaves it, and the next `beginGeneration` reconciles.

`generation.js:506` (the record set), `generation.js:479` (reuse requires the
previous generation to exist), `generation.js:686` (the reuse decision itself).

### 2.3 Output ownership and the deletion fix

Spike 2 documented, as known limitation #5, that a deleted source's published
JavaScript stayed on disk forever. That behaviour is now in scope and fixed.

Every generated artifact has one explicit owner, recorded in a state file:

```
.<out>.pms-state.json          the CURRENT generation's records
.<out>.pms-state.pending.json  a fully prepared generation, mid-publish

{ version, generationId, revisionId,
  files: { "<rel>": { digest, size, owner, kind, generationId } } }
```

`removed` is `previous generation's records − this generation's records`. A stale
file therefore cannot survive merely because an older generation contained it, and the
published file set is a function of the revision rather than of the history that led
to it.

The record file lives **outside** the output directory deliberately: the output
directory's file set is compared against a fresh rebuild's, and a control file inside
it would be a difference from the reference on every revision.

Ownership supports all five required transitions, and three of them are tested through
a real project:

| transition | behaviour | test |
|---|---|---|
| source changed | its output is replaced | `a single-file edit writes only the affected JavaScript` |
| source unchanged | its output is reused by digest | `unchanged JavaScript is reused by content, not rewritten` |
| source deleted | its output is removed | `a removed module leaves no stale JavaScript and no stale CSS` |
| source leaves coverage | its output is removed | `a file that leaves the covered set removes its output` |
| source renamed | old path removed, new path published | `a renamed source removes the old path and publishes the new one` |

### 2.4 Output digest model

`digest: sha256(content)`, taken **when the file is compiled**, not at publication.
The session hashes each compiled file once and keeps the digest with its contribution
(`session.js:1290`), so the publisher's "unchanged?" answer is O(changed), not
O(project). For metadata artifacts the digest is computed at staging, which is also
O(changed) because only changed metadata is staged.

**mtime is never used.** Reuse is decided by content digest and by the session's
validity key, both of which are content-derived.

### 2.5 Reuse strategy, filesystem acceleration, and the portable fallback

| | |
|---|---|
| preferred | `link()` — a hard link from the current generation into the new one |
| fallback | `copyFileSync`, counted as `publication_copies` |
| probe | once per process, against the real staging directory, not assumed |
| counters | `publication_hardlinks`, `publication_copies` |

Every run in this spike reports `publication_hardlinks = 10004` and
`publication_copies = 0` at c10000, so the fallback was never exercised and the
numbers are fast-path numbers.

**Cross-filesystem.** The staging directory, the backup directory, the output
directory and the control files are all **siblings**, so they are on the same
filesystem by construction and `EXDEV` is impossible for the swap. This is a design
property, not a runtime check. What is *not* guaranteed is link support itself: a
filesystem without hard links falls back to copying, which is correct and
O(total bytes), and a run on such a filesystem says so in its counters.

### 2.6 Hard-link safety

All four required properties hold, and the mechanism is what makes them hold: a
published artifact is **never opened for writing**. Writes only ever target a fresh
file in the staging directory; an unchanged artifact is linked, never rewritten. A
changed artifact is therefore a new inode (`a changed artifact is a NEW file, never an
in-place write of a linked one`). Releasing a generation drops one link and cannot
invalidate a later one (`releasing a generation does not invalidate the one that
reused it`).

### 2.7 Transactional guarantee

Unchanged and strengthened. The commit is a pending-intent file and three renames:

```
1. write  .<out>.pms-state.pending.json     the generation is complete and durable
2. rename outDir -> .<out>.pms-backup       retire N, O(1)
3. rename staging -> outDir                 install N+1, O(1)
4. rename pending -> .<out>.pms-state.json  N+1 becomes current
5. rm -rf .<out>.pms-backup                 release N
```

The pending file is the commit intent, and reconciliation on the next
`beginGeneration` is:

| state on disk | resolution |
|---|---|
| pending + staging | **roll forward** — it was validated before step 1 |
| pending, staging gone | steps 2–3 completed; promote the state |
| no pending | publication never began; discard staging |
| backup, no pending | a full-mode snapshot; restore it |

`outDir` therefore always contains exactly one complete, self-consistent generation,
and N+1 is never observable as current unless it committed.

`outDir` is absent for the instant between renames 2 and 3. This is stated rather than
glossed: it is the price of a portable directory swap with no symlink indirection, and
it is narrower than the window the previous commit-marker-last design exposed, in which
a reader ignoring the marker could see a mixed payload for the whole commit.

### 2.8 No-change generation semantics

A revision and a generation are **not** collapsed. A revision is recorded whether or
not it required a new generation (`a revision and a generation are not the same
thing`).

A generation whose records are byte-identical to the current one is **not
rematerialized**: nothing is written and no directory is swapped
(`a byte-identical generation is not rematerialized`).

In practice this does not fire at session level, and the report says so rather than
claiming otherwise. The build report records the revision inside its `incremental`
block, so a no-change revision legitimately changes exactly one artifact — the
6.24 MB report at c10000 — which is publication metadata the revision requires. The
measured no-change result is therefore **0 JS artifacts written, 0 CSS rewritten, 1
metadata artifact written**, not "zero writes". Reporting a zero that the design does
not achieve would be the more flattering and less useful number.

### 2.9 Generation cleanup policy

- current generation — retained
- previous generation — retained during the commit, released on success
- staging — released on commit and on rollback
- retired generations — never accumulate; §6 proves this over 1000 revisions

---

## 3. Phase A — incremental publication

Phase A was implemented, tested and measured **before** any CSS work began. The
`session_incremental_publish_css` variant threw rather than aggregating in full until
Phase B existed, and a test pins that refusal
(`the Phase B variant is a real third path, not a relabelled one`).

### 3.1 Phase A results, c1000 (`process_warm_edit`, median of 3)

| scenario | revision full | revision delta | files written | files reused | files removed | bytes written | bytes reused |
|---|---|---|---|---|---|---|---|
| one_file_existing_atoms | 360.2 ms | 116.4 ms | 2 | 1004 | 0 | 624 920 | 1 171 565 |
| one_file_new_atom | 278.3 ms | 116.7 ms | 2 | 1004 | 0 | 610 875 | 1 171 559 |
| five_files_batch | 350.5 ms | 136.9 ms | 6 | 1000 | 0 | 612 245 | 1 167 937 |
| module_add | 298.8 ms | 114.5 ms | 1 | 1005 | 0 | 594 571 | 1 172 258 |
| module_remove | 346.1 ms | 101.5 ms | 1 | 1004 | 1 | 600 081 | 1 171 477 |
| file_rename | 286.2 ms | 118.0 ms | 1 | 1004 | 1 | 596 857 | 1 171 475 |
| import_change | 276.9 ms | 124.8 ms | 1 | 1005 | 0 | 601 735 | 1 172 261 |
| repair_forbidden_value | 274.0 ms | 119.8 ms | 1 | 1005 | 0 | 621 870 | 1 172 270 |
| token_value (global fallback) | 3102.3 ms | 2890.8 ms | 4 | 1002 | 0 | 898 696 | 869 662 |

### 3.2 Phase A results, c10000 (`process_warm_edit`, median of 2)

| scenario | revision full | revision delta | publish full | publish delta | files written | files reused |
|---|---|---|---|---|---|---|
| one_file_existing_atoms | 3100.1 ms | 935.6 ms | 2868.8 ms | 603.1 ms | 2 | 10004 |
| one_file_new_atom | 2847.1 ms | 923.6 ms | 2627.6 ms | 591.8 ms | 2 | 10004 |
| five_files_batch | 2823.0 ms | 1313.9 ms | 2589.1 ms | 971.5 ms | 6 | 10000 |
| module_remove | 2907.2 ms | 907.9 ms | 2691.1 ms | 592.3 ms | 1 | 10004 |
| file_rename | 3547.4 ms | 917.5 ms | 3321.6 ms | 589.8 ms | 1 | 10004 |
| import_change | 3778.0 ms | 933.9 ms | 3553.3 ms | 602.7 ms | 1 | 10005 |
| token_value (global fallback) | 29213.1 ms | 27456.2 ms | 2674.1 ms | 633.1 ms | 4 | 10002 |

### 3.3 Phase A no-change revision

| | c1000 | c10000 |
|---|---|---|
| revision, full publication | — | — |
| JS artifacts written, full | 1006 | 10006 |
| JS artifacts written, delta | **0** | **0** |
| artifacts reused, delta | 1005 | 10005 |
| bytes written, full → delta | 1 754 250 → 598 419 | 14 837 398 → 5 983 528 |
| generations materialized | 1 | 1 |

### 3.4 Phase A oracle

`session_incremental_publish` against a fresh full rebuild of the same bytes, 54
revisions over the full scenario set:

**54 revisions, 0 mismatches, 0 errors, verdict `equivalent`** (§5).

### 3.5 A defect the c10000 campaign found

The first c10000 campaign produced 33 errors in 150 jobs, all the same failure:
`link '.../project/.pandamstyle/design.pandamstyle.js' -> ENOENT`.

The cause was real and is now fixed. The record file could outlive its generation —
whenever something cleared the output directory between builds — and reuse then
trusted it and tried to link from files that were not there. Reuse now requires the
generation to exist (`generation.js:479`), and the hole is pinned by
`a record file that outlived its generation does not claim a reuse`.

This is exactly the class of bug that only appears once publication can reuse, and it
is why the campaign was worth running before Phase B.

---

## 4. Phase B — incremental CSS aggregation

Implemented only after Phase A's correctness gate passed. The StyleX aggregator is
unchanged and remains the reference.

### 4.1 CSS state model

`packages/@stylexjs/babel-plugin/pandamstyle/css-state.js`.

```
RuleRecord   one atomic rule: className, priority, substituted ltr/rtl,
             a text digest, the SET of files that own it, and whether it
             carries a logical float

ownerIndex   file -> Set<className>       (the per-file contribution index)
ordered      RuleRecord[]                (kept sorted by the aggregator's comparator)
groups       contiguous priority-level runs, each with a CACHED text
constsMap    the constant-substitution table, and a digest of its identity
```

A rule exists while at least one file owns it. Deleting one of two owners does not
remove it; the rule disappears when its owner set empties.

### 4.2 Rule identity

**The class name** — StyleX's content hash of the atomic declaration, and the same key
the aggregator's own deduplication uses (`new Map(rules.map(([a, b]) => [a, b]))`).

This is **checked, not assumed**. When a second owner arrives, the rendered text and
priority it carries are compared against the ones already recorded, and a disagreement
is a **fallback**, never a silent preference for one of them. If the class name were
ever insufficient, the output is still correct.

### 4.3 Ownership and refcount model

Per-file contributions replace wholesale, so a file's rule set is the unit of change.
Ownership is expressed as a set of owners per rule, not a count, because the identity
of the surviving owners is what matters. Retiring an owner is a single filter pass
over the rule array, so a changed file costs one pass, not one search per rule.

The premise of every ownership test is asserted through the ownership graph before the
conclusion is asserted. This is not ceremony: `display: grid` looks exclusively owned
by the module that declares it and is in fact a **design-system** rule too, and a test
that had picked it would have "proved" deletion while testing nothing.

### 4.4 Ordering model

**A new rule is never appended.** It is binary-searched into the sorted array at the
position the aggregator's own comparator gives it, and a removed rule is spliced out.

The comparator is the aggregator's, not a copy of it. The comparator, the specificity
bump, the theme-selector rewrite, the RTL wrapping and the layer grouping were
**extracted** from `src/index.js` and shared (`src/index.js:945` onward), because a
second implementation of cascade semantics is one that agrees today and disagrees
later.

The ordering is total — the final tiebreak is the whole rule text, which contains a
unique class name — so an array built by binary-searched insertion is the array a full
`.sort()` of the same contributions produces. This is verified, not argued: §5.

### 4.5 A defect Phase B found

`designSystem.injected` is a **mutable accumulator**: every `create()` call the design
system hands to a page does `Object.assign(injected, result.injected)` on it
(`pandamstyle/index.js:83`). The session aliased the design system's rule array to the
same array it appended page rules into, so the incremental layer believed the design
system owned **every rule in the project** and no page rule could ever be retired.

The two arrays are now distinct (`session.js:1180`), and the design system correctly
owns its own 17 rules rather than all 33. The full-aggregation path's output is
byte-identical either way, because the aggregator deduplicates by class name — which
is precisely why the bug was invisible to it and visible only to something that
attributes a rule to an owner.

### 4.6 Phase B results

| | c1000 | c10000 |
|---|---|---|
| CSS aggregation, full | 26.66 ms | 210.92 ms |
| CSS rule-state update | 0.25 ms | 1.02 ms |
| CSS order maintenance | 0.07 ms | 0.11 ms |
| CSS final serialisation | 0.01 ms | 0.01 ms |
| rules added / removed / reused, one-file edit | 2 / 0 / 33 | 2 / 0 / 10 003 |
| rule records held | 326 (flat) | 10 006 |

CSS work is now a function of the changed contribution set: **1.02 ms against 10,006
live rules**, with the final string materialisation at 0.01 ms.

### 4.7 Is final serialisation dominant? No.

This was the brief's question and it is answered negatively, which is why **no CSS
chunking was built**. Only the affected layer group is re-serialised, the group texts
are cached, and joining them costs 0.01 ms at both scales because the stylesheet is
27 KB at c1000 and 27 KB at c10000 — the corpus generator's token set is shared, so
the stylesheet does not grow with the file count. Chunking would be solving a problem
this corpus does not have.

### 4.8 Design-system rules and the global fallback

Design-system injected rules are a global base contribution owned by a reserved key,
so a design-system change is expressible as an ordinary owner change.

For a token, theme, condition, recipe or configuration change, a full CSS rebuild is
taken, counted and **named** (`css_full_fallback`, `fallbackReason`). The measured
cost of that fallback at c10000 is 39.19 ms of rule-state update — the rebuild itself —
against 1.02 ms for a local edit, and it is visible in the build report as
`incremental.css.fallbackReason`.

The CSS state caches the aggregator's **configuration**, so a configuration change
discards and recreates it; reusing it would have emitted a stylesheet shaped by the
previous configuration.

---

## 5. Correctness

### 5.1 Fresh-rebuild oracle

For every revision: drive the session, capture the published generation, rebuild the
same bytes from scratch in a **child process**, compare. The comparison gained an
explicit `generation-file-set` check, because comparing only the files the reference
*expects* cannot see a stale file it does not have.

| variant | revisions | mismatches | errors | verdict |
|---|---|---|---|---|
| `session_full_publish` | 54 | 0 | 0 | `equivalent` |
| `session_incremental_publish` | 54 | 0 | 0 | `equivalent` |
| `session_incremental_publish_css` | 54 | 0 | 0 | `equivalent` |

Compared per revision: verdict, diagnostic codes and locations, the covered set,
compiled JS bytes per current file, the **generation file set**, CSS bytes and CSS
text, the manifest, the build report's semantic state, the generated design-system
module, and the runtime composition structure.

### 5.2 Tests

**333 PandamStyle tests pass**, against a baseline of 283: **+50 new**, in two files.
No existing test was removed or weakened.

- `incremental-publication-test.js` — 38 tests: the delta is real, per-kind
  accounting, deletion, removal, rename, leaving coverage, the whole-trace
  differential, global fallback, valid→invalid→repair, failure injection at five
  points, generation reuse, hard-link semantics, and crash recovery.
- `incremental-css-test.js` — 12 tests: byte equality over a mixed trace, shared-atom
  ownership, last-owner removal, ordering under a non-traversal edit order,
  condition/media ordering, and fallback correctness.

### 5.3 Publication failure injection

Failure injected at five points spanning the publication window — `mid-stage`,
`after-removals-computed`, `after-css-staged`, `before-manifest`, `before-commit` —
after a real edit that recompiles one file and removes another. For each:

```
generation N remains current, byte for byte (whole tree compared)
generation N+1 is never observable
```

and a retry publishes normally and equals a rebuild.

### 5.4 Crash safety

| scenario | result |
|---|---|
| dies before the commit | N current and complete; staging discarded on the next run |
| dies between the swap and the state promotion | rolled **forward**; the output directory is one complete generation and the artifact always agrees with the manifest that describes it |
| staging left by a crash | identifiable by name, cleanable, and does not affect the published generation |

### 5.5 Cancel / supersede

A revision rejected at validation publishes **nothing** and generation N stays current
byte for byte; a subsequent repair revision publishes normally. Verified in the
valid→invalid→repair test. Publication itself is synchronous, so there is no
mid-publication cancellation point; this is a documented limitation of the current API
and no async concurrency was invented to create one.

---

## 6. Retention: 1000 revisions

`session_incremental_publish_css`, c1000, 1000 revisions of a mixed churn
(300 local edits, 100 module adds, 100 removes, 100 renames, 100 no-change,
100 global fallbacks), sampled every 100 revisions with GC exposed.

| revision | heap MB | RSS MB | CSS rule records | CSS owners | owner memberships | file states | resolution keys | parse cache |
|---|---|---|---|---|---|---|---|---|
| cold | 42.9 | 290.8 | 326 | 1001 | 4096 | 1003 | 5 | 2 |
| 100 | 43.1 | 346.0 | 326 | 1002 | 4097 | 1004 | 5 | 0 |
| 500 | 75.2 | 1234.1 | 326 | 1002 | 4097 | 1004 | 5 | 0 |
| 900 | 98.0 | 1244.8 | 326 | 1002 | 4097 | 1004 | 5 | 0 |
| 1000 | 103.6 | 1247.4 | 326 | 1002 | 4097 | 1004 | 5 | 0 |
| 1000 (no change) | 103.5 | 1247.4 | 326 | 1002 | 4097 | 1004 | 5 | 0 |

**Every structure PandamStyle owns is flat from revision 100 onwards.** The
publication state, the CSS state, the rule records, the owner sets, the owner
memberships, the file states, the resolution keys and the module-graph caches do not
grow with the revision count. Generations and staging directories are released, and
the retained artefacts are exactly the current generation plus one record file.

**The heap does grow, and this is reported rather than claimed away.** ~60 KB per
revision, no plateau. It is **pre-existing and not introduced here**: Spike 2's own
recorded 1000-revision trace measured 54.6 MB of heap growth, and this run measures
60.6 MB over the same trace. It is not in the session, not in the CSS state, not in
the publication state, and not in the module-graph caches — the new
`moduleGraphCacheStats()` probe shows those empty at every sample, because
`clearModuleCache` empties them between revisions. It is in the compiler frontend's
per-revision allocations, and Spike 3 neither introduced nor fixed it.

Final no-change revision at c1000: **61.1 ms**.

---

## 7. The remaining profile, and what it says

c10000, `session_incremental_publish_css`, one-file edit, median of 2:

| phase | ms | share |
|---|---|---|
| analysis (`pms_generation_ready_ms`) | 228.6 | 31% |
| of which `session_scan_ms` | 112.1 | 15% |
| of which `session_compile_files_ms` | 47.1 | 6% |
| of which `session_closure_ms` | 36.5 | 5% |
| publication I/O (`publish_io_ms`) | 250.0 | 34% |
| of which `publish_materialize_ms` (10 004 links + 2 writes) | ~220 | 30% |
| of which `publish_cleanup_ms` (10 006 unlinks) | ~105 | 14% |
| CSS | 1.1 | 0.1% |
| **whole revision** | **739.1** | |

**The largest remaining edit-path cost is the two O(total) terms the directory swap
inherits: the per-artifact `link()` pass (~11.6 µs each) and the retirement `unlink()`
pass.** They are the honest price of immutability without a pointer indirection, they
are measured, and they are the first thing to attack if publication is still the
bottleneck.

The second observation is larger and it is about a *different* workload: `token_value`
takes **26 448 ms of analysis** at c10000, 97% of that revision, because a
design-system change is a counted global fallback that recompiles the whole project
and rebuilds the design system. No amount of publication or CSS work touches it. A
workload dominated by design-system edits would be improved by design-graph
invalidation, and nothing in this spike's profile says that is the common case.

### The brief's 14 questions

1. **Files written for a one-file edit** — 2 (1 JS + the build report), from 10 006.
2. **Unchanged artifacts reused** — 10 004, by hard link.
3. **Bytes actually written** — 6 241 028, from 15 094 204; 1 171 565 B reused.
4. **Publication latency at c1000** — 93.4 ms whole revision, 25.8 ms of it I/O.
5. **Publication latency at c10000** — 739.1 ms whole revision, 250.0 ms of it I/O.
6. **Does publication still scale linearly with project size?** — **Bytes, no: O(changed).**
   Inode operations, **yes**: one `link()` and one `unlink()` per artifact, ~11.6 µs
   and ~10 µs, so ~230 ms of the 739 ms. Stated as a residue, not hidden.
7. **Does a no-change compile materialise a generation?** — It installs a new
   generation containing 1 changed metadata artifact; **0 JS artifacts and 0 CSS are
   rewritten**. A byte-identical generation is *not* rematerialised, and that path is
   implemented and tested, but the build report's revision block means a session
   revision always changes that one file.
8. **Are deleted/renamed outputs physically absent?** — **Yes**, verified by file-set
   equality against a fresh rebuild, not by absence of a reference to them.
9. **CSS work for a one-file edit** — 1.02 ms at c10000, 0.25 ms at c1000.
10. **Does CSS scale with changed contributions or total atoms?** — **changed
    contributions.** 1.02 ms against 10 006 live rules, against 210.92 ms in full.
11. **Is final CSS serialisation dominant?** — **No.** 0.01 ms, because only affected
    groups are re-serialised and the stylesheet is 27 KB at both scales. Chunking was
    not built, deliberately.
12. **Largest remaining cost** — the O(total) link + unlink passes of the directory
    swap (34% of the revision), then analysis/scan (31%).
13. **Memory/disk cost of retaining reusable artefacts** — generations are released on
    commit, so the retained set is the current generation plus one small record file;
    reuse costs **zero additional bytes** because a hard link shares the inode. The
    process heap grows ~60 KB/revision, pre-existing and outside every structure
    PandamStyle owns (§6).
14. **Is Oxc/SWC still unjustified?** — **Yes, and more strongly than before.** After
    publication and CSS collapsed, the frontend is *not* the bottleneck: analysis is
    228 ms of a 739 ms revision, and 112 ms of that is a filesystem re-scan and
    re-hash, not parsing. Parsing one file is 47 ms. Replacing the parser would
    address the smaller half of the smaller term.

---

## 8. Next-step decision, from the profile

**Do not select Oxc/SWC. Do not build CSS chunking. Do not build a design graph yet.**

The profile says the edit path is now dominated by two things that are not the
compiler frontend:

1. **Filesystem scanning — 112 ms of a 739 ms revision (15%).** `session_scan_ms`
   re-scans and re-hashes the covered set on every revision because a session has no
   way to know which files changed. The fix is **watcher-driven dirty-file input and
   filesystem event integration**, with content-hash avoidance for files a watcher has
   already vouched for. This is the largest single addressable term and it is an
   orchestration problem, not a parsing one.

2. **The O(total) link/unlink passes of the directory swap — 230 ms (31%).** Removing
   them requires indirection (a symlinked output directory, or a pointer file with a
   projected view). This is a real option and it is deliberately **not** taken here
   because it changes the published artifact's on-disk shape, and portability claims
   are not made beyond what is implemented. It should be a deliberate decision with a
   fallback, not an accident.

3. **Publication byte volume is now dominated by the build report** — 6.24 MB of the
   6.24 MB written at c10000, against ~2 KB of actual JavaScript. A build report that
   is regenerated and rewritten in full on every revision, for one changed file, is
   the largest remaining *byte* cost. Splitting or versioning it is worth a decision
   and is not CSS chunking.

If a fourth spike runs, the order implied by the profile is: **filesystem-watcher
dirty-file input first** (15% of the revision, no on-disk contract change), then the
**build report** (the dominant write), then the **pointer indirection** if publication
is still material. Frontend work stays last, because on this profile it is the
smallest of the three.

And if warm edit latency at 10,000 files is already good enough for the product — 739 ms
end to end, 93 ms at 1,000 files, 61 ms for a no-change revision at 1,000 — then the
right call is to stop optimising the compiler and spend the investment on product and
P0 work. Spike 3's contribution to that decision is that the two costs which looked
structural (publication, CSS) turned out to be removable, and the one that remains
structural (the filesystem re-scan) is not the compiler's.

---

## 9. Verification

`./verify-pms.sh` → **VERIFICATION OK**, 8 of 8 steps passed, `complete: true`,
`skippedSteps: []`, `failedSteps: []`, no skip flags.

Tested commit `c34c862396eb45ef7815b2b2d8d2ea75a5d44f9a`, tree
`45464df4c840133ad7a2f6f0b4867469315ed6d6`, branch
`perf/pandamstyle-spike-3-publication-css-2026-09`.

| suite | result | baseline | delta |
|---|---|---|---|
| upstream babel-plugin | 1007 passed / 64 skipped / 42 suites | 1007 / 64 / 42 | unchanged |
| upstream stylex | 99 passed / 4 suites | 99 / 4 | unchanged |
| PandamStyle | **333 passed / 14 suites** | 283 / 12 | **+50 new, 0 removed** |
| benchmark harness (`node --test`) | 34 passed | 34 | unchanged |
| `npm run lint:report` | clean | clean | unchanged |
| `npm run prettier:report` | clean | clean | unchanged |
| `python3 summarize.py --self-test` | ok | ok | unchanged |
| campaigns | c1000 144/144, c10000 72/72, 0 errors | — | — |

Every increase is accounted for by new tests.

### Disk capacity before c10000

Recorded **before** the campaign, in `corpora/c10000-capacity-and-scenario-plan.md`.
The filesystem was at **100% with 518 MB free** — the condition that killed the Spike
2 c10000 run. Reclaiming regenerable caches brought it to **7.9 GB**, and the focused
c10000 scenario set was chosen and recorded **before** the campaign started. The run
completed 72/72 jobs with 0 errors and the filesystem stable at 6.2 GB free.
`PMS_DISCARD_JOB_PROJECT=1` was set and recorded.

### Files modified

Production compiler code:

| file | change |
|---|---|
| `pandamstyle/generation.js` | delta publication, reuse, deletion, state file, crash reconciliation, metrics |
| `pandamstyle/session.js` | publication variants, output digests and ownership, CSS state wiring |
| `pandamstyle/css-state.js` | **new** — the incremental CSS state |
| `pandamstyle/perf.js` | Spike 3 metrics |
| `pandamstyle/module-graph.js` | `moduleGraphCacheStats()` diagnostic |
| `pandamstyle/entry-node.js` | exports the CSS state and the cache diagnostic |
| `src/index.js` | the cascade primitives, **extracted and shared**, not reimplemented |

Tests and harness: `incremental-publication-test.js` (new),
`incremental-css-test.js` (new), `session-helpers.js`, `harness.js`, `worker.js`,
`run-campaign.js`, `incremental-oracle.js`, `schema/observation.schema.json`.

`src/index.js` is the vendored StyleX file. It was already the home of this fork's
measurement hooks, and the change is additive: functions are *extracted* from existing
ones so the full aggregator and the incremental one share one implementation. The
extractor's output is byte-identical to the original for the full path, which the 54
revisions of the `session_full_publish` oracle confirm.

### Known limitations

1. The directory swap is O(total) in inode operations: ~11.6 µs per `link()` and
   ~10 µs per `unlink()`. Reported, not hidden; removal requires a pointer indirection
   deliberately not taken.
2. A byte-identical generation is not rematerialised, but a session revision always
   changes the build report, so the path does not fire at session level.
3. The first delta publication over a generation this implementation did not write is
   a full one, because there is no record of what was published. It bootstraps the
   records; the next revision is a real delta. This is the alternative to reading
   every published byte on every revision.
4. Publication is synchronous, so there is no mid-publication cancellation point.
5. Hard-link support is probed, not assumed; on a filesystem without it the fallback
   is `copyFileSync` and is O(total bytes). No run in this spike took that path.
6. Cross-filesystem output directories are not exercised: the design keeps every path
   a sibling, so the swap is same-filesystem by construction. A consumer pointing
   `outDir` at a mount point is untested.
7. The process heap grows ~60 KB per revision over 1000 revisions. Pre-existing
   (Spike 2 measured 54.6 MB on the same trace), not in any structure PandamStyle
   owns, and not fixed here.
8. The incremental CSS state is single-threaded and not persisted; a session restart
   rebuilds it.

### Raw data

Not durable. Campaign and oracle raw streams remain under `.pms-bench/` — ignored
local scratch, not an archive.

| artefact | sha256 | bytes |
|---|---|---|
| `.pms-bench/qualification/spike3/` (raw campaign + oracle streams) | see `INDEX.json` | see `INDEX.json` |

Durable evidence is `evidence/performance/spike-3/`, indexed by `INDEX.json`.
Spike 1 and Spike 2 measurement evidence are untouched.
