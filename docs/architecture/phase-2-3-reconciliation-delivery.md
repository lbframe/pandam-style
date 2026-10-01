# Phase 2 + Phase 3 reconciliation delivery

## Identity and verdict

| Item | Value |
| --- | --- |
| Phase 2 source head / tree | `b2b079b84be502dcd65d08a4f09dbe61f5f9a9e2` / `c947a7e20f826ce45bc3a77bfa38804dfe0abb29` |
| Phase 3 source head / tree | `5fee68e335bdc698ab48dbb80660f83dbe851f96` / `67d5f0cc9870066870fb12663e41eabf46287b98` |
| Branch | `integration/pandamstyle-phase-2-3-reconciliation-2026-10` |
| Tested implementation commit / tree | `fa292c0ec4ea7c14c1c09b34f6bdb4fe4f87ba61` / `a9db412f9ecb61ec00a9c54004dc903010b45449` |
| Evidence-only closure commit / tree | This document's containing commit and tree, reported in the final handoff; a commit cannot contain its own identity. |
| Main | `71fcc045b18eb215f0c3a815bb8c8d15a9f99489`, unchanged. |

The tested commit is clean. Final qualification below ran on that commit, with
the verifier recording the same commit and tree. The closure diff contains only
`evidence/**` and this delivery document. No Phase 4 implementation, donor
tree deletion, main merge, PR, or package publication occurred.

## Ownership and overlap resolution

The final runtime owner is [`packages/core`](../../packages/core),
`@pandamstyle/core@0.1.0`, ABI **1**. Its public root values are `ABI_VERSION`,
`assertAbi`, `props`, `defineRecipeSelector`, and `PmsSelectionError`. Its
runtime dependencies, StyleX/Panda dependencies and Node builtin runtime
imports are all **0**.

The only compiler owner is [`packages/compiler`](../../packages/compiler),
`@pandamstyle/compiler@0.1.0`. Its root exports are `createProjectSession`,
`PmsError`, `Codes`, `formatDiagnostic`, `COMPILER_ABI_VERSION`,
`DIAGNOSTICS_RESULT_KIND`, and `DIAGNOSTICS_RESULT_SCHEMA_VERSION`. `/config`
exports `defineConfig` and `token`; `/host` exports `createHostBridge`. The
old `packages/@pandamstyle/compiler` package is absent. The public compiler
`./runtime` export and its bundle are absent.

The old donor-shaped `runtime.js` and `recipe-select.js` are deleted. ABI
conversion is owned by `packages/compiler/src/artifacts/javascript/refs.js`;
runtime composition and finite recipe selection are in core. The only
remaining donor-shaped PandamStyle integration file is `vite.js`, used by the
current verifier and pilot until the Phase 8 adapter migration. It is not a
final Vite architecture. The [overlap matrix](phase-2-3-reconciliation.md)
records Phase 2 intent, Phase 3 intent, integrated resolution and evidence for
every named overlap.

The generated valid fixture has **5** `@pandamstyle/core` imports and **0**
`@stylexjs/*`, `@pandacss/*` or `@pandamstyle/compiler/runtime` imports across
six generated JavaScript files. The official verifier checks these counts in
[`generated-runtime-imports.json`](../../evidence/phase-2-3-reconciliation/verify/artifacts/generated-runtime-imports.json).

## Semantic and package proof

The [semantic oracle](../../evidence/phase-2-3-reconciliation/verify/semantic-oracle/semantic-oracle.json)
reports **129 total / 125 MUST_PRESERVE / 0 KNOWN_GAP / 4 DEFERRED / 0 failed /
0 unknown**. SG-01, SG-02, SG-03, SG-04, SG-05, SG-06, SG-07, SG-08, SG-09,
SG-10, SG-11 and SG-13 were resolved in Phase 3. SG-12 was resolved in Phase 2.
The frozen targets and case population were retained. The only deferred cases
are slots, compounds, patterns and advanced themes.

