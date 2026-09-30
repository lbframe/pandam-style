# PandamStyle Spike 4, Phase C — the agent loop and the split of audit metadata

Base `7799e89a7ce872a2f0b3325d01747bdb65f747d9` (delivered Spike 4 Phase B head)
`main` is untouched, nothing was merged, no PR was opened, nothing was published.

Phase A (`de8e4c7b`) established the explicit agent mutation transaction. Phase B
(`7799e89a`) established watcher-based fallback discovery. Phase C gives an AI
agent a compact, revision-bound, machine-authoritative result that does not carry
the project with it — and proves the evidence is still there.

---

## 1. The verdict

At c10000 a one-file agent edit is **173.1 ms** to complete authoritative
diagnostics, and the compact build report a publication writes is **3,301 bytes**
instead of **5,003,195**. The project-wide coverage snapshot is still produced —
**5,164,617 bytes**, byte-for-byte the array the monolithic report carried inline —
on request, for the same revision, in 813 ms.

| | c1000 | c10000 |
|---|---|---|
| `agent_edit_to_diagnostics_ms`, one file | **34.6 ms** | **173.1 ms** |
| `agent_edit_to_diagnostics_ms`, invalid revision | **31.6 ms** | **158.3 ms** |
| `agent_edit_to_diagnostics_ms`, repair revision | **32.2 ms** | **142.8 ms** |
| agent result, success | 1,803 B | 1,815 B |
| agent result, with a diagnostic | 3,720 B | 3,738 B |
| `build-report.json`, pre-Phase-C (`inline`) | 495,397 B | **5,003,195 B** |
| `build-report.json`, Phase C (`reference`) | 3,259 B | **3,301 B** |
| reduction | **152×** | **1,516×** |
| coverage document, on request | 509,848 B | 5,164,617 B |
| source files read / hashed, one-file edit | 1 / 1 | 1 / 1 |
| source files compiled, one-file edit | 1 | 1 |
| source files reused, one-file edit | 1,001 | 10,001 |

The headline is not the ratio. It is that **the agent's answer no longer contains
the project, and the project is still one request away.**

---

## 2. What was measured, and how

### 2.1 The measurement that decided the architecture

`benchmarks/pandamstyle/src/report-bytes.js` audits a published metadata document
by exact marginal cost:

```
bytes(field) = size(serialize(document)) − size(serialize(document \ field))
```

applied to the document that was actually written, with the publisher's own
formatting. The difference is taken between two real serializations, so it
includes the key, the punctuation and the pretty-printing. The residue is
reported rather than distributed, so the table reconciles.

It runs against **both** policies, on the same compiler and the same analysis, so
the two tables differ only by the metadata policy.

**c10000, `auditPolicy: 'inline'` (the pre-Phase-C artifact), 3,252,376 bytes:**

| field | bytes | % |
|---|---|---|
| **coverage entries** | **3,250,511** | **99.943%** |
| relayEdges | 391 | 0.012% |
| externalRequests | 26 | 0.001% |
| incremental counters | 805 | 0.025% |
| diagnostics | 0 | 0.000% |
| top-level metadata (everything else) | 640 | 0.020% |
| residue (braces, commas, newlines) | 3 | — |

Coverage entry fields, c10000:

| field | bytes | % of the file | entries |
|---|---|---|---|
| `coverage[].relayChain` | 850,118 | **26.138%** | 10,002 |
| `coverage[].file` | 499,012 | 15.343% | 10,003 |
| `coverage[].usedDesignSystem` | 320,065 | 9.841% | 10,002 |
| `coverage[].usedPmsHelpers` | 300,061 | 9.226% | 10,002 |
| `coverage[].ruleCount` | 220,877 | 6.791% | 10,002 |
| `coverage[].diagnostics` | 240,072 | 7.381% | 10,003 |
| `coverage[].analysed` | 240,072 | 7.381% | 10,003 |
| `coverage[].origin` | 240,103 | 7.382% | 10,003 |
| `coverage[].role` | 220,075 | 6.767% | 10,003 |

**c10000, `auditPolicy: 'reference'` (Phase C), 2,572 bytes** — no coverage
entries, no per-file anything. Same information, on request.

c1000 is the same shape: 326,609 → 2,548 bytes, coverage 99.434%, `relayChain`
26.061%. Full tables in `metadata/`.

The hypothesis the brief advanced — coverage dominates, and `relayChain` is the
largest single contributor — is **confirmed from serialized bytes**, at both
scales, by a tool that ships with the change.

