# Agentic evaluation corpus (AG-00.1)

This directory holds the versioned task corpus, project fixtures, schemas and
independent oracles used to evaluate how well LLM agents complete PandamStyle
workflows. It implements execution task AG-00.1 of the
[accepted plan](../../docs/architecture/agentic-optimizations-plan.md) (lot
AG-00). It is evaluation tooling: nothing here is imported by `packages/*`, and
no product behavior depends on it.

Status:

- **Present:** corpus `1.4.4`, reference epoch `alpha1`. It has 47 development
  tasks and 16 held-out tasks (encrypted in the repository; see
  [held-out policy](heldout/ACCESS-POLICY.md)), 8 project shapes on 5 hosts, the
  oracles, and 199 development oracle fixtures (known-good and known-bad
  solutions, including the independent reviews' probes).
- **Present (AG-00.2, #6):** the evaluation runner and its Claude Code and
  Codex adapters in [`runner/`](runner/), tested with adapter fixtures (fake
  CLIs) only. See [Runner](#runner-ag-002).
- **Not present:** the frozen baseline and the thresholds (AG-00.3, #7). No
  LLM run has been executed against this corpus; the first provider-backed run
  is the authorized smoke run of the runner's design note (section 9.4).

## Layout

| Path | Content |
| --- | --- |
| `corpus.json` | Corpus version, reference epoch, epoch registry, workflows, required coverage tags. |
| `corpus.lock.json` | Digests of corpus, schemas, oracles (including the DOM tree's manifest and lockfile), fixtures, development tasks and held-out manifest. |
| `schema/` | JSON Schemas (draft 2020-12 subset) for tasks, fixtures, the agent report, the held-out manifest and oracle results. |
| `dom/` | Harness-only dependency tree of the sandbox's DOM implementation (jsdom): `package.json` and `yarn.lock`, installed by `yarn bench:agentic:install`. |
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
| `rendered` | `render.styles` | Compiler artifacts rendered by the real `react-dom` client into a standards DOM (jsdom), plus a static cascade over compiler CSS in a stated context. Token identity is resolved through a compiler probe. |
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

Further rules make content and behavior part of the evidence, not just
structure:

- An application task needs at least one required render check asserting
  rendered content (`text`, `textMatches` or `texts`). A render check matching
  several elements must assert each element's content (`texts`).
- Rendered evidence is the DOM React committed, read after effects and
  deferred work settled and before any interaction. The sandbox returns it as
  a structured tree; serialized markup is never re-parsed (raw-text elements
  such as `<script>` or `<xmp>` serialize their text unescaped, and a
  `<template>` serializes its content rather than its children).
- Text assertions use presented text: descendants under `hidden`, `inert`,
  elements the user agent never renders (`<template>`, `<script>`,
  `<noscript>`, `<style>`, `<rp>`, ...), a closed `<dialog>`, a closed
  `<details>` (except its first `<summary>` child),
  `display:none`, `visibility:hidden`, `opacity:0`, `font-size:0`,
  `content-visibility:hidden` or a text color equal to its background
  contribute nothing. `aria-hidden` is not concealment: the text is still
  visible.
- Text whose presentation is undecidable counts only towards `unmeasured`: an
  assertion that holds without it passes, one that needs it is `unmeasured`.
  That covers popovers (jsdom has no popover state), form-control and embedded
  content (`<select>`, `<option>`, `<textarea>`, `<iframe>`, `<canvas>`, media,
  SVG and MathML), and the risky styles below.
- Every matched element must be presented, by the same rules along its
  ancestor chain. Concealment the static cascade cannot decide makes the check
  `unmeasured`, never `pass`: clip-path or clip, masks, overflow clipping,
  non-trivial transforms, scale, translate, rotate or filters, negative
  margins, insets or z-index, animations, text indentation and spacing, boxes
  of 1px or less, and any positioned (`absolute`/`fixed`/`sticky`) element in
  the rendered tree.
- Requested interactions are native events on the committed DOM: `click()`
  or a real `MouseEvent`, `KeyboardEvent` or `FocusEvent` that bubbles, with
  native `target`, `currentTarget`, `button` and `disabled` semantics. Only
  committed elements exist, so unused JSX and `cloneElement` results count
  exactly as React rendered them. Dispatch candidates must correspond one to
  one with the committed tree's elements carrying the test id. The target
  must be the single presented,
  enabled (not `disabled`, not under `pointer-events:none`) committed element
  with the test id. A clicked target must be a native control (`<button>`, an
  `<input>` button, checkbox or radio, `<a href>`, or a `<details>`' first
  `<summary>`): only those are keyboard operable by the platform (Enter and
  Space activation), which jsdom does not emulate, so custom `role="button"`
  widgets are not accepted. A render prop written `{"$pmsSpy": "onRemove"}` becomes a
  spy; `expect.callbacks` counts the calls made by that dispatch, and calls
  during render always fail.
- Style channels outside PandamStyle fail render checks and `no-bypass`,
  wherever they appear in the document, after rendering, each interaction and
  the sweep: `<style>` elements, style sheet `<link>`s (a `rel` with the
  `stylesheet` or `import` token, or `as="style"`; other links, such as
  canonical, icon or image preloads, are not style channels), `style`
  attributes, raw markup
  (`dangerouslySetInnerHTML`, also reported statically) and legacy
  presentational HTML. The presentational list is in
  `src/oracles/style-channels.mjs`: the elements `basefont`, `big`, `blink`,
  `center`, `font`, `marquee`, `nobr`, `spacer`, `strike` and `tt`; the
  attributes `align`, `alink`, `background`, `bgcolor`, `border`,
  `cellpadding`, `cellspacing`, `clear`, `color`, `face`, `frame`, `hspace`,
  `link`, `marginheight`, `marginwidth`, `noshade`, `nowrap`, `rules`, `text`,
  `valign`, `vlink` and `vspace`; `size` on `<hr>`; and `width`/`height` on
  anything but `canvas`, `embed`, `iframe`, `img`, `input`, `object`,
  `source`, `svg` and `video`. Attributes inside SVG are SVG's own, and custom
  elements (names with a hyphen) define their own attributes (not compared,
  so `unmeasured`). The DOM checks know each element's namespace; the static
  rules check attributes only on element names that are provably HTML
  (`HTML_ELEMENTS`), since a child component's JSX may render inside an
  `<svg>`.
- Generated integrity takes its references only from places the agent cannot
  edit: the harness's baseline snapshot and a fresh trusted recompilation of
  the final sources. The workspace's generation state is never trusted as an
  inventory. Full path inventories (the output directory and the state file)
  are compared exactly, deterministic files byte for byte, and the state file
  on every path-independent field. The build report is compared in full
  against the fresh one after normalising only path and session differences:
  project paths (covered roots, relay edges) are reduced to the part that
  names a file of the project, and the session record (`incremental`, the
  coverage report's `revisionId` and `materializedAt`) is dropped. The generation must be the fresh compiler generation (`must-match`),
  or either that or the byte-identical baseline generation (`no-hand-edits`).
  "Never generated" applies only when the baseline had no generation either;
  deleting a baseline generation fails. A task whose generated directory is
  harness-ignored must carry this check.

## Threat model

**What the oracles guarantee.** A `pass` means the observed final workspace
satisfies every required check. The checks are computed by harness code from
evidence the evaluated agent cannot forge: byte diffs, a fresh compilation by
the trusted compiler, sandboxed execution with a dynamic trace, and the static
analysis of its sources. An undecidable observation is `unmeasured`, never
`pass`.

**Assumed adversary.** An LLM coding agent that may cut corners, misread the
task, or follow prompt-injected instructions found in project files. That
includes editing generated output, writing outside its scope, injecting styles
at runtime, inventing vocabulary, or deliberately trying common bypasses it
has seen. It is not an arbitrary attacker with unbounded obfuscation budget
and knowledge of the oracle internals, and the oracles do not try to be an OS
sandbox for hostile native code.

**Layered defenses.**

1. **Scope and integrity (byte level).**
   - Workspace diffs are taken against the materialized baseline, matched
     against writable and protected globs.
   - Symbolic links are violations.
   - The full generated inventory is checked against the baseline snapshot
     and a fresh trusted recompilation, never against agent-editable state.
   - The vocabulary diff covers token references.
2. **Trusted compilation.** `project-worker.mjs` compiles through the public
   SDK and never executes anything derived from agent input. Definitions
   arrive as sandbox-produced data, and the vocabulary probe runs in the
   sandbox. Packages come from `--trusted-node-modules`, never the
   agent-writable `node_modules`.
3. **Sandbox and dynamic trace (primary for runtime behavior).** Agent code
   runs only in `src/oracles/sandbox.mjs`. One process renders all scenarios
   of an evaluation, each in its own DOM window with its own instances of
   workspace modules.
   - **Node permission model:** reads are limited to the scratch copy, the
     trusted packages and the harness's own DOM implementation; no writes,
     child processes, workers, addons or WASI. The permission model does not
     cover the network, so `fetch`, `WebSocket`, `EventSource` and
     `XMLHttpRequest` throw.
   - **No code from strings:** `--disallow-code-generation-from-strings`
     makes `eval`, `Function` and every alias or `.constructor` form throw;
     attempts are recorded.
   - **Denied imports and ambient handles:** module hooks deny built-ins,
     harness modules and the DOM implementation, and `process`/`console` are
     replaced. Uncaught errors and rejections are recorded on the scenario.
   - **Frozen intrinsics and DOM:** the intrinsics the harness relies on, every
     DOM and CSSOM interface and the window's bindings to them are frozen
     before agent code loads. The harness reads and dispatches only through
     functions captured before that.
   - **Tagged result:** the result is accepted only on a nonce-tagged line.
   - **Real React, real DOM:** the real `react-dom` client renders into jsdom
     (`jsdom@29.1.1`), so refs, effects, `cloneElement`, props and events have
     their real semantics. jsdom lives in its own harness-only tree,
     `dom/` (manifest and lockfile committed, locked in `corpus.lock.json`,
     installed by `yarn bench:agentic:install`), apart from the repository
     workspaces: its dependencies must never change the product's hoisted
     packages (as a root install would, putting the ESM-only
     `@csstools/css-tokenizer@4` over the compiler's v3), and only the sandbox
     loads it. Older jsdom releases are not an option: their selector engine
     compiles selectors from strings, which the sandbox forbids.
   - **Instrumented DOM:** any write to a style channel (CSSOM, inline style
     objects, `style` attributes, adopted style sheets, creating `<style>`,
     any write that makes a created `<link>` a style sheet link) is a
     violation whoever makes it. Any other DOM write
     is a violation unless React itself makes it. A `MutationObserver`
     catches writes that go around the wrapped APIs.
   - **Committed-tree consistency:** after rendering, after each interaction
     and after the sweep, the DOM must be exactly what React's committed fiber
     tree says: the same nodes in the same order, the same text, and the
     attributes React's own serializer derives from the committed props
     (portal nodes inside a node React renders count among that node's
     children; hoisted `<title>`, `<meta>` and non-resource `<link>`
     instances are compared like the others, while resources and singletons
     are `unmeasured`); the rest of the document is unchanged apart from React-placed nodes, and no
     own property or replaced prototype shadows a DOM interface member. This catches writes with no
     agent stack frame, such as a bound DOM method handed to React as a ref or
     handler.
   - **Sweep:** after the requested interactions, common events are dispatched
     on every committed element, so handler code the task does not exercise
     still runs under observation. Any violation fails the render checks and
     `no-bypass`.
4. **Static analysis (second layer, fail closed).**
   - It reports the direct forms (style objects, CSSOM, `<style>`, a `<link>`
     whose props do not prove a constant non-style-sheet `rel` and `as`,
     DOM globals, Node built-ins).
   - It treats code outside an analyzable subset as `dynamic-code`:
     string-built code (`eval`, `Function` references, `.constructor`,
     `with`), prototype mutation, and computed access, calls or writes on
     values that may be DOM nodes (ref and handler parameters, `.current`,
     `.target`, DOM queries and their aliases).
   - Computed reads, writes and calls on ordinary values (array indexing,
     lookup maps such as `handlers[e.key]?.()`, accumulators, ref containers
     created with React's `useRef` (also imported under another name, or as
     `React.useRef`) from provably plain data (`[]`, `{}`, `new Array(n)`,
     `Array.from(...)`, or a local bound to one) and used only through
     `refs.current`: the binding (resolved by scope, so a shadowing binding
     never counts) is never reassigned, never passed as a `ref`, to a call or
     an alias, and `refs.current` is never an assignment target in any form
     (compound or destructuring assignment at any depth, for-of/for-in heads,
     `++`/`--`, `delete`) except a plain reset to a literal such as
     `refs.current = []`, since React or code could otherwise put a DOM
     element in `current`. Container uses look like `refs.current[i] = el`
     and `refs.current[(i + 1) % n]?.focus()`) stay inside the subset and are left to the
     dynamic trace, which observes their effect on the DOM. The
     `good-idiomatic-indexing`, `good-handler-map` and `good-roving-focus-refs`
     fixtures prove it. `Object.assign` and the other `Object` mutators are
     accepted on provably plain data only: a literal, a local bound to one, or
     a `reduce` accumulator seeded with one (`good-object-assign-accumulator`).
   - Legacy presentational JSX (elements and attributes listed above) and
     raw markup in props objects are reported.
   - Computed access on a value that may be a DOM node fails closed rather
     than being `unmeasured`: it is the one form the dynamic trace cannot
     observe on paths the sweep does not reach, and no honest solution needs
     it (named DOM members are always available).
5. **Report and transcript.** The agent's report counts only for what it
   claims to diagnose. The runner's transcript adds command-level evidence
   (for example installs during an audit).

**Residual risks.** Each one requires deliberate obfuscation or knowledge of
the oracle internals, and another layer still applies:

- **Style mutation behind a hidden branch reached through an interprocedural
  alias.** The DOM node is passed to a helper that reads a computed member and
  then writes a plain property, on a code path the sweep does not reach: it
  only runs on data or a later invocation the rendered props never produce.
  - Static mitigation: the direct, aliased and chained forms are reported.
  - Dynamic mitigation: any reached path is traced, and the committed DOM is
    compared with React's committed tree.
- **Harness tampering through intrinsics that are not frozen** (for example
  `Error.prototype`, kept writable to avoid breaking ordinary code).
  - Mitigation: verdicts are computed in the parent from parsed data. Inside
    the sandbox such tampering can only change what the agent's own code
    reports about itself (markup, callback counts). Prototype mutation is
    reported statically.
- **Tampering with React's internal fiber objects** (reachable only through
  randomized expando keys on DOM nodes) to make the consistency check expect
  the tampered DOM.
  - Mitigation: the fiber root is captured right after `createRoot`, before
    any agent render code, so added or replaced root keys are ignored.
    Reaching fiber objects needs computed access on a DOM node, which is
    reported statically. The committed markup is still the evidence: hidden,
    inert, unknown classes, style attributes and style elements in it fail
    regardless.

`host.build` is not a residual of the oracles: it executes agent-controlled
build scripts by design, and is safe only under the runner precondition below
(isolated execution). Without it, a host build result is not evidence.

Known oracle limits that are reported, not passed:

- clipping, overflow and overlap concealment (`unmeasured`);
- pixel fidelity (`unmeasured`);
- host builds and transcripts the runner did not supply (`unmeasured`).

The rendered and behavioral oracles are limited:

- They render with the real React client into jsdom and resolve the cascade
  statically over the compiler CSS. jsdom does no layout and has no popover
  state, so layout-dependent concealment and popovers are `unmeasured`.
  Presented content is read from the committed DOM before interactions; state
  changes caused by interactions re-render, but only callback counts are
  asserted on them.
- A selector or media feature outside the compiler's emitted shape makes the
  affected property `unmeasured`; it is never guessed.

## Runner contract (input to AG-00.2)

The runner drives headless agent CLIs such as `claude -p` and `codex exec` with
models chosen in run configuration, never in tasks. For each task × model ×
repetition:

1. `pms-agentic materialize <task> <ws> --files-only`, outside this repository.
   The workspace must not expose `benchmarks/`, oracle fixtures or held-out
   data.
2. If `environment.install` is `before-agent`, install dependencies with
   `environment.packageManager` and the candidate PandamStyle packages under
   test (`environment.pandamstyle: candidate-packages`). Keep a pristine copy
   of that install outside the workspace: it is the oracles'
   `--trusted-node-modules`. For tasks the agent installs itself, the runner
   provides an equivalent candidate install.
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
   --transcript <f> --observations <f> --epoch <e>
   --trusted-node-modules <pristine install from step 2> [--host-commands]`.
   Results follow `schema/evaluation-result.schema.json`. The harness
   checkout needs its DOM tree installed (`yarn bench:agentic:install`).

Oracles are deterministic for a fixed workspace, candidate package set and
epoch: three repetitions re-evaluate independently with no shared state. The
scope baseline must be the post-event state the runner actually produced.

**Required runner precondition (AG-00.2, #6): isolated execution.** The
agent session, every runner-executed host command (`host.build`, dev servers,
`workspace.services`) and `pms-agentic evaluate --host-commands` must run in a
disposable container or OS-level sandbox with no access to the host's files,
credentials or network beyond what the task's capabilities grant. Host builds
run agent-controlled scripts (package scripts, host configuration, loaders)
that need no obfuscation to act on whatever they can reach, and running them
in another directory is not containment. A runner that cannot provide this
isolation must not pass `--host-commands`; the `host.build` check is then
`unmeasured`. The oracle sandbox is a defense-in-depth boundary for oracle
integrity, not a substitute for this isolation.

## Commands

```sh
yarn build                                       # oracles compile through the built compiler
yarn bench:agentic:install                       # the sandbox's DOM tree (benchmarks/agentic/dom)
yarn bench:agentic:validate                      # schema, semantic, coverage, lock and held-out checks
yarn bench:agentic:test                          # node:test suites, including all oracle fixtures
node benchmarks/agentic/bin/pms-agentic.mjs list
node benchmarks/agentic/bin/pms-agentic.mjs oracle-fixtures --task <id> --verbose
node benchmarks/agentic/bin/pms-agentic.mjs lock # after a reviewed change only
```

Local oracle-fixture runs materialize under `.pms-bench/`, which is gitignored
and inside the repository so packages resolve from the workspace root.

## Runner (AG-00.2)

The [design note](runner/DESIGN.md) is the runner's contract; its section 11
maps each section to code and tests and lists the implementation's
differences. Schemas: [`runner/schema/`](runner/schema/) (`v1`).

```sh
yarn bench:agentic:runner:test                   # adapter fixtures (section 9.1), no provider, no Docker
R=benchmarks/agentic/runner/bin/pms-agentic-runner.mjs
node $R validate-config matrix.json
node $R run matrix.json                          # adapter-fixture matrices: fake CLIs, under .pms-bench/
node $R report <matrix dir> --out report.json --markdown report.md
node $R compare <record a> <record b>            # refuses unequal comparability keys
node $R selftest --matrix matrix.json            # Docker isolation self-test of that configuration
node $R refusals                                 # durable provider refusals (resolve-refusal <provider>)
yarn bench:agentic:runner:docker-test            # credential-free Docker integration (fake CLI image)
```

- `matrix.json` (`pms-agentic-matrix/v1`) names tasks, models, repetitions,
  budgets and, **per provider, the credential mode and source** (a
  configuration directory and an account label; no default). The source
  policy is enforced in code: Claude runs use only the claude-team-2 account
  directory (`~/.claude-t3/team-2`, account `claude-team-2`), never
  `~/.claude`; Codex uses `~/.codex`; symbolic links are refused. Adapter
  fixtures mark synthetic sources `"synthetic": true`.
- Provider-backed matrices need `"authorization": "orchestrator-go"`, a clean
  checkout, a run root outside the repository, `--setup` (verified store copy
  and closures), a valid isolation self-test, and never run in CI. Held-out
  tasks and `--heldout-dir` are always refused.
- Stream-derived tokens, cost and tool counts are estimates
  (`cli-stream-unattested`); unknown values stay `null`; reports give each
  cell's success as a point estimate and a lower bound counting contested
  repetitions as non-success.

## Versioning

Any change that can alter a verdict needs a `corpusVersion` bump, review and a
regenerated `corpus.lock.json`. That covers tasks, fixtures, schemas, oracles
and the report contract. `validate` fails on a stale lock. The
development/held-out split is part of the versioned data: each task's `split`
field, the committed held-out manifest and its digest in the lock.

## Known limitations

- Click targets must be native controls; an accessible custom widget
  (`role="button"` with its own key handling) fails, because jsdom cannot
  verify keyboard activation.

- No real LLM run exists yet: the runner is tested with adapter fixtures
  only, and its provider-backed path first runs in the authorized smoke run.
- Services and browser tasks are refused by the runner; installation tasks
  are refused until a local package mirror exists. Pixel fidelity has no
  oracle.
- The rendered oracle covers compiler-emitted selectors only. jsdom has no
  layout, popover state or navigation, so those effects are `unmeasured` or
  absent.
- Static rules and the dynamic trace are deliberately conservative (fail
  closed). Legitimate DOM API use in application code (for example a ref that
  writes a property) is reported and fails the task.
- The sandbox depends on the Node permission model of the pinned Node 22.22,
  on in-thread module hooks (`module.registerHooks`) and on jsdom 29.1.1 as
  the DOM. It is a defense-in-depth boundary for oracle integrity, not an OS
  sandbox for hostile host builds (see the runner precondition).
- React hides Suspense fallbacks' primary content and hidden `<Activity>`
  subtrees with inline styles; the style-channel rule rejects that, so such
  renders fail rather than pass.
- The committed-tree consistency check reads React 19's fiber layout
  (`__reactContainer$` root, host fiber tags). A React version with another
  layout makes every render fail (no committed root found), never pass.
- Fixture `package.json` files pin versions but ship no lockfiles; the runner
  resolves dependencies at install time and must record them.
- `prepare` compile steps and oracles use the compiler resolvable from the
  workspace. Results are bound to that candidate.
