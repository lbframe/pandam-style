# PandamStyle Phase 3 delivery

## Git identity and scope

| Item                                | Result                                                                                                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch                              | `refactor/pandamstyle-phase-3-compiler-2026-10`                                                                                                             |
| Phase 1 base commit / tree          | `034ef24a23ee548e2a5cba46a3fdf1be2b4bfb97` / `3efc60c9fb9e5d41146994fcf04b91e64ef9f684`                                                                     |
| Tested implementation commit / tree | `f48bd4fa46a52a7d1d2ba423900f7a7ce445a0bb` / `266e819a9996ad215d77e26532bfd9ac922e7a30`                                                                     |
| Evidence closure commit / tree      | This document and the evidence are in the closure commit; its exact Git IDs are given in the completion handoff because a commit cannot contain its own ID. |
| Remote head / local match           | The pushed branch tip; verified equal to local HEAD in the completion handoff.                                                                              |
| Working tree                        | Clean after the evidence closure commit.                                                                                                                    |
| `main`                              | `71fcc045b18eb215f0c3a815bb8c8d15a9f99489`, unchanged locally and remotely.                                                                                 |
| Phase 2 checkout                    | Independent branch `feat/pandamstyle-phase-2-core-2026-10`, HEAD `b2b079b84be502dcd65d08a4f09dbe61f5f9a9e2`; left unchanged and clean.                      |
| PR / merge / package publication    | None / none / none.                                                                                                                                         |

The tested-to-final source diff is evidence and delivery documentation only. The
tested commit includes the SDK path-resolution fix and the project-isolation
test; the official verifier ran after that commit.

## 27-module migration

The accepted module map accounts for all 27 compiler modules: **9 MOVE, 17
REFACTOR, 1 MERGE, 0 DELETE, 0 unresolved/unaccounted**. Eight MOVE rows have
been physically re-homed in Phase 3; the selector's move to core is the one
mapped MOVE held as a temporary Phase 2 seam until branch reconciliation. Three
additional package integration files (`bin/pms-build.js`, `rollup.config.mjs`,
and `package.json`) were refactored into `packages/compiler/` as separately
listed by the map.

The old compiler package at `packages/@pandamstyle/compiler/` is absent. It is
not retained as a forwarding package. The authoritative package is
`packages/compiler/`.

The old PandamStyle-shaped directory has only these three integration seams:

| Remaining file     | Reason                                                                                                                            | Removal owner                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `recipe-select.js` | Shared finite selector remains here until the parallel core branch is reconciled.                                                 | Phase 2 moves the shared implementation to `@pandamstyle/core`.   |
| `runtime.js`       | Temporary runtime bridge keeps the current pilot and generated facade working. The compiler `/runtime` subpath is also temporary. | Phase 2 integration; generated modules then import core directly. |
| `vite.js`          | Temporary adapter is used by the existing verifier and pilot; compiler `/vite` is not a permanent target.                         | Phase 8 moves it to `packages/vite`.                              |

No donor tree was deleted and no Phase 4 engine closure was mass-copied into
compiler-owned paths.

## Compiler package and SDK

| Item                          | Result                                                                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package path / name / version | `packages/compiler/` / `@pandamstyle/compiler` / `0.1.0`                                                                                                               |
| Description                   | `PandamStyle compiler and revision-based project service.`                                                                                                             |
| Runtime root exports          | `createProjectSession`, `PmsError`, `Codes`, `formatDiagnostic`, `COMPILER_ABI_VERSION`, `DIAGNOSTICS_RESULT_KIND`, `DIAGNOSTICS_RESULT_SCHEMA_VERSION`                |
| Expected root surface         | The same stable service, error/diagnostic facade, protocol constants, and SDK types.                                                                                   |
| Accidental root exports       | None observed.                                                                                                                                                         |
| `/config` runtime exports     | `defineConfig`, `token`; types include `Definition` and `TokenRef`.                                                                                                    |
| `/host` runtime exports       | `createHostBridge`; types include `HostBridge`, `ArtifactResult`, and `PublicationTicket`.                                                                             |
| SDK types                     | Revision, project config/session, mutation, diagnostic result, publication receipt, candidate query, artifact, and publication ticket types are in `types/index.d.ts`. |

Actual root, `/config`, and `/host` export keys were read from the built package
after the official build. The only extra package subpaths are the explicitly
temporary `/runtime` and `/vite` seams plus `/package.json` metadata.

Neither `createCompilerSession` nor `buildProject` is exported as an alternate
public authority; graph, cache, Babel, CSS-state, and publication internals are
not root exports.