---

## 3. The architecture that was chosen

### Selected: B (compact summary + separate detailed coverage artifact), with C (lazy) as its trigger

```
build-report.json        3,301 B   the revision/build summary
coverage.json            5,164,617 B   the project-wide snapshot, on request
```

- The `build-report.json` carries `coverageSummary` (counts) and a
  `coverageReport` reference carrying the document kind, the schema version, the
  entry count and the **revision id**. The revision id is what makes the
  standalone document findable after the fact.
- `session.requestFullAudit()` produces it, synchronously, for the current
  revision. There is no background writer, no timer and no queue.
- Before `compile()`, a request stages `coverage.json` into the generation, so a
  generation that contains it is a generation that is complete. After
  `compile()`, the generation is immutable — its manifest already certified its
  contents — so the document is written to `.<out>.pms-audit/coverage-rev-N.json`
  beside the output directory, carrying its own revision and generation ids.
  **A committed generation is never mutated.**

### Rejected

| option | why not |
|---|---|
| **A. existing monolithic report** | 99.943% of its bytes are project-wide metadata, and 26% of the file is a list of relay chains. It is measured here as the `inline` policy and it is the thing Phase C removes. |
| **D. delta report referencing the previous revision** | The cost Phase C found is per-revision *volume*, not per-revision *churn*. A delta against the previous revision would have made the second and later revisions cheap and the FIRST one — and a forensic reconstruction of revision N from revision N−1 — expensive and lossy. It answers a question this workload does not ask. Not measured; rejected on the shape of the problem, and recorded as such. |
| **C alone (lazy monolithic)** | Deferring the *write* while still building the whole object in memory moves the cost rather than removing it, and a report that quietly re-derives itself at read time is dishonest about where the time went. The split removes the object from the hot path too. C is the **trigger** for B, not a substitute. |

`auditPolicy: 'inline'` is kept as a supported option, not deleted: a host with a
version 1 reader keeps working, and the spike can measure the two policies against
each other on one compiler, which attributes the difference to the metadata policy
rather than to a different checkout.

---

## 4. The agent result

```json
{
  "documentKind": "pandamstyle-agent-result",
  "schemaVersion": 1,
  "revisionId": 3,
  "ok": false,
  "projectSemanticEpoch": 1,
  "diagnostics": [ … ],
  "mutation":    { "mode": "verified-explicit", "declared": 1, "read": 1,
                   "hashed": 1, "contentChanged": 1, "contentUnchanged": 0,
                   "changed": 1, "added": 0, "removed": 0, "renamed": 0,
                   "noOp": false },
  "incremental": { "filesChanged": 1, "filesAdded": 0, "filesRemoved": 0,
                   "filesCompiled": 1, "filesRecompiled": 0, "filesReused": 10001,
                   "coveredFiles": 10003, "dirtyInputMode": "verified-explicit",
                   "fullDiscovery": false, "fullFallback": false,
                   "fullFallbackReason": null },
  "coverage":    { "coveredSetChanged": false, "affectedCount": 1,
                   "affectedEntryLimit": 64, "affectedTruncated": false,
                   "projectEntries": 10003,
                   "affectedEntries": [ { "file": "…/Button.tsx", "origin": "root",
                                          "role": "page", "analysed": true,
                                          "failed": true, "diagnostics": 1,
                                          "codes": ["PMS_FORBIDDEN_VALUE"] } ] },
  "generation":  { "published": false, "generationId": null, "generationReused": false,
                   "mode": null, "outputsWritten": 0, "outputsReused": 0,
                   "bytesWritten": 0 },
  "audit":       { "requested": false, "ready": false, "document": null, "bytes": null,
                   "reason": "not requested; project-wide coverage is available on demand",
                   "request": "session.requestFullAudit()" },
  "timings":     { "diagnosticsReady": true, "generationReady": false,
                   "generationCommitted": false, "auditReportReady": false,
                   "agent_edit_to_diagnostics_ms": 158.308135,
                   "agent_edit_to_generation_ready_ms": null,
                   "agent_edit_to_generation_committed_ms": null,
                   "agent_edit_to_audit_report_ms": null,
                   "incrementalAnalysisMs": 158.0… }
}
```

**A real result, from a `forbidden_value` revision at c10000.** The generation
block is `published: false, generationId: null` because the revision refused: a
result is never allowed to imply generation success merely because validation
succeeded.

### 4.1 Compactness is a contract, and both ways of breaking it are capped

