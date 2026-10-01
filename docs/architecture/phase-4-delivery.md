# PandamStyle Phase 4 delivery

## Result

Phase 4 is complete. The compiler behavior required by PandamStyle is owned
inside `packages/compiler`; `@pandamstyle/core` and `@pandamstyle/compiler` have
zero production dependencies or imports from StyleX/Panda CSS-library packages,
and the verified packed dependency closure contains no donor package. The
physical donor trees remain present for Phase 5.

## Commit and branch record

| Field                             | Value                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Branch                            | `refactor/pandamstyle-phase-4-engine-absorption-2026-10`                                                                                                                             |
| Base commit                       | `902f4e89cb11faae54fa02bb4883e5e05159454a`                                                                                                                                           |
| Base tree                         | `a32339cac578f50142156734811d78492f538243`                                                                                                                                           |
| Implementation commits            | `a9a4346e28ef12bf7f8775550502cbe101b4b16d`, `6aaa5a1d83f7753a50e482e2bcb723960e481005`, `7b6b58ee2a430d8495a2acbed67fb631fc43f577`                                                   |
| Tested commit                     | `7b6b58ee2a430d8495a2acbed67fb631fc43f577`                                                                                                                                           |
| Tested tree                       | `2459745ffd057f10bd567ee4dadd6805534eddf7`                                                                                                                                           |
| Evidence-only closure commit/tree | This final evidence-only commit, resolved by the branch `HEAD` and `HEAD^{tree}`; its object IDs are included in the handoff summary because a Git object cannot embed its own hash. |
| Remote head / remote equals local | `origin/refactor/pandamstyle-phase-4-engine-absorption-2026-10`; verified equal to local `HEAD` after push.                                                                          |
| Working tree                      | Clean after the evidence-only commit and push.                                                                                                                                       |
| `main`                            | `71fcc045b18eb215f0c3a815bb8c8d15a9f99489`, unchanged.                                                                                                                               |
| PR / merge / package publication  | None.                                                                                                                                                                                |

The tested commit was qualified from a clean tree. The only changes after it are
this delivery record and files under
[`evidence/phase-4-engine-absorption/`](../../evidence/phase-4-engine-absorption/).

## Reachability and ownership

The initial donor inventory contained 14 direct edges: 13 Phase 4 engine edges
and one temporary Vite qualification seam. The recursive pre-absorption walk
covered 103 source modules: 84 under `packages/@stylexjs/` and 19 in
`packages/style-value-parser/`. The compiler now owns the 48 required modules:
40 StyleX-derived modules and eight media-query parser modules. The other 55
source modules were unneeded and were not copied. One StyleX `package.json` is
resolution metadata, separate from the source-module count.

The retained-module decisions are 14 **MOVE**, 31 **REFACTOR**, and 3
**REWRITE**. The per-module rationale, donor origin/revision, accepted behavior,
and target are in the
[`engine absorption map`](phase-4-engine-absorption-map.md) and
[`derived-source provenance record`](phase-4-derived-source-provenance.md).

Owned targets include:

- `packages/compiler/src/frontend/babel/static-evaluator.js`,
  `static-evaluation-errors.js`, and `pass-state.js` for static evaluation and
  per-pass state;
- `packages/compiler/src/engine/index.js` as the owned engine entry;
- `packages/compiler/src/engine/atomic/**` for atomic style lowering;
- `packages/compiler/src/engine/ordering/**`, including the selected media-query
  parser closure;
- `packages/compiler/src/engine/lowering/styles.js`;
- `packages/compiler/src/design-system/tokens/**` and
  `packages/compiler/src/design-system/themes/lowering.js`;
- `tools/pms/donor-closure.js` and `tools/pms/module-imports.js` for the
  fail-closed production and package-closure verifier.

No wholesale donor package copy was made. The compiler Rollup graph now builds
only owned compiler code and legitimate infrastructure dependencies.

## Donor closure and package proof

| Surface                                             | Donor dependencies/imports |
| --------------------------------------------------- | -------------------------: |
| `@pandamstyle/core` manifest and production source  |                          0 |
| `@pandamstyle/compiler` `@stylexjs/*` dependencies  |                          0 |
| `@pandamstyle/compiler` `@pandacss/*` dependencies  |                          0 |
| Compiler production imports into donor engine paths |                          0 |
| Compiler Rollup watched donor source files          |       0 in all four graphs |
| Built compiler donor specifiers                     |  0 across four built files |
| Packed core/compiler donor dependencies or imports  |                          0 |
| Generated application runtime donor imports         |                          0 |
| Installed donor packages / workspace leakage        |             `[]` / `false` |
| Remaining production donor engine edges             |                      **0** |

The packed installed dependency graph is complete. The machine-readable proof is
in
[`packed-package-proof.json`](../../evidence/phase-4-engine-absorption/packed-package-proof.json),
the artifact import scan is in
[`built-artifact-donor-scan.json`](../../evidence/phase-4-engine-absorption/built-artifact-donor-scan.json),
and the full fail-closed scan is in
[`verify/donor-closure/report.json`](../../evidence/phase-4-engine-absorption/verify/donor-closure/report.json).

## Semantic, browser, and project acceptance

