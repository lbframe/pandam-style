# Phase 8 + Phase 9 checkpoint delivery

Qualification verdict: **verified**, ten of ten required gates passed, **800
tests in 51 suites**, zero failures, skips or omitted required steps. Core,
compiler and Vite coexist in one externally qualified release-candidate tree.
Git closure requires the evidence commit containing this record, its push and
remote readback; the final handoff reports those hashes after they exist.
Phase 8 and Phase 9 are closed. This checkpoint closes upon that Git readback,
authorizing Phase 10; no Phase 10 implementation is included.

## Repository identity and isolation

Branch: `integration/pandamstyle-phase-8-9-checkpoint-2026-10`.
Worktree: `/home/kyle/work/pandam-style-phase-8-9-checkpoint-2026-10`.
Created clean from the exact Phase 9 final head, independently of the source
worktrees. Local and actual remote `main` remain
`71fcc045b18eb215f0c3a815bb8c8d15a9f99489`.

| Source | Head | Tree |
| --- | --- | --- |
| Phase 8 | `8b7a4093ce5ef12cdbbb2edb16a1a774f7a2a5f5` | `692789d56b357157d269f7617407909d9221709c` |
| Phase 9 / structural base | `2c60997e854de7d880d03694a4ccab74832514ee` | `dc17a6d83e45471a2143ade6ba07310d9e33d0d2` |
| Common reconciliation base | `ce6601d8bd02f31f893d0ea386c25874fb2e5011` | `c23e4fff23dfb1d8df331b5cc14a1815a6f14921` |

Before/after HEAD and status comparisons match for Phase 8, Phase 9, Phase 6+7
reconciliation and the initial checkout. All remain clean at their original
heads; the initial checkout remains `dd93bd4da211333bacf4c470554e5daab009e84e`.
See [isolation evidence](../../evidence/phase-8-9-checkpoint/worktree-isolation.json).
The final handoff repeats these comparisons after push and checks checkpoint
cleanliness, remote equality and the evidence-only final diff.

Integrated commits, in order:

| Commit | Change |
| --- | --- |
| `84d606256e5f968cef44597a93df482da31edb60` | Phase 8 typed host artifacts and source overlays |
| `b8bb7ca310170387e6bc7e310d9c3743291a13be` | Public Vite host adapter |
| `f9c11af9866c058bab1b2921b4ef604574a9b97b` | External packed-package pilot, remove private seam |
| `69ef094a8d409598d0df1da9b7d036e5f26b653b` | Phase 8 verification fixtures |
| `e50a7acc29cedd1f19a01f3366dd2eb07f716800` | Recipe variant-domain qualification |
| `e8052bfa5e024990855abf1927dcdad6ece3d4d2` | Three-package release qualification and verifier reconciliation |
| `487ddeef5233d778f7fb50296b369e950584e003` | Correct browser Node-specifier scan |

**Tested commit:** `487ddeef5233d778f7fb50296b369e950584e003`.
**Tested tree:** `eff7e713ea9a7ba6a8cb7ee2a5498cf6653d680e`.
The full verifier started clean on that commit. Technical checkpoint and package
contract documents were committed before it. The final commit adds only freshly
generated evidence and this delivery document. Its own hash/tree cannot be
embedded in its content; resolve the containing commit and consult the handoff.

Exactly two overlapping changed files were established against the common base:
`verify-pms.sh` and `tools/pms/__tests__/tooling-verification-test.js`. Both
were manually reconciled; unresolved count is **0**. Their intents, combined
behavior and regression assertions are in the
[checkpoint contract](phase-8-9-checkpoint.md).

## Package contract and packing

Root workspaces are exactly `packages/core`, `packages/compiler`,
`packages/vite`. Yarn 1 frozen installation succeeds without changing the
existing lockfile. Core source/package contract and compiler manifest/legal
material remain unchanged from Phase 9. Vite adapter implementation remains
byte-identical to Phase 8; metadata, engines and notices are extended.

