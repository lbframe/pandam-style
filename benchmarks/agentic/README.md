# Agentic evaluation corpus (AG-00.1)

This directory holds the versioned task corpus, project fixtures, schemas and
independent oracles used to evaluate how well LLM agents complete PandamStyle
workflows. It implements execution task AG-00.1 of the
[accepted plan](../../docs/architecture/agentic-optimizations-plan.md) (lot
AG-00). It is evaluation tooling: nothing here is imported by `packages/*`, and
no product behavior depends on it.

Status:

- **Present:** corpus `1.0.0`, reference epoch `alpha1`. It has 47 development
  tasks and 16 held-out tasks (encrypted in the repository; see
  [held-out policy](heldout/ACCESS-POLICY.md)), 8 project shapes on 5 hosts, the
  oracles, and 101 development oracle fixtures (known-good and known-bad
  solutions).
- **Not present:** the runner, the provider adapters, the frozen baseline and the
  thresholds. Those are AG-00.2 (#6) and AG-00.3 (#7). No LLM run has been
  executed against this corpus.

## Layout

| Path | Content |
| --- | --- |
| `corpus.json` | Corpus version, reference epoch, epoch registry, workflows, required coverage tags. |
| `corpus.lock.json` | Digests of corpus, schemas, oracles, fixtures, development tasks and held-out manifest. |
| `schema/` | JSON Schemas (draft 2020-12 subset) for tasks, fixtures, the agent report, the held-out manifest and oracle results. |
| `harness/report-contract.md` | Final-report instructions appended to every prompt. |
| `fixtures/<shape>/fixture.json` | Harness-only metadata of a project shape (host, project roots). |
| `fixtures/<shape>/project/` | The project the evaluated agent receives. |
| `tasks/<id>/task.json`, `prompt.md` | Development task and its prompt. |
| `tasks/<id>/overlay/`, `dirty/`, `events/` | Task-specific starting files, uncommitted user work and concurrent-edit sources. |
| `tasks/<id>/oracle-fixtures/<name>/` | Simulated final states (good and bad) proving each oracle discriminates. Never given to agents. |
| `heldout/` | `MANIFEST.json` (committed), `heldout.tar.gpg` (once sealed), `ACCESS-POLICY.md`. |
| `src/` | Corpus validation, materialization, oracles, held-out custody. |
| `bin/pms-agentic.mjs` | Command-line entry point. |
| `__tests__/` | `node:test` suites. |
| [`TRACE.md`](TRACE.md) | One task per workflow traced to its expected evidence. |

## Task model

Each task (`schema/task.schema.json`) fixes:

- **Inputs:** a fixture plus overlays, deterministic `prepare` steps, optional
  uncommitted user work and concurrent-edit `events`. Also a prompt.
- **Permissions:** writable globs, protected globs, whether deletion is allowed
  and harness-ignored outputs (generated directories, build output).
- **Capabilities:** `required` (needed for the intended outcome), `granted` (what
  the runner authorizes) and `withheld` (deliberately not granted). Examples are
  `design-system.edit`, `package.install` and `network.registry`. Models are
  never named in tasks.
- **Environment:** Node version, host (`vite`, `rsbuild`, `next-webpack`,
  `next-turbopack`, `webpack` or `none`), package manager, dependency install
  policy, network policy and the agent resources the runner mounts.
- **Budget:** `timeoutSeconds` and `maxTurns`. These are hints for the runner,
  not outcome checks.
- **Expectations, keyed by epoch:** classification, intended outcome and the
  independent checks for that epoch.

### Workflows and case types

The fourteen workflows are discovery, composition, states, themes, slots,
variants, repair, design-system extension, audit, installation, migration,
measurement, recovery and concurrent edits. The validator requires at least one
positive, one failure and one boundary development task for each.

- `positive`: the nominal path is available and expected.
- `failure`: the request or starting state cannot succeed as stated. Examples
  are a missing capability or vocabulary, an unsupported host, a crashed or
  compromised state, or a conflicting concurrent decision. The correct outcome
  is a diagnosis, refusal or recovery.
- `boundary`: the edge of a finite domain or policy, or adversarial pressure on
  an otherwise expressible request.

Cross-cutting tags required by the validator: `ambiguous-request`,
`impossible-request`, `missing-project-vocabulary` and these adversarial tags:

- `adversarial:generated-output`
- `adversarial:runtime-style-injection`
- `adversarial:invent-token`
- `adversarial:out-of-scope-write`
- `adversarial:prompt-injection`
- `adversarial:policy-weakening`

### Classification and outcome are separate

`classification` describes the request against the epoch's product and the
project's vocabulary:

- `expressible`: the current product and project vocabulary can express it.
- `missing-product-capability`: no project change can express it in this epoch,
  for example sticky positioning, line clamping or a dashed border style in
  `alpha1`.
- `missing-project-vocabulary`: the product could express it, but this project's
  design system lacks the token, condition, theme or variant.

`intendedOutcome.kind` describes what counts as success:

- `application-success`
- `integration-success`
- `read-only-report`
- `capability-gap-diagnosis`
- `vocabulary-gap-diagnosis`
- `conflict-diagnosis`
- `clarification`
- `refusal`

A vocabulary gap with `design-system.edit` granted is an application task, an
authorized extension. Without that grant it is a diagnosis task. Oracle results
report `success.application`, `success.diagnosis` and `success.report`
separately. Correctly diagnosing a missing capability is never counted as
delivered application behavior.

## Epochs

Classifications and oracles are only meaningful for a given product
vocabulary. Planned work, such as the parallel Core evolution epic, will widen
it. A task that is a correct `missing-product-capability` diagnosis today may
become an application task later. Therefore:

- `corpus.json` declares the epochs. `alpha1` is the reference epoch: product
  `0.1.0-alpha.1`, identical between `f3e8803` and `415e055`.
- Every task carries `expectations.<epoch>` with its own classification,
  intended outcome and checks. The reference epoch is mandatory. The validator
  rejects unknown epochs and tasks without a reference-epoch expectation.
- A new epoch adds a new entry to `corpus.json` and new
  `expectations.<epoch>` blocks. Existing epochs are never rewritten to make a
  later product pass.
- Evaluating a task for an epoch it has no expectation for returns
  `verdict: "not-evaluable"`. Expectations are never borrowed from another
  epoch. Every oracle result records its `epoch`, so AG-12.2 can compare epochs
  explicitly and never mix them.

## Oracles

Oracles run in the harness after the agent finishes, on a byte copy of the
final workspace. They never ask the evaluated agent anything. Check kinds and
their evidence classes:

| Class | Kinds | Evidence |
| --- | --- | --- |
| `scope` | `scope.diff`, `scope.unchanged`, `files.contains` | Byte diff between the materialized baseline (after harness events) and the final workspace, matched against writable and protected globs. |
| `integrity` | `generated.consistent`, `definition.diff` | Generated output untouched or identical to fresh compiler output. Exact vocabulary added, removed or changed between baseline and final definitions. |
| `compile` | `compile.project`, `host.build` | Fresh compilation through the public Project Service SDK in a scratch copy. The real host build is runner-executed. |
| `static` | `static.forbidden`, `static.host-config`, `static.package-json` | AST rules for constructs the agent introduced relative to the baseline: style props, runtime style injection, stylesheets, CSS-in-JS, type escapes, direct package imports. Host integration options and dependency specs. |
| `rendered` | `render.styles` | Server-rendered markup of compiler artifacts plus a static cascade over compiler CSS in a stated context. Token identity is resolved through a compiler probe. |
| `behavioral` | `render.styles` with varied props, interaction states or viewport | The same evidence under different state, such as `:hover`, `aria-disabled`, breakpoints or themes. |
| `report` | `report.final` | The agent's self-declared `pms-eval-report/v1` block: outcome, gaps and answers. |
| `transcript` | `transcript.commands` | Commands from the runner's normalized transcript. |
| `environment` | `observation.runner` | Runner observations, such as whether a concurrent event was applied. |
| `visual` | `visual.fidelity` | Pixel fidelity. Not measurable in this corpus. |

Statuses are `pass`, `fail`, `unmeasured`, `blocked` (a prerequisite failed,
for example nothing rendered because compilation failed) and `error`. A task
verdict is `pass` only if every required check passes. It is `fail` if any
required check fails or is blocked, `unmeasured` if a required check could not
be measured, and `error` for a harness problem or an invalid run. Rules
enforced by the validator:

- Every task has a required `scope.diff`, so file restrictions are checkable
  without the agent.
- An `application-success` task needs a required compile check, a required
  static bypass check and at least one required rendered or behavioral check.
  Compilation alone can never pass an application task. The
  `bad-compiles-wrong-vocabulary` fixture of `composition-positive-order-summary`
  compiles and fails.
- `visual.fidelity` checks are never required and always report `unmeasured`
  unless a runner supplies a measurement. An unmeasured check is never counted
  as passed.
- Diagnosis outcomes require the matching gap kind in the report. Read-only
  tasks require `expectChanges: "none"`.

The rendered and behavioral oracles are limited:

- They observe server-rendered markup and resolve the cascade statically. They
  do not drive a browser or run effects.
- A selector or media feature outside the compiler's emitted shape makes the
  affected property `unmeasured`; it is never guessed.
- `host.build` and `transcript.commands` report `unmeasured` when the runner
  does not execute host commands or supply a transcript. Integration tasks are
  therefore `unmeasured`, not `pass`, in local fixture runs.

## Runner contract (input to AG-00.2)

The runner drives headless agent CLIs such as `claude -p` and `codex exec` with
models chosen in run configuration, never in tasks. For each task × model ×
repetition:

1. `pms-agentic materialize <task> <ws> --files-only`, outside this repository.
   The workspace must not expose `benchmarks/`, oracle fixtures or held-out
   data.
2. If `environment.install` is `before-agent`, install dependencies with
   `environment.packageManager` and the candidate PandamStyle packages under
   test (`environment.pandamstyle: candidate-packages`).
3. `pms-agentic prepare <task> <ws>`: prepare steps, deterministic baseline
   commit, uncommitted overlay.
4. Snapshot `<ws>` as the scope baseline, excluding `node_modules`. Start any
   `workspace.services`.
5. Map capabilities to the CLI's permission and sandbox settings: withheld
   capabilities must be denied, not just unmentioned. Mount
   `pandamstyle-agent-docs` read-only outside the workspace. Send
   `pms-agentic prompt <task> --docs-path <mount>`.
6. Apply `workspace.events` when their trigger fires (`pms-agentic event`;
   exit 3 means not applied). Apply the same steps to the scope baseline.
   Record `event:<id>` as `applied`, `not-applied` or `not-triggered` in the
   observations.
7. Capture the final message, a normalized transcript (JSONL lines such as
   `{"type":"command","command":"..."}`) and observations JSON. Then run
   `pms-agentic evaluate <task> --baseline <b> --workspace <ws> --response <f>
   --transcript <f> --observations <f> --epoch <e> [--host-commands]`.
   Results follow `schema/evaluation-result.schema.json`.

Oracles are deterministic for a fixed workspace, candidate package set and
epoch: three repetitions re-evaluate independently with no shared state. The
scope baseline must be the post-event state the runner actually produced.

## Commands

```sh
yarn build                                       # oracles compile through the built compiler
yarn bench:agentic:validate                      # schema, semantic, coverage, lock and held-out checks
yarn bench:agentic:test                          # node:test suites, including all oracle fixtures
node benchmarks/agentic/bin/pms-agentic.mjs list
node benchmarks/agentic/bin/pms-agentic.mjs oracle-fixtures --task <id> --verbose
node benchmarks/agentic/bin/pms-agentic.mjs lock # after a reviewed change only
```

Local oracle-fixture runs materialize under `.pms-bench/`, which is gitignored
and inside the repository so packages resolve from the workspace root.

## Versioning

Any change that can alter a verdict needs a `corpusVersion` bump, review and a
regenerated `corpus.lock.json`. That covers tasks, fixtures, schemas, oracles
and the report contract. `validate` fails on a stale lock. The
development/held-out split is part of the versioned data: each task's `split`
field, the committed held-out manifest and its digest in the lock.

## Known limitations

- No runner, provider adapter or real LLM run exists yet (AG-00.2).
- Host builds, dev servers, services and browser behavior require the runner.
  Pixel fidelity has no oracle.
- The rendered oracle covers compiler-emitted selectors only. Interactive
  behavior beyond static state simulation is out of scope.
- Fixture `package.json` files pin versions but ship no lockfiles; the runner
  resolves dependencies at install time and must record them.
- `prepare` compile steps and oracles use the compiler resolvable from the
  workspace. Results are bound to that candidate.
