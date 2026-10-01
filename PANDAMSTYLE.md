# PandamStyle

Library with a constrained vocabulary: **StyleX fork + selected and adapted
Panda CSS modules**. The goal: agents compose with an authorized design
vocabulary instead of reinventing micro-decisions.

Current technical checkpoint after performance Spikes 1–4:
[Strategic checkpoint — September 2026](docs/strategic-checkpoint-2026-09.md).
It records the final Phase D architecture, metric boundaries, semantic/product
gaps and next implementation order. Earlier measurements below remain historical
examples; P0 is still not validated.

## Repository contents

| Path                                                     | Contents                                                                                                                                                                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/@stylexjs/*`                                   | StyleX fork code (upstream remote → facebook/stylex)                                                                                                                                                                         |
| `packages/compiler/`                                     | Installable `@pandamstyle/compiler`: stable project SDK, compiler domains and `pms-build`; no temporary runtime or Vite export                                                                                               |
| `tools/pilot/vite-seam.js`                               | Qualification-only Vite seam used by the pilot; Phase 8 still owns public Vite support                                                                                                                                        |
| `benchmarks/pandamstyle/`                                | The benchmark laboratory: corpus generator, campaign runner, the engine-vs-engine oracle, the incremental-vs-fresh-rebuild oracle, the long-session memory trace, the agent-loop campaign and the Phase C correctness oracle |
| `packages/@stylexjs/babel-plugin/__tests__/pandamstyle/` | Current PandamStyle integration tests and fixture projects; their later move is a Phase 5 deletion precondition                                                                                                                |
| `packages/compiler/__tests__/engine-absorption-test.js` | PandamStyle-owned engine behavior tests added in Phase 4                                                                                                                                                                       |
| `pilot/vite-react/`                                      | Vite + React pilot application, installed from local `npm pack` tarballs                                                                                                                                                     |
| `docs/pandamstyle-specification-v0.1/`                   | Specification v0.1 (architecture, P0 scope, acceptance, decisions)                                                                                                                                                           |
| `evidence/l0/`, `evidence/demo/`                         | Historical L0 baseline and demo evidence (kept unchanged)                                                                                                                                                                    |
| `evidence/phase-4-engine-absorption/`                    | Phase 4 closure evidence: verifier, oracle, package graph, browser/SSR, isolation and performance                                                                                                                                 |
| `upstream/panda/`                                        | Vendored Panda CSS donor (comparison source)                                                                                                                                                                                 |
| `tools/pilot/run-pilot.sh`                               | Pilot driver: pack, install outside the workspace, build                                                                                                                                                                     |
| `tools/pms/`                                             | Verification reporting: the Jest-output reader that decides a run's verdict from suite AND test counts                                                                                                                       |
| `verify-pms.sh`                                          | Verification entry point                                                                                                                                                                                                     |

## Verify the work

```bash
PMS_OUT_DIR=evidence/phase-4-engine-absorption/verify \
  PMS_BATCH_BASE_REF=feat/pandamstyle-native-compiler ./verify-pms.sh
```

The required verifier runs 11 steps: dependency install, build, upstream
reference suites, PandamStyle and core suites, semantic oracle, tooling tests,
the packed Vite pilot, artifact collection, and donor closure. The command above
stores qualification output under the Phase 4 evidence directory.

Use **Node 22** — the major pinned by `.nvmrc`. On that major
`yarn install --frozen-lockfile` completes with no `--ignore-engines`, which the
historical Node 26 baseline required.

`PMS_OUT_DIR` selects the run directory. It must resolve inside the repository
and is refused otherwise. `PMS_SKIP_INSTALL=1` and `PMS_SKIP_PILOT=1` skip a
step; both are recorded in `summary.json` rather than hidden.

The Phase 4 delivery document records the exact final test and suite counts.

## Incremental compilation (project session)

`createProjectSession` is the stable compiler API. The private full-rebuild
reference used by tests is not a product export. A session owns one project, its
revisions, validated diagnostics, artifacts and publication state.

```js
import { createProjectSession } from '@pandamstyle/compiler';

const project = createProjectSession({ rootDir, definition, roots, outDir });
const initial = await project.initialize();
const result = await project.validate(initial.revision);
if (result.ok) await project.compile(result.revision);
await project.close();
```

The contract is exact equivalence:

> `incremental(revision N) == fresh_full_rebuild(revision N)`

for every externally meaningful compiler semantic — the same bytes, the same
diagnostics with the same locations, the same coverage set, the same stylesheet
in the same cascade-relevant order. Reuse is decided by a **validity key** per
file (source content hash, role, compiler contract version, project semantic
epoch, engine options, local edge resolutions, design-system view), never by
path, never by mtime, and never by "the file is still there". A file's compiled
result depends on its own source, on the design system, and on what its own
module edges resolve to — not on the content of any other covered file, which is
what makes reuse possible at all.

A change the session cannot yet reason about locally — the design system, the
policy, the roots, the compiler or resolution configuration — is an explicit,
**counted** full fallback, and the reason is reported on the revision and in
`build-report.json`. Publication stays transactional: a refused revision returns
its diagnostics, publishes nothing, and leaves the previous generation current.

The measurements, the oracle and the known limits are in
`evidence/performance/spike-2/`.

## The agent loop

An agent submits a complete revision transaction. The SDK returns a compact,
revision-bound Diagnostics Protocol v1 result.

```js
const revision = await project.applyChanges({
  baseRevision: initial.revision,
  mode: 'verified-explicit',
  changed: [file],
  added: [],
  removed: [],
  renamed: [],
});
const result = await project.validate(revision.revision);
if (!result.ok) {
  for (const diagnostic of result.diagnostics) {
    console.log(
      diagnostic.code,
      diagnostic.source.file,
      diagnostic.source.line,
    );
  }
} else {
  await project.compile(revision.revision);
}
```

The result carries the mutation (`declared` / `read` / `hashed` /
`contentChanged` / `contentUnchanged` / `noOp`, as six separate numbers), the
incremental work (`filesCompiled` / `filesRecompiled` / `filesReused`, and the
project size as a **number**), the coverage of the **affected** files only, and
four separate completion points — `diagnosticsReady`, `generationReady`,
`generationCommitted`, `auditReportReady` — with a duration beside each. A
failed revision reports the first and leaves the other three false: it published
nothing, and reporting a generation time for it would be inventing work.

A diagnostic is a protocol. Each one carries `code`, `severity`, `rule`, a
structured `source` (`file` / `line` / `column` / `role`), the violation's
`context`, an `expected` category or admitted domain, a capped `candidates` list
with its true `candidatesTotal` and a truncation flag, and a `repair` that is
either a structured suggestion or a stated reason there is none. `autofix` stays
`null`: `17` is not a proven equivalent of any token value.

**The full audit is still there.** `build-report.json` is small and carries the
coverage _counts_ plus a reference; `session.requestFullAudit()` produces the
project-wide snapshot for that revision, on demand, synchronously, and
byte-for-byte the array the monolithic report carried inline. Before `compile()`
the snapshot is staged into the generation, so a generation that contains it is
complete; after `compile()` it is written beside the output directory, because a
committed generation is never mutated.

`auditPolicy: 'inline'` reproduces the previous format exactly, for a host whose
reader is written against it, and so that the two policies can be measured
against each other on one compiler.

At c10000 a one-file agent edit is **173 ms** to diagnostics and the compact
build report is **3,301 bytes** instead of **5,003,195**. See
`evidence/performance/spike-4/`.

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

Earlier limits recorded in `evidence/demo/REPORT.md` (AST traversal, cross-file
resolution, build integration, out-of-workspace install, coverage) are now
closed by this batch; the historical report is left unchanged.
