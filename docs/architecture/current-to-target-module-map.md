# Current-to-target compiler module map

Status: Phase 3 migration checklist candidate pending canonical master-plan
reconciliation. Baseline commit `d49a7eabf6a6df4eda44cc405f6824158fafd4be`, tree
`3500c2a1c3273d6c840fc6eba757524e1ff78e99`. Inventory from tracked source, not
an assumed greenfield decomposition. No source is moved in Phase 0.

## Inventory boundary and actions

The 27 files below are every current module in
`packages/@stylexjs/babel-plugin/pandamstyle/`. Current path in the table is
relative to that exact prefix; every row names an individual file, with no
wildcard mapping. There are 27 mapped, zero unmapped within this inventory.
Three current compiler package integration files are mapped separately. Donor
engine closure is a different inventory, not silently included in the 27 count.

KEEP means responsibility retained at the named destination; MOVE means behavior
preserved while source ownership changes; REFACTOR splits internal
responsibilities without a semantic rewrite; MERGE removes duplicate assembly in
favor of the specified owner; DELETE removes a surface only after useful
behavior/tests are accounted for. All production-source destinations are final,
not legacy copies. Test-only visibility never means deleting a failing test.
Test seams must remain available to the independent oracle without being
published SDK.

| Current path      | Current responsibility                                                               | Target domain/path                                                                                                                                                                     | Future visibility                                                      | Action   |
| ----------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------- |
| agent-result.js   | Compact result, structured repair, coverage/build metadata                           | packages/compiler/src/protocol/diagnostics-result.js and artifacts/metadata/audit.js                                                                                                   | INTERNAL (schemas/types public via api)                                | REFACTOR |
| babel-plugin.js   | Original-syntax pass, role/channel validation and transforms                         | packages/compiler/src/frontend/babel/plugin.js; semantics/conformance/channels.js                                                                                                      | INTERNAL                                                               | REFACTOR |
| build.js          | Fresh build driver, per-file compilation, coverage, alternate compiler session       | packages/compiler/src/api/cli.js; frontend/babel/compile-file.js; project/session/fresh.js                                                                                             | INTERNAL (CLI via stable service)                                      | REFACTOR |
| codegen.js        | Generated facade and finite recipe data/markers                                      | packages/compiler/src/artifacts/javascript/design-module.js                                                                                                                            | INTERNAL                                                               | MOVE     |
| compiler.js       | Token/theme lowering, style policy, condition normalization and CSS rendering        | packages/compiler/src/design-system/tokens/compile.js; themes/compile.js; conditions/normalize.js; semantics/conformance/values.js; engine/lowering/styles.js; artifacts/css/render.js | INTERNAL                                                               | REFACTOR |
| conformance.js    | Educational design-system fixture, not shipped theme                                 | tests/fixtures/design-systems/conformance.js                                                                                                                                           | TEST ONLY                                                              | MOVE     |
| coverage-graph.js | Persistent compact coverage graph/closure, independent verify oracle                 | packages/compiler/src/project/graph/coverage.js; tests/oracles/coverage.js                                                                                                             | INTERNAL; verification helper TEST ONLY                                | REFACTOR |
| css-state.js      | Rule ownership/refcounts/order and incremental CSS state                             | packages/compiler/src/project/css-state/index.js                                                                                                                                       | INTERNAL                                                               | MOVE     |
| diagnostics.js    | Codes, base diagnostic/error and human formatter                                     | packages/compiler/src/protocol/diagnostics.js; packages/core/src/selection-error.js (minimal runtime subset)                                                                           | INTERNAL implementations; PUBLIC named facade/type exports             | REFACTOR |
| dirty-input.js    | Normalize transactions, dirty modes and providers                                    | packages/compiler/src/project/mutations/transaction.js; providers.js                                                                                                                   | INTERNAL; public transaction types via api                             | REFACTOR |
| entry-node.js     | Broad Node export assembly                                                           | packages/compiler/src/api/index.js; config.js; host.js; tests/support/compiler-inspection.js                                                                                           | PUBLIC stable facade; INTERNAL/TEST ONLY removed broad exports         | REFACTOR |
| evaluate-usage.js | Import/binding recognition, static evaluation and origin location                    | packages/compiler/src/frontend/babel/evaluate.js; frontend/resolution/design-access.js                                                                                                 | INTERNAL                                                               | REFACTOR |
| generation.js     | Transaction staging, delta publication, rollback/crash recovery                      | packages/compiler/src/artifacts/publication/transaction.js                                                                                                                             | INTERNAL                                                               | MOVE     |
| index.js          | Registry/token/theme/recipe assembly and demonstrator create/props                   | packages/compiler/src/design-system/registry/build-system.js                                                                                                                           | INTERNAL                                                               | REFACTOR |
| module-graph.js   | Module summaries, resolution/forwarding, overlays and caches                         | packages/compiler/src/frontend/resolution/module-summary.js; exports.js; project/graph/resolution.js; session-owned overlay.js                                                         | INTERNAL                                                               | REFACTOR |
| perf.js           | Phase/counter measurement and benchmark experiment switches                          | packages/compiler/src/observability/metrics.js; benchmarks/support/experiments.js                                                                                                      | INTERNAL; experiment switches TEST ONLY                                | REFACTOR |
| policy.js         | Property categories and finite structural domains                                    | packages/compiler/src/design-system/policy/properties.js                                                                                                                               | INTERNAL (manifest exposes readonly catalog)                           | MOVE     |
| provenance.js     | Identity proofs, admitted compositions and write/escape checks                       | packages/compiler/src/semantics/provenance/index.js                                                                                                                                    | INTERNAL                                                               | MOVE     |
| recipe-select.js  | Shared finite selection/default/order/error semantics                                | packages/core/src/recipe-select.js (compiler imports same implementation)                                                                                                              | INTERNAL helper; generated factory PUBLIC ABI                          | MOVE     |
| recipe.js         | Compile base/branches, selector metadata and old StyleRef wrapper                    | packages/compiler/src/design-system/recipes/compile.js; packages/core/src/recipe.js                                                                                                    | INTERNAL; selector metadata PUBLIC generated surface                   | REFACTOR |
| registry.js       | Flatten/resolve tokens, theme projections, condition/recipe registry/digest          | packages/compiler/src/design-system/registry/index.js; tokens/graph.js; themes/registry.js; conditions/registry.js; recipes/registry.js                                                | INTERNAL                                                               | REFACTOR |
| runtime.js        | Finite selector runtime/error exports and identity composeRefs helper                | packages/core/src/index.js; recipe.js; selection-error.js                                                                                                                              | PUBLIC ABI facade; composeRefs removed                                 | MERGE    |
| session.js        | Revision authority, persistent discovery/views, validation/compile/audit/publication | packages/compiler/src/project/session/index.js; mutations/; graph/design-system-views.js; artifacts/publication/; api/project.js                                                       | INTERNAL service; PUBLIC facade                                        | REFACTOR |
| token.js          | Separate author/compiler TokenRef trust marks and path extraction                    | packages/compiler/src/design-system/tokens/ref.js; api/config.js; artifacts/javascript/intrinsics.js                                                                                   | INTERNAL mint/proof; PUBLIC config author token and generated sentinel | REFACTOR |
| transform.js      | Lower recognized create/recipe/props into compiled JS and rules                      | packages/compiler/src/frontend/babel/transform.js; artifacts/javascript/refs.js                                                                                                        | INTERNAL                                                               | MOVE     |
| vite.js           | Current Vite-owned session/rule map/coverage/generation integration                  | packages/vite/src/index.js backed only by compiler/host                                                                                                                                | PUBLIC adapter                                                         | REFACTOR |
| watcher.js        | Watch journal/digest provider, resync and scratch exclusions                         | packages/compiler/src/hosts/watcher/index.js; journal.js                                                                                                                               | INTERNAL implementation; ADVANCED PUBLIC session bridge                | MOVE     |

