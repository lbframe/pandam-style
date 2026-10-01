# Phase 5 deletion map

This inventory was created before any donor directory was removed. It records
the disposition of each meaningful donor, legacy, test, build, and documentation
area found at the Phase 5 base. Donor source is never retained for reference;
Git history preserves deleted source. Test relocation and legal/provenance
transfer are prerequisites to the physical deletions below.

## Source and package trees

| Current path or subtree | Classification | Phase 5 disposition and gate |
| --- | --- | --- |
| `packages/@stylexjs/babel-plugin/__tests__/pandamstyle/**` | MIGRATE THEN DELETE | Move the complete PandamStyle-owned test suite, helpers, and fixtures to `packages/compiler/__tests__/pandamstyle/**`; preserve test meaning and record each path in the test migration inventory before deleting the donor package. |
| `packages/@stylexjs/babel-plugin/src/**`, its non-PandamStyle tests/fixtures, package/build/Jest configuration | DELETE | Secondary donor reference implementation and suite. First add and pass owned regressions for retained evaluator, atomic, normalization, ordering, and direction behavior that lacks owned protection. |
| `packages/@stylexjs/stylex/**` | DELETE | Donor runtime, tests, and package/build configuration. PandamStyle runtime composition is owned by `packages/core`; retain its ABI and composition protections there. |
| `packages/@stylexjs/{atoms,cli,create-stylex-app,devtools-extension,eslint-plugin,postcss-plugin,rollup-plugin,shared,unplugin}/**` | DELETE | Donor packages, tests, examples, release/build/lint machinery, and package documentation have no PandamStyle production role. Existing PandamStyle uses are checked and retargeted before removal. |
| `packages/@stylexjs/` as a whole | DELETE | Remove the complete donor package namespace after migrations above; no source subtree is moved into an archive or retained as a reference checkout. |
| `packages/style-value-parser/**` | DELETE | Remove the donor workspace/package and its upstream property-parser tests after the retained media-query behavior has owned compiler regression coverage. The eight required parser modules are already owned under `packages/compiler/src/engine/ordering/media-query/`. |
| `upstream/stylex/` | NOT IN SCOPE / JUSTIFICATION | Absent at the Phase 4 base. Confirm absence in final repository-tree and donor-closure evidence; do not recreate it. |
| `upstream/panda/**` | DELETE | Remove the vendored comparison checkout in full after its license text, exact revision, and any still-useful citations have been transferred to owned legal/provenance records. No source, website, sandbox, package, or binary copy is retained. |
| `upstream/README.md` | MIGRATE THEN DELETE | Transfer exact source pins and historical checkout description into `ATTRIBUTIONS.md` and the Phase 4 provenance record, then remove the obsolete checkout-oriented document. |
| `packages/@pandamstyle/compiler/` | NOT IN SCOPE / JUSTIFICATION | Empty directory at the Phase 4 base; no package source or compatibility wrapper is present. Final forbidden-path scan checks that no wrapper/package appears. |

## PandamStyle tests, fixtures, and retained donor-test behavior

| Current path or subtree | Classification | Phase 5 disposition and gate |
| --- | --- | --- |
| `packages/@stylexjs/babel-plugin/__tests__/pandamstyle/{*-test.js,*.js}` | MIGRATE THEN DELETE | Move suites and both shared helpers, preserving the suite/fixture topology at `packages/compiler/__tests__/pandamstyle/`. Rewrite only root-relative paths required by the new depth. |
| `packages/@stylexjs/babel-plugin/__tests__/pandamstyle/fixtures/**` | MIGRATE THEN DELETE | Move every fixture file intact beneath the owned test root. Preserve intentionally forbidden donor imports and existing path-resolution cases. |
| `packages/compiler/__tests__/engine-absorption-test.js` | NOT IN SCOPE / JUSTIFICATION | Owned engine regression suite; kept and expanded with fail-closed evaluator escape, stable-hash, null shorthand override, CSS splitting/value normalization, and breakpoint ordering cases. |
| Donor evaluator escape/deopt test cases for behavior retained by the owned static evaluator | MIGRATE THEN DELETE | Add a bounded reflection/constructor escape vector, a non-deterministic call and a payload non-execution assertion to the owned compiler suite; run it before donor deletion. |
| Donor value-normalization, CSS-value splitting, shorthand expansion, and media-condition ordering cases for retained behavior | MIGRATE THEN DELETE | Add fixed-output owned coverage for nested `calc()`/`var()` splitting, content quote escaping, numeric normalization, a stable atom hash, null longhand suppression, and min/max breakpoint order; run it before donor deletion. Do not port unrelated donor APIs. |
| Donor DOM injection, standalone StyleX APIs, and unused Babel transforms/tests | DELETE | Outside PandamStyle's retained product behavior; no owned replacement is required. The PandamStyle core/runtime contract remains covered by owned tests. |
| `tests/semantic/**` and `tools/semantic-oracle/**` | NOT IN SCOPE / JUSTIFICATION | PandamStyle-owned Phase 1 oracle and harness. Preserve authored expectations and case inventory; retarget any donor-root fixture references without changing semantics. |
| `tools/pms/{collect-regression-cases,forwarding-semantic-oracle,forwarding-warm-guard}.js` and related tests | MIGRATE THEN DELETE | Retarget helper/fixture roots to owned test paths; preserve independent discovery and forwarding checks. |
| `tools/pms/core-package-proof.js`, `generated-runtime-imports.js`, `module-imports.js`, `test-counts.js` | NOT IN SCOPE / JUSTIFICATION | Keep active PandamStyle packaging/import/count verification; donor names remain only where they define explicit rejection policy. |

