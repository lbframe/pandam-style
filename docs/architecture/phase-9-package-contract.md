# Phase 9 standalone package contract

Status: verified for the `0.1.0` core/compiler package boundary on the Phase 9
tested tree. This records the packages actually packed and exercised as npm
tarballs; it does not claim that future packages are shipped.

## Published package surfaces

`@pandamstyle/core` is an ESM package. Its value entry is `.` and its only
other public subpath is `./package.json`. The package ships the core runtime in
`src/`, the TypeScript declarations in `src/types.ts`, `LICENSE`, and a
package-specific `ATTRIBUTIONS.md`. It sets `sideEffects: false`, has no runtime
dependencies, and declares no Node engine requirement. The browser runtime is
small and uses no Node built-ins or compiler code.

`@pandamstyle/compiler` is ESM-only and declares Node `>=20.0.0`. Its public
value entry points are `.`, `./config`, and `./host`; `./package.json` is also
exported. The `pms-build` executable is `bin/pms-build.js`. The package ships
only built `lib/`, public `types/`, the CLI, package/legal material, and the
two Phase 4 provenance records. Its runtime dependencies include the exact
`@pandamstyle/core` `0.1.0` ABI package dependency, Babel parser/traversal and
transform packages, `@csstools/css-tokenizer`, and `postcss-value-parser`.
There are no peer or optional dependencies.

Both packages carry MIT metadata, repository metadata, and package-local legal
notices. Compiler tarballs include the root attribution record, the Panda MIT
notice, and the source-provenance mapping documents. They do not include the
compiler source tree, tests, fixtures, evidence, or donor source trees.

## Generated application boundary

The installed compiler generates the canonical set `design.js`, `design.d.ts`,
`manifest.json`, `styles.css`, and `artifacts.json`. The generated JavaScript
binds finite design-system data to the core ABI. Browser application bundles
depend on `@pandamstyle/core`; they do not depend on `@pandamstyle/compiler`,
Babel, Node built-ins, or donor packages. The compiler and its CLI are
Node-only.

The external TypeScript consumer checks public core, config, SDK, host, and
generated design-system declarations in strict no-emit mode. It accepts public
tokens, finite recipe axes, conditions, and themes, rejects private/invalid
values, and includes eight negative type assertions.

## Resolution, support, and measured bundling

The qualification installs local npm tarballs into a temporary consumer,
resolves all public entry points from that installation, checks package
realpaths, clears `NODE_PATH`, and temporarily makes the repository's
`packages/` directory unavailable while consumer commands run. npm is the
tested consumer package manager; this evidence does not claim Yarn or pnpm
consumer installation support.

Node `20.0.0` is the declared compiler/CLI boundary and was exercised directly.
The repository runtime, Node `22.22.0`, was also exercised. Core has no Node
engine restriction.

Tree shaking was measured from compiled application artifacts. Static use of
one recipe or one theme removes unrelated recipe/theme vocabulary, and an
unused core import produces a one-byte bundle. A finite dynamic recipe-axis
selection is supported and retains the generated recipe-selector module; in
the qualification fixture that bundle is 18,944 bytes and includes unrelated
recipe data because the generated facade exports recipes as one object. Dynamic
recipe namespace indexing is not supported by the tested compiler path and is
rejected with `PMS_UNVERIFIED_PROPS_SOURCE`. These are measured boundaries,
not claims that `sideEffects: false` alone proves tree shaking.

Repeated `npm pack` runs compare complete file inventories and SHA-256 content
digests. The tested archives were byte-identical as well. The qualification
tool emits npm metadata, tarball inventories, install/realpath/dependency
reports, runtime and CLI/SDK/type reports, bundle and browser scans, Node
matrix, legal/provenance checks, reproducibility data, and package footprint
measurements under `evidence/phase-9-release-qualification/`.
The exact run and machine-readable detail are in the
[package qualification report](../../evidence/phase-9-release-qualification/verify/package-qualification/report.json).

The qualification harness is repository tooling, not a publishing tool. A
later Phase 8+9 checkpoint can extend its explicit package descriptor and
external-consumer cases to include `@pandamstyle/vite`; Phase 9 does not
implement or qualify that package.