## Project/session authority

`createProjectSession` is the canonical Promise-based API. `projectId` defaults
to the normalized project root unless configured. Every session receives a UUID
`sessionId`; `revisionId` increases within that session. Revision equality
compares the full `(projectId, sessionId, revisionId)` tuple, so equal numeric
revisions from separate sessions are not interchangeable.

The service owns configuration, graph and coverage state, design-system views,
validation, CSS state, diagnostics, and publication. Design-system identity
carries `systemId` and `registryDigest`; the ABI version is `1`. A committed
receipt carries `generationId`, `artifactDigest`, the artifact-origin
`artifactRevision`, and the current `associationRevision`. Invalid revisions
cannot publish; a generation ID is assigned only on successful publication.

One explicit isolation test passes in
[project-api-test.js](../../packages/@stylexjs/babel-plugin/__tests__/pandamstyle/project-api-test.js).
It opens two projects, checks their project/session identities, rejects a
foreign revision, mutates one project, and proves the other project retains its
revision and artifact. The same test found and fixed relative mutation paths
being resolved from process cwd; public mutation paths now resolve from the
project `rootDir`.

## Semantic oracle and Phase 3 gaps

The
[oracle artifact](../../evidence/phase-3-verification/semantic-oracle/semantic-oracle.json)
records 129 cases: 124 `MUST_PRESERVE`, 1 known gap, and 4 deferred cases. It
has 0 failures and 0 unknowns. Applicable results are:

| Comparison              | Passed / applicable | Failures |
| ----------------------- | ------------------: | -------: |
| Fresh vs expected       |           116 / 116 |        0 |
| Incremental vs expected |           124 / 124 |        0 |
| Fresh vs incremental    |           116 / 116 |        0 |

The Phase 1 revision comparisons also pass: 157/157 fresh-vs-expected, 170/170
incremental-vs-expected, and 157/157 fresh-vs-incremental.

| Gap   | Phase 3 status                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------- |
| SG-01 | Resolved; `MUST_PRESERVE`, oracle passes.                                                                     |
| SG-02 | Resolved; `MUST_PRESERVE`, oracle passes.                                                                     |
| SG-03 | Resolved; `MUST_PRESERVE`, oracle passes.                                                                     |
| SG-04 | Resolved; `MUST_PRESERVE`, oracle passes.                                                                     |
| SG-05 | Resolved; `MUST_PRESERVE`, oracle passes.                                                                     |
| SG-06 | Resolved; `MUST_PRESERVE`, oracle passes.                                                                     |
| SG-07 | Resolved; `MUST_PRESERVE`, oracle passes.                                                                     |
| SG-08 | Resolved; `MUST_PRESERVE`, oracle passes.                                                                     |
| SG-09 | Resolved; `MUST_PRESERVE`, oracle passes.                                                                     |
| SG-10 | Resolved; `MUST_PRESERVE`, oracle passes.                                                                     |
| SG-11 | Resolved; `MUST_PRESERVE`, oracle passes.                                                                     |
| SG-12 | Untouched and still a known gap owned by the independent Phase 2 branch. It is not claimed as a Phase 3 pass. |
| SG-13 | Resolved; `MUST_PRESERVE`, oracle passes.                                                                     |

The remaining known mismatch is SG-12 (`props.runtime-malformed`). Deferred
cases are slots, compound variants, patterns, and advanced themes.

## Diagnostics protocol

The public diagnostics document is `pandamstyle-diagnostics-result`, schema
version `1`, compiler ABI `1`. It and each diagnostic bind to a full revision
identity: `projectId`, `sessionId`, and `revisionId`. The envelope also carries
`designSystem.systemId` and `designSystem.registryDigest`. Publication identity
carries `generationId`, artifact-origin revision, association revision, and
artifact digest when publication exists. The historical
`pandamstyle-agent-result` is not the authoritative public protocol.

## Remaining upstream seams

Phase 4 still owns the StyleX-derived engine closure. Direct remaining
dependencies include `@stylexjs/shared@0.19.1` and `@stylexjs/stylex@0.19.1`;
compiler paths also import the donor transform and its shared
create/define-vars/theme helpers, default options, evaluator, AST conversion,
and Babel state manager. These are explicit Phase 4 dependencies, not evidence
that donor closure has been absorbed.

The only Vite adapter seam is
`packages/@stylexjs/babel-plugin/pandamstyle/vite.js`, bundled temporarily at
compiler `/vite` for the current pilot and verifier. Phase 8 owns its
extraction. The Phase 2 selector/runtime seams are described above; no second
compiler runtime or permanent compiler runtime subpath is claimed.

