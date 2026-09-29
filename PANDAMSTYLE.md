# PandamStyle

Library with a constrained vocabulary: **StyleX fork + selected and adapted
Panda CSS modules**. The goal: agents compose with an authorized design
vocabulary instead of reinventing micro-decisions.

## Repository contents

| Path | Contents |
|---|---|
| `packages/@stylexjs/*` | StyleX fork code (upstream remote → facebook/stylex) |
| `packages/@stylexjs/babel-plugin/pandamstyle/` | PandamStyle modules: registry, policy, compiler, recipe, plus the native Babel plugin, build pipeline, codegen and bundler adapter |
| `packages/@pandamstyle/compiler/` | Installable package: the fork engine bundled with the PandamStyle modules. Exposes `.`, `./runtime`, `./vite` and the `pms-build` bin |
| `benchmarks/pandamstyle/` | The benchmark laboratory: corpus generator, campaign runner, the engine-vs-engine oracle, the incremental-vs-fresh-rebuild oracle and the long-session memory trace |
| `packages/@stylexjs/babel-plugin/__tests__/pandamstyle/` | Tests and fixture projects: one valid project (JS/TS/TSX) and 14 negative projects, each built by a real process |
| `pilot/vite-react/` | Vite + React pilot application, installed from local `npm pack` tarballs |
| `docs/pandamstyle-specification-v0.1/` | Specification v0.1 (architecture, P0 scope, acceptance, decisions) |
| `evidence/l0/`, `evidence/demo/` | Historical L0 baseline and demo evidence (kept unchanged) |
| `evidence/native/` | This batch's run: report, environment, per-step logs, digests |
| `upstream/panda/` | Vendored Panda CSS donor (comparison source) |
| `tools/pilot/run-pilot.sh` | Pilot driver: pack, install outside the workspace, build |
| `verify-pms.sh` | Verification entry point |

## Verify the work

```bash
./verify-pms.sh
```

Steps, each propagating its own failure: dependency install, build of the
delivered packages, the upstream reference suites, the PandamStyle suites, the
Vite pilot, then artifact collection with digests. Output lands in
`evidence/native/` (`env.json`, `summary.json`, `steps.tsv`, one log per step).

Use **Node 22** — the major pinned by `.nvmrc`. On that major
`yarn install --frozen-lockfile` completes with no `--ignore-engines`, which the
historical Node 26 baseline required.

`PMS_OUT_DIR` selects the run directory. It must resolve inside the repository
and is refused otherwise. `PMS_SKIP_INSTALL=1` and `PMS_SKIP_PILOT=1` skip a
step; both are recorded in `summary.json` rather than hidden.

Reference results: 1007 upstream babel-plugin tests (64 skipped, 887 snapshots),
99 upstream stylex tests, 111 PandamStyle tests, plus a green pilot build. See
`evidence/native/REPORT.md`.

## Incremental compilation (project session)

`buildProject` is a **full rebuild**: every covered file is read, parsed and
compiled on every invocation. `@pandamstyle/compiler` also exports
`createProjectSession`, a reusable session over one project that keeps the state
a build produces — per-file compiled results, per-file rule contributions,
per-file coverage certificates, the forward and reverse module graphs and the
resolution state — and reuses it across revisions.

```js
const { createProjectSession } = require('@pandamstyle/compiler');

const session = createProjectSession({ definition, roots, outDir });
session.initialize();          // revision 1: the full analysis
session.validate();            // the verdict for the active revision
session.compile();             // transactional publication of that revision

// later, in the same process:
session.applyChanges({ addedFiles: [...], removedFiles: [...] });
session.validate();
session.compile();
session.close();
```

The contract is exact equivalence:

> `incremental(revision N) == fresh_full_rebuild(revision N)`

for every externally meaningful compiler semantic — the same bytes, the same
diagnostics with the same locations, the same coverage set, the same stylesheet
in the same cascade-relevant order. Reuse is decided by a **validity key** per
file (source content hash, role, compiler contract version, project semantic
epoch, engine options, local edge resolutions, design-system view), never by
path, never by mtime, and never by "the file is still there". A file's
compiled result depends on its own source, on the design system, and on what
its own module edges resolve to — not on the content of any other covered file,
which is what makes reuse possible at all.

A change the session cannot yet reason about locally — the design system, the
policy, the roots, the compiler or resolution configuration — is an explicit,
**counted** full fallback, and the reason is reported on the revision and in
`build-report.json`. Publication stays transactional: a refused revision returns
its diagnostics, publishes nothing, and leaves the previous generation current.

The measurements, the oracle and the known limits are in
`evidence/performance/spike-2/`.

## Status

**Native compilation and the pilot build are demonstrated over the described
scope** — a conforming JS/TS/TSX page compiles to static CSS and consumable
JavaScript, and `padding: '17px'` fails a real build process with
`PMS_FORBIDDEN_VALUE`, with no TypeScript involved.

**P0 is not yet validated.** Still unmet, and not claimed:

- generated TypeScript types (no `types` export is declared on purpose);
- SSR, hydration, TanStack Start, advanced HMR;
- browser-level proof of the cascade and condition ordering;
- the acceptance ranges this batch did not execute — see the case table in
  `evidence/native/REPORT.md`, which distinguishes `passed`, `not_run` and
  `blocked`.

Earlier limits recorded in `evidence/demo/REPORT.md` (AST traversal,
cross-file resolution, build integration, out-of-workspace install, coverage)
are now closed by this batch; the historical report is left unchanged.
