# Phase 5 delivery: donor and legacy repository cleanup

## Delivery state

| Item | Result |
| --- | --- |
| Branch | `chore/pandamstyle-phase-5-donor-cleanup-2026-10` |
| Base commit / tree | `44bbdb4c323cfaae9abc69f524d4fc8b5ceb4133` / `7bcda6007bb012574a5f5ffb3b43836553692e1e` |
| Implementation commits | `23ef9f4b`, `b4e72bb8`, `e90e3b21`, `844439a0`, `61f932b6`, `5b8baf82`, `85bb4e83`, `82a5d1d0`, `cf2a1403` |
| Tested commit / tree | `cf2a1403ed6e651fdc23c950a40b4d639c504ef5` / `aedce15ebfc9a2d0ca33f9e8ab7e6c6404c03478` |
| Evidence-only final commit / tree | This document's containing commit and its root tree. Their literal object IDs are reported in the final execution record; embedding either object's own ID in its tree would be self-referential. The only post-test changes are under `evidence/` and this delivery document. |
| Remote head | Verified after push to equal the local branch tip; the final execution record carries the literal head SHA. |
| Working tree | Clean after the evidence-only commit and push. |
| `main` | Remains `71fcc045b18eb215f0c3a815bb8c8d15a9f99489`. |

No pull request was opened, no merge was performed, and no package was published.

## Deleted structure and migrated tests

The tested tree physically removes `packages/@stylexjs/`, `packages/style-value-parser/`, `upstream/stylex/`, and `upstream/panda/`. All 13 forbidden donor, vendor, legacy, archive, and reference paths in [repository-tree.json](../../evidence/phase-5-donor-cleanup/repository-tree.json) are absent. No donor source tree was archived.

The complete PandamStyle test inventory moved from `packages/@stylexjs/babel-plugin/__tests__/pandamstyle/` to `packages/compiler/__tests__/pandamstyle/`: 22 test files, 2 helpers, and 84 fixture files (108 mapped entries), with 0 unmigrated tests. The owned migration suite plus engine absorption regressions passed: 23 suites and 510 tests. See the [inventory](../../evidence/phase-5-donor-cleanup/test-migration/inventory.json) and [migration result](../../evidence/phase-5-donor-cleanup/test-migration/result.json).

The donor reference suite's retained behavior was grouped into six categories and covered by PandamStyle-owned compiler/core tests and the semantic oracle. Three out-of-contract categories were deliberately discarded: donor DOM injection and StyleX-only runtime behavior, standalone StyleX APIs, and unused donor Babel transforms/tests. The two upstream verifier steps were removed from the required contract; they are neither run nor skipped. The category counts and rationale are recorded in the migration result and [deletion map](phase-5-deletion-map.md).

## Workspace, tooling, and provenance

The root remains the private `pandamstyle-workspace`; its only workspaces are `packages/core` (`@pandamstyle/core`) and `packages/compiler` (`@pandamstyle/compiler`). `yarn.lock` was regenerated through the Yarn 1 workspace install workflow. A detached clean Git worktree at the tested commit passed `yarn install --frozen-lockfile --non-interactive`, build, and the complete verifier. The lockfile digest and clean-install details are in [clean-install.json](../../evidence/phase-5-donor-cleanup/clean-install.json).

CI continues to run the owned verifier, Flow, lint, and Prettier checks. Donor build/reference steps, the donor benchmark workflow, and generic workspace release machinery were removed. `tools/pilot/vite-seam.js` remains a private qualification tool for the packed Vite pilot; it is not a compiler export or a public Vite package. Phase 8 Vite work, Next support, and native rewrites were not started.

`ATTRIBUTIONS.md`, `LICENSES/PANDA-MIT-LICENSE.md`, the Phase 4 derived-source map, and the engine absorption map preserve origin and license records. The StyleX origin remains recorded as version `0.19.1`, commit `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`. The Panda comparison source remains commit `1a310482ff18102c44b2a478b7644b064a80d7c6`; the separate historical Panda v2 reference remains `c171f630adc6dec4a1f9e4b9a79ef706d8278aae`. The retained Panda MIT text has SHA-256 `94fac7d7284588389b95e9f06583d3569c9f774ed597f8750dded1df3586d801`, matching the Phase 4 base source. These records describe provenance and do not make a legal conclusion; see [legal-provenance-scan.json](../../evidence/phase-5-donor-cleanup/legal-provenance-scan.json).