| Additional current path                          | Responsibility                                                   | Target                                                                      | Visibility                       | Action   |
| ------------------------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------- | -------- |
| packages/@pandamstyle/compiler/bin/pms-build.js  | Real CLI process/status/config loading and injected-failure seam | packages/compiler/bin/pms-build.js; src/api/cli.js; tests/support/faults.js | PUBLIC CLI; TEST ONLY fault seam | REFACTOR |
| packages/@pandamstyle/compiler/rollup.config.mjs | Compiler/runtime/Vite distribution assembly                      | packages/compiler/rollup.config.mjs plus core/vite build configs            | INTERNAL                         | REFACTOR |
| packages/@pandamstyle/compiler/package.json      | Current donor-coupled distribution/subpath exports               | packages/compiler/package.json                                              | PUBLIC release metadata          | REFACTOR |

## Current exported symbols: exhaustive classification

Baseline `entry-node.js` exports 73 symbols. Each appears exactly once below.
Classification describes the final visibility, not deletion of useful semantics.
Moving a root symbol behind a facade is intentional; no permanent old entry
alias. Public protocol constants bind the target schema and must not reuse a
historical version number for a breaking wire change.

| Classification  | Current symbols                                                                                                                                                                                                                                   | Future boundary                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PUBLIC          | createProjectSession, PmsError, Codes, formatDiagnostic                                                                                                                                                                                           | Stable compiler root SDK                                                                                                                                       |
| PUBLIC          | token                                                                                                                                                                                                                                             | compiler/config author-role helper; page token remains generated intrinsic                                                                                     |
| PUBLIC          | BUILD_REPORT_KIND, BUILD_REPORT_SCHEMA_VERSION, COVERAGE_REPORT_KIND, COVERAGE_REPORT_SCHEMA_VERSION                                                                                                                                              | Stable compiler protocol constants; version changes explicit when schemas evolve                                                                               |
| ADVANCED PUBLIC | createFilesystemWatcher, DIRTY_INPUT_MODES                                                                                                                                                                                                        | session.watch()/public mutation-mode types, not independent compiler or publisher                                                                              |
| INTERNAL        | collectCoveredFiles, compileFile, assertCoverageConsistency, beginGeneration, withGeneration, createCssState, createChangeJournal, generationScratchPaths, normalizeMutationTransaction, explicitAgentProvider, fullScanProvider, resolveProvider | Service-owned graph/mutation/publisher/input implementation                                                                                                    |
| INTERNAL        | buildDesignSystem, COVERAGE_REPORT_FILE, DEFAULT_AFFECTED_ENTRY_LIMIT, DEFAULT_CANDIDATE_LIMIT, buildAgentResult, buildCoverageReport, coverageSummary, machineDiagnostic                                                                         | Registry/protocol/artifact internals; stable result schema, not constructors                                                                                   |
| INTERNAL        | buildRegistry, registryDigest, supportedProperties, propertyKind, propertyCategory, mintTokenRef, tokenPathOf, compileStyles, compileTokens, renderCss, defineRecipe, isStyleRef, selectRecipeRefs, makeRecipeSpec, generateDesignSystemModule    | Semantic/engine/generation implementation; core ABI helper ownership as mapped above                                                                           |
| INTERNAL        | pandamstyleBabelPlugin, Provenance, isAdmitted, provenanceOf, diagnostic, resolveDesignSystemModule, resolveRelativeFile, moduleEdgesOf, moduleSummaryOfCode, DESIGN_SYSTEM_MARKER, REQUIRED_HELPERS, engineDefaultOptions, perfNow               | Frontend/provenance/protocol/observability internals, no private host imports                                                                                  |
| TEST-ONLY       | digestOfTree, conformanceDefinition, moduleGraphCacheStats, clearModuleCache, installPerfCollector, perfCollector, perfSnapshot, workEliminated, setPerfEngineName, perfMetricNames                                                               | Private test/benchmark access; runtime measurement hooks remain internal                                                                                       |
| REMOVED         | buildProject, createCompilerSession, AGENT_RESULT_KIND, AGENT_RESULT_SCHEMA_VERSION                                                                                                                                                               | Alternate public build/session removed after hosts use service; fresh algorithm remains independent oracle; target diagnostics envelope has new kind/constants |

