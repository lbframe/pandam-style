# Phase 4 donor edge inventory after absorption

## Closure result

The reconciled input inventory had **14 direct donor boundary edges**: 13
engine/dependency edges assigned to Phase 4 and one temporary Vite qualification
input assigned to Phase 8. Phase 4 moved the Vite seam to
`tools/pilot/vite-seam.js` and removed the 13 engine edges from the owned
compiler.

| Production surface | `@stylexjs/*` | `@pandacss/*` | Donor source paths | Evidence |
| --- | ---: | ---: | ---: | --- |
| `packages/core` manifest and source | 0 | 0 | 0 | `donor-closure/report.json` |
| `packages/compiler` manifest and source | 0 | 0 | 0 | `donor-closure/report.json` |
| Compiler Rollup production graph | 0 | 0 | 0 | Four compiler entry graphs, no donor watch files or emitted specifiers |
| Built compiler artifacts | 0 | 0 | 0 | Structural import scan of `packages/compiler/lib` |
| Generated application runtime | 0 | 0 | 0 | Structural import scan of the generated fixture runtime |
| Packed core/compiler packages and installed dependency graph | 0 | 0 | 0 | Tarball manifests, packed JS, installed graph; `workspaceLeakage: false` |

The production donor engine edge count is **0**. This is a source/build/package
closure statement, not a claim that donor source has been deleted.

## Reachable source closure

The pre-edit source-root walk recorded 84 reachable donor JavaScript modules and
one StyleX package manifest used for resolution metadata. The independent
pre-edit Rollup watch graph recorded 74 donor source modules and that package
manifest. The full path list and disposition decisions are in
[`phase-4-engine-absorption-map.md`](phase-4-engine-absorption-map.md).

Of the 84 modules under `packages/@stylexjs/`, 40 have retained PandamStyle
behavior with an explicit MOVE, REFACTOR, or REWRITE mapping; the remaining 44
are outside the supported engine contract and were not copied. The recursive
workspace parser entry adds 19 source modules: 8 required media-query modules
were absorbed and 11 unrelated property-parser modules were excluded. Across
both closures, 103 source modules were mapped: 48 retained and 55 excluded.
The StyleX package manifest was resolution metadata, not a source module; its
compiler dependency was removed. No donor package was copied wholesale.

## Remaining donor-tree uses

These references remain outside the `@pandamstyle/core` and
`@pandamstyle/compiler` production graphs:

| Use | Paths / owner | Phase 5 disposition |
| --- | --- | --- |
| Upstream StyleX reference implementation and package family | `packages/@stylexjs/{atoms,babel-plugin,cli,create-stylex-app,devtools-extension,eslint-plugin,postcss-plugin,rollup-plugin,shared,stylex,unplugin}` | Keep through Phase 4 upstream reference suites; delete only after preserving any still-required upstream comparison tests. |
| StyleX media-query parser workspace package | `packages/style-value-parser/`; after absorption only `packages/@stylexjs/babel-plugin` still imports its package entry | The compiler owns the eight-module parser closure. Keep the package for the Phase 4 upstream suite; review its workspace/tests when Phase 5 removes the donor plugin. |
| PandamStyle integration tests and fixture projects | `packages/@stylexjs/babel-plugin/__tests__/pandamstyle/` | Relocate the product tests and fixtures into a PandamStyle-owned test location before deleting the donor Babel plugin package. The Phase 4 engine protection now also lives in `packages/compiler/__tests__/engine-absorption-test.js`. |
| Test and oracle helpers that address the PandamStyle test tree | `tools/pms/collect-regression-cases.js`, `tools/pms/forwarding-semantic-oracle.js`, `tools/pms/forwarding-warm-guard.js`, `tools/pms/__tests__/jest-config-test.js`, `tools/pms/__tests__/tooling-verification-test.js`, and `verify-pms.sh` | Retarget when the product test tree moves; retain reference suites until their Phase 5 migration decision is recorded. |
| Qualification-only Vite seam | `tools/pilot/vite-seam.js`, loaded by `pilot/vite-react/vite.config.js` through `PMS_VITE_SEAM_PATH` | Remains a test/pilot helper. It is not a compiler input/export or public package; Phase 8 still owns product Vite support. |
| Legal attribution and source provenance | MIT headers on moved/refactored code; donor `LICENSE` files; `upstream/README.md`; `docs/architecture/phase-4-derived-source-provenance.md`; existing source maps | Preserve required notices and provenance before removing the corresponding donor trees. |
| Historical evidence and documentation | `evidence/**`, `docs/**`, `benchmarks/pandamstyle/src/generate-corpus.js`, and donor-tree comments | Historical records and comparison paths; classify before any broad text cleanup. |
| Vendored Panda reference source | `upstream/panda/` | No Phase 4 production import or dependency. Retain until Phase 5 verifies all recorded comparison/provenance uses and licensing. |

`upstream/stylex/` is not present in the Phase 4 starting tree; the StyleX fork
is stored under `packages/@stylexjs/*` with the separate
`packages/style-value-parser/` workspace package. Phase 4 did not remove or
relocate those trees, aside from moving the qualification-only Vite adapter.

The donor names in `packages/compiler/src/frontend/babel/evaluate.js` are
forbidden-import matcher values. The verifier parses module syntax and package
manifests, so matcher strings, comments, license text, fixture text, and
historical documentation do not create production edges.
