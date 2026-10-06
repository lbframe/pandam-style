# Compiler and host API reference

This page lists the public API shape relevant to agents. Install and authoring
workflows are in [agent-install](../agent-install.md) and
[authoring reference](authoring.md).

## Public package exports

The current package manifests define these public entry points:

| Package entry | Public exports / purpose |
| --- | --- |
| `@pandamstyle/core` | `ABI_VERSION`, `assertAbi`, `props`, `defineRecipeSelector`, `PmsSelectionError`; public runtime types from `src/types.ts`. |
| `@pandamstyle/compiler` | `createProjectSession`, `PmsError`, `Codes`, `formatDiagnostic`, diagnostic protocol constants. |
| `@pandamstyle/compiler/config` | `defineConfig`, `token`, `patternStyles`, and their types. |
| `@pandamstyle/compiler/host` | `createHostBridge` and host bridge types. |
| `@pandamstyle/vite` | `pandamstyle(options)` Vite plugin. |
| `@pandamstyle/next` | `withPandamStyle(options)` Next config wrapper; package also exports `@pandamstyle/next/adapter`, `/loader`, and `/turbopack-loader`. |
| `@pandamstyle/rsbuild` | `pandamstyle(options)` Rsbuild plugin. |

Do not import package-private files or infer an export from an internal source
module. The consumer authoring API is the host-generated design-system module,
not direct calls to internal compiler functions.

## Host option types

Vite and Rsbuild host options require a `definition` object or path and a
nonempty list of `roots`; each adapter owns project root. Next options also
require `roots`, `definition`, and an explicit backend (`webpack` or
`turbopack`). Turbopack requires a publication mode; `semantic-dev` applies
only to the qualified development command. See package type declarations and
[agent-install](../agent-install.md#qualified-hosts) for supported exact host
versions and launch behavior.

The adapters are not generic postcss plugins and do not establish support for
other frameworks or bundlers. Do not expose internal `ProjectConfig` options as
host-supported without confirming the adapter type and host contract.

## Compiler Project Service

`createProjectSession` is a programmatic compiler SDK, not a project discovery,
migration, install or benchmark CLI. Its public configuration accepts
`rootDir`, `definition`, `roots` and optional output/engine settings. The
revision workflow includes initialization, changes, validation, compilation,
generated artifacts, diagnostics, audit and lifecycle methods. Consult
`packages/compiler/types/index.d.ts` for the exact method and result types
before writing a custom integration.

The only packaged executable in the compiler manifest is `pms-build`, invoked
as `pms-build --config <build-config-module>`. It performs a one-shot compile
for that config shape. It is not an audit, migration planner, host dev server,
interactive diagnostic repairer or benchmark runner.

## Diagnostics

Compiler diagnostics use a structured schema with `code`, `severity`, `phase`,
`rule`, `message`, `source`, `context`, `expected`, candidate metadata, repair
metadata, affected region, coverage and revision. `autofix` is `null`. Use the
reported source and finite expected/candidate domain as repair authority.
`PmsError.diagnostics` exposes structured diagnostics; `formatDiagnostic`
renders a human-readable line. See [agent-repair](../agent-repair.md) for the
local repair loop.

Examples of current error codes include `PMS_UNKNOWN_TOKEN`,
`PMS_INVALID_TOKEN_CATEGORY`, `PMS_TOKEN_NOT_PUBLIC`, `PMS_FORBIDDEN_VALUE`,
`PMS_UNSUPPORTED_PROPERTY`, `PMS_UNSUPPORTED_PROPERTY_FORM`,
`PMS_UNKNOWN_CONDITION`, `PMS_INVALID_VARIANT_KEY`,
`PMS_INVALID_VARIANT_VALUE`, `PMS_INVALID_RECIPE_SLOT`,
`PMS_AMBIGUOUS_RECIPE_COMPOUND`, `PMS_UNKNOWN_PATTERN`,
`PMS_INVALID_PATTERN_PARAMETER`, `PMS_NON_STATIC_VALUE`,
`PMS_COVERAGE_GAP`, and `PMS_ABI_MISMATCH`. This list is not exhaustive.

## Generated artifacts

The compiler produces generated JavaScript, types, manifest, CSS and artifact
metadata for a revision. Generated design-system output imports the public
`@pandamstyle/core` entry at runtime. The generated module and its declarations
are compiler-owned; consumers MUST NOT modify them. Run the qualified host
build/dev path to validate them as one generation.
