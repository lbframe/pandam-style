# PandamStyle Phase 7 delivery

Date: 2026-10-01

## Repository and qualification identity

- Branch: `refactor/pandamstyle-phase-7-project-service-2026-10`
- Worktree: `/home/kyle/work/pandam-style-phase-7-project-service-2026-10`
- Base commit/tree: `dd93bd4da211333bacf4c470554e5daab009e84e` /
  `306f083735fca2be5aa84fc03ef5164dd139d8cf`
- Implementation commits:
  - `845f93db5b1aaba43ca53fa1c4e1813c28f8f68a` — Project Service authority,
    lifecycle and qualification coverage.
  - `4e72cf32e498d5f4c3be0a9153c1d9c9aaba1d0a` — preserve unchanged recovered
    generations and release fresh-oracle sessions between revisions.
- Tested commit/tree:
  `4e72cf32e498d5f4c3be0a9153c1d9c9aaba1d0a` /
  `1a2de11b4b1accb454e2ac5702d5c0de074d5e74`.
- The official verifier recorded a clean worktree at the start of qualification.
  Its summary is `evidence/phase-7-project-service/verify/summary.json`.
- Evidence-only closeout commit/tree: this document is part of that evidence-only
  payload. Its exact Git identity is reported in the completion record because
  embedding a commit or tree hash in its own contents would change that hash.
- Remote branch head: verified equal to the local branch head after the
  authorized push; the exact final hash is in the completion record.
- `origin/main` was fetched and verified as
  `71fcc045b18eb215f0c3a815bb8c8d15a9f99489`. It was not changed.
- Final worktree status: clean after the evidence-only commit.

## Production authority

`createProjectSession()` is the sole production project/session lifecycle entry
point. It owns project and session identity, the per-session promise queue,
revision validation, ticket state, watcher handles, output leases, and durable
generation association. `project/session/index.js` remains the internal
incremental algorithm called by that service; it is not package-exported.

The CLI creates one public service session and performs initialize, validate,
audit, compile, and close through it. The watcher journals filesystem evidence
and routes transactions or resync through the same service queue. Agent-facing
diagnostics and candidate queries are revision-bound Project Service
operations. `/host` only projects artifact reads and publication ticket
operations from the supplied service.

The independent fresh compiler remains a test/reference oracle. Private
inspection, benchmarks, and the Vite seam remain qualification-only. There is
no production Vite or Next adapter. The complete authority inventory is in
`docs/architecture/phase-7-authority-inventory.md`.

The reviewed process-wide mutable service registry is the output lease map. It
contains canonical output paths and opaque session IDs, not compiler semantic
state, and is cleared on initialization failure or close. Graph contexts,
overlays, resolution answers, coverage, design-system views, CSS state, and
generated-artifact authentication remain session-owned. Observability state,
the synchronous parse label, and the hard-link capability probe do not decide
semantic validity.

## Public SDK and identity

Runtime ESM exports verified after build:

- Root: `createProjectSession`, `PmsError`, `Codes`, `formatDiagnostic`,
  `COMPILER_ABI_VERSION`, `DIAGNOSTICS_RESULT_KIND`,
  `DIAGNOSTICS_RESULT_SCHEMA_VERSION`.
- `/config`: `defineConfig`, `token`.
- `/host`: `createHostBridge`.

The TypeScript declarations passed a strict no-emit check. The root export does
not expose graph, cache, or mutable session internals. Runtime export evidence
is `evidence/phase-7-project-service/sdk-surface-report.json`.

Every public revision is the full tuple `projectId`, `sessionId`, and
`revisionId`. Bare numeric and foreign revisions reject; accepted mutations
advance monotonically, and superseded results cannot be used for artifact reads,
diagnostics, audits, candidate queries, or publication. A cold reopen creates a
new session ID and does not restore warm compiler caches.

`GenerationId` is independent of `revisionId`. A publication receipt carries
the artifact origin revision, current association revision, and artifact
digest. A byte-identical cold reopen retains the prior generation and artifact
origin while associating it with the new session revision. A changed candidate
publishes a later generation. The corrected lifecycle is covered by the
Project Service cold-reopen test and the consecutive-build byte-identity test.

Publication tickets are bound to one project/session/revision and candidate
digest. They are single-use, rejected across sessions, and revoked by a newer
revision, validation invalidation, abort, close, or failed commit. An injected
host publication failure leaves the prior generation byte-identical and
current.

