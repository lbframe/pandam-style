# Phase 9 delivery: standalone package qualification

**PandamStyle Phase 9 is complete for the implemented `@pandamstyle/core` and
`@pandamstyle/compiler` release boundary.** Both packages were packed twice,
installed from local tarballs in an external npm consumer, and exercised while
the repository `packages/` directory was unavailable. Nothing was published.

## Tested source and branch

The work used branch
`chore/pandamstyle-phase-9-release-qualification-2026-10` in the dedicated
worktree `/home/kyle/work/pandam-style-phase-9-release-qualification-2026-10`.
Its authoritative base is commit
`ce6601d8bd02f31f893d0ea386c25874fb2e5011`, tree
`c23e4fff23dfb1d8df331b5cc14a1815a6f14921`.

The implementation commits are:

1. `df17deb684a6b2d9ec7556c8faf2d0cd1a04017a` — package contract, manifests,
   and legal/provenance files.
2. `b5e263ead78b4da3dacf43074c6f76f662ede208` — external tarball qualification
   harness.
3. `4e78fec34eafba52173680b663e49d26d61bb667` — public type and CLI/generator
   edge-case fixes.
4. `cdbc08bb4471bfa7f0d51bda7bb7701b43f1a16b` — required verifier gate and
   integrity tests.

The verifier tested commit `cdbc08bb4471bfa7f0d51bda7bb7701b43f1a16b`, tree
`93a478ea7e54395f6a83364639b5578f64ad3cc1`, from a clean worktree. The evidence
closure that follows this tested commit changes only `evidence/**` and this
delivery document. The exact final commit and remote head are recorded in the
delivery response.

## Package results

| Package | Version | Public values | Types | Engine / side effects | Tarball / unpacked / files |
| --- | --- | --- | --- | --- | --- |
| `@pandamstyle/core` | `0.1.0` | `.`, `./package.json` | `./src/types.ts` | no Node engine; `sideEffects: false` | 6,397 / 23,365 bytes / 10 |
| `@pandamstyle/compiler` | `0.1.0` | `.`, `./config`, `./host`, `./package.json`; `pms-build` | `./types/index.d.ts` plus config/host declarations | Node `>=20.0.0` | 233,114 / 1,121,351 bytes / 14 |

Both packages are ESM-only. Core has no runtime dependencies. Compiler has ten
direct runtime dependencies: core `0.1.0`, Babel core/helper-module-imports/
parser/preset-react/preset-typescript/traverse/types, `@csstools/css-tokenizer`,
and `postcss-value-parser`; it has no peer or optional dependencies. Every
declared export target exists in the tarball. Core source/types, compiler
build/bin/types, MIT notices, attributions, and provenance records are
included; tests, fixtures, evidence, compiler source, and donor source trees are
excluded. Representative core and compiler private deep imports fail with
`ERR_PACKAGE_PATH_NOT_EXPORTED`.

The external consumer installed both tarballs with npm. Runtime, CLI, type,
SDK, and host tests resolved from external package realpaths while `NODE_PATH`
was unset and repository package sources were moved aside. The installed
production graph contains 60 packages (13,333,849 installed bytes), with zero
donor packages, workspace/file dependency references, missing dependencies,
or repository path leakage. All 18 compiler runtime import specifiers resolve
to declared dependencies or Node built-ins; none is a donor import.

Node `20.0.0` (the declared minimum) and repository Node `22.22.0` both passed
ESM imports, runtime/API checks, canonical artifact identity, and CLI builds.
The installed `pms-build` passed successful, repeated, invalid-source,
structured-diagnostic, missing-config, missing-definition, invalid-config,
stale-output cleanup, and recovery cases. Invalid source returned
`PMS_UNKNOWN_TOKEN`; each missing/invalid configuration case exited with code
2. The public SDK lifecycle, config API, and `/host` bridge passed across the
package boundary. ABI mismatch returned `PMS_ABI_MISMATCH`; a counterfeit
generated artifact was rejected with `PMS_GENERATED_ARTIFACT_MISMATCH`.

The compiler generated the canonical external set `design.js`, `design.d.ts`,
`manifest.json`, `styles.css`, and `artifacts.json`. Strict TypeScript 5.9.3
no-emit checks passed for public core/SDK/host/config types and generated design
types. Nine intended invalid shapes were rejected, including private/unknown
tokens, invalid recipe domains, unknown conditions/themes, invalid composition,
wrong ABI, and unverified props input. The generated declaration was 11,231
bytes.

Static recipe/theme application bundles remove unrelated design vocabulary; an
unused core import produces a one-byte bundle. A one-recipe bundle is 7,304
bytes, one-theme is 7,278 bytes, and two recipes are 7,477 bytes. A supported
dynamic axis selection bundles to 18,944 bytes and retains the unrelated
`notice` recipe because the runtime selector keeps the generated aggregate
`recipes` object reachable; unrelated theme data is removed. Dynamic namespace
indexing is rejected with `PMS_UNVERIFIED_PROPS_SOURCE`. The browser scan passed
for 16 core, generated-runtime, and bundled files with no Node built-ins,
compiler/Babel imports, donor imports, or checked process-dependent references.

Packed licenses and provenance passed byte-for-byte checks. Both repeated
`npm pack` runs had stable file lists and content digests, and both archive
pairs were byte-identical. The compiler cold import measured 645.832 ms, CLI
startup 204.717 ms, generated typecheck 842.854 ms, and external npm install
4,207.592 ms in this run.

## Semantic and verifier gates

The semantic oracle remained unchanged at 129 cases: 125
`MUST_PRESERVE`, 0 `KNOWN_GAP`, 4 `DEFERRED`, 0 failed, and 0 unknown. All six
browser/SSR cases passed. Donor closure passed with zero findings and zero
production donor-engine edges.

Standalone package qualification is the tenth required official verifier step.
The full order was install, build, PandamStyle tests, core tests, semantic
oracle, tooling tests, pilot, artifacts, donor closure, and package
qualification. The run was complete and verified: 10/10 required steps, 792
tests across 51 suites, zero failures, and zero skipped steps.

The worktree isolation record is
[`worktree-isolation.json`](../../evidence/phase-9-release-qualification/worktree-isolation.json).
It records the protected main SHA and separate Phase 6/7/8 worktrees. The
Phase 8 worktree remained on its own branch at the reconciliation base; visible
uncommitted Phase 8 work was preserved. The Phase 9 branch was pushed after the
evidence closure and its remote head was verified equal to local HEAD. No PR,
merge, registry publication, or auth/token operation occurred.

The complete machine-readable reports and raw verifier logs are in
[`evidence/phase-9-release-qualification/verify`](../../evidence/phase-9-release-qualification/verify).
The package-specific manifest, tarball, install, realpath, dependency,
runtime, CLI, SDK/host, TypeScript, bundle, browser, Node, provenance,
reproducibility, and footprint reports are under its
[`package-qualification`](../../evidence/phase-9-release-qualification/verify/package-qualification)
directory.

Phase 8 remains an independent workstream. A Phase 8+9 checkpoint must qualify
`@pandamstyle/vite` with these release rules and run the real external Vite app
before any Phase 10 decision. **Phase 10 is not authorized by this delivery.**
