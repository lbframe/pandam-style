# Agentic optimizations (epic #4) — handoff snapshot, 2026-10-22

The CI host (sk) and the agent host (kh) were stopped on the owner's request. This branch collects every unmerged
piece of epic #4 work so nothing lives only on those machines. It is a **snapshot, not a release**: nothing here
replaces the review and gate rules of `docs/agent-delivery-protocol.md`. Merge to main only through the individual PRs
below.

## Done (on main)

Closed: #5, #6, #7 (AG-00 baseline frozen), #8 (AG-01.1 operation registry, #131 + #135), #9 (AG-01.2 audit
operations, #140 + #144), #10 (AG-13.1 surface inventory, #139). Also merged: #137 (AG-03.1 design note), #146 (AG-02.1
design note), #145 (CI: docker-test images unique per run + daemon-wide lock). **6 of 33 tasks closed.**

## In flight (not on main)

| Issue | PR | Branch | State | What remains |
|---|---|---|---|---|
| #12 AG-03.1 vocabulary metadata (code) | #153 (draft) | `agentic/ag-03.1-metadata` (a813ebd, reviewed) + `agentic/ag-03.1-metadata-perf-wip` (aa4d5e1: #153 merged with main 8e0145e + the UNTESTED perf work in progress at shutdown) | Review converged (2 Codex rounds + bounded verification). Product perf gate under budgets v4 **failed 109/110**: `ce-corpus incremental.token-value.toDiagnosticsMs` 1.309 vs 1.25 (+0.26 ms per token-value edit; ce-corpus declares no `meta`). | Make metadata cost ≈0 when no `meta` is declared and on rebuilds where `meta` subtrees did not change (skip/lazy semantics build, memoize on a digest of the `meta` inputs). A WIP for this was started (see the perf-wip commit message for what is done/untested). Then: short independent check of the perf diff, perf re-gate by the Core evolution owner, CI, merge. |
| #11 AG-02.1 owner bridge (code, PR 1 of 2) | #155 (draft, base main) | `agentic/ag-02.1-bridge` | 2 Codex rounds + bounded verification. **One surviving block (BV1), awaiting the owner's decision**: on start-up refusal, cleanup removes the runtime directory by path without checking it is still the directory this call created, so a concurrently swapped-in empty directory can be removed. No perf gate needed (published bundles byte-identical). | Owner decision: accept BV1 as residual, or allow one exceptional mini-fix (recommended: drop the cleanup step — the prospective placement check already prevents creating a refused directory — or an identity-checked removal) + bounded check. Then merge main, CI, merge. PR 2 (standalone `session.open`, `discover`) not started. |

## Next tasks once the above land

#13 (AG-03.2, after #12; must plan for manifest schema v3 from CE-02.2), #14–#16 (host owner bridges, after #11;
hosts must declare watch roots outside `rootDir`), #17 (after #11 + #10), #30 (after #9 + others). Critical path:
8 → 12 → 13 → 23 → 24 → 25 → 26 → 29 → 31 → 32 → 33 → 34 → 35 → 37.

## Follow-up issues

#133 (AG-01.1 + inventory delta after CE #156/#150), #142 (AG-03.1 / AG-01.2), #151 (Docker daemon races left after
#145, runner-digest-covered), #120, #108, #102. Core evolution owns #147 (output lease) and #134 (identifier limits).

## Coordination facts to keep

- Product perf gate (CE-00.3, now budgets v4, main 05c3a33) is run by the Core evolution orchestrator on sk in announced
  windows; AG never runs it. During a window: no CI-triggering action (no ready-marking, no push to a non-draft PR);
  draft pushes are fine.
- Session-path PRs must show: reachability test unchanged, bundle bytes, and A/B RSS/heap with medians + IQR and an
  explicit inside/outside-noise verdict.
- The frozen AG-00 baseline gates bind the runner tree digest
  `27092b35d7369e513fe9e78f0044834896869c42b5fee3d5829d9578633b5636`; changes under `benchmarks/agentic/runner/` outside
  the digest-excluded paths need a new baseline.
- Codex review briefs must be written in correctness vocabulary (defect, unusual input, visibility rule); security-attack
  wording gets the request refused.

## About this branch

- It is `main` (8e0145e) + #155 + #153 (a813ebd). Conflicts between #153 and #155 were purely additive (two
  `Codes` entries, test-support exports, CHANGELOG entries) and were resolved as the union of both sides.
- `agentdoc/agentdoc.config.yaml` keeps main + #155's pins; the pins for the files #153 changes are **stale here**
  (they are correct on the #153 branch). The merge commit was made without the lint-staged hook (no `node_modules` in
  the snapshot worktree). No tests were run on this combined branch.
- The untested #153 perf WIP is deliberately **not** merged here; it is only on `agentic/ag-03.1-metadata-perf-wip`.
- The Core evolution epic has its own handoff: branch `core-evolution/handoff-2026-10-22`,
  `docs/research/ce-handoff-2026-10-22.md` (shares the token-value timing-cell risk with #153).
