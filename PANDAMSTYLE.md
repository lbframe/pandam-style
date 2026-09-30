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
| `packages/@stylexjs/babel-plugin/pandamstyle/`           | PandamStyle modules: registry, policy, compiler, recipe, plus the native Babel plugin, build pipeline, codegen and bundler adapter                                                                                           |
| `packages/@pandamstyle/compiler/`                        | Installable package: the fork engine bundled with the PandamStyle modules. Exposes `.`, `./runtime`, `./vite` and the `pms-build` bin                                                                                        |
| `benchmarks/pandamstyle/`                                | The benchmark laboratory: corpus generator, campaign runner, the engine-vs-engine oracle, the incremental-vs-fresh-rebuild oracle, the long-session memory trace, the agent-loop campaign and the Phase C correctness oracle |
| `packages/@stylexjs/babel-plugin/__tests__/pandamstyle/` | Tests and fixture projects: one valid project (JS/TS/TSX) and 14 negative projects, each built by a real process                                                                                                             |
| `pilot/vite-react/`                                      | Vite + React pilot application, installed from local `npm pack` tarballs                                                                                                                                                     |
| `docs/pandamstyle-specification-v0.1/`                   | Specification v0.1 (architecture, P0 scope, acceptance, decisions)                                                                                                                                                           |
| `evidence/l0/`, `evidence/demo/`                         | Historical L0 baseline and demo evidence (kept unchanged)                                                                                                                                                                    |
| `evidence/native/`                                       | This batch's run: report, environment, per-step logs, digests                                                                                                                                                                |
| `upstream/panda/`                                        | Vendored Panda CSS donor (comparison source)                                                                                                                                                                                 |
| `tools/pilot/run-pilot.sh`                               | Pilot driver: pack, install outside the workspace, build                                                                                                                                                                     |
| `tools/pms/`                                             | Verification reporting: the Jest-output reader that decides a run's verdict from suite AND test counts                                                                                                                       |
| `verify-pms.sh`                                          | Verification entry point                                                                                                                                                                                                     |

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

An AI agent knows which file it just wrote. `applyAgentChanges` asks the CALLER
where to look, and `validate()` answers with a compact, revision-bound,
machine-readable result instead of a project snapshot.

```js
session.applyAgentChanges({ changed: [file] });
const { agentResult } = session.validate();

if (!agentResult.ok) {
  // Structured, machine-authoritative. No prose parsing.
  for (const d of agentResult.diagnostics) {
    console.log(d.code, d.source.file, d.source.line, d.repair.kind);
  }
} else {
  const bytes = session.serializeAgentResult().bytes; // ~1.8 KB at c10000
  session.compile(); // generation committed
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