## Package and behavior qualification

Both public packages have zero `@stylexjs/*` and `@pandacss/*` dependencies or imports. Compiler Rollup graphs contain no donor source files; built and generated runtime scans show no donor specifiers. Core and compiler tarballs were installed into external temporary consumers: workspace leakage is `false`, the installed graph contains 0 donor packages, and the tarballs contain no donor tree. Compiler root, `/config`, and `/host` exports load; the packed core runtime and generated runtime's core imports load. See [package-closure.json](../../evidence/phase-5-donor-cleanup/package-closure.json), the full [donor-closure report](../../evidence/phase-5-donor-cleanup/verify/donor-closure/report.json), and [pilot log](../../evidence/phase-5-donor-cleanup/verify/pilot.log).

The semantic oracle remains at 129 cases: 125 `MUST_PRESERVE`, 0 `KNOWN_GAP`, 4 `DEFERRED`, 0 failed, and 0 unknown. All six browser cases passed fresh, incremental, and differential comparisons, including computed styles and SSR/hydration. The explicit project isolation test passed. Incremental CSS, negative resolution, publication rollback, generation/revision identity, and diagnostics protocol v1 are covered by the passing owned suites and oracle. Results are available in the [oracle report](../../evidence/phase-5-donor-cleanup/verify/semantic-oracle/semantic-oracle.json), [browser/SSR result](../../evidence/phase-5-donor-cleanup/browser-ssr.json), and [project isolation result](../../evidence/phase-5-donor-cleanup/project-isolation.json).

## Performance guard

The 10k guard compares this tested commit with the exact Phase 4 tested commit `7b6b58ee2a430d8495a2acbed67fb631fc43f577` (tree `2459745ffd057f10bd567ee4dadd6805534eddf7`). Each cell has three measured sessions after a discarded warm-up. The 10,020-source-file corpus manifest is included in the evidence. Latency is mixed, so these measurements do not establish an overall performance gain.

| Scenario / metric | Phase 4 p50 (ms) | Phase 5 p50 (ms) | Change |
| --- | ---: | ---: | ---: |
| Style edit to diagnostics | 70.121 | 65.617 | -6.42% |
| Import change to diagnostics | 20.919 | 31.859 | +52.30% |
| Re-export change to diagnostics | 114.983 | 113.372 | -1.40% |
| Unresolved import to diagnostics | 21.046 | 20.803 | -1.15% |
| Unresolved import repaired to diagnostics | 76.935 | 77.018 | +0.11% |
| No-change to diagnostics | 67.287 | 61.618 | -8.43% |
| Publication ready | 619.375 | 563.465 | -9.03% |
| Publication committed | 750.997 | 700.908 | -6.67% |

All 96 work-shape counter comparisons match Phase 4; no counter changed, including closure work, reuse, or full fallback. There were 0 nonzero full fallbacks across 18 diagnostics observations and 3 publication observations; both runs had 0 errors. See [performance comparison](../../evidence/phase-5-donor-cleanup/performance/comparison.json) and the raw observations.

## Verifier and static checks

The clean-checkout official verifier completed all nine required steps in order:

`install → build → pandamstyle → pandamstyle-core → semantic-oracle → tooling-tests → pilot → artifacts → donor-closure`.

The verdict is `verified`: 9/9 steps, 0 omitted, 0 failed, 0 skipped; 753 tests and 49 suites passed, with 0 failures or skips. Donor closure reports 0 findings and 0 production donor-engine edges. Flow reported no errors; ESLint and Prettier passed; the benchmark harness passed all 35 tests. The complete [verifier summary](../../evidence/phase-5-donor-cleanup/verify/summary.json), step logs, and [static-check results](../../evidence/phase-5-donor-cleanup/static/results.json) are retained.

## Phase status

All Phase 5 exit gates pass. **Phase 5 is closed. Phase 6 and Phase 7 are authorized** to proceed in controlled parallel under the canonical master plan. Phase 6 and Phase 7 work has not started. The branch is pushed; after push, remote and local heads match. `main` is unchanged.
