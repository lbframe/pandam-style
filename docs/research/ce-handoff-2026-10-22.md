# Core evolution (#39): handoff, 2026-10-22

This is the state of the core-evolution epic when the perf host and the CI runners were shut down. Every in-flight change is pushed: as a PR branch, or under `core-evolution/handoff-wip/*`. Nothing below is merged unless it says so.

## Merged on main

- **CE-00 baselines and budgets**
  - Budgets v3 (#122) and v4 (#157). v4 raises the memory floor from 1.10 to 1.15 on three session/full peak-RSS cells, with justified relaxations; CE-12.3 (#76) owns recovery.
  - Record validator in CI (#129, #93); fuzzer invariant (#127, #101).
- **CE-01.1** browser targets (#106, closes #44).
- **CE-01.2** CSS transformation stage (#117, closes #45), with the memory fixes A–D (#136, #130).
- **CE-02.1** property descriptors and project property domains: #126 (A) and #132 (B), which close #46. Epoch record `ce-02.1-5a79a68`. Design note follow-up in #138.
- **Follow-ups:** #94 partial (#125, browser pin), #143 qualification readiness under load (#148).

## Open, in flight

| Item | Branch / PR | State | Next step |
|---|---|---|---|
| CE-02.2 PR A: grammar and numeric domains | #141 (`core-evolution/ce-02.2a-grammar-numeric`) | Approved after its rebase review; CI green | Merge together with PR B once the perf gate passes |
| CE-02.2 PR B: value safety and ownership (closes #47) | #154 at `85230dd` | Approved: S1/S2 fixes, token-value perf memo, incremental verdict-key fix with an incremental-vs-full oracle, weak-key retention fix. CI green | Perf gate under v4: **inconclusive** on `ce-corpus incremental.token-value.toDiagnosticsMs`, 1.248 [1.240, 1.252] against 1.25. Perf round 2 was in progress; its unverified WIP is on `core-evolution/ce-02.2b-perf-wip-handoff` |
| #150 private Babel instance | closed; branch `ce/150-private-babel` | Not adopted. Per-file cache clearing trades the c10000 gain for a c1000 high mode on low core counts | Revisit under CE-12.3 (#76) |
| #134 author identifier length limits | issue | Not started. It follows AG-01.1's `PMS_INVALID_DEFINITION` shape and also bounds echoed values in definition diagnostics | Start after CE-02.2 |
| #147 output lease (symlinked outDir, visible name) | issue | Not started | — |
| #149 host qualification flakes under load | issue | Not started | — |
| #94 archived Chromium runs | issue | Blocked: the archived engine needs an AppArmor profile on the host for its sandbox (a host decision) | — |

## Known risk for the next gates

- The incremental token-value edit on the small workloads (about 2 ms per edit) is the tightest timing cell.
- Every registry-side feature adds to it, because a token-value edit rebuilds the registry. Both CE-02.2 and AG-03.1 (#153) currently land at or over 1.25.
- If per-feature optimizations stop being enough, the structural fix is an incremental registry update for token-value edits. That should be its own issue.

## Process notes

- **Perf gate:** CE-00.3 budgets v4 (`--rev 05c3a33`). One admissible attempt counts, and there is no cherry-picking.
- **Admissibility:** no foreign process at ≥ 50% CPU, 232/232 samples. So no CI may run on the perf host during an attempt: announce the window, hold pushes, and don't mark PRs ready.
- **Closures:** third-party versions are pinned to the CE-02.1 closure; for example `node-releases` stays at 2.0.59 while 2.0.60 is newer upstream.
- **Reviews:** at most 2 rounds plus 1 bounded verification. After that, the orchestrator decides.
