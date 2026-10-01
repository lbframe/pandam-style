# Phase 8 + 9 integration checkpoint

This integration uses Phase 9 final commit
`2c60997e854de7d880d03694a4ccab74832514ee` (tree
`dc17a6d83e45471a2143ade6ba07310d9e33d0d2`) as its structural base in
`/home/kyle/work/pandam-style-phase-8-9-checkpoint-2026-10`, branch
`integration/pandamstyle-phase-8-9-checkpoint-2026-10`.
Phase 8 final source is `8b7a4093ce5ef12cdbbb2edb16a1a774f7a2a5f5`, tree
`692789d56b357157d269f7617407909d9221709c`. Its five functional commits
`bdbf44e7`, `94372ad9`, `7076bbd1`, `6b48f003`, and `5c03b32c` are integrated.
The common base is `ce6601d8bd02f31f893d0ea386c25874fb2e5011`, tree
`c23e4fff23dfb1d8df331b5cc14a1815a6f14921`.

## Authority and scope

The canonical Project Service remains the sole lifecycle, revision, validation
and publication authority. The immutable Design System Snapshot remains the
sole vocabulary and projection authority. Vite uses only the compiler root and
public `/host` entry; the private qualification seam is removed. ABI v1,
Diagnostics Protocol v1, semantic expectations and deferred capabilities retain
their accepted contracts.

Phase 9 core source and compiler manifest/legal material are preserved.
Phase 8 adds `MutationTransaction.sourceOverlays`, `ArtifactResult.sourceDigest`
and `readGeneratedArtifacts(revision)` to runtime and declarations. Packed SDK
tests exercise overlays with distinct filesystem bytes, exact source digests,
immutable five-file views, stale-read rejection and correspondence to published
bytes. The host bridge delegates these operations to the same service queue.

Global definition mutations retain the named `design-system-definition`
fallback. Their accepted revision, rebuild, fallback and publication counts
remain observable. Unsupported `build.write: false` and multiple outputs still
reject with structured `PMS_UNSUPPORTED_FEATURE`. No Next, Rsbuild, native or
capability expansion is part of this checkpoint.

## Two manually reconciled overlaps

Comparing each source branch against the common base yields exactly two shared
changed files. Mechanical cherry-picks applied cleanly; both combined files
were then reviewed and manually extended. Neither was resolved wholesale.

| File | Phase 8 intent | Phase 9 intent | Combined behavior and proof |
| --- | --- | --- | --- |
| `verify-pms.sh` | Build/check Vite, run real external three-tarball pilot, capture adapter artifacts | Required standalone package qualification; ten steps and release evidence | Preserve Vite build/pilot/artifacts and all ten Phase 9 steps in their original order. Package qualification validates that the report includes core/compiler/Vite, stable contents and external Vite import/types. Real full verifier and integrity fixture tests prove both paths. |
| `tools/pms/__tests__/tooling-verification-test.js` | Three workspaces, Vite build fixture and required package pilot, correct migrated suite counts and optional peer closure | Ten-step order/count, required qualification artifact, omissions/skips cannot certify completion | Preserve both fixtures and assertions. Added tests reject a two-package report and omission of build/pilot/package qualification; structural assertions retain Vite build, tarball installation, public entry and seam absence. The green fixture still requires exactly ten ordered steps. |

Unresolved overlap count: **0**. Phase 9 package manifests were not replaced by
the Phase 8 versions. Root workspaces contain only core, compiler and Vite;
Yarn 1 installation checks workspace resolution without adding a compatibility
workspace or changing the existing lockfile contents.

## Qualification contract

The package harness uses descriptors for each package's directory, exports,
allowed inventory and required files. Each package is packed twice, audited,
installed in an external npm consumer and checked while this checkpoint's
`packages/` directory is temporarily unavailable. It records realpaths,
dependency closure, types, CLI, SDK, host, provenance and browser/tree-shaking
boundaries. No other worktree supplies source or build output.

Core/compiler qualify on Node 20.0.0 and 22.22.0. Vite 7.3.2 declares Node
`^20.19.0 || >=22.12.0`, so the Vite adapter declares that effective requirement.
Adapter import/construction on 20.0.0 is recorded separately from unsupported
Vite runtime support. External dev/transform/build cases exercise Node 20.19.0,
22.12.0 and 22.22.0. The exact Vite peer is not widened.

The real external pilot reruns the Phase 8 dev/HMR, invalid/repair,
add/delete/rename, re-export, seven definition mutations, close/reopen, edit
burst, isolation, production repetition/recovery and nine failure cases.
Publication retains the prior valid generation, rejects stale tickets and
authenticates all five canonical members. Browser bundles must exclude compiler,
Vite, Node, Babel and donor runtime machinery.

Official required order: install, build, pandamstyle, pandamstyle-core,
semantic-oracle, tooling-tests, pilot, artifacts, donor-closure,
package-qualification. The semantic oracle remains 129 total, 125
MUST_PRESERVE, zero KNOWN_GAP, four DEFERRED, zero failed and zero unknown;
all six browser/SSR cases remain required.

Final qualification must start from a clean committed implementation. Its
commit/tree are captured by the verifier. A fresh detached checkout independently
rebuilds and qualifies the tarballs. The closure commit may change only evidence
and the checkpoint delivery record. Source worktree HEAD/status and protected
local/remote main are compared with their before snapshots.

The [delivery record](phase-8-9-checkpoint-delivery.md) reports observed results
and the final verdict. Historical phase evidence is not reused as checkpoint
qualification. Phase 10 authorization depends on every checkpoint gate passing.
