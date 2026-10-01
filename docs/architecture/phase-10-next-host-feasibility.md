# Phase 10 Next host feasibility

Research frozen on 2026-10-01 against roadmap commit
`339e777d85dc5b2ef31f24ece408ebb791bb822e`, tree
`6aa8abf5afed29e313ceffc8828adbbd06bda060`.
This is a feasibility decision, not backend qualification.

## Versions and runtime

The official documentation currently identifies Next **16.3.8** as latest.
The Next-published npm manifests and official source tags were inspected for
15.5.0, 15.5.27, 16.0.0 and 16.3.8. The latest stable 15.5 patch observed in
the publisher's registry metadata was **15.5.27**. Qualification initially
targets **16.3.8 + webpack** only. No 15.5.x or broad 16.x support is declared.
No backend is qualified by this document.

| Investigated version | Upstream Node requirement | Compiler intersection | Disposition |
| --- | --- | --- | --- |
| 15.5.0 / 15.5.27 | `^18.18.0 || ^19.8.0 || >=20.0.0` | `>=20.0.0` | Researched; not a qualification target |
| 16.0.0 / 16.3.8 | `>=20.9.0` | `>=20.9.0` | Exact 16.3.8 webpack candidate |

The compiler manifest requires Node >=20.0.0. The Next candidate's effective
minimum is therefore 20.9.0, independently of Vite's engines. The machine
runtime installed for research is Node 22.23.3; observing that runtime does not
qualify the lower bound. Published claims require actual external qualification.