All three packages are version **0.1.0**, public (`private: false`), ESM-only,
MIT metadata, with explicit file/export inventories. Repository metadata is
`git`, `https://github.com/lbframe/pandam-style.git`, and each corresponding
`packages/<name>` directory.

| Package | Exports | Dependencies / peers | Engines | sideEffects |
| --- | --- | --- | --- | --- |
| core | `.`, `./package.json` | None | None | `false` |
| compiler | `.`, `./config`, `./host`, `./package.json`; `pms-build` | core `0.1.0`, Babel tooling, CSS tokenizer and value parser; no peers | `>=20.0.0` | Omitted |
| vite | `.`, `./package.json`; `pandamstyle(options)` | compiler `0.1.0`; exact peer Vite `7.3.2` | `^20.19.0 \|\| >=22.12.0` | `false` |

No package has optional dependencies. Exact dependency ranges, declarations,
entry paths and browser/build-time boundaries are in the
[combined package contract](phase-8-9-package-contract.md) and the
[qualification report](../../evidence/phase-8-9-checkpoint/package-qualification/report.json).

| Tarball | Packed bytes | Unpacked bytes | Files | Repeat result |
| --- | ---: | ---: | ---: | --- |
| core | 6,397 | 23,365 | 10 | Byte-identical |
| compiler | 234,994 | 1,132,973 | 14 | Byte-identical |
| vite | 10,817 | 41,911 | 5 | Byte-identical |

Vite ships exactly `ATTRIBUTIONS.md`, `LICENSE`, `package.json`,
`src/index.js`, `types/index.d.ts`. The increase from Phase 8's 3-file package
is expected notice/metadata material. Compiler growth includes Phase 8 SDK
implementation/declarations. All complete file inventories and individual
SHA-256 digests are in
[tarball inventories](../../evidence/phase-8-9-checkpoint/package-qualification/tarball-inventories.json).
No tests, fixtures, evidence, pilot source, private compiler source, worktree
paths or donor source ship.

Repeated archive SHA-256 values, identical for both packs:

| Package | SHA-256 |
| --- | --- |
| core | `6ed9ee5078a071c543d8972c35567be5c311173531f88b06a2de5f110e021b58` |
| compiler | `31f146f5f2fa9641a399c694e4caad1f7dde323c37a1ea36ba619d4569a9e618` |
| vite | `37f95ab7b47523f281ea895270d6de7fa4f3fe936fe36744c6590534c0748b5a` |

A fresh detached checkout at the tested commit, initially without build output,
independently installed with Yarn 1, rebuilt and qualified all three packages.
Its inventories and archive hashes match the official run exactly. See
[clean-checkout proof](../../evidence/phase-8-9-checkpoint/clean-checkout-qualification.json).
All package LICENSE files equal the root bytes; compiler Panda notices and
derived-source mappings remain preserved. Package provenance checks passed;
this records supplied notices without making a new legal conclusion.

## External install, Node, SDK, CLI and types

The consumer installed three real tarballs plus Vite 7.3.2. Package realpaths:

```text
/tmp/pandamstyle-phase-8-9-wXnbXO/consumer/node_modules/@pandamstyle/core
/tmp/pandamstyle-phase-8-9-wXnbXO/consumer/node_modules/@pandamstyle/compiler
/tmp/pandamstyle-phase-8-9-wXnbXO/consumer/node_modules/@pandamstyle/vite
```

All are outside the repository with no workspace symlink, repository `file:`
back-reference or `NODE_PATH`. Qualification continued with this checkpoint's
package sources temporarily unavailable. The production closure is complete:
75 installed packages, zero donor packages, missing runtime dependencies,
workspace/file back-references, private PandamStyle dependencies or forbidden
reverse edges. Direction remains Vite → compiler → core.