### Retained engine behavior coverage before donor-suite deletion

| Retained behavior | Owned regression/evidence | Donor tests no longer needed for |
| --- | --- | --- |
| Static expression evaluation, per-pass isolation, and fail-closed escape handling | `engine-absorption-test.js`; moved provenance and negative-build suites | Donor evaluator implementation and its custom plugin state manager |
| Stable atomic hashes, declaration normalization, deduplication, shorthand priority, null longhand suppression, and legacy expansion | `engine-absorption-test.js`; semantic oracle and moved incremental CSS suites | Donor plugin code that no longer participates in PandamStyle builds |
| CSS functions and quoted values in shorthand splitting; content quoting and supported number normalization | `engine-absorption-test.js` fixed-output cases | Donor value parser and normalization suite as executable test authority |
| Same-property breakpoint ordering for min and max media conditions, layer emission, and RTL logical floats | `engine-absorption-test.js`; browser semantic cases | Donor CSS serializer tests |
| Token variables, theme projection, runtime composition, and recipes | `engine-absorption-test.js`, `packages/core/__tests__/core-test.js`, moved recipe/chain suites | Donor StyleX runtime tests; PandamStyle owns this smaller runtime contract |
| Computed browser style, condition/media cascade, theme scope, token values, SSR/hydration | Six browser semantic oracle cases in `tests/semantic/cases/browser.js` | Donor DOM injection and StyleX-specific runtime behavior, which are not retained |
| Incremental ownership/refcounts, publication rollback, generation identity, revision association, diagnostics, and project isolation | Moved CSS/publication/session/API suites plus the unchanged semantic oracle | Donor watcher/injection behavior outside the PandamStyle session contract |

## Repository scripts, configuration, CI, and examples