Primary references: [Next 16 upgrade guide](https://nextjs.org/docs/app/guides/upgrading/version-16),
[Next 15.5 announcement](https://nextjs.org/blog/next-15-5),
[15.5.27 package source](https://github.com/vercel/next.js/blob/v15.5.27/packages/next/package.json),
[16.3.8 package source](https://github.com/vercel/next.js/blob/v16.3.8/packages/next/package.json).

## Backend selection and public integration

Next 15.5 defaults to webpack; Turbopack dev/build require explicit flags and
production Turbopack was introduced as beta. Next 16 defaults to Turbopack for
both commands. Its documented `next dev --webpack` and `next build --webpack`
select webpack. Adding a webpack callback does not select webpack; explicit
Turbopack flags can cause it to be ignored. The adapter must reject backend
mismatches before creating a service or compiling application source.

The supported webpack entry is the user `webpack(config, context)` callback.
Next supplies webpack and distinguishes client/node/edge contexts; its callback
can be invoked three times. The adapter can add a source pre-loader and plugins
through this callback. It must preserve the user's callback and unrelated Next
configuration. Next warns that webpack config customization is outside semver;
an exact tested peer is appropriate.

References: [custom webpack configuration](https://nextjs.org/docs/app/api-reference/config/next-config-js/webpack),
[CLI backend guide](https://nextjs.org/docs/app/api-reference/turbopack),
[16.3.8 CLI selection source](https://github.com/vercel/next.js/blob/v16.3.8/packages/next/src/lib/bundler.ts),
[15.5.27 build CLI](https://github.com/vercel/next.js/blob/v15.5.27/packages/next/src/cli/next-build.ts).

## RSC and client transforms

PandamStyle must receive the original filesystem-backed module bytes before
Next SWC, React Compiler and Flight transforms. A webpack `enforce: 'pre'`
loader is the candidate public ordering mechanism. It compares incoming bytes
to `ArtifactResult.sourceDigest`; a mismatch fails closed. Framework-generated
modules outside the declared roots are not assigned consumer provenance.
Generated facade bytes come from `readGeneratedArtifacts(revision)` and are
transported separately from consumer source.

`'use client'` and `'use server'` directives must survive the compiler output;
their preservation, server-to-client composition, nested layouts and runtime
bundle boundaries require actual Next fixtures. Framework support for RSC is
not evidence that this adapter preserves it.

References: [server and client components](https://nextjs.org/docs/app/getting-started/server-and-client-components),
[webpack loader ordering](https://webpack.js.org/configuration/module/#ruleenforce),
[16.3.8 Flight loader source](https://github.com/vercel/next.js/blob/v16.3.8/packages/next/src/build/webpack/loaders/next-flight-loader/index.ts).

## Dev, watching and invalidation

Webpack exposes compilation, failure, invalidation and watch-close hooks.
The candidate uses them for transport and settlement; Project Service watcher
events remain SDK mutations, never a second semantic graph. Source, context
and design-definition dependencies must participate in webpack cache/watch
identity. Successful recompilation must settle the exact validated revision;
failed compilation must abort its ticket and retain the prior generation.
Next handles Fast Refresh, RSC invalidation and browser reload transport.
Actual outcomes must be measured, including add/delete/rename and repair.

References: [webpack compiler hooks](https://webpack.js.org/api/compiler-hooks/),
[loader dependency API](https://webpack.js.org/api/loaders/),
[Fast Refresh](https://nextjs.org/docs/architecture/fast-refresh).

## Production settlement and limitations

Webpack `done` proves that compiler's result, not that the complete Next build
succeeded. `compiler.runAfterProductionCompile` also executes before type
checking and static page generation. Neither is a whole-build commit point.
The documented Next adapter `onBuildComplete` hook is the candidate production
settlement point; user adapter hooks must compose and run before PandamStyle
commit. The exact hook's coverage and late failure behavior must be qualified.
Unsupported output/worker modes must reject before compilation instead of
quietly changing user configuration.

Source inspection shows `onBuildComplete` runs after page generation and export,
but before standalone output copying. Consequently standalone output cannot be
claimed using that hook alone. There is no documented general build-failure
hook. Prepared tickets must remain unpublished on failure and be discarded
when the process/service closes; a backend without a supported settlement
surface is blocked. Do not patch Next's build functions or internal events.

References: [Next compiler hook](https://nextjs.org/docs/architecture/nextjs-compiler),
[adapter configuration](https://nextjs.org/docs/app/api-reference/config/next-config-js/adapterPath),
[adapter API](https://nextjs.org/docs/app/api-reference/adapters/api-reference),
[16.3.8 build ordering](https://github.com/vercel/next.js/blob/v16.3.8/packages/next/src/build/index.ts).

## CSS and cache delivery

The only CSS authority is the compiler's canonical CSS member. A webpack loader
may transport those bytes into Next's existing CSS pipeline; it cannot aggregate
rules or derive new CSS. The root layout should reference the generated CSS.
The facade and CSS must come from the same full revision. All five canonical
members are published exclusively through prepare/commit/abort.
No host writes a substitute canonical artifact set.

Cache identity includes the exact source and design/artifact identity. Retain
Next/webpack caches and qualify cold/repeat builds, restart, source/definition
mutation and routing caches. Disabling all caching is not acceptance proof.
References: [App Router CSS](https://nextjs.org/docs/app/getting-started/css),
[Next cache guide](https://nextjs.org/docs/app/guides/caching).

## Worker/process topology

Next dev uses a supervising CLI and server child process. Webpack build workers
are enabled by default without custom webpack configuration; customization
disables the default, while users can explicitly enable workers. Loader execution
must share one Project Service owner for the project/output. SSR/prerender workers
consume application runtime only. A cross-process transport may relay the public
SDK, but cannot create an independent semantic session in each loader worker.
Unsupported worker modes need an explicit rejection and an authority report.

References: [Next memory/worker guide](https://nextjs.org/docs/app/guides/memory-usage),
[16.3.8 webpack worker source](https://github.com/vercel/next.js/blob/v16.3.8/packages/next/src/build/webpack-build/index.ts),
[16.3.8 dev CLI](https://github.com/vercel/next.js/blob/v16.3.8/packages/next/src/cli/next-dev.ts).

## Turbopack decision: STOP / unsupported

Turbopack exposes `turbopack.rules`, aliases and extensions, with a subset of
webpack loader APIs. Options must be serializable and loaders return JavaScript;
webpack plugins are unsupported. The loader IPC delivers source/dependency/error
information, but no public per-dev-compilation success/failure/close transaction
hook is exposed to a config integration. The deployment adapter exposes config
modification and a production completion hook, not equivalent dev settlement.

The blocker is **observing and gating the complete dev framework compilation
for one exact Project Service revision**. A source loader's return is not evidence
that RSC/client compilation, chunk generation and CSS delivery succeeded. Committing
there would publish before downstream failures. Waiting for private Turbopack/Next
events, scraping terminal text, timers or instantiating per-loader services would
violate the required contract. `onBuildComplete` cannot fill a dev lifecycle gap.
The missing CSS-loader/emitFile capabilities are additional transport constraints,
not the sole reason for this decision.

Stop Turbopack implementation for both investigated lines. Reject its explicit
backend before compilation. Do not claim dev, production, RSC or hydration
support for it. Phase 10 remains **OPEN/BLOCKED** under the brief's explicit
Turbopack gate, even if webpack subsequently passes.

References: [Turbopack rules and missing loader features](https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack),
[unsupported webpack plugins](https://nextjs.org/docs/app/api-reference/turbopack#webpack-plugins),
[16.3.8 loader transport source](https://github.com/vercel/next.js/blob/v16.3.8/turbopack/crates/turbopack-node/js/src/transforms/webpack-loaders.ts).

## Required-read discrepancy

`docs/architecture/phase-8-delivery.md` is absent from the mandated base tree
(connector returned 404; local tree confirms absence). The complete Phase 8+9
checkpoint delivery and Phase 8 host contract were read instead. This discrepancy
is recorded rather than silently fabricating a historical document.