Two things would have made this object scale with the project, and both are
handled explicitly rather than assumed away.

**Admissible token candidates.** A `PMS_FORBIDDEN_VALUE` diagnostic's candidate
list is derived from the *registry*, so at a 10,000-token design system one
one-line edit would carry 10,000 strings. Capped at 32, with
`candidatesTotal` and `candidatesTruncated` beside the prefix, and the full list
reachable through `session.candidateTokens({ category, limit, offset })`. A
silently shortened list would be indistinguishable from a registry of 32.

**The affected coverage entries.** The affected set is a handful of files on a
normal revision and **the whole project on a global fallback** — a design-system
change drops every cached result. Measured at c1000 before the cap: a
`token_value` revision produced a **413,988-byte** agent result, throwing away
the entire saving on the one revision where an agent most needs a small answer.
Capped at 64 with `affectedCount` and `affectedTruncated`; now **27,976 bytes**
at c10000, and the rest is where it has always been.

### 4.2 A diagnostic is a protocol

```json
{
  "schemaVersion": 1,
  "code": "PMS_FORBIDDEN_VALUE",
  "severity": "error",
  "phase": "policy",
  "rule": "category-strict",
  "message": "Valeur interdite pour color : 17. Un token colors est requis.",
  "source": { "file": "src/page.tsx", "line": 18, "column": 12,
              "role": "page", "label": "src/page.tsx (page)" },
  "context": { "property": "color", "value": 17, "systemId": "…",
               "conditionPath": null },
  "expected": { "category": "colors", "admitted": null },
  "candidates": [ "colors.text.base", "…" ],
  "candidatesTotal": 24, "candidatesTruncated": false,
  "candidatesQuery": "session.candidateTokens({ category, limit, offset })",
  "repair": { "kind": "substitute-token", "applicable": true,
              "property": "color", "value": 17,
              "expected": { "category": "colors" },
              "candidatesFrom": "diagnostic.candidates",
              "how": "replace the value with a token reference drawn from …" },
  "autofix": null,
  "file": { "file": "src/page.tsx", "origin": "root", "role": "page",
            "analysed": true, "usedDesignSystem": true, "ruleCount": 2,
            "relayChain": [ "bridge/index.ts" ], "failed": true,
            "codes": ["PMS_FORBIDDEN_VALUE"] }
}
```

Four changes relative to the version 1 diagnostic, and each is load-bearing:

- **`source` is an object, not a label.** Version 1 collapses file and role into
  one string, `"a.tsx (page)"`. Recovering a file and a role from that is a
  regular expression against an author's file name, and a file whose name
  contains `" (page)"` breaks it. `label` is kept beside it for display.
- **`expected` is named.** The admissible category is lifted out of `context`
  into a field a host switches on, rather than a key that happens to be present.
- **`repair` is a stable identifier or a stated reason.** Every code the negative
  corpus can raise has one. A test asserts it across the whole `neg-*` corpus: a
  code with neither a structured repair nor a reason is a code an agent can only
  act on by reading prose.
- **`autofix` stays `null`.** 17 is not a proven equivalent of any token value. A
  compiler that auto-wrote a different colour would be changing an author's
  design; the *repair* is a substitution the agent chooses.

**Diagnostic context is local.** `file` is the coverage record of the file the
diagnostic is about, and nothing else. Attaching the project-wide graph would
drag the 5 MB back into the agent result through one diagnostic.

---

## 5. The four completion points, and the numbers

Medians over 7 iterations per cell (c1000) and 1 per cell (c10000). One process
per cell.

| | c1000 | c10000 |
|---|---|---|
| `agent_edit_to_diagnostics_ms` — one file | 34.6 | 173.1 |
| — invalid | 31.6 | 158.3 |
| — repair | 32.2 | 142.8 |
| `agent_edit_to_generation_ready_ms` | 91.8 | 711.4 |
| `agent_edit_to_generation_committed_ms` | 105.2 | 834.2 |
| `agent_edit_to_audit_report_ms` | 109.5 | 813.1 |
| **complete invalid → repair loop** (break + repair, both milestones) | **31.6 + 104.2** | **158.3 + 804.1** |
| **complete loop, to the full audit** | **31.6 + 109.5** | **158.3 + 813.1** |

A failed revision reports `diagnosticsReady: true` and every other milestone
`false`/`null`. That is not a gap in the measurement; it is the result. A refused
revision reaches diagnostics and stops, and a generation time for it would be
inventing work that was correctly refused.