## Isolation, concurrency, watcher, and resources

- Multi-project isolation covers identical relative paths, distinct output
  directories, same `systemId` with different registry digests, foreign
  revisions and tickets, negative-import isolation, watcher isolation, project
  close independence, and sequential same-project cold reopen. Result: pass.
- Concurrent service calls cover compile + mutation, validate + mutation,
  prepare + mutation, candidate query + close, and watcher flush + explicit
  mutation. The queue gives serialized success, deterministic stale rejection,
  ticket revocation, or closed-session rejection. Result: pass.
- Watcher overflow, lost startup, and unattributable events discard partial
  evidence and fall back to full discovery through the Project Service. A
  process restart does not restore the volatile journal; a fresh service
  session starts with full discovery. Result: pass.
- Close rejects new stateful operations, clears pending watcher events,
  releases output leases and ticket state, and preserves committed output.
  Repeated create/close cycles returned observable resource registrations to
  baseline. Result: pass.

The individual records are under `evidence/phase-7-project-service/`.

## Semantic oracle and official verifier

The independent semantic oracle reported 129 cases: 125 `MUST_PRESERVE`, 0
`KNOWN_GAP`, 4 accepted `DEFERRED`, 0 failed, and 0 unknown. Its 20 suites and
148 harness assertions all passed. The JSON report is
`evidence/phase-7-project-service/semantic-oracle-report.json`.

The official verifier ran every required step on the exact tested commit, in
this order:

1. `install`
2. `build`
3. `pandamstyle`
4. `pandamstyle-core`
5. `semantic-oracle`
6. `tooling-tests`
7. `pilot`
8. `artifacts`
9. `donor-closure`

All 9 required steps completed; verdict `verified`; failed steps 0; skipped
steps 0. Test steps reported 763 passed, 0 failed, 0 skipped across 49 suites.
The tested source worktree was clean when the verifier started.

## Performance guard

The Phase 7 10k profile used the same corpus content hash as the Phase 5
baseline, with three isolated processes per case. Thirty cells produced 1,956
rows and zero failed cells. The Phase 7 p50 diagnostics times were 59.100 ms
(style), 21.574 ms (import), 111.121 ms (re-export), 63.031 ms (unresolved
repair), and 58.959 ms (no change). Publication ready and committed measured
507.407 ms and 629.549 ms. All 40 compared work counters were unchanged; full
fallback stayed at zero.

The latency profile measures the internal incremental-session path, not the
public wrapper. A separate one-sample c10k service profile measured wall times
of 5.164 ms for `applyChanges`, 57.168 ms for `validate`, 115.547 ms for
`host.readArtifact`, 162.387 ms for `preparePublication`, and 605.317 ms for
`commitPrepared`. Queue wait was 0.009–0.012 ms. Commit reused 10,004 files via
hard links, changed two output files, and wrote 4,338 bytes. The service sample
has no wrapper baseline; three latency samples do not provide a confidence
interval, and no causal performance claim is made.

Raw rows, the comparison, and the service profile are in
`evidence/phase-7-project-service/performance/`.

## Phase 6 boundary and scope

No Phase 6-owned implementation files were changed. In particular, the branch
does not touch `packages/compiler/src/design-system/**`,
`packages/compiler/src/artifacts/types/**`, or design-system manifest/catalog
generation. Phase 7's separate integration contract is
`docs/architecture/phase-7-design-system-integration-contract.md`; it defines
the boundary without copying Phase 6 work.

The independent Phase 6 branch was
`feat/pandamstyle-phase-6-canonical-design-system-2026-10` at
`345ff45aed5ad83a3b363633ea60a7c0bc82e283` when checked. Its worktree was clean
and tracking its remote branch. Phase 6 completion is not claimed. Reconcile the
canonical design-artifact and publication boundary before Phase 8/9 acceptance.

No Vite or Next implementation, deferred design-system capability, native
rewrite, main merge, pull request, or package publication is included in this
delivery.

## Verdict

**PandamStyle Phase 7 is complete. The revision-based Project Service is now
the single production authority for project state, graph/coverage validity,
diagnostics, artifact access and publication lifecycle; CLI, watcher and
host-facing operations no longer own alternate semantic truth;
revision/generation/ticket supersession semantics are enforced; and
multi-project/concurrency isolation is verified. Phase 6 remains an independent
parallel workstream, and their shared design-artifact/publication boundary must
be reconciled before later integration phases.**
