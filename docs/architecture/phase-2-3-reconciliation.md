# Phase 2 + Phase 3 overlap reconciliation

The Phase 3 compiler tree is the structural base. Phase 2 supplies the ABI v1
runtime and its compiler boundary conversion. The table records every file
named as an overlap in the reconciliation brief, plus the adjacent tests and
step contract that needed the same integration decision. All Phase 1 target
assertions remain unchanged.

| File | Phase 2 intent | Phase 3 intent | Integrated resolution | Why neither phase is weakened | Tests/evidence |
| --- | --- | --- | --- | --- | --- |
| `docs/architecture/semantic-gap-register.md` | Record SG-12 as resolved by core. | Record SG-01–11 and SG-13 as resolved by the owned compiler. | Preserve all historical observations; mark each gap with its original resolution phase. | The target assertions are unchanged and no open gap is relabeled as a pass. | Semantic oracle report, `gaps.js`. |
| `packages/@stylexjs/babel-plugin/__tests__/pandamstyle/provenance-props-test.js` | Assert emitted composition imports core and carries ABI refs. | Run against the Phase 3 private inspection bundle and retain provenance rejection tests. | Keep the inspection bundle and assert core imports, StyleRef and ThemeRef shapes. | Binding and rejection checks still run; runtime ownership is proven. | PandamStyle Jest suite, semantic provenance cases. |
| `packages/@stylexjs/babel-plugin/__tests__/pandamstyle/recipe-contract-test.js` | Test core's finite selector and composition ABI. | Keep tests wired to the relocated compiler fixture. | Use the Phase 2 ESM core test loader with the Phase 3 compiler-built recipe spec. | The actual generated spec, core selector, CSS and dynamic selection path are exercised. | Recipe contract suite, core suite, semantic recipes. |
| `packages/@stylexjs/babel-plugin/__tests__/pandamstyle/vite-build-test.js` | Verify the current Vite pilot's generated output with core. | Retain the Phase 3 compiler path and existing Vite qualification. | Keep the Phase 3 path and assertions; the generated facade now imports core without a runtime override. | Vite still builds through the temporary seam; application output is donor-free. | Vite build suite, external packed pilot. |
| `tests/semantic/cases/gaps.js` | Promote SG-12 after actual malformed-ref rejection. | Promote the twelve compiler-owned gaps against frozen targets. | Keep all Phase 3 promotions and promote only SG-12's status. | All 129 authored cases and target values remain; none is bypassed. | Semantic oracle report and harness integrity suite. |
| `tests/semantic/harness/implementation-adapter.js` | Load core in the actual generated module evaluator and use ABI tombstones. | Exercise `packages/compiler` project/session, diagnostics and publication. | Keep the Phase 3 compiler adapter and route emitted core imports to actual core source; use ABI ref tombstones. | Fresh and incremental lanes still execute real product code and compare the same target. | Semantic oracle report, browser/SSR cases. |
| `tools/pilot/run-pilot.sh` | Pack and resolve core outside the workspace. | Pack the owned compiler and retain current Vite qualification. | Pack compiler and core, verify both installed tarballs, run the real Vite build. | Compiler SDK and core resolve externally; StyleX is not an application dependency. | Pilot log and packed-core proof. |
| `tools/pms/__tests__/tooling-verification-test.js` | Demand a core test step in the official order. | Demand exact step classification, suite discovery and no false green verdict. | Exercise a ten-step fixture with a real core step contract and retain all negative verifier cases. | An omitted, failed or skipped step cannot qualify. | Tooling tests and official verifier summary. |
| `tools/pms/forwarding-semantic-oracle.js` | Recognize ABI ref output as compiled style. | Retain relocated compiler inspection and forwarding authority checks. | Accept ABI StyleRef/ThemeRef markers as compiled output while keeping binding and forwarding checks. | Only output classification changed; authority remains identity-based. | PandamStyle forwarding suite. |
| `verify-pms.sh` | Require core tests and packed proof. | Build the owned compiler and retain the semantic/tooling/pilot gates. | Ten required steps in the specified order; core proof is collected in artifacts. | Every phase's required gate executes and is counted separately. | Official verifier raw logs and summary. |
| `packages/@stylexjs/babel-plugin/__tests__/pandamstyle/native-compile-test.js` | Assert core-only application composition imports and ABI refs. | Retain owned compiler fixture execution. | Apply Phase 2 ABI assertions to Phase 3's build output. | The real compiler, not a synthetic fixture, produces the assertions. | Native compile suite. |
| `tools/pms/step-contracts.js` and its test | Classify core as a required test step. | Retain strict classifier semantics. | Add `pandamstyle-core` to the explicit step map and test population. | No step can escape classification or pass without test counts. | Step contract and tooling verifier suites. |

Additional compiler boundary resolution: `packages/compiler/src/artifacts/javascript/refs.js`
owns conversion from legacy compiler atom maps to ABI v1. The generated module
and Babel transform use that same conversion. `packages/core` owns runtime
composition and finite selection. The old compiler package and public
`compiler/runtime` export are absent. The donor-shaped `vite.js` remains the
temporary Phase 8 verifier adapter.