The dispatch figure (`agent_loop_dispatch_ms`, the outer wall clock around
`applyAgentChanges` + `validate` + `serializeAgentResult`) is reported beside the
session's own stamp: c1000 34.93 vs 34.64, c10000 173.5 vs 173.1. The gap is the
harness's own overhead, and reporting it is what keeps the session's stamp
honest.

### 5.1 Metadata timings, separated

| | c1000 | c10000 |
|---|---|---|
| `agent_result_build_ms` | 0.081 | — |
| `agent_result_serialize_ms` | 0.011 | — |
| `build_report_build_ms` (compact) | 0.044 | — |
| `build_report_serialize_ms` (compact) | 0.012 | — |
| `coverage_report_build_ms` (on request) | 0.030 | — |
| `coverage_report_serialize_ms` (on request) | 1.370 | — |
| `metadata_bytes_written_hotpath` (compact publication) | ~6,600 | ~6,700 |
| `metadata_bytes_written_audit` (coverage document) | 477,102–538,279 | 4,837,871–5,445,051 |

The compact report's build and serialize together are **0.056 ms** at c1000. They
were never the problem; the *volume* was, and the volume is what left.

---

## 6. 1 / 5 / 20-file agent transactions

The point is to show that work scales with the agent's affected set rather than
with the project.

| transaction | c1000 diag | c10000 diag | files read | files hashed | files compiled | files reused (c10000) | agent result |
|---|---|---|---|---|---|---|---|
| 1 file | 34.6 ms | 173.1 ms | 1 | 1 | 1 | 10,001 | 1,815 B |
| 5 files | 54.7 ms | 174.2 ms | 5 | 5 | 5 | 9,997 | 3,261 B |
| 20 files | 93.2 ms | 212.3 ms | 20 | 20 | 20 | 9,982 | 9,347 B |

Latency is a function of the affected set. 20 files at c10000 cost 39 ms more
than 1 file, and 10,000 extra files in the project cost nothing.

`files_hashed == files_read == files_declared` in every row: the declared set is
still read and content-hashed. Phase A's contract is unchanged.

### 6.1 The no-change transaction, recorded honestly

| | c1000 | c10000 |
|---|---|---|
| `mutation.declared` | 1 | 1 |
| `mutation.read` | 1 | 1 |
| `mutation.hashed` | 1 | 1 |
| `mutation.contentChanged` | **0** | **0** |
| `mutation.contentUnchanged` | **1** | **1** |
| `mutation.noOp` | **true** | **true** |
| `filesRecompiled` | 1 | 1 |

The host declared a file and its bytes were identical. That is a no-op that cost
a read and a hash, and it is labelled as one.

**It still recompiled the file.** `scanPreviousAndRoots` adds every declared path
to the invalid set whether or not its bytes changed, so a declared-but-unchanged
file is recompiled. This is Phase A behaviour, it is not a correctness defect —
recompiling an unchanged file produces the same result — and it was **not**
changed in Phase C. It is recorded here as a measured cost and carried to §9.

---

## 7. The correctness oracle

`benchmarks/pandamstyle/src/phase-c-oracle.js`. Two halves, because the metadata
was restructured and the compiler must not have been.

**Semantic — compared for EQUALITY** against a fresh full rebuild **in a separate
process** (`phase-c-rebuild.js`). The process boundary is the point: a rebuild in
the same process would share the module registry, the compiler's caches and the
design system the session just built, and would not be a rebuild at all.

Compared: the verdict, the diagnostics with their codes, rules, severities,
locations and contexts, the covered set, the compiled JavaScript **byte for
byte**, the CSS byte for byte, the generation's file set, the manifest, the
registry digest, the system id, the contract version, every rule count, the
external requests, the relay edges, and the **runtime composition structure**
(class literals, `__pmsRecipe_*` references, import specifiers).

| corpus | revisions | mismatches | errors | verdict |
|---|---|---|---|---|
| c100-t100-r10-s101 | 12 | 0 | 0 | **equivalent** |
| c1000-t1000-r100-s809 | 12 | 0 | 0 | **equivalent** |
| c10000-t1000-r100-s307 | 12 | 0 | 0 | **equivalent** |

The 12-revision trace is mixed on purpose — a local edit, a five-file edit, a
violation, its repair, a module add, a no-op, a remove, a rename, an unresolved
import, the file that resolves it, a twenty-file edit, and a design-system
change — because a trace that only edited files would say nothing about whether a
rename still removes the old output.