| Node | Compiler/core imports, CLI and artifacts | Vite adapter | Real Vite dev/transform/build |
| --- | --- | --- | --- |
| 20.0.0 | Pass | Import/construction pass | Unsupported by upstream engines |
| 20.19.0 | Not an additional compiler minimum claim | Pass | Pass |
| 22.12.0 | Not an additional compiler minimum claim | Pass | Pass |
| 22.22.0 | Pass | Pass | Pass |

Vite's effective requirement follows its published 7.3.2 engines
`^20.19.0 || >=22.12.0`, also documented in the
[upstream guide](https://v7.vite.dev/guide/). Importing the adapter on 20.0.0
does not qualify unsupported Vite runtime operation. The exact peer is unchanged.

External compiler SDK lifecycle passes: create session, initialize, validate,
compile, current, candidateTokens, agentResult, full audit, prepare, abort,
commit and close. Public `/host` import and operations pass. Phase 8 extensions
`sourceOverlays`, `ArtifactResult.sourceDigest` and
`readGeneratedArtifacts(revision)` pass through the packed compiler: overlay
bytes differ from disk, digest matches exact source, immutable five-file reads
match publication, stale reads reject. No private compiler import is exposed
or used by the adapter: **0**.

External `pms-build` passes success/repeat, structured invalid-source diagnostics,
missing config/definition, invalid config, stale-output cleanup and recovery.
Generated `design.js`, `design.d.ts`, `manifest.json`, `styles.css`,
`artifacts.json` are coherent; tampered artifact identity rejects.

TypeScript 5.9.3 strict no-emit tests pass core, compiler root/config/host, Vite
plugin/options, Phase 8 SDK types and external generated design declarations.
All **11** expected invalid cases reject, including private/unknown vocabulary,
invalid recipe/condition/theme/composition/ABI inputs and invalid Vite options.

## Real Vite host qualification

The external pilot installs only packed public packages. No private seam or
repository import participates. Vite 7.3.2 dev matrix passes all **30** rows:
style/new atom/import/re-export edits, add/delete/rename and shared ownership,
pending transform, edit burst, invalid usage/repair, unresolved import/repair,
seven definition changes, pending close and reopen.

Integrated observations: **33 revision events, 9 HMR updates, 21 full reloads**.
All named row outcomes match Phase 8's historical matrix. Its rapid burst
accepted three watcher HMR revisions (9, 10, 11); this run accepted one (9),
then settled final CSS at revision 10. Final source and CSS digests are equal
across runs. Inference from that sequence and the unchanged adapter's exact
source reconciliation path: watcher coalescing plus a final transform overlay
accounts for two fewer HMR updates, one additional reload and one fewer revision
overall than 34/11/20. The adapter explicitly observes and reloads after that
reconciliation. This is scheduling behavior with unchanged policy, recorded in
[HMR comparison](../../evidence/phase-8-9-checkpoint/vite/hmr-comparison.json).

All seven global definition mutations retain `design-system-definition`:
exactly one accepted revision, one generation advance, one fallback and one
revision event with authenticated five-file publication. Canonical service
concurrency evidence separately proves one snapshot rebuild, one fallback and
one materialization. No duplicate rebuild is observed.

Production passes clean, byte-identical repeat (canonical set and bundle),
changed, failure/recovery and restored builds. Nine failure points pass:
invalid source before transform, transform, renderStart, generateBundle,
writeBundle, commitPrepared, edit during prepared publication, write:false and
multiple outputs. Prior valid output survives failed publication, stale tickets
reject and canonical five-file sets cannot mix. The last two modes retain
structured unsupported-feature diagnostics.

Two projects with the same relative module path remain isolated: different
registry/CSS digests and **zero** project-two events during project-one
invalidation. Revision/CSS coherence, monotonic bursts, rename serialization,
invalid retention and close/reopen checks pass.

## Browser, semantic and tree-shaking boundaries

Browser scan passes: generated runtime imports only core (application JSX also
uses React). Browser bundles contain no compiler/Vite build runtime, Node
imports, Babel or donor leakage. Vite's own Node imports stay at build time.

| Tree-shaking case | Bundle bytes |
| --- | ---: |
| Unused core | 1 |
| Props-only | 7,201 |
| One recipe | 7,304 |
| One theme | 7,278 |
| Two recipes | 7,477 |
| Finite dynamic axis | 18,944 |

Static cases remove unrelated vocabulary. Dynamic-axis aggregate selection
still retains unrelated `notice` recipe data, the documented Phase 9
optimization opportunity. Dynamic namespace indexing remains rejected with
`PMS_UNVERIFIED_PROPS_SOURCE`; no optimization expansion was attempted.

Semantic oracle: **129 total, 125 MUST_PRESERVE, 0 KNOWN_GAP, 4 DEFERRED,
0 failed, 0 unknown**. All six browser/SSR cases pass fresh, incremental and
cross-result equivalence. Expectations, ABI v1 and Diagnostics Protocol v1 are
unchanged. Donor closure passes: retired StyleX/parser/upstream trees absent,
zero `@stylexjs/*` or `@pandacss/*` in all three package closures.

## Host measurements

Single-run observations in milliseconds; references are not SLAs. Total
verification duration is not used as a compiler performance claim.

| Measurement | Integrated | Phase 8 reference |
| --- | ---: | ---: |
| Cold Vite ready | 327.7 | 329.5 |
| First transform | 22.1 | 22.3 |
| Style diagnostics | 15.6 | 20.7 |
| Style CSS settlement | 20.4 | 40.4 |
| Import diagnostics / settlement | 13.5 / 17.1 | — |
| Re-export diagnostics / settlement | 8.1 / 10.7 | — |
| Recipe-domain diagnostics / settlement | 16.4 / 19.4 | — / 102.2 |
| Production clean | 995.8 | 936.6 |
| Production repeat | 625.1 | 611.2 |
| Production changed | 579.3 | 585.5 |
| Failure recovery | 566.6 | — |
| Restored build | 553.8 | — |

Ordinary style edit recompiles one file and reuses three. Global definition
edits intentionally retain one canonical fallback. Individual host samples vary
(including shared-owner edits); full rows and counters remain available in
[performance evidence](../../evidence/phase-8-9-checkpoint/vite/host-visible-performance.json).
These samples do not establish a statistical speed improvement or regression.

## Official verifier and completion

Exact required order: install, build, pandamstyle, pandamstyle-core,
semantic-oracle, tooling-tests, pilot, artifacts, donor-closure,
package-qualification. Required count **10**; package qualification covers all
three packages and pilot uses public Vite.

`complete=true`, `verdict=verified`, `failedSteps=[]`, `skippedSteps=[]`,
`omittedRequiredSteps=[]`. Test breakdown: compiler 547/25 suites, core 14/1,
semantic 148/20, tooling 91/5; **800/51**, no failures or skips. See
[official summary](../../evidence/phase-8-9-checkpoint/verify/summary.json).

An earlier full run on `e8052bfa` passed the test suites but its pilot scan
incorrectly matched minified React's `{node:n}` property as a Node import.
`487ddeef` restricts that check to quoted import specifiers and preserves the
other forbidden-runtime checks. The entire ten-step verifier was rerun clean;
earlier failed evidence is retained under `attempts/e8052bfa` and is not used as
the final qualification. Fresh-checkout qualification also uses `487ddeef`.

All freshly generated reports are under `evidence/phase-8-9-checkpoint/`.
Historical Phase 8 evidence is used only for explicitly labelled comparisons.
Only evidence and this delivery record may differ from tested to final.

Final gate after commit/push/readback: Phase 8 **CLOSED**, Phase 9 **CLOSED**,
checkpoint **CLOSED**, Phase 10 (`@pandamstyle/next`) **AUTHORIZED**.
Phase 10 has not started. PR: **no**. Merge: **no**. npm publish: **no**.
No Next, Rsbuild, native-engine work or production-release claim is included.