The semantic oracle remains at 129 cases: 125 `MUST_PRESERVE`, zero `KNOWN_GAP`,
four accepted `DEFERRED`, zero failed, and zero unknown. All 125 incremental
comparisons passed; the 117 applicable fresh checks and fresh-to-incremental
comparisons also passed. The four deferred features remain slots, compound
variants, patterns, and advanced themes.

All six browser cases passed in fresh and incremental mode, including computed
style, cascade, theme-scope, and SSR/hydration cases. Project isolation passed:
two sessions had distinct project/session identities, cross-project revision use
was rejected, and changing one project's artifact left the other project's
artifact and current revision unchanged. Incremental CSS, negative resolution,
transactional publication, and diagnostics protocol cases all passed in the
oracle. See
[`browser-ssr-evidence.json`](../../evidence/phase-4-engine-absorption/browser-ssr-evidence.json),
[`project-isolation-evidence.json`](../../evidence/phase-4-engine-absorption/project-isolation-evidence.json),
and the full semantic report under
[`verify/semantic-oracle/`](../../evidence/phase-4-engine-absorption/verify/semantic-oracle/).

## Performance qualification

The same harness (`pms-agent-loop-harness/1.0.0`), warm-process policy, variant,
Node `v22.22.0`, Linux x64, AMD Ryzen 7 5800X3D, 16 CPUs, and corpus
`c10000-t1000-r100-s307-reconciliation` (10,021 files) were used for the
pre-absorption baseline and tested engine. There were three measured sessions
per cell. The harness discards its warmup revision; the table reports the median
`agent_edit_to_diagnostics_ms` or publication milestone. The baseline raw rows
do not record a commit SHA. No confidence intervals were computed.

| Workload                          | Baseline p50 | Tested p50 |  Change |
| --------------------------------- | -----------: | ---------: | ------: |
| Style edit, existing atoms        |     58.70 ms |   70.12 ms | +19.45% |
| Import change                     |     22.16 ms |   20.92 ms |  -5.58% |
| Re-export change                  |    109.09 ms |  114.98 ms |  +5.40% |
| Unresolved import                 |     21.28 ms |   21.05 ms |  -1.11% |
| Unresolved import repaired        |     61.75 ms |   76.94 ms | +24.59% |
| No-change revision                |     58.68 ms |   67.29 ms | +14.67% |
| Publication: generation ready     |    497.56 ms |  619.38 ms | +24.48% |
| Publication: generation committed |    617.50 ms |  751.00 ms | +21.62% |

These measured latency regressions are reported as-is; the three-session sample
is small and does not support a confidence claim. The compared work shape
medians are unchanged across the measured scenarios, and fallback was zero in
all baseline and tested observations. The full comparison, including diagnostic
dispatch latency, counters, p95 upper-rank values, and raw baseline and tested
observations, is in
[`performance/comparison.json`](../../evidence/phase-4-engine-absorption/performance/comparison.json).

## Official qualification

[`verify/summary.json`](../../evidence/phase-4-engine-absorption/verify/summary.json)
records a complete `verified` result from these 11 required steps, in order:

1. `install`
2. `build`
3. `upstream-babel-plugin`
4. `upstream-stylex`
5. `pandamstyle`
6. `pandamstyle-core`
7. `semantic-oracle`
8. `tooling-tests`
9. `pilot`
10. `artifacts`
11. `donor-closure`

All 11 passed; `failedSteps` and `skippedSteps` are empty. The run reported
1,844 tests passed, zero failed, and 64 skipped, across 94 passed suites, zero
failed suites, and one skipped suite. The individual test skips are recorded by
the upstream Babel plugin suite. Donor closure returned zero findings.

An additional, non-gating root `npm run flow` check reported 25 Flow errors in
unchanged donor sources (`packages/@stylexjs/babel-plugin/src/index.js` and
`packages/@stylexjs/babel-plugin/src/shared/stylex-create.js`). No owned
`packages/compiler` source error remained. Flow is not one of the 11 official
Phase 4 steps.

## Vite seam and Phase 5 readiness

The temporary seam is `tools/pilot/vite-seam.js`. It is private pilot
qualification support, is not a public package export or compiler Rollup input,
and does not implement Phase 8. Public Vite support remains Phase 8 work.

No donor tree was physically deleted or archived. `packages/@stylexjs/` and
`packages/style-value-parser/` remain for the upstream reference suites;
`upstream/stylex/` is absent, and `upstream/panda/` remains comparison source.
No legacy/archive tree was introduced. Phase 13/native rewrite was not started.

The [`Phase 5 deletion-readiness record`](phase-5-deletion-readiness.md)
identifies no unresolved semantic migration blocker, so Phase 5 is authorized to
begin. Its physical-cleanup work still needs to relocate PandamStyle tests and
fixtures/helpers from the donor tree, retarget Jest/workspace/verifier
references, retain owned guards for required behavior, and reconcile license and
provenance references. **Deletion-ready: yes as a Phase 5 workstream; no
physical deletion was started here.** Phase 8 and Phase 13 remain untouched.

## Final gate

Phase 4 is complete. Phase 5 is authorized. There is no PR, merge, or package
publication.