**Audit — compared for COMPLETENESS, not byte equality.** Demanding byte
equality between the old monolithic report and the new pair would demand that
Phase C changed nothing about the format, which is the opposite of what it is
for. `AUDIT_FIELD_MAP` names where every field version 1 carried lives in
version 2; a field with no entry is reported as **unaccounted** rather than
skipped, because a comparison that ignores fields it does not recognise passes
when information was lost. The per-file records are compared element by element
against the coverage document, and the summary's counts are checked to be
*derived from* that document.

| corpus | verdict | unaccounted fields | differing records | coverage document |
|---|---|---|---|---|
| c100 | **complete** | 0 | 0 | 42,611 B |
| c1000 | **complete** | 0 | 0 | 411,925 B |
| c10000 | **complete** | 0 | 0 | 4,114,740 B |

`auditPolicy: 'inline'` is the reference here, so this is a **metadata-policy
comparison on one compiler**, not a comparison between two checkouts. Both passes
run over the **same bytes at the same absolute path** — two copies at two paths
produce two different `coveredRoots` and two different `relayEdges` for reasons
that have nothing to do with either policy, and the first version of this oracle
reported exactly that.

### 7.1 Schema versions

| document | version | note |
|---|---|---|
| `pandamstyle-build-report` | **2** | 1 carried the coverage array inline. `schemaVersion` is REQUIRED, not optional: a reader that does not check it would read a version 1 report's `coverage` as absent and could take that for an empty project. |
| `pandamstyle-coverage-report` | 1 | new document |
| `pandamstyle-agent-result` | 1 | new document |

`auditPolicy: 'inline'` emits `schemaVersion: 1` plus the version field, which the
pre-Phase-C artifact did not have. That is the only difference and it is stated
in the oracle's own table rather than glossed.

---

## 8. What was NOT changed

- **No Oxc, SWC, Rust or Salsa.** Nothing of the kind exists and nothing was
  added.
- **No publication-contract change.** The output directory, the generation
  transaction, the commit marker, the delta record and the hardlink/copy reuse
  are exactly as Spike 3 left them. The metadata split adds a document to a
  generation when one is requested; it does not change how anything is published.
- **No Phase A or B behaviour weakened.** All 381 Spike 3 / Phase A / Phase B
  tests pass **unchanged**, plus 32 new ones. The three test files that needed
  editing read the coverage array from its new home; their assertions are
  otherwise untouched, and the differential oracle was extended rather than
  weakened.
- **The `analyseCoveredFiles` O(total) loop was instrumented, not optimised.** See
  §9.3.
- **The Vite adapter's report is unchanged.** It is a different document kind
  (`pandamstyle-vite-build-report`) with a different consumer, it is not on the
  agent hot path, and changing it would alter the pilot's published bytes with no
  measurement motivating it. Carried to §9 as a candidate.

---

## 9. Where the time actually goes — the Phase D question

The brief asked whether the next dominant agent-path cost is A (`analyseCoveredFiles`
O(total) reuse iteration), B (directory-swap link/unlink O(total)), C (watcher /
dirty-index work), D (affected-file compilation), or E (something else). It is
mostly **E**, and the profile says exactly what.

### 9.1 The one-file edit, c1000, 30.5 ms (measured, `c1000-phase-profile.json`)

| phase | ms | % |
|---|---|---|
| `session_closure_ms` | **10.74** | **35%** |
| `session_dsv_view_ms` | **10.58** | **35%** |
| `session_compile_files_ms` | 7.81 | 26% |
| ↳ of which `session_compile_affected_ms` | 4.54 | 15% |
| ↳ of which `session_reuse_iteration_ms` | **0.39** | **1.3%** |
| ↳ of which `session_coverage_entries_ms` | 0.56 | 1.8% |
| `session_scan_ms` | 0.39 | 1.3% |
| unaccounted | 0.98 | 3.2% |

The two answers, one per line:

- **A. `analyseCoveredFiles` O(total) reuse iteration: NOT MATERIAL.** 0.39 ms
  of 30.5 ms — **1.3%** at c1000, **3.1%** (5.3 ms of 173.1 ms) at c10000. It did
  not confound the metadata experiment, so per the brief it was **not optimised**
  in Phase C. It remains the correct next small win if the two large items are
  addressed first.