## Warm performance guards

The baseline is the prior optimized D3 c10000 campaign in
[d3-c10000-campaign.jsonl](../../evidence/performance/spike-4/phase-d/d3-c10000-campaign.jsonl)
and
[d3-c10000-publish.jsonl](../../evidence/performance/spike-4/phase-d/d3-c10000-publish.jsonl).
Current raw profiles and environment summaries are in
[performance evidence](../../evidence/phase-3-verification/performance/). Both
runs used Node `v22.22.0`, Linux x64, Ryzen 7 5800X3D, 16 CPUs, and the c10000
corpus family. The profile copy has 10,021 files; 10,020 are byte-identical to
the Phase 2 checkout corpus. The sole adaptation changes the config token import
to the new `/config` subpath. The Phase 2 checkout was read-only.

Latency is the profile's `agent_edit_to_diagnostics_ms`; publication reports
`agent_edit_to_generation_ready_ms` and `agent_edit_to_generation_committed_ms`.
Baseline diagnostic medians use 5 observations; current style/import use 1 each
and re-export/repair/no-change use 3 each. Publication baseline uses 2
observations and current uses 1. These are regression checks, not universal
performance claims.

| Scenario                      | Baseline median |  Phase 3 median | Change | Work shape / assessment                                                                                                                                                                                                                                             |
| ----------------------------- | --------------: | --------------: | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local style edit              |        57.48 ms |  61.98 ms (n=1) |  +7.8% | 1 closure node examined, 10,002 reused; one DSV view reused.                                                                                                                                                                                                        |
| Import edit                   |        21.86 ms |  22.15 ms (n=1) |  +1.3% | 1 closure node examined, 10,002 reused; one DSV view recomputed.                                                                                                                                                                                                    |
| Re-export edit                |        97.61 ms | 105.59 ms (n=3) |  +8.2% | Same 1/10,002 closure counts and 3,334 DSV recomputations as baseline; no full fallback. Phase timing localizes the increase to DSV view derivation (33.37 ms vs 20.86 ms median), not a larger visited set. This measured latency delta is retained in the record. |
| Unresolved import repair      |        70.16 ms |  64.70 ms (n=3) |  -7.8% | 2 closure nodes examined, 1 added, 10,002 reused. DSV examines/recomputes the changed consumer plus the new source (2 vs baseline 1); no full fallback or project-wide closure walk.                                                                                |
| Declared no-change            |        57.80 ms |  60.29 ms (n=3) |  +4.3% | 0 closure nodes examined, 10,003 reused; one DSV view reused, none recomputed.                                                                                                                                                                                      |
| Publication, generation ready |       657.02 ms | 511.50 ms (n=1) | -22.1% | Same one-node closure and one reused DSV view.                                                                                                                                                                                                                      |
| Publication, committed        |       792.73 ms | 633.45 ms (n=1) | -20.1% | Same one-node closure and one reused DSV view.                                                                                                                                                                                                                      |

All 15 profile cells exited successfully with zero harness failures.
Non-publishing profiles report unsupported publication-only metrics by design.
The guards show no full-project closure fallback or increase in closure work;
the re-export DSV latency increase is disclosed above rather than hidden.

## Official verification and phase gate

The
[official verifier summary](../../evidence/phase-3-verification/summary.json)
records `complete: true`, verdict `verified`, and the tested commit/tree above.
Its order was:

1. install
2. build
3. upstream-babel-plugin
4. upstream-stylex
5. pandamstyle
6. semantic-oracle
7. tooling-tests
8. pilot
9. artifacts

All 9 steps passed; `failedSteps` and skipped required steps are empty. Test
totals: 1,824 passed, 0 failed, 64 skipped; suite totals: 93 passed, 0 failed, 1
skipped. The 64 skipped tests and one skipped suite are existing upstream
Babel-plugin skips. The independent semantic-oracle step ran 148 tests in 20
suites.

**PandamStyle Phase 3 is complete.** The PandamStyle-native compiler now lives
under the owned compiler architecture, the stable SDK and project/session
authority match the frozen contracts, all Phase 3 semantic gaps are resolved
against the independent oracle, and the verified incremental architecture
remains intact. Phase 4 may begin only after Phase 2 is also independently
complete and the two branches are reconciled without weakening either phase's
gates.

Phase 2 remains an independent, unqualified parallel branch in this workspace;
its implementation is not claimed complete by this delivery. Therefore **Phase 4
is not yet authorized**. No PR, merge, or package publication was performed.