The [external packed-core proof](../../evidence/phase-2-3-reconciliation/verify/core-package-proof/proof.json)
passes `npm pack`, a clean install outside the workspace, dependency graph
inspection and runtime checks. `workspaceLeakage=false`; donor dependency
counts and Node builtin imports are zero. Composition and recipe selection
pass. Malformed refs raise `PMS_UNVERIFIED_PROPS_SOURCE`; unsupported ABI
raises `PMS_ABI_MISMATCH`.

The [project isolation proof](../../evidence/phase-2-3-reconciliation/project-isolation/proof.json)
passes with two project roots containing the same `src/page.js` relative path.
Sessions have distinct identities, a foreign revision is rejected, a
rootDir-relative mutation changes only the left project's artifact, and the
right project's artifact and revision remain unchanged. The official
PandamStyle suite also runs the full project API test file.

## 10k performance guards

The [performance report](../../evidence/phase-2-3-reconciliation/performance/report.json)
contains eight successful profile cells and 481 raw metric rows, with no
harness failures, no unexpected whole-project fallback, no increased closure
work and no semantic verdict failures. All five diagnostic scenarios use the
same 10k corpus family; publication uses the same corpus. The profile copy
repairs 33 invalid recipe defaults in one design-system definition file so
core ABI v1 can validate it; no component or graph path was removed. This
[adaptation](../../evidence/phase-2-3-reconciliation/performance/corpus-adaptation.json)
limits exact latency comparability with Phase 3. Two earlier failed harness
attempts are retained under `performance/invalid-run/` and excluded from
measurements.

| Scenario | Reconciled latency | Phase 3 | Closure examined / reused | DSV recomputed |
| --- | ---: | ---: | ---: | ---: |
| Local style edit | 56.87 ms | 61.98 ms | 1 / 10,002 | 0 |
| Import edit | 37.63 ms | 22.15 ms | 1 / 10,002 | 1 |
| Re-export edit, median of 3 | 104.34 ms | 105.59 ms | 1 / 10,002 | 3,334 |
| Unresolved repair | 66.13 ms | 64.70 ms | 2 / 10,002 | 2 |
| Declared no-change | 58.56 ms | 60.29 ms | 0 / 10,003 | 0 |
| Publication, generation ready | 476.84 ms | 511.50 ms | 1 / 10,002 | 0 |
| Publication, committed | 592.52 ms | 633.45 ms | 1 / 10,002 | 0 |

The import-edit latency is 69.9% above its single Phase 3 observation. Its
closure and DSV counts are unchanged, and this campaign also has one
observation for that scenario; this is a measured limitation, not a claim of
latency parity. Re-export median is **1.2% lower** than Phase 3, with its
closure and DSV counts unchanged.

## Official verifier and remaining donor edges

The [official summary](../../evidence/phase-2-3-reconciliation/verify/summary.json)
records ten required steps in order: install, build, upstream-babel-plugin,
upstream-stylex, pandamstyle, pandamstyle-core, semantic-oracle,
tooling-tests, pilot, artifacts. All execute and pass: `complete=true`,
`verdict=verified`, `failedSteps=[]`, `skippedSteps=[]`. Counts are **1,837
passed tests / 94 passed suites / 0 failures**. The 64 skipped tests and one
skipped suite are inherited upstream Babel-plugin skips, not skipped verifier
steps. The raw per-step logs and pilot result are in the evidence directory.

The compiler still has **14 direct donor boundary edges** in the
[Phase 4 inventory](phase-4-donor-edge-inventory.md): 13 engine/dependency
edges for Phase 4 and one temporary Vite adapter input for Phase 8. Its
remaining donor package dependencies are `@stylexjs/shared@0.19.1` and
`@stylexjs/stylex@0.19.1`; the other direct source edges target donor Babel
transform, evaluator, state manager, atomic lowering, variables, themes and
default options. There is no direct owned-compiler production import of
`@pandacss/*` or `upstream/panda`. This does not claim the compiler is
donor-free. The [raw scan](../../evidence/phase-2-3-reconciliation/donor-edges/direct-scan.txt)
and the inventory distinguish imports from forbidden-import matchers and
comments.

**Phase 2: CLOSED. Phase 3: CLOSED. Phase 2+3 reconciliation: CLOSED after
evidence-only closure push and remote equality. Phase 4: AUTHORIZED at that
point.**
