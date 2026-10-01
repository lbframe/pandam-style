# Phase 8: Vite host contract

Status: implemented on the Phase 8 branch; qualified with Vite `7.3.2`.

## Authority boundary

`@pandamstyle/vite` owns Vite hook registration, Vite module IDs, watcher event
collection, the dev-server CSS route, HMR delivery and the bundler output
lifecycle. It creates one `createProjectSession()` per configured project and
uses only the public `@pandamstyle/compiler` and `@pandamstyle/compiler/host`
entry points.

The Project Service remains the authority for source identity, graph closure,
coverage, diagnostics, design-system semantics, revisions, compiler output,
CSS aggregation, generated artifacts and publication tickets. The adapter has
no module graph, style registry, semantic reuse cache or publication writer of
its own. Its generated-artifact cache is scoped to one immutable revision. Its
dev CSS cache is transport-only, keyed by project, session, revision and CSS
digest, and retains at most 16 revision entries.

## Public entry and options

```js
import { pandamstyle } from '@pandamstyle/vite';

export default {
  plugins: [
    pandamstyle({
      definition: './design.pandamstyle.config.js',
      roots: ['./src'],
      outDir: './.pandamstyle',
    }),
  ],
};
```

`definition` is a public `Definition` value or a module path relative to
Vite's resolved root. `roots` is required and names the project-local
JavaScript/TypeScript source roots covered by the Project Service. The
remaining `ProjectConfig` options are accepted, except that Vite owns
`rootDir` and the definition option is required by the adapter. The declaration
file imports `Definition` and `ProjectConfig` from the compiler public package
and `Plugin` from the Vite peer.

The package is ESM-first and exports only `.` and `./package.json`. It declares
Vite `7.3.2` as an exact peer and depends on `@pandamstyle/compiler` `0.1.0`.
The qualification does not establish support for another Vite version.

## Source identity and dev updates

The adapter resolves Vite IDs by stripping query/hash suffixes, normalizing
`/@fs/` and file URLs, resolving symlinks, and checking that a JavaScript or
TypeScript file belongs to one declared root. A generated design-system import
resolves to the compiler's canonical in-memory generated module. The adapter
does not transform generated output as application source.

Each source transform reads `ArtifactResult` for the current full revision
identity. The returned source digest must equal Vite's transform input digest.
When Vite supplies newer in-memory source during `serve`, the adapter submits
that exact text through `MutationTransaction.sourceOverlays`; it then validates
and compiles the new service revision before returning the artifact. Production
builds reject source mismatches with a structured coverage/provenance
diagnostic. Source overlays are restricted to project-relative paths listed as
changed, added or renamed destinations, stay outside the generated output
directory, and are removed when a later filesystem mutation touches that path.

Valid edits go through `applyChanges()`, `validate()`, `compile()` and
`readGeneratedArtifacts()`. The dev stylesheet URL carries the exact service
session and revision. The server serves the CSS artifact recorded for that
identity and returns an error for an unavailable revision instead of serving a
different revision's CSS. Invalid edits send Diagnostics Protocol v1 data and
do not replace the last valid CSS or canonical generation. The virtual client
removes the diagnostics overlay after repair and updates the stylesheet URL
for a valid CSS revision.

Ordinary changed modules return Vite's invalidated module set for HMR. File
add/delete/rename and design-system definition changes trigger full reloads.
Definition changes use the service's named `design-system-definition` full
fallback, since the current compiler contract treats the complete definition
as one semantic input. The adapter waits for its add/unlink watcher journal to
settle before applying a dependent module edit, allowing a rename and matching
import update to arrive as one service transaction. Close waits for queued
service work, releases the watcher and session, and prevents late events from
publishing.

## Production output and limits

Vite performs normal source transforms and bundling. During `generateBundle`,
the adapter validates the exact current revision, reads the canonical five-file
set, emits its exact `styles.css` as `pandamstyle/styles.css`, and prepares the
service publication ticket. The ticket commits only after Vite's successful
`writeBundle` hook. Any build failure before commit preserves the previous
canonical generation; a service mutation after preparation revokes the stale
ticket. `closeBundle` aborts an uncommitted ticket and closes the session.

Phase 8 deterministically rejects `build.write: false`, more than one configured
Rollup output, and output-directory overlap. The tested adapter accepts
filesystem-backed `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs` and `.cjs` modules; Vue
single-file component submodules need a separate source identity adapter.
Production source-transform plugins must run after PandamStyle so output
modules share one Project Service revision.

No browser bundle should retain the adapter, compiler, Node builtins or
diagnostic machinery. Generated runtime imports remain governed by the
compiler's existing `@pandamstyle/core` contract.