- **E. Something else, and it is 70%: `refreshClosure` and
  `refreshDesignSystemViews`.** Both walk the whole covered set on every
  revision, and neither has anything to do with the file the agent edited. The
  closure refresh re-derives the module graph from persistent summaries
  (`session_closure_ms`, 10.74 ms); the design-system view refresh recomputes
  every file's view of the design system (`session_dsv_view_ms`, 10.58 ms).
  Together: **21.3 ms of 30.5 ms.**

B is real but it is on the **publication** path, not the diagnostics path: at
c10000, `generation_ready` → `generation_committed` is **122.8 ms** (711.4 →
834.2), which is the directory swap, the state record and the metadata commit.
C is 0.39 ms of scan. D is 4.54 ms.

### 9.2 The publication path, c10000

`diagnostics → generation_ready` is **538 ms** — the 1,002 JavaScript artifacts
and the stylesheet are written on every revision by `session_full_publish`'s
successor variant, which is `session_incremental_publish` here. That is Spike 3's
territory, not Phase C's, and it is the second-largest number in the whole
profile.

### 9.3 Recorded candidates, in the order the profile supports

1. **`refreshDesignSystemViews` (10.58 ms, 35%).** A per-file design-system view
   whose inputs changed for **one** file is recomputed for all of them. The
   reverse-dependency index the session already maintains for relay chains is the
   obvious input: only the files whose view's inputs actually moved need
   re-deriving.
2. **`refreshClosure` (10.74 ms, 35%).** Every covered file's module summary is
   re-examined per revision. The summary is persistent; what changes is the set
   of files whose edges could have resolved differently, and the session already
   knows that set for negative resolution.
3. **The publication path (538 ms at c10000, staging).** `session_full_publish`
   is the default; `session_incremental_publish` is available and Spike 3
   measured it at 3.3×. The agent-loop harness drives the delta variant, so this
   number is a property of the variant, not of the agent loop — but an agent
   host that publishes on every edit pays it.
4. **`analyseCoveredFiles` reuse loop (0.39 ms / 5.3 ms).** Small now; becomes
   worth it once 1 and 2 are done and the constant is no longer dominated.
5. **The Vite adapter's report.** Same shape, not on the agent path, unchanged
   on purpose.

### 9.4 One thing the campaign found that was not in the brief

**A declared-but-unchanged file is still recompiled** (§6.1). On a no-op
transaction the session reads and hashes the file, proves the bytes are
identical, and then recompiles it anyway. The Phase A comment says "should cost
nothing downstream", and the code does not deliver that. It is correct, it is
cheap at these sizes (0.4 ms of scan at c1000), and it is a real Phase A
optimization that Phase C deliberately did not make. **A host that reformats
files it did not semantically change is paying a full compile per file.**

---

## 10. Verification

### 10.0 The PandamStyle surface — the delivery gate

| | |
|---|---|
| tests passed | **413** (381 Spike 3 / Phase A / B baseline + 32 new) |
| tests failed | **0** |
| tests skipped | **0** |
| suites passed | **17** (16 baseline + 1 new) |
| suites failed | **0** |
| suites skipped | **0** |
| new suite | `__tests__/pandamstyle/agent-result-test.js`, 32 tests |
| tooling | `tools/pms/__tests__/`, 21 tests, 2 suites |
| prettier | clean across the whole repository |
| eslint | clean across the whole repository |
| benchmark harness self-test | pass (`agent-loop.js --self-test`, 15 assertions) |

### 10.0.1 The whole repository, from the root

The repository-level Jest configuration existed to make a root run work. It did
not, and the reason is the same class of defect as the suite-count one.

Jest's default `testMatch` is `**/__tests__/**/*.[jt]s?(x)`: **every**
JavaScript file under a `__tests__` directory is a test, including the fixture
PROJECTS that live there and the helper modules next to the suites. A root run
at the Phase B head:

| | Phase B head (`7799e89a`) | Phase C |
|---|---|---|
| suites failed | **132** | **11** |
| tests failed | 185 | 18 |
| tests passed | 2,112 | 2,454 |
| the 17 PandamStyle suites | **all failed to load** | **all pass** |

Measured, not asserted: a git worktree at the Phase B head, the same
`node_modules`, the same `npx jest`. Every one of the 11 remaining failures is
also present in the Phase B head's 132 — **none of them is Phase C's**, and all
of them are in packages this phase does not touch (`stylex`,
`style-value-parser`, `devtools-extension`, `cli`, the babel-plugin's `legacy`
tests, and `benchmarks/pandamstyle/tests/bench.test.js`, which is a `node --test`
file that Jest cannot run). They are the pre-existing state of a cross-package
convenience run, and the per-package runs — `npm run test:packages`, which is
what `verify-pms.sh` gates on — are green for them.