Baseline `/runtime` additional exports `defineRecipeSelector`, PmsError/Codes/
formatDiagnostic, selectRecipeRefs and composeRefs are accounted for: generated
factory moves to core public ABI; runtime errors become core selection subset;
finite selector implementation stays shared private core; identity-only
composeRefs is REMOVED. Baseline `/vite` export pandamstyle moves to vite; both
compiler subpaths disappear after consumers migrate. All session inspection
methods not listed in public-api-v0.1 (cssState, validityOf,
verifyDesignSystemViews, verifyCoverageGraph, coverageOrder, inspectForwarding,
fileStates, internal graph stats) are TEST-ONLY. lastPublication/dirty-input
summaries may be public receipt fields; mutable state is never public.
serializeAgentResult is INTERNAL/host transport; serialization does not define
diagnostics readiness.

## Audited source-to-runtime trace

References below are baseline source evidence, not new tests. Prefix `pms/`
means `packages/@stylexjs/babel-plugin/pandamstyle/`.

| Concept                          | Author source / generated artifact                                                            | Recognition / validation                                                                                             | Runtime / extraction / diagnostics                                                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| create                           | pilot/vite-react/src/pages/App.jsx; pms/codegen.js exports sentinel                           | pms/evaluate-usage.js binding/static folding; provenance.js; transform.js                                            | compiler.js validates token/structural policy and calls shared/stylex-create; sentinel throws if missed; static/property/value diagnostics                                    |
| props                            | Same pilot uses generated props; codegen.js forwards donor props                              | babel-plugin.js JSX channel checks; provenance.js arguments/spreads/escapes; transform.js injects composition import | packages/@stylexjs/stylex/src/stylex.js uses styleq; closed path expects compiled finite refs; unverified source/provenance/spread diagnostics                                |
| token                            | Pilot page generated intrinsic; design config imports compiler author token                   | evaluate-usage.js mints compiler-trusted ref; token.js separates author/compiler marks                               | compiler.js checks public/category then varsByToken; registry cycles/category/reference diagnostics; no legitimate page runtime token call                                    |
| recipes / variants               | pilot/vite-react/design.pandamstyle.config.js base/variants/defaults; codegen.js finite specs | registry.js stores order/domains; recipe.js compiles branches; transform.js literal selection validation             | recipe-select.js shared static/runtime selector; runtime.js returns ref arrays, demonstrator recipe.js wraps old StyleRef; invalid key/value diagnostics                      |
| themes                           | Definition partial token overrides; codegen.js theme ref objects                              | registry.js resolves base/projected references; compiler.js theme lowering                                           | Shared define-vars/create-theme engine extracts vars/overrides; props composes refs; missing reference errors; advanced category/projection behavior needs independent oracle |
| conditions                       | Definition names hover/wide; page property maps and recipe \_hover blocks                     | registry.js records definitions; compiler.js expands maps/blocks and named-only constraints                          | Shared atomic lowering emits CSS; no runtime condition evaluation; unknown condition/form errors                                                                              |
| slot recipes / compound variants | registry.js explicitly rejects nonempty slots/compoundVariants                                | No delivered recognition beyond unsupported-feature rejection                                                        | Manifest capability false; no claim of slot/compound extraction/runtime                                                                                                       |
| patterns/layout                  | Historical proposal, no canonical generated export/engine path                                | No delivered schema/compiler primitive                                                                               | Manifest patterns false; no assertion that unknown top-level pattern declaration is already uniformly rejected                                                                |

