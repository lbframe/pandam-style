# Phase 4 donor edge inventory after Phase 2 + Phase 3 reconciliation

This is an input inventory, not a Phase 4 implementation. It records every
direct production import/dependency from the owned compiler into `@stylexjs/*`,
`@pandacss/*`, or `packages/@stylexjs/*` at the reconciled tested tree. The
compiler still needs donor engine packages at build time. Generated application
runtime imports core only. Relative import paths below are resolved against
`packages/compiler/`. MOVE/REFACTOR/REWRITE are candidates for Phase 4 review,
not decisions to migrate in this batch.

| # | Caller | Callee/source | Time | Why still required | Target Phase 4 owner domain | Candidate | Protection |
| ---: | --- | --- | --- | --- | --- | --- | --- |
| 1 | `package.json` | `@stylexjs/shared@0.19.1` | build-time dependency | Helpers used by the current StyleX-derived compiler engine and Vite bundle. | `engine/atomic`, `frontend/babel` after reachable closure analysis | REFACTOR | Full PandamStyle and upstream suites, pilot |
| 2 | `package.json` | `@stylexjs/stylex@0.19.1` | build-time dependency | Current engine transform and integration bundle still resolve StyleX internals. | `engine/atomic`, `engine/lowering` | REFACTOR | Upstream StyleX suite, PandamStyle suite, pilot |
| 3 | `src/frontend/babel/evaluate.js` | `packages/@stylexjs/babel-plugin/src/utils/evaluate-path` | build-time source import | Static evaluation of authenticated source expressions. | `frontend/babel` | MOVE | Provenance, forwarding and semantic oracle suites |
| 4 | `src/frontend/babel/plugin.js` | `packages/@stylexjs/babel-plugin/src/utils/state-manager` | build-time source import | Babel traversal and rule metadata state. | `frontend/babel` | REFACTOR | Native compile, diagnostics and provenance suites |
| 5 | `src/frontend/babel/compile-file.js` | `packages/@stylexjs/babel-plugin/src/index` | build-time source import | Legacy transform export is still part of the current compilation bundle. | `frontend/babel`, `engine/atomic` | REFACTOR | Native compile, semantic oracle |
| 6 | `src/project/session/fresh.js` | `packages/@stylexjs/babel-plugin/src/index` | build-time source import | Fresh lane uses the same donor transform as the current engine. | `frontend/babel`, `engine/atomic` | REFACTOR | Fresh/incremental semantic comparisons |
| 7 | `src/project/css-state/index.js` | `packages/@stylexjs/babel-plugin/src/index` | build-time source import | Current incremental CSS state inspects engine output. | `engine/ordering`, `project/css-state` | REFACTOR | Incremental CSS, shared-owner and publication suites |
| 8 | `src/project/session/index.js` | `packages/@stylexjs/babel-plugin/src/index` | build-time source import | Project session currently invokes the engine transform. | `frontend/babel`, `project/session` | REFACTOR | Session, 10k guards, semantic oracle |
| 9 | `src/engine/lowering/styles.js` | `packages/@stylexjs/babel-plugin/src/shared/stylex-create` | build-time source import | Atomic style lowering, hashing and rule emission. | `engine/atomic`, `engine/lowering`, `engine/ordering` | REFACTOR | CSS/cascade, browser and SSR semantic cases |
| 10 | `src/engine/lowering/styles.js` | `packages/@stylexjs/babel-plugin/src/shared/stylex-define-vars` | build-time source import | Stable token variable generation. | `design-system/tokens`, `engine/lowering` | REFACTOR | Token/theme and rename-repair cases |
| 11 | `src/engine/lowering/styles.js` | `packages/@stylexjs/babel-plugin/src/shared/stylex-create-theme` | build-time source import | Theme projection and shared variable identity. | `design-system/themes`, `engine/lowering` | REFACTOR | Theme composition, browser and SSR cases |
| 12 | `src/engine/lowering/styles.js` | `packages/@stylexjs/babel-plugin/src/shared/utils/default-options` | build-time source import | Current engine defaults keep CSS ordering and direction stable. | `engine/ordering` | MOVE | CSS ordering and 10k guards |
| 13 | `rollup.config.mjs` | `packages/@stylexjs/babel-plugin/src/**/*` transpilation include | build-time source closure | Flow donor modules reachable from rows 3–12 must be transpiled. | Same domains as reachable modules | REFACTOR | Compiler build, upstream suites, pilot |
| 14 | `rollup.config.mjs` | `packages/@stylexjs/babel-plugin/pandamstyle/vite.js` | build-time adapter input | Current verifier/pilot need the temporary Vite adapter. | Phase 8 `packages/vite`, outside Phase 4 engine absorption | MOVE in Phase 8 | Vite build suite, packed pilot |

Rows 1–2 also appear in Rollup's `external` array; those declarations represent
the same package edges, not two extra dependencies. Rows 5–8 share the same
callee but are separate production call sites. Row 13 is the build reachability
boundary for donor source: Phase 4 must inventory its recursive useful module
closure before choosing each subsystem's final MOVE/REFACTOR/REWRITE action.
The original donor trees remain in place for this gate.

The `@stylexjs/*` and `@pandacss/*` strings in
`src/frontend/babel/evaluate.js` are **forbidden-import matchers**, not imports
or dependencies. The donor names in comments and historical documentation are
also not production edges. There are no direct production imports of
`@pandacss/*` or `upstream/panda` from the owned compiler. The donor-shaped
`vite.js` is the one remaining PandamStyle adapter seam, explicitly owned by
Phase 8. No generated application JS imports any donor package.

To recheck the direct edge population, scan `packages/compiler/src`,
`packages/compiler/package.json`, `packages/compiler/rollup.config.mjs`, and
the remaining `packages/@stylexjs/babel-plugin/pandamstyle/vite.js` for static
imports, package dependencies, and build inputs. The qualification evidence
contains the raw bounded scan and generated-runtime import counts.