The fix is two settings, and they are the two the babel-plugin's own config
already had: `testMatch` names the repository's convention (`*-test.js`, plus the
three `*.test.js` files elsewhere), and `testPathIgnorePatterns` excludes
`__fixtures__/`, `pandamstyle/fixtures/` and `fixtures/`. The two configs are now
asserted to agree, because two configs that disagree about what a test file is
will eventually disagree about whether a suite exists.

**This is the brief's defect, live.** At the Phase B head the root run reported
**2,112 passing tests and 132 failed suites** — and the PandamStyle suite, the
one this repository exists to test, contributed *zero* of them.

### 10.1 Suite-count integrity

Phase A/B found a verification hole that had nothing to do with the compiler: a
suite that **fails to load** contributes no tests, so removing it makes the total
look better, and a delivery that quoted the passed-test total would claim a green
run that had not run the code.

`tools/pms/test-counts.js` reads Jest's output and decides the verdict, and
`verify-pms.sh` uses it. Six numbers are recorded — tests and suites, each
passed / failed / skipped — plus `testsAccountedFor` and `suitesAccountedFor`
against the totals Jest reported. The rules, each with its own finding code:

| finding | what it catches |
|---|---|
| `SUITE_FAILED` | a suite reported failures. A failure, whatever the passed-test total says. |
| `TEST_FAILED` | a test reported failures, with no suite line. |
| `SUITES_UNACCOUNTED` | passed + failed + skipped ≠ the total. Suites went missing. |
| `TESTS_UNACCOUNTED` | the same for tests. |
| `SUITE_LINE_MISSING` | no `Test Suites:` line. UNKNOWN, not zero. |
| `EXIT_CODE_DISAGREES` | the exit code and the counts tell different stories — a wrapper that swallowed the code. |
| `EXIT_CODE_MISSING` | a step with no exit code. `null`, never `0`. |

`summary.json` carries the six numbers and the verdict at the TOP, and
`verify-pms.sh` **exits non-zero when the counts say a step failed even if the
step table says it passed**. A separate test asserts the Phase A/B shape — seven
passed tests, one failed suite — is reported `failed`, not green. 13 tests.

The run verdict does not collapse `failed` and `incomplete`: "nothing failed" and
"everything ran" are different claims.

### 10.2 The root Jest configuration

`jest.config.js` is now covered by `tools/pms/__tests__/jest-config-test.js`,
**two-sided** because a one-sided test cannot catch the failure it exists for:

- the generated trees **are** excluded — `evidence/`, `upstream/`, `examples/`,
  `.unpacked/` — and no discovered test lives under any of them;
- the **real** test surfaces are still discovered, named one by one, so an
  ignore pattern that grows by accident makes a test fail rather than quietly
  shrinking the suite;
- the admitted patterns **are** this repository's convention, and the primary
  pattern is the same string the babel-plugin's own config uses — asserted
  against that config, not against a copy of it;
- a **fixture project is not a test**, asserted by name, including the compiled
  `fixtures/valid/generated/` output that actually appeared in the failing run;
- exactly one `package.json` in the repository answers to
  `@pandamstyle/compiler` — the `_assertNoDuplicates` crash is asserted
  **before** the suites that load a design system, not inside one of them;
- no ignore pattern is a bare catch-all, and the config sets only the five keys
  it says it sets, so it cannot change how tests are transformed or where Jest
  looks for modules. 8 tests.

### 10.3 A defect the campaign found, in the harness

`token_value_full_fallback` reported `full_fallback: 0`. The changed design
system was written to disk and then never handed to the session — the cell
labelled "the one path where the affected set IS the project" was measuring an
ordinary no-fallback edit. The oracle caught it as a divergence against a fresh
rebuild that had read the changed bytes.

A design-system change goes through `applyChanges({ definition })`, not
`applyAgentChanges(mutation)`, because the definition is a separate input and
the session digests what it is given rather than watching the file. The oracle
also had to stop using a plain `require` for the same reason: Node's ES module
registry is keyed by URL and has no public invalidation, so a second edit to a
definition is invisible to `require`. The harness's own self-test now asserts
that the fallback fires **and** that the project was really recompiled.

### 10.4 Two harness defects, for the record

