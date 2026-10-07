# Agent contract: install PandamStyle

## Objective

Install the Alpha package for the detected, qualified host and make the
existing project compile with PandamStyle available. Installation MUST preserve
the current styling system and visible behavior. Installation MUST NOT perform
a migration unless the user also requested one.

## Prerequisites and inspection

Before editing files, the agent MUST inspect:

- Framework and version from the manifest and lockfile.
- Actual bundler and how the project starts it. Do not infer this from a
  framework default.
- Package manager from the repository's lockfile and package-manager field.
- Existing scripts, config format (ESM/CJS), TypeScript/JavaScript settings,
  source roots, generated-output paths, and local changes.
- Existing styling dependencies, global CSS imports, design tokens, themes,
  and generated files. Do not remove or rewrite them during installation.

Read the current package metadata and [support records](#qualified-hosts) before
choosing a host package. Exact versions below are compatibility evidence, not
permission to widen a peer range.

## Qualified hosts

| Status | Host configuration | Install integration | Required command/config behavior |
| --- | --- | --- | --- |
| Supported and compatibility-qualified | Vite `8.3.1` on Rolldown | `@pandamstyle/vite` | Register `pandamstyle({ definition, roots })` in the Vite plugin list. |
| Supported and compatibility-qualified | Next.js `16.3.8` with webpack | `@pandamstyle/next` | `backend: 'webpack'`; use explicit `next dev --webpack` and `next build --webpack`. |
| Supported and compatibility-qualified for semantic development | Next.js `16.3.8` with Turbopack | `@pandamstyle/next` | `backend: 'turbopack', publicationMode: 'semantic-dev'`; run dev through `pandamstyle-next dev --turbopack`. |
| Supported and compatibility-qualified for production build (separate strict mode) | Next.js `16.3.8` with Turbopack | `@pandamstyle/next` | Set `publicationMode: 'strict'`; run `pandamstyle-next build --turbopack`. |
| Supported and compatibility-qualified | Rsbuild `2.2.11` / Rspack `2.2.8` | `@pandamstyle/rsbuild` | Register `pandamstyle({ definition, roots })` in Rsbuild plugins. |

This table is the Alpha 1 compatibility contract. The [package architecture](architecture/package-architecture-v1.md),
[public API](architecture/public-api-v0.1.md), and [diagnostics protocol](architecture/diagnostics-protocol-v1.md)
describe the package boundaries and behavior. Package manifests declare peer
ranges for installation; they do not qualify additional host versions or modes.

Check the installed Node version against each package's declared `engines`
before editing. The engine field is a package requirement; it does not widen the
qualified host/version combinations in this table.

Other bundlers, other versions, Next custom output modes, a competing Next
deployment adapter, webpack worker compilation, and strict Turbopack
development are unsupported or not qualified. `semantic-dev` is only for the
qualified Turbopack development command; strict production build is a separate
mode. If the detected setup does not match the table, stop before package/config
edits and report the mismatch.

## Allowed actions

1. Resolve the package manager and Alpha package version from the checked-out
   release instructions or package registry tag. Keep all direct PandamStyle
   packages on the same Alpha release.
2. Add `@pandamstyle/core`, `@pandamstyle/compiler`, and exactly one host package
   as direct dependencies. `core` is imported by generated runtime output;
   `compiler/config` is imported by a design-system definition. Add them
   directly so Plug'n'Play and non-hoisting package managers can resolve them.
3. Add the host package integration to the existing config without replacing
   unrelated plugins or config callbacks. Create a design-system definition
   only if none exists; use the project's vocabulary and never invent a visual
   system as part of installation.
4. Set `roots` to the existing app-local JavaScript/TypeScript directories that
   contain PandamStyle-authored modules. Keep the generated output outside those
   roots. Do not use a broad repository root without checking what it covers.
   If the project has no PandamStyle-authored app code yet, create a dedicated
   empty source directory for future modules (for example, `src/pandamstyle`)
   and use only that directory as the root. Do not include the general app source
   tree just to activate the adapter; keep existing CSS imports and styling code
   outside the covered roots until those files intentionally adopt PandamStyle.
5. Update only the script/config entry needed to launch the selected qualified
   host mode. Preserve existing script names and behavior where possible.

For npm, the direct dependency form is:

```sh
npm install @pandamstyle/core@alpha
npm install --save-dev @pandamstyle/compiler@alpha @pandamstyle/vite@alpha
```

Keep `@alpha` on every direct PandamStyle package during Alpha 1, or pin all
packages to the exact version `0.1.0-alpha.1`. Do not rely on bare package
requests or treat npm's `latest` tag as the stable PandamStyle channel. The
first stable PandamStyle release will make `latest` authoritative for stable
installation.

Replace `@pandamstyle/vite` with `@pandamstyle/next` or
`@pandamstyle/rsbuild` for the detected host. Use the equivalent `pnpm add`,
`yarn add`, or `bun add` operation while preserving the repository's package
manager and lockfile. If the Alpha tag is not available, stop and report the
registry/version mismatch; do not silently install a stable or local workspace
copy.

### Host configuration shapes

Adapt these fragments to the existing file format, config callback, roots and
plugins. Do not overwrite a user's existing config.

Vite:

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

Next.js webpack:

```js
import { withPandamStyle } from '@pandamstyle/next';

const nextConfig = {};

export default withPandamStyle({
  backend: 'webpack',
  definition: './design.pandamstyle.config.js',
  roots: ['./app', './components'],
})(nextConfig);
```

The roots above are examples; include only directories that exist. Start and
build with the explicit `--webpack` flag. For Turbopack semantic development,
select `backend: 'turbopack'` and `publicationMode: 'semantic-dev'`, then invoke
`pandamstyle-next dev --turbopack`. For a supported production build, set
`publicationMode: 'strict'` and invoke `pandamstyle-next build --turbopack`.
Do not set `semantic-dev` for webpack, build, or start; strict Turbopack dev is
not qualified.

Rsbuild:

```js
import { defineConfig } from '@rsbuild/core';
import { pandamstyle } from '@pandamstyle/rsbuild';

export default defineConfig({
  plugins: [
    pandamstyle({
      definition: './design.pandamstyle.config.js',
      roots: ['./src'],
      outDir: './.pandamstyle',
    }),
  ],
});
```

The definition imports author helpers from `@pandamstyle/compiler/config`;
generated application modules import from the configured generated file.
Consult [design-system reference](reference/design-system.md) and
[authoring reference](reference/authoring.md) only when defining a new system
is required.

## Forbidden behavior

- MUST NOT rewrite existing CSS, CSS-in-JS, utility classes, tokens or themes.
- MUST NOT remove styling dependencies or change rendered design as an
  installation side effect.
- MUST NOT add PandamStyle runtime APIs or unsupported host integrations.
- MUST NOT broaden `roots` to conceal coverage gaps or add `passthroughUncovered`
  as a blanket workaround.
- MUST NOT hand-edit generated output or weaken TypeScript/build checks to hide
  failures.
- MUST NOT bundle installation with migration, benchmark claims, or design
  refreshes.

## Expected checks

After configuration, run the repository's package-manager install in frozen or
lockfile-preserving mode when available, then its existing type/lint checks.
Run the host's normal production build. Start the supported dev command, verify
the application opens, make one temporary local style edit in an existing
PandamStyle-covered file, verify the host observes it, then restore that edit.
For Next Turbopack, use the qualified wrapper command. Do not run a command for
an unsupported backend just to see whether it happens to work.

If the project has no safe dev smoke path, report that as unverified. Do not
claim a passing build or dev behavior without running it.

## Stop conditions

Stop before editing if the host/version/backend is outside the table, package
version resolution is ambiguous, config composition would discard user config,
or a required adapter combination is explicitly unsupported. Stop after install
if a host check fails; preserve the failure and diagnose it with
[agent-repair](agent-repair.md). Do not migrate styling to get installation to
pass.

## Completion report

Report host and exact versions, package manager, direct packages added,
config/scripts/files changed, styling system preserved, commands and results,
unverified checks, and any stop condition. Distinguish install success from
migration status.