| Current path or subtree | Classification | Phase 5 disposition and gate |
| --- | --- | --- |
| Root `package.json` StyleX identity, donor workspaces, package-wide build/test/release assumptions | MIGRATE THEN DELETE | Rename the private root workspace to PandamStyle, enumerate only the real owned workspaces, remove donor release/build scripts, and retain commands that build/check owned packages. |
| `yarn.lock` entries reachable only from deleted workspaces | MIGRATE THEN DELETE | Regenerate using the repository-supported Yarn 1 workflow after manifest cleanup; prove frozen install from a clean checkout. Do not hand-delete lock blocks. |
| `verify-pms.sh` donor builds, upstream suite steps, donor test/fixture roots | MIGRATE THEN DELETE | Remove the two obsolete upstream steps only after owned regressions pass; retarget PandamStyle suite and fixture paths; keep install/build/semantic/tooling/pilot/artifact/closure gates. |
| `tools/pms/step-contracts.js` and its integrity tests | MIGRATE THEN DELETE | Change required step population from 11 to the nine owned steps and keep explicit step/evidence integrity checks. No upstream step becomes skipped or fake-passing. |
| `jest.config.js` donor Babel root, donor suite/test-discovery assumptions | MIGRATE THEN DELETE | Use PandamStyle-owned compiler/core transform configuration; retain test discovery and fixture exclusions with paths that still exist. |
| `.flowconfig` donor module mappers, `flow_modules` lookup, `flow-typed.config.json`, and generated `flow-typed/` stubs | MIGRATE THEN DELETE | Remove mappings to deleted packages, the nonexistent `flow_modules` lookup, unused generator config, and donor/example stubs. Keep five module declarations required by owned compiler sources (`@babel/traverse`, `@babel/types`, `@csstools/css-tokenizer`, `estree`, `postcss-value-parser`) and re-run Flow to prove the owned package check remains valid. |
| `.eslintrc.js`, `.prettierignore`, `.gitignore` donor fixture/upstream paths | MIGRATE THEN DELETE | Retarget the PandamStyle fixture exclusion to its owned root and remove exclusions for deleted donor trees; preserve ignore rules with a live generated-output purpose. |
| `.github/workflows/tests.yml` | MIGRATE THEN DELETE | Remove donor devtools jobs and keep CI exercising `verify-pms.sh` plus applicable owned Flow/lint/format checks. |
| `.github/workflows/benchmarks.yml` | DELETE | Current jobs invoke the donor `benchmarks` workspace and compare donor package size/performance. Phase 5 runtime performance evidence is produced by the owned PandamStyle harness, not this donor workflow. |
| `.github/workflows/typos.toml` donor-only exclusions | MIGRATE THEN DELETE | Remove stale donor path exemptions while retaining generic spell-check settings. |
| `examples/example-*/**` (all donor integration examples) | DELETE | Remove examples that depend on `@stylexjs/*` and their package/workflow/test scaffolding. No donor example is kept as a reference. |
| `pilot/vite-react/**` | MIGRATE THEN DELETE | Move the active qualification pilot intact to `examples/pilots/vite-react/**`; update active tooling paths. Keep its packed-package install and qualification-only seam. |
| `tools/pilot/{run-pilot.sh,vite-seam.js,vite-seam.rollup.config.mjs}` | NOT IN SCOPE / JUSTIFICATION | Keep the private qualification seam required by the packed Vite pilot; it stays outside public exports and compiler source. Update obsolete donor-path guards/comments when they describe active paths. |
| `packages/{benchmarks,docs,scripts,shared-ui,typescript-tests}/**` | DELETE | Donor benchmark suites, StyleX documentation UI/shared components, Flow type generators, and donor TypeScript examples. The separate top-level `benchmarks/pandamstyle/**` remains the owned performance harness. |
| `tools/npm/release.js` and its root `release` command | DELETE | Generic-looking script releases all workspaces and therefore encodes donor repository assumptions. Phase 5 creates no package publisher; Phase 9 owns release qualification. |
| `tools/husky/**`, `tools/eslint/copyright-header.txt`, top-level `benchmarks/pandamstyle/**` | NOT IN SCOPE / JUSTIFICATION | Shared repository hook/header tooling and the owned performance harness remain required; retain after checking their path references. |

## Legal, provenance, and historical records

| Current path or record | Classification | Phase 5 disposition and gate |
| --- | --- | --- |
| Root `LICENSE` | LEGAL/PROVENANCE PRESERVE | Preserve exact current text and path because owned derived-source headers refer to it. |
| Panda `upstream/panda/LICENSE.md` | LEGAL/PROVENANCE PRESERVE | Copy the exact notice to an owned `LICENSES/` record and cite it before deleting the checkout. |
| StyleX `0.19.1` origin, commit `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2` | LEGAL/PROVENANCE PRESERVE | Record repository, version, commit, retained derived subsystems, and MIT notice in `ATTRIBUTIONS.md` and the Phase 4 provenance record. |
| Panda comparison commit `1a310482ff18102c44b2a478b7644b064a80d7c6` and any separately recorded historical v2 citation | LEGAL/PROVENANCE PRESERVE | Preserve the precise distinction between the vendored comparison source and any historical citation. Do not claim Panda source was absorbed into PandamStyle. |
| `docs/architecture/phase-4-derived-source-provenance.md`, `phase-4-engine-absorption-map.md` | LEGAL/PROVENANCE PRESERVE | Keep and update with the physical deletion outcome while preserving exact Phase 4 origin, revision, and source-to-owned-target records. |
| Phase 4 delivery/evidence and immutable semantic expectations/source maps | HISTORICAL DOC PRESERVE | Preserve as truthful historical records. Do not rewrite past paths, run results, or expected semantics to hide deleted sources. |
| Obsolete donor product manuals, READMEs, website docs, setup/release instructions | DELETE | Remove with the donor product/source tree. Any active PandamStyle contributor instruction must instead use owned paths and commands. |
| Donor ancestry comments and copyright/license headers in derived compiler files | LEGAL/PROVENANCE PRESERVE | Keep truthful source ancestry and required headers; they are not executable donor architecture. |

## Final verification boundary

The owned verifier must fail if any executable donor tree, compatibility path,
or legacy/reference archive reappears. Its structured report distinguishes
physical paths, parsed imports, package dependencies, build inputs, and active
workspace/script/config references from permitted legal/provenance records,
historical evidence, source ancestry comments, and negative-policy matchers.
The required report includes an explicit `upstream/stylex/` absent result.
