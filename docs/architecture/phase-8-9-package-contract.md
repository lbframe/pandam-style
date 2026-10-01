# Combined public package contract: 0.1.0

The checkpoint's public package graph comprises `@pandamstyle/core`,
`@pandamstyle/compiler`, and `@pandamstyle/vite`, all version `0.1.0` and
ESM-only. This document describes the implementation contract; the
[checkpoint delivery](phase-8-9-checkpoint-delivery.md) binds qualification
results to an exact tested tree.

| Package | Public entries | Types | Runtime requirement | Dependencies and peers |
| --- | --- | --- | --- | --- |
| core | `.`, `./package.json` | `src/types.ts` | Browser safe; no Node engine restriction | No runtime dependencies or peers |
| compiler | `.`, `./config`, `./host`, `./package.json`; `pms-build` CLI | `types/index.d.ts`, config/host declarations | Node `>=20.0.0` | Exact core `0.1.0`; Babel core/helper-module-imports/parser/preset-react/preset-typescript/traverse/types, `@csstools/css-tokenizer`, `postcss-value-parser`; no peers or optional dependencies |
| vite | `.`, `./package.json`; `pandamstyle(options)` and its default alias | `types/index.d.ts`, public `PandamStyleOptions` using compiler types and Vite `Plugin` | Node `^20.19.0 || >=22.12.0` with Vite 7.3.2 | Exact compiler `0.1.0`; exact Vite peer `7.3.2`; no optional dependencies |

Core and Vite set `sideEffects: false`; compiler does not make a blanket
side-effects claim. All packages have MIT metadata, repository type `git`, URL
`https://github.com/lbframe/pandam-style.git`, and their respective
`packages/core`, `packages/compiler`, or `packages/vite` repository directory.
All are public package manifests (`private: false`), with explicit files and
exports. No CJS public entry or private deep import is provided.

## Runtime and host boundaries

Application generated runtime imports only core. Compiler is a Node build tool;
Vite is a build-time configuration adapter. Neither belongs in browser bundles.
The allowed package direction is Vite → compiler → core. Core does not depend
on compiler/Vite, compiler does not depend on Vite, and no private PandamStyle
package or donor CSS-library dependency is admitted.

Compiler ships built `lib/`, CLI `bin/`, public `types/`, licenses, attribution
and the Phase 4 derived-source mapping. Core ships its small runtime/types and
package-specific notices. Vite ships `src/index.js`, `types/index.d.ts`,
`LICENSE`, `ATTRIBUTIONS.md` and its manifest. Tests, fixtures, pilot source,
evidence, logs, compiler private source and donor source do not ship.

The compiler retains its Phase 9 package/CLI contract and the three typed
Phase 8 SDK additions: `MutationTransaction.sourceOverlays`,
`ArtifactResult.sourceDigest`, and `readGeneratedArtifacts(revision)` on the
session and host bridge. These use the existing canonical service and exact
revision checks; they add no private root export. Generated output remains
`design.js`, `design.d.ts`, `manifest.json`, `styles.css`, `artifacts.json`,
with configurable adjacent facade/declaration filenames and ABI v1.

## Node and Vite qualification claims

Compiler/core qualification includes Node 20.0.0 and 22.22.0. Vite integration
qualification includes Node 20.19.0, 22.12.0 and 22.22.0. Vite's published
7.3.2 manifest declares `^20.19.0 || >=22.12.0`; the adapter manifest matches
that effective requirement. Node 20.0.0 adapter import/construction alone does
not establish supported Vite runtime operation. The upstream requirement also
appears in the [Vite 7 guide](https://v7.vite.dev/guide/).

Only Vite 7.3.2 is qualified. `build.write: false` and multiple outputs remain
explicit structured unsupported modes. Future Vite versions require a new
compatibility matrix. npm external installation from local tarballs is tested;
Yarn 1 is the repository workspace workflow, not an additional consumer claim.

## Types, bundling and reproducibility

Strict no-emit TypeScript qualification covers core, compiler root/config/host,
Vite options/plugin and externally generated design declarations. Consumer
types need no private compiler import. Invalid/private vocabulary, unsupported
recipe domains, invalid condition/theme names and invalid Vite options reject.

Tree shaking retains the Phase 9 cases: unused core, props-only, one recipe,
one theme, two recipes and finite dynamic axis selection. Static use removes
unrelated vocabulary. Dynamic axis selection retains unrelated `notice` recipe
data through the generated recipes aggregate; this known optimization
opportunity is not changed by the checkpoint. Dynamic namespace indexing
rejects with `PMS_UNVERIFIED_PROPS_SOURCE`.

Repeat packing compares full inventories, file content SHA-256 digests and
archive bytes independently for all three packages. Exact sizes/digests are
evidence observations in `evidence/phase-8-9-checkpoint/`, not fixed acceptance
constants. Legal/provenance checks compare actual notices; they make no new
legal conclusion. Qualification does not publish packages or claim a production
release. No Next package is implemented by this checkpoint.