Baseline codegen imports donor stylex plus compiler/runtime. Transform also
emits donor composition imports. Distribution lists donor dependencies. Vite
calls createCompilerSession and maintains rule maps; CLI invokes buildProject.
These prove debt A/B/C and prevent treating the rename as cosmetic. Baseline
generated markers alone do not establish artifact authenticity; target digest
binding is an explicit oracle/migration obligation. Private recipe visibility,
null/coercion, theme projections and runtime wrapper parity require baseline and
expected-target fixtures before changing semantics.

## Donor engine closure and Phase 3 handoff

The 27-file map does not claim every donor file is useful. Current imports
include babel-plugin/src/shared/stylex-create, stylex-define-vars,
stylex-create-theme, shared/utils/default-options, utils/evaluate-path and
utils/js-to-ast; runtime uses stylex/src/stylex and its composition dependency.
Phase 3 must derive the exact recursive engine/helper closure from the locked
baseline, map each reachable file to engine/atomic, engine/lowering,
engine/ordering or frontend/babel, and carry its independent tests/legal
headers. Babel plugin donor visitors not used by PandamStyle are not
automatically retained. Unreachable donor packages/tools are Phase 5 deletion
candidates, not extra public packages.

Move behavior first under these domains using the Phase 1 oracle. Do not
silently fold module graph into host caches, turn publication into per-host
writes, drop negative dependencies or replace incremental CSS with full
aggregation. This map freezes the destination for all current PandamStyle
modules; engine closure selection remains an evidence task within the fixed
ownership boundary, not an unresolved public architecture question.