- **One process for 336 cells died at cell 44** of the c1000 campaign. A session
  at a thousand files holds its per-file contributions and 44 of them in one
  address space is gigabytes. A cell is now its own process, which is also the
  right hygiene: a cell's numbers must not depend on how many cells ran before
  it. A cell that dies is recorded as a failed cell, not silently dropped.
- **The test suite's fixture copies filled a 900 GB volume** and killed a running
  campaign. They now live under one temp root per process, removed on exit.

---

## 11. Files

| file | what |
|---|---|
| `packages/@stylexjs/babel-plugin/pandamstyle/agent-result.js` | the agent-result schema, the diagnostic normalizer, the coverage document |
| `packages/@stylexjs/babel-plugin/pandamstyle/session.js` | the milestones, the agent result, `requestFullAudit()`, `candidateTokens()`, `auditPolicy`, the split report |
| `packages/@stylexjs/babel-plugin/pandamstyle/build.js` | the same split on the full-rebuild path |
| `packages/@stylexjs/babel-plugin/pandamstyle/perf.js` | the Phase C metric names |
| `packages/@stylexjs/babel-plugin/__tests__/pandamstyle/agent-result-test.js` | 32 tests |
| `packages/@stylexjs/babel-plugin/__tests__/pandamstyle/session-helpers.js` | the oracle's two halves |
| `benchmarks/pandamstyle/src/agent-loop.js` | the campaign |
| `benchmarks/pandamstyle/src/agent-loop-summary.js` | the tables |
| `benchmarks/pandamstyle/src/phase-c-oracle.js` | the correctness gate |
| `benchmarks/pandamstyle/src/phase-c-rebuild.js` | the oracle's fresh-rebuild child |
| `benchmarks/pandamstyle/src/report-bytes.js` | the byte audit |
| `tools/pms/test-counts.js` | suite-count integrity |
| `tools/pms/__tests__/` | 19 tests |

Evidence: `agent-loop/c1000-agent-loop-summary.json`,
`agent-loop/c10000-agent-loop-summary.json`,
`agent-loop/c1000-phase-profile.json`,
`agent-loop/c1000-phase-c-oracle.json`,
`agent-loop/c10000-phase-c-oracle.json`,
`metadata/bytes2-*.json` (four documents: both policies, both scales).

The raw observation stream is regenerable and is not committed, like Spike 1–3:
`node src/agent-loop.js --corpus … --out-dir … --iterations 7` reproduces it.

---

## 12. Reproducing

```bash
npm --prefix packages/@pandamstyle/compiler run build

# The harness's own tests.
PMS_AGENT_LOOP_CORPUS=$PWD/.pms-bench/corpora/c100-t100-r10-s101 \
  node benchmarks/pandamstyle/src/agent-loop.js --self-test

# c1000, 7 iterations, all four policies, all twelve scenarios.
node benchmarks/pandamstyle/src/agent-loop.js \
  --corpus $PWD/.pms-bench/corpora/c1000-t1000-r100-s809 \
  --out-dir .pms-bench/run --iterations 7
node benchmarks/pandamstyle/src/agent-loop-summary.js \
  -i .pms-bench/run/c1000-t1000-r100-s809-agent-loop.jsonl \
  -o .pms-bench/run/c1000-summary.json

# c10000, 1 iteration per cell: 48 cells at ~85 s each, about 70 minutes.
node benchmarks/pandamstyle/src/agent-loop.js \
  --corpus $PWD/.pms-bench/corpora/c10000-t1000-r100-s307 \
  --out-dir .pms-bench/run10k --iterations 1

# Correctness, both scales.
node benchmarks/pandamstyle/src/phase-c-oracle.js \
  --corpus $PWD/.pms-bench/corpora/c10000-t1000-r100-s307 \
  --out .pms-bench/run10k/oracle.json

# The byte audit, both policies.
node benchmarks/pandamstyle/src/report-bytes.js \
  --corpus $PWD/.pms-bench/corpora/c10000-t1000-r100-s307 \
  --audit-policy inline --out /tmp/bytes-inline.json
```

**c10000 is one iteration per cell and c1000 is seven**, and the difference is
stated in every table above. c10000 carries the scale; c1000 carries the
distribution. The c10000 medians are single observations and are reported as
such — a median of one is a measurement, not a distribution, and
`agent-loop-summary.js` prints the session count beside every number for exactly
that reason.

**Environment.** One machine, one Node (`v22.22.0`), one filesystem
(`overlay`), warm OS page cache. Every number is a warm-OS-cache number and says
so. Nothing here is a claim about other hardware.
