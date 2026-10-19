# AG-00.2 runner: design note

Status: **design note, round 2 plus the conservative amendment of §0.4
(user decision after the bounded verification of `772422c`) and the
credential-source decision of §4.6.** The runner is implemented as described
here; §11 maps each section to its code and tests and lists every place where
the implementation differs from or completes this note.
This note defines how the multi-model evaluation
runner of [issue #6](https://github.com/lbframe/pandam-style/issues/6) will
work. It is written before implementation as the
[delivery protocol](../../../docs/agent-delivery-protocol.md) requires: the
runner has a privacy surface (the user's subscription credentials), a security
surface (it executes agent-written code) and an adversarial surface (the
evaluated agent can try to influence its own score). Nothing here is a shipped
API. The schemas in [`schema/`](schema/) are `v1`, promoted from the round-2
drafts together with the implementation.

Inputs: the [corpus README](../README.md) (its runner contract and the
required isolation precondition), the
[held-out access policy](../heldout/ACCESS-POLICY.md), lot AG-00 of the
accepted [plan](../../../docs/architecture/agentic-optimizations-plan.md)
(unchanged), and the Alpha 1 baseline epoch manifest
`benchmarks/core-evolution/epochs/alpha1/manifest.v1.json` (on `main` since
`e2a864b`).

## Evidence labels

Every factual claim about the CLIs, Docker, the host or the store carries one
of these labels. Appendix A lists every probe and source read.

- **observed**: seen by executing something locally during this design: CLI
  `--help`/`--version`, offline CLI runs in containers with no network and no
  credentials (a model call is impossible by construction), Docker probes
  against a dummy host service, the CE store verifier on a copy. No model call
  was made and no credential content was read.
- **source**: read in the pinned upstream source or published typings of the
  exact versions in use: Codex `rust-v0.163.0`, and the Claude Agent SDK
  `0.3.303`, whose `package.json` declares `claudeCodeVersion: 2.1.303`. This
  is the documented contract, not runtime behavior.
- **unverified**: inferred or documented elsewhere and not observed. The
  implementation never depends on an unverified behavior without a fixture
  for both outcomes. The authorized smoke run (§9.4) settles the listed items
  or the design is corrected.

## 0. Round-2 changes and requirement map

### 0.1 Review findings

| Finding | Class (generalized) | Resolution |
| --- | --- | --- |
| R1 | a containment claim that depends on Docker defaults or host state | §4.3: per-attempt `internal` network with the **isolated** gateway mode, no IPv6, per-attempt proxy; observed probes; self-test validity bound to network, proxy and host state |
| R2 | a value the CLI prints is not necessarily a measurement (defaults, overlaps, cumulative totals) | §2.2: raw vs normalized counters, per-CLI default-zero rules from the pinned sources, subset/additive relations, cumulative-snapshot rule; fixtures F3–F9 |
| R3 | telemetry and failure signals the agent can forge or influence | §4.4: trust classes; execute-only (non-dumpable) CLI binaries, observed to block same-UID `/proc` access; stream captured outside the container; channel audit; `contested` attempts and conservative bounds (§5.3); fixtures F20–F23 |
| R4 | stored evidence differs from graded evidence | §6: the oracle-relevant set is kept byte for byte with link metadata; replay is `exact` only when that set is complete and unredacted; fixtures F30–F33 |
| R5 | absence of a detected event read as evidence of absence | §2.4: repair cycles are a labelled lower bound; first-pass success is `unknown` without full coverage; the same rule for compiler attribution; fixtures F24–F27 |
| R6 | an identity key that includes transient values or omits controlled inputs | §1.4: an exact canonical projection, explicit exclusions and normalizations, and the permitted product-dependent differences; fixtures F34–F35 |
| R7 | a capability denial asserted without a mechanism that covers every path | §4.5: per-capability enforcement matrix (prevent / detect / refuse), with explicit rules for shell paths and provider-side tools; fixtures F36–F39 |
| R8 | trusted and untrusted code sharing an authority boundary | §4.2: separate containers per role, UIDs, mounts and result channels; two-pass grading isolating agent-written host builds; fixtures F40–F43 |
| R9 | a secret lifecycle step ordered after the destruction of its source; redaction sets fixed too early | §4.6: export phase before tmpfs destruction, untrusted-file handling, compare-and-swap of the host file, redaction set completed before any persistence; fixtures F44–F50 |
| R10 | adapter semantics assumed from strings instead of the output contract | §3.4–3.6: event mappings from the pinned sources and offline observation; free-text errors classified conservatively; Codex reroutes detected; primary-model fidelity separated from auxiliary usage; fixtures F10–F19 |
| F1 | future scope implemented early | §4.9: held-out refusal is unconditional in AG-00.2; future held-out and candidate-packing paths are declarative only |
| F2 | unrouted catalog files | the runner's schemas (now `v1`) are routed in `tools/agentdoc.yaml` |
| G (orchestrator) | the grading compiler must be the frozen product, never repository `HEAD` | §4.8: trusted tree built only from the digest-verified Alpha 1 tarballs, ancestor fallback refused, digest recorded and re-checked every attempt; fixtures F51–F53 |

### 0.2 Issue requirements

| Issue item | Covered by |
| --- | --- |
| Deliverable 1: model IDs, provider/version, parameters, budgets, repetitions, prompts, task revision, environment | §1, §3, §4.8 |
| Deliverable 2: success, first-pass success, repair cycles, tool calls, tokens, cost, time, visual fidelity, vocabulary, scope | §2 |
| Deliverable 3: compiler/tool/agent cost separation; unknown stays unknown; estimates labelled | §2.1, §2.5, §2.6 |
| Deliverable 4: raw traces and failures, bounded and redacted; deterministic vs provider-backed | §5, §6, §1.1 `kind` |
| AC1: replay or compare with exact inputs/configuration identified | §1.4, §1.5, §6 |
| AC2: missing telemetry never zero nor an observation | §2.1, §2.2 |
| AC3: distributions and per-task/model failures incl. policy/scope breaches | §7 |
| AC4: instrumentation isolated, reference comparable | §8 |
| Targeted verification | §9 |

### 0.3 Decisions recorded

| # | Decision | Applied in |
| --- | --- | --- |
| Q1 | **User decision:** copies of the user's existing login files, not dedicated logins. The user accepted the risk to their own sessions. The design minimizes it: access-only mode if the CLI supports it, else a controlled export and compare-and-swap. **Amended (user rule, AG-00.2 phase 2):** the credential source is a required, recorded run-config input per provider. Claude models authenticate with the **claude-team-2** account, whose configuration directory is `~/.claude-t3/team-2/` (`.credentials.json`, mode 0600); the runner never defaults to `~/.claude`. Codex keeps `~/.codex` (`auth.json`). | §4.6 |
| Q2 | The 3 `network: package-registry` tasks need a read-only local mirror of the pinned closure; until it exists they are reported `unsupported / not run`, never failed or dropped. | §4.5, §7 |
| Q3 | **User decision (final):** the smoke run passes **no** effort flag and observes each CLI's effective effort; the baseline then pins that observed value explicitly in argv and records it. A CLI that does not report its effective effort records `unknown`, and the pinned value is the CLI's documented default for the pinned version (Codex 0.163.0 bundled catalog: `low` for `gpt-6.1-sol`, observed), labelled as such. | §3.2, §9.4 |
| Q4 | Web tools and subagents disabled for both CLIs with effective-configuration evidence, or the task refused. Codex web search, which has configuration and source evidence but no runtime pre-run evidence, is **detect-and-fail** (Q12). | §3.3, §4.5 |
| Q5 | First-pass success and repairs from the transcript, no oracle feedback, with the R5 uncertainty rules. | §2.4 |
| Q6 | Visual fidelity `unmeasured`; follow-up issue #102 owns a visual oracle. | §2.3 |
| Q7 | Success requires normal completion within budget; the oracle verdict is preserved separately. | §2.3, §5 |
| Q8 | **User decision:** cadence decided at AG-00.3 launch. Concurrency (default 1 per provider), operator time windows and a matrix wall-clock cap are configuration, recorded in the run config. | §1.2, schema |
| Q9 | At most 3 attempts per repetition, infrastructure-only retries, every attempt and missing repetition preserved (subject to R3). | §5 |
| Q10 | Publish leak-scanned records, evaluations and reports; raw artifacts stay local through the baseline review, then are pruned explicitly. | §6 |
| Q11 | An effective `maxToolCalls` is recorded separately from the corpus `maxTurns` hint; Claude's native turn limit is not described as equivalent. | §3.8 |
| Q12 | **User decision:** withheld capabilities that can only be detected (`host.build` in the 9 read-only tasks, `host.dev-server`, local installs into `node_modules`, Codex web search) are **detect-and-fail**: a policy breach, counted as non-success and listed in the breach section. Installation tasks stay refused until the local mirror exists (Q2). | §4.5, §5.1, §7 |

### 0.4 Conservative amendment (user decision after the bounded verification)

The bounded verification of `772422c` resolved R1, R2, R4, R6–R10, F1, F2 and
G, and found R3 and R5 partially resolved. The user chose these conservative
rules instead of another design round. They take precedence over any looser
wording elsewhere in this note.

- **R3, stream attestation.** A sampled absence of tampering is not a
  demonstrated boundary. Unless a test **demonstrates** a protection boundary
  for the CLI event stream (every same-UID path to it closed, not merely
  unobserved), every stream-derived token, usage and cost value is at most an
  `estimate` with method `cli-stream-unattested`, never `observed`.
  `cli-attested` exists only for a demonstrated boundary; none is
  demonstrated today (§4.4), so the implementation never emits it. Every
  repetition that consumed an infrastructure retry decided from the stream is
  `contested`, and reports show the point estimate **and** a lower bound
  counting every contested repetition as non-success. No stream event alone
  establishes that a retry is unbiased.
- **R5, opaque commands.** `firstPassSuccess` is `unknown` whenever any
  **opaque** command ran: package scripts (`npm|yarn|pnpm run …`, `npm test`,
  `yarn <script>`), `npx`/`pnpm dlx`/`yarn dlx`, shell scripts, `make`, and
  any command not on the closed allowlist of transparent single-purpose
  commands (§2.4). Repair cycles stay a heuristic lower bound. Compiler-command
  attribution carries the same uncertainty. Fixture F58: a script performing
  fail → repair → pass and exiting 0 makes `firstPassSuccess` `unknown`.

## 1. Run record

### 1.1 Units and identity

- **Matrix**: one invocation over tasks × models × repetitions for one
  product build (`matrix.json`, `matrixId`).
- **Cell**: task × model configuration.
- **Repetition** `r` in `1..R` (baseline `R = 3`): an independent sample whose
  index is fixed when planned, never according to its outcome.
- **Attempt** `a` in `1..3`: one execution of a repetition. A new attempt
  starts from scratch only after an infrastructure failure (§5.2). Every
  attempt is recorded.

`kind` is `provider-backed` (real CLI, real provider) or `adapter-fixture`
(fake CLI). Reports refuse to aggregate different kinds, and fixture records
are labelled synthetic wherever they appear.

### 1.2 Fields

Schemas:
[`run-config.v1.schema.json`](schema/run-config.v1.schema.json),
[`run-record.v1.schema.json`](schema/run-record.v1.schema.json),
[`product-build.v1.schema.json`](schema/product-build.v1.schema.json),
[`report.v1.schema.json`](schema/report.v1.schema.json).

| Group | Fields |
| --- | --- |
| Identity | `schema`, `kind`, `matrixId`, cell, repetition, attempt, `comparabilityKey` and its projection (§1.4) |
| Task | id, split (always `development`), workflow, case type, epoch, corpus version, `corpus.lock.json` sha256, task digest from the lock |
| Harness identity (§1.3) | repository commit of the runner checkout and its clean state, `corpus.lock.json` sha256 (covers schemas, oracles, report contract, DOM tree), runner tree digest, harness dependency lockfile sha256 |
| Prompt | verbatim prompt (`prompt.md`), sha256, fixed docs path, delivery channel |
| Model configuration | requested model, reasoning effort as passed, raw argv and the normalized argv (§1.4), non-secret environment, harness-written CLI config files (verbatim and sha256), effective-configuration evidence (§3.3) |
| CLI identity | name, `--version` in the image, binary sha256, expected values from `matrix.json` |
| Provider info | session/thread id, primary-model fidelity and auxiliary models (§3.6), rate-limit state, API retries, reroutes; absent fields are `unknown` |
| Budgets | corpus `timeoutSeconds` and `maxTurns` hint; effective `timeoutSeconds`, `maxToolCalls` and `cliMaxTurns`; which limit fired |
| Product build | binding digest (§4.8), epoch, source commit, **trusted grading tree digest** and its `@pandamstyle` subtree digest |
| Environment | agent, grader and proxy image ids; Docker version; kernel; CPU model and count; memory; 5 s load samples; cgroup CPU, memory peak, pids peak; isolation self-test id |
| Schedule | concurrency per provider, operator time window and matrix wall-clock cap in force (Q8) |
| Integrity | stream protection status (§4.4), channel-audit result, anomalies, `contested` flag (§5.3) |
| Timestamps | UTC start/end and monotonic duration per phase |
| Outcome | termination, failure class and code (§5), retry decision, grading passes, verdict, task success |
| Metrics | measured values of §2 |
| Evidence | artifacts with sha256, size, truncation, redaction and the evidence completeness that decides replay exactness (§6) |

### 1.3 Harness and product identity

The harness that grades is `benchmarks/agentic/` at the runner's commit. A
record carries the commit SHA and the clean state, and also content digests:
the `corpus.lock.json` sha256 (schemas, oracles, report contract, DOM tree) and
the runner tree digest. Provider-backed matrices refuse a dirty checkout. The
commit identifies; the digests compare. `main` keeps moving with product work,
and a new commit that leaves the harness bytes unchanged must not break
comparability (§1.4).

The product under evaluation and the grading compiler are both the frozen
product build (§4.8), never the repository's working tree or `HEAD`.

### 1.4 Comparability key (R6)

`comparabilityKey = sha256(canonicalJSON(projection))`, where canonical JSON
means sorted keys, no insignificant whitespace and UTF-8. The projection is,
exactly:

```text
pms-agentic-comparability/v1
task:        id, taskDigest, epoch, corpusVersion, corpusLockSha256
harness:     runnerTreeDigest, harnessDepsLockSha256
prompt:      sha256 of the prompt as sent (the docs path is a fixed constant)
model:       cli, cliVersion, cliSha256, requestedModel, reasoningEffort,
             normalizedArgv, nonSecretEnv (normalized), cliConfigSha256 (normalized)
policy:      effectiveToolPolicy, capabilityEnforcementMatrixSha256,
             egressAllowlistSha256, proxyImageId, networkMode
budgets:     timeoutSeconds, maxToolCalls, cliMaxTurns
containers:  agentImageId, graderImageId, cpus, memoryBytes, pidsLimit,
             tmpfsBytes, workspaceBytesCap
dependencies: nodeSha256, packageManager {name, version, sha256},
             fixtureClosureNonProductLockSha256
```

Normalization (the raw values are kept in the record, outside the key):

- the session id (`--session-id <uuid>`), the attempt directory, container
  names, temporary paths, ports and timestamps in argv, environment and
  config files are replaced by fixed placeholders (`<session>`, `<attempt>`);
- `fixtureClosureNonProductLockSha256` hashes the fixture closure lockfile
  with every `@pandamstyle/*` entry removed.

**Excluded, recorded only:** repetition and attempt indices, timestamps,
session ids, host load, repository commit SHA, credential mode and source
(§4.6), isolation self-test id.

**Permitted product-dependent differences** (the axis under comparison):
product build binding digest, the `@pandamstyle/*` lockfile entries and
tarballs, the trusted grading tree digest, and the agent-docs tree digest
(the docs ship with the product).

`compare` pairs attempts only with equal keys. On a mismatch it lists the
differing projection fields and refuses. A frozen AG-00.3 threshold is bound
to one key per cell.

### 1.5 Replay

1. **Re-grading.** The evidence archives (§6) are re-evaluated with the
   recorded harness digests and trusted tree. This is `exact` only if the
   attempt's evidence completeness is `complete`; otherwise the result is
   labelled `non-exact` with the reason (§6.3).
2. **Re-execution.** `matrix.json`, the product build binding, the image ids
   and the comparability projection identify every input. Re-running gives a
   new sample with an equal key, compared statistically (§7).

## 2. Metrics

### 2.1 Measured-value rule (AC2, R2, R3)

```json
{ "status": "observed | estimate | unknown", "value": 123, "unit": "tokens",
  "source": "claude.result.modelUsage", "integrity": "harness | cli-attested | cli-unattested",
  "method": "cli-stream-unattested", "lowerBound": null }
```

- `observed`: the named source reported a value whose provenance establishes
  a measurement (the rules of §2.2), **and** its integrity is `harness`, or
  `cli-attested` for a stream behind a **demonstrated** boundary (§0.4,
  §4.4). No such boundary is demonstrated today, so stream-derived values are
  never `observed`.
- `estimate`: an approximation, or a value read from a `cli-unattested`
  stream. `method` is mandatory: `cli-stream-unattested` for every
  stream-derived token, usage and cost value (combined with the provenance
  rule of §2.2, e.g. `cli-stream-unattested+claude-cli-api-equivalent`),
  `transcript-heuristic/v1`, `harness-receive-time`.
- `unknown`: `value` is `null`. Absent, ambiguous (§2.2) or unparseable
  values are unknown, never `0`.

A sum is unknown if any component is unknown; the known part may appear only
as `lowerBound`. The accounting modules may not contain a zero default; a lint
and a property test enforce the class (§9.2).

### 2.2 Token accounting (R2)

The record keeps the **raw counters** exactly as the CLI printed them, then
derives **normalized counters**. Each derivation states its rule.

**Codex 0.163.0** (source: `exec_events.rs`,
`event_processor_with_jsonl_output.rs`, `codex-api/src/sse/responses.rs`):

- `turn.completed.usage` is the thread's **cumulative** total from the last
  `ThreadTokenUsageUpdated` notification. If no notification arrived it is
  `Usage::default()`, all zeros. So an all-zero `usage` is `unknown`, not zero.
- Provider usage parsing defaults `cached_tokens` and `cache_write_tokens` to
  0 when `input_tokens_details` is absent, and `reasoning_tokens` to 0 when
  `output_tokens_details` is absent. A zero in `cached_input_tokens`,
  `cache_write_input_tokens` or `reasoning_output_tokens` is therefore
  `unknown`. A non-zero value is a measurement.
- `input_tokens` **includes** cached input and `output_tokens` **includes**
  reasoning output (OpenAI Responses usage semantics: unverified here, checked
  at smoke for consistency). Normalized uncached input is `input_tokens −
  cached_input_tokens` only when the cached count is known.
- One `codex exec` run is one turn. If several `turn.completed` events
  appear, the **last** one is the total; they are never summed.
- `turn.failed` and interrupted turns carry no usage: tokens are `unknown`
  even though tokens were spent.
- The JSONL contract has no cost field: cost is `unknown`.

**Claude Code 2.1.303** (source: SDK 0.3.303 `sdk.d.ts`; observed offline):

- `result.modelUsage` (per model, cumulative, covering the main loop,
  subagents and internal calls such as compaction, but excluding helper calls
  such as the permission classifier and token-count probes) is "the correct
  field for token/cost accounting; treat it as an estimate, not a billing
  statement". `result.usage` covers the **main loop only**. Neither is summed
  with the other.
- Anthropic `input_tokens` **excludes** `cache_read_input_tokens` and
  `cache_creation_input_tokens`; the three are additive (provider API
  semantics, unverified here). Thinking tokens
  (`output_tokens_details.thinking_tokens`, `ModelUsage.thinkingTokens`) are
  treated as a subset of output (unverified; consistent with a subset in
  the smoke run, §9.4).
- **Default zeros (observed):** with no credentials, Claude printed an
  assistant message with `model: "<synthetic>"`, all-zero usage and
  `error: "authentication_failed"`, then a result with `total_cost_usd: 0`,
  all-zero `usage`, `modelUsage: {}` and `is_error: true`. The SDK typings add
  that "crash/startup-error results may carry zeroed usage". Rule: Claude
  token counters are `observed` only from `modelUsage` entries of a run with
  at least one non-synthetic assistant message. Zeros on a result with
  `is_error`, an empty `modelUsage` or only synthetic messages are `unknown`.
- Per-message usage of non-synthetic main-loop assistant messages
  (`parent_tool_use_id: null`), de-duplicated by `message.id`, is a
  cross-check of `modelUsage[requested]`. A disagreement is recorded as
  `discrepancy` and never silently resolved. Only fields that are final per
  message are compared: `input_tokens`, `cache_read_input_tokens` and
  `cache_creation_input_tokens` against `inputTokens`,
  `cacheReadInputTokens` and `cacheCreationInputTokens`. Per-message
  `output_tokens` are early snapshots (observed in the smoke run, Claude
  Code 2.1.303: the events of one `message.id` repeat the same input and
  cache counts, while their output sums to 35 against 3299 in
  `modelUsage`) and are never compared. A missing counter makes the check
  `not-computable`.

Normalized token fields: `inputUncached`, `inputCacheRead`, `inputCacheWrite`,
`inputTotal`, `outputTotal`, `outputReasoning` (subset of `outputTotal`). Each
has its own status, so `inputTotal` can be observed while `inputCacheRead` is
unknown.

### 2.3 Metric table

| Metric | Definition | Source | Claude 2.1.303 | Codex 0.163.0 |
| --- | --- | --- | --- | --- |
| Task success | grading verdict `pass` **and** termination `completed` within budget (Q7); verdict kept separately | grading + harness | harness | harness |
| Outcome split | `success.application`, `.diagnosis`, `.report` | oracle | harness | harness |
| First-pass success | §2.4: `true`, `false` or `unknown` | transcript + workspace deltas | derived | derived |
| Repair cycles | §2.4: `estimate`, lower bound | transcript + workspace deltas | `tool_result.is_error` (exit status form unverified) | `command_execution.exit_code` (source) |
| Tool calls | by normalized kind | stream | `tool_use` blocks (source) | `item.*` types (source) |
| Agent steps | model round-trips | stream | `num_turns` (source: "API round-trips") | not reported: `unknown` |
| Tokens | §2.2 | stream | `modelUsage` | `turn.completed.usage` |
| Cost | §2.6 | stream | `total_cost_usd` and `modelUsage[*].costUSD`: `estimate`; `costBasis: unknown` makes it `unknown` | `unknown` |
| Elapsed time | harness monotonic agent phase; CLI durations beside it | harness + stream | `duration_ms`, `duration_api_ms` (source) | harness only |
| Visual fidelity | `visual.fidelity` | oracle | `unmeasured` (Q6) | same |
| Vocabulary compliance | required `static.forbidden`, `definition.diff`, `generated.consistent` and the token assertions of required `render.styles` checks, with per-check breakdown | grading | harness | harness |
| Scope violations | realized: `scope.diff`; attempted: denials and detections of §4.5 | grading + proxy + filesystem + transcript | all | all |
| Primary-model fidelity | §3.6 | stream | observable | reroutes observable, served model `unknown` |
| Infrastructure noise | API retries, rate-limit events, reconnects | stream | `api_retry`, `rate_limit_event` (source) | `error` "Reconnecting…" events (observed) |

### 2.4 Repairs, first-pass success and compiler attribution (R5)

The harness knows a command's text and status, not its effects, and shell
commands can write files, chain checks or mask failures. So:

- **Command classes** (versioned table `command-classes/v4`, closed):
  - `transparent`: a single simple command on the closed allowlist of
    transparent single-purpose commands that execute no code, load no
    project code and write no file, each with its audited options excluded:
    `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `stat`, `pwd`, `echo`; `rg`
    without `--pre*`, `-z`/`--search-zip`, `--hostname-bin`; `find` without
    `-exec*`, `-ok*`, `-delete`, `-fprint*`, `-fls`; `file` without
    `-z`/`-Z`/`-C`; `tree` without `-o`/`--output`; and `sed` only as
    `sed -n '<address>p' <files>` (GNU sed's `e`, `w`, `s///e`, `r` and `-f`
    execute, write or load scripts). Options are matched conservatively: a
    short-option token containing a forbidden letter anywhere (combined
    flags, attached values: `-zm1`, `-o/tmp/x`), and any prefix of a
    forbidden long option (getopt abbreviations), make the command opaque.
    **git is never transparent**: its system, global, XDG, include and
    `GIT_CONFIG_*` configuration can define diff drivers, textconv filters,
    pagers, aliases and hooks, and some of those sources are agent-writable
    in every run. Words are
    split as a POSIX shell would; `$` anywhere, escapes, a quote adjacent to
    other characters and **any unquoted glob, brace or tilde character
    anywhere in a word** (`*`, `?`, `[`, `]`, `{`, `}`, `~`), whose expansion
    can inject options or paths from agent-controlled names (`-fpri*`
    matching a file named `-fprintf`), make the command opaque;
  - configuration the transparent programs read (shell startup files,
    `~/.gitconfig`, `~/.magic`, tool configuration) can only be written
    without an opaque command through a file-write tool call outside the
    workspace; such a write makes coverage incomplete
    (`write-outside-workspace`);
  - `opaque`: everything else, in particular package scripts
    (`npm|yarn|pnpm run …`, `npm test`, `yarn <script>`), `npx`,
    `pnpm dlx`, `yarn dlx`, shell scripts (`sh x.sh`, `./x`), `make`, `node`,
    host build tools and the PandamStyle CLI (they load project code such as
    host or design-system configuration), and any command with shell operators
    (`;`, `&&`, `||`, `|`, subshells, redirections, substitutions);
  - `verify` is an orthogonal tag: a command whose text matches a known
    compile, build, typecheck or test pattern (`npm run build`, `vite build`,
    `next build`, `rsbuild build`, `tsc`, `pandamstyle …`). A `verify` command
    is usually also `opaque`.
- **Workspace deltas.** After each tool result the event-runner container
  (§4.2) records a no-follow tree digest of the workspace, excluding
  `node_modules`. Shell-mediated writes are then visible even without a
  file-write event. A concurrent write can race the digest, so this remains a
  heuristic.
- **Repair cycle:** a `verify` command with a known non-zero exit status,
  followed by a workspace delta, followed by a later `verify` command.
  `repairCycles` is `estimate`, method `transcript-heuristic/v1`, and a lower
  bound (an opaque command can repair internally, as F58 shows).
- **Coverage** is `complete` only if no `opaque` command ran (§0.4), every
  tool call has a known completion status, no item is unfinished or
  interrupted, and every workspace-delta sample succeeded.
- **First-pass success:**
  - `false` if the task did not succeed, or if at least one repair cycle was
    detected;
  - `true` only if the task succeeded, zero repairs were detected and
    coverage is complete;
  - otherwise `unknown`. In practice any package script or build makes it
    `unknown`; that is the intended conservative outcome.
- **Compiler attribution** uses the same table and coverage. Its counts and
  times are `estimate` with the coverage flag; opaque commands are counted as
  `opaque` and never attributed to the compiler.

### 2.5 Compiler, tool and agent cost

Three accounts, never summed:

- **Agent cost:** tokens and the CLI cost estimate per served model. Primary
  model and auxiliary models are reported separately (§3.6).
- **Tool cost:** tool calls by kind; bytes of tool output returned to the
  model (`observed` from the stream; a token count of them is an `estimate`);
  tool wall time from harness receive times (`estimate`, method
  `harness-receive-time`); container CPU time (cgroup, `observed`, includes
  the CLI process).
- **Compiler cost:** (a) agent-invoked compiler and host builds by §2.4
  attribution (`estimate`); (b) harness-side compile work in `prepare` and
  grading, timed by the harness in a separate section never attributed to the
  agent.

### 2.6 Cost under subscription authentication

There is no billed cost. Claude's `total_cost_usd` is an `estimate` (method
`claude-cli-api-equivalent`; source: "an estimate, not a billing statement").
Its `costBasis` per model is `list`, `managed` or `unknown`, and `unknown`
("a guess at the default model's rate") makes cost `unknown`. A zero cost on
an error result is `unknown` (observed default). Codex cost is `unknown`. The
runner computes no price-table estimate.

### 2.7 Time under a busy host

Deterministic metrics are primary. Each attempt records the load series, CPU
time and CLI durations. Matrices can **interleave** cells across product
builds (ABAB per task × model × repetition) for paired latency ratios. Every
absolute latency is labelled `indicative`.

## 3. Adapters

### 3.1 Contract sources

| CLI | Contract read | Offline observation |
| --- | --- | --- |
| Claude Code 2.1.303 | Agent SDK `0.3.303` `sdk.d.ts` (tarball sha256 `86dc2947…71fc`, `claudeCodeVersion: 2.1.303`): `SDKSystemMessage` (init), `SDKAssistantMessage` (`error` enum), `SDKResultSuccess`/`SDKResultError`, `ModelUsage`, `SDKAPIRetryMessage`, `SDKRateLimitEvent`, `SDKModelRefusalFallbackMessage`, `TerminalReason` | init, synthetic auth-failure assistant message and error result printed with no network and no credentials (Appendix A, P3) |
| Codex 0.163.0 | `rust-v0.163.0`: `ThreadEvent`, `ThreadItemDetails`, `Usage`, notification→event mapping, usage parsing, multi-agent and web-search configuration resolution | `debug prompt-input`, `debug models`, `exec --json` with no network and no credentials (P4) |

### 3.2 Invocations

Claude, started by `docker exec` in the agent container (§4.2), working
directory `/workspace`:

```sh
claude -p "<prompt>" --output-format stream-json --verbose \
  --model <claude-haiku-5-5|claude-sonnet-5-5> [--effort <pinned, Q3>] \
  --tools "Bash,Edit,Glob,Grep,Read,Write" \
  --disallowedTools "WebFetch,WebSearch,Agent" \
  --permission-mode bypassPermissions --strict-mcp-config \
  --disable-slash-commands --setting-sources "" --no-session-persistence \
  --max-turns <cliMaxTurns> --session-id <uuid>
```

Environment: `HOME` and `CLAUDE_CONFIG_DIR` on tmpfs, the credential (§4.6),
`DISABLE_TELEMETRY=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `DISABLE_AUTOUPDATER=1`, `HTTPS_PROXY`.
Observed offline: every flag above is accepted, including
`--setting-sources ""` and `--max-turns`. `init.tools` equals the `--tools`
list. The environment variables remove the built-in telemetry plugin, set
`analytics_disabled: true` and remove the auto-memory path.

Codex:

```sh
codex exec - --json --strict-config --ephemeral --ignore-rules \
  -m gpt-6.1-sol [-c model_reasoning_effort="<pinned, Q3>"] \
  -c web_search="disabled" -c agents.enabled=false \
  --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check \
  -C /workspace -o /run/agent/last-message.txt
```

`CODEX_HOME` is on tmpfs and holds only the credential and a harness-written
`config.toml`. Observed offline: `--strict-config` accepts these keys, and
`web_search` is validated (variants `disabled|cached|indexed|live`).

Both CLIs run with their approval layer bypassed and their own sandbox off.
Enforcement is the container's (§4.5) and is identical for both.

### 3.3 Effective-configuration evidence (Q4)

Requested settings can be silently ignored (Claude's `-p` mode ignores
invalid settings files, observed in `--help`), so each attempt records
evidence of what was in force. It refuses the attempt (`harness:
config-integrity`) when the evidence contradicts the request.

| Setting | Claude evidence | Codex evidence |
| --- | --- | --- |
| model | `init.model` (observed field) | requested `-m`; the served model is not reported (§3.6) |
| tools | `init.tools` equals the allowlist (observed) | matrix-start render of `codex debug prompt-input` with the same `-c` overrides, recorded by digest (observed: no model call) |
| subagents | `Agent` absent from `init.tools` (observed; `init.agents` still lists agent types, which are unusable without the tool) | `agents.enabled=false` removes the `<multi_agent_role>`/`<multi_agent_mode>` instructions from the model-visible input (observed); `--disable multi_agent` alone does **not** (observed); source: `multi_agent_version_override` returns `Disabled`, which takes precedence over the model catalog's `multi_agent_version: v2` |
| web tools | `WebSearch`/`WebFetch` absent from `init.tools` (observed) | key accepted with strict validation (observed); source: `resolve_web_search_mode` returns the configured value before any feature flag. The tool list is not rendered offline, so there is **no runtime pre-run evidence**: detect-and-fail (Q12) |
| effort | not present in the offline `init` (the typed field is optional; observed absent): requested value recorded, effective value `unknown` until the smoke run | requested value recorded; effective value not observable |
| user config | clean `CLAUDE_CONFIG_DIR`; `init.skills`, `slash_commands`, `mcp_servers` empty (observed); built-in plugins `cc-plugin-agents-md` and `cc-plugin-plugin-authoring` remain (observed) and are recorded | clean `CODEX_HOME`; the CLI creates its own state there (observed: sqlite logs, memories, goals, `skills/.system`), all ephemeral |

Post-run detection completes the evidence: any `server_tool_use`/web-search
counter above 0, `Agent` tool use, or Codex `web_search` or
`collab_tool_call` item is a policy breach (§4.5) and makes the attempt
non-successful.

### 3.4 Claude event mapping

| Stream element (source / observed) | Adapter meaning |
| --- | --- |
| `system/init` | effective configuration (§3.3); exactly one per run |
| `assistant` with `message.model` not `<synthetic>` and `parent_tool_use_id: null` | main-loop model response; `tool_use` blocks are tool calls; per-message usage cross-check |
| `assistant` with `error` (enum: `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `verification_required`, `billing_error`, `rate_limit`, `overloaded`, `invalid_request`, `model_not_found`, `server_error`, `unknown`, `max_output_tokens`, `cloud_credential_error`) | failure signal (§5.1) |
| `user` with `tool_result` | tool completion; `is_error` is the only typed failure flag |
| `system/api_retry` (`attempt`, `error_status`, `error`) | infrastructure noise; never terminal by itself |
| `rate_limit_event` (`status`, `resetsAt`, `rateLimitType`) | quota state; `rejected` plus a terminal `rate_limit` error is a rate-limit failure |
| `system/model_refusal_fallback` (`original_model`, `fallback_model`) | primary-model fidelity violation (§3.6) |
| `system/compact_boundary` | recorded |
| `result` | terminal; `is_error`, `terminal_reason`, `api_error_status`, `num_turns`, `modelUsage`, `total_cost_usd`, `permission_denials`, `result_index` |

Observed: an authentication failure ends with `subtype: "success"` **and**
`is_error: true`, `terminal_reason: "api_error"`, `api_error_status: null`,
exit code 1. So `subtype` is never used for classification; `is_error`,
`terminal_reason` and the last assistant `error` are used instead.

### 3.5 Codex event mapping

| Event (source / observed) | Adapter meaning |
| --- | --- |
| `thread.started {thread_id}` | session id; no model id |
| `turn.started` | start |
| `item.*` `command_execution {command, aggregated_output, exit_code?, status}` | tool call (`command` in the transcript) |
| `item.*` `file_change {changes[{path, kind}], status}` | file-write tool call |
| `item.*` `mcp_tool_call`, `web_search`, `collab_tool_call` | tool calls; web search and collab are policy breaches (§3.3) |
| `item.completed` `error {message}` | **not terminal**. Source: config warnings, warnings, deprecation notices and model reroutes (`"model rerouted: <from> -> <to> (<reason>)"`) all map here. Observed: `"Falling back from WebSockets to HTTPS transport…"` |
| `error {message}` | **not terminal**. Observed: `"Reconnecting... n/5 (stream disconnected…)"` retry notices; source: the last one becomes the `turn.failed` message if the turn fails |
| `turn.completed {usage}` | normal terminal; usage per §2.2 |
| `turn.failed {error: {message}}` | failure terminal; free-text message only |
| no terminal event (interrupted turn) | from harness signal → budget or cancellation; otherwise `abnormal-exit` |

The Codex contract has **no structured error kind**: terminal errors are
free-text messages. Classification uses a versioned pattern table
(`codex-errors/v1`) built from the pinned source's error display strings
(usage limit, server overloaded, authentication, stream disconnected). A
message matching no pattern is `unclassified` (§5.1). A reroute item is a
primary-model fidelity violation.

### 3.6 Primary-model fidelity and auxiliary usage (R10)

- **Claude:** the primary model is faithful if `init.model` equals the
  requested id, every non-synthetic main-loop assistant `message.model` equals
  it (exact string; `ModelUsage.canonicalModel` recorded when present), and no
  `model_refusal_fallback` event appears. `modelUsage` keys other than the
  requested model are **auxiliary usage**, which is legitimate (internal
  helper calls). They are reported per model and are never a fidelity
  violation. `--fallback-model` is never passed.
- **Codex:** the served model is `unknown` (not in the JSONL contract). A
  surfaced reroute item is a fidelity violation. The absence of a reroute item
  is recorded as "no reroute surfaced", not as confirmed fidelity.
- A fidelity violation makes the attempt invalid (`harness:
  model-fidelity`). It is not retried; the repetition becomes `missing`, and
  the matrix halts after 3 such attempts per provider.

### 3.7 Version pinning and drift

The CLI binaries are copied into the agent image from pinned sources,
identified by sha256 (observed on the host: `claude.exe` `375988f4…`, `codex`
`399ff69c…`), and installed **execute-only** (`root:root 0711`, §4.4). Both
run correctly in that mode (observed). `--version` is checked inside the image
at matrix start against `matrix.json`; any difference refuses the matrix.
Autoupdate is disabled and the root filesystem is read-only.

### 3.8 Budgets, timeouts and cancellation (Q11)

- Wall clock: corpus `timeoutSeconds`, from CLI start. At expiry the runner
  sends SIGINT, then SIGTERM after 15 s, then kills every agent-UID process
  (§4.6 step 2) after 30 s. Termination is `budget-timeout`.
- `maxToolCalls`: a harness cap on normalized tool calls, the same for both
  CLIs. Its value is configuration (default: the corpus `maxTurns` hint) and
  is recorded separately from that hint. Termination is
  `budget-max-tool-calls`.
- `cliMaxTurns`: Claude `--max-turns`, documented in the SDK as "agentic turns
  (API round-trips)", a different unit. It is a backstop (default
  `2 × maxToolCalls`), and when it fires the record says `cli-max-turns`. It
  is never described as equivalent to the harness cap. Codex has no native
  turn limit (observed).
- The final workspace is read only after every agent-UID process is gone.
- Operator cancellation runs the same teardown, including the credential
  export (§4.6), writes `harness:cancelled` records and leaves the matrix
  resumable.

## 4. Isolation, integrity and credentials

### 4.1 Threat model

**Assets:** the user's subscription credentials and quota; host files; the
integrity of verdicts and metrics.

**Adversary:** the evaluated agent, possibly following prompt-injected task
material, running arbitrary code as the agent UID inside its container. It
has no kernel exploits and no knowledge of harness internals.

**Untrusted:** everything the agent UID can write or execute; every
workspace byte after the agent starts; model and tool text in the stream.

**Trusted:** the host-side runner; harness code and the trusted tree mounted
read-only into grader containers; images built by the runner; the CLI binary
itself (but not the CLI's state, which shares a UID with the agent).

### 4.2 Containers and authority boundaries (R8)

Every container is fresh per attempt, has `--cap-drop ALL`,
`--security-opt no-new-privileges`, the default seccomp and AppArmor profiles,
a `--read-only` root, cpu/memory/pids limits and **no credentials** except
the agent container. All harness Node processes use the store's Node 22.22.0
installed execute-only, so they are non-dumpable (§4.4).

| Role | UID | Network | Mounts (owner, mode) | Executes | Result channel |
| --- | --- | --- | --- | --- | --- |
| **P** prepare | agent 10001 (no agent code exists yet; files end up owned by the agent UID without `CAP_CHOWN`) | none | fixture closure (ro), product tarballs (ro), fresh workspace dir (rw), trusted-tree build dir (rw, mounted read-only everywhere afterwards) | `materialize`, offline `npm ci --ignore-scripts`, `prepare` (corpus content only, no agent code yet) | stdout → runner |
| **A** agent | agent 10001 | per-attempt isolated network (§4.3) | workspace (rw; ro parts per §4.5), agent docs (ro), tmpfs `/run/agent` and `/tmp` | supervisor (PID 1, harness UID); CLI and tools as agent UID via `docker exec` | CLI stdout via the `docker exec` stream → runner |
| **E** event runner | agent 10001 | none | workspace (rw) | `pms-agentic event` steps; workspace-delta digests (no-follow) | stdout → runner |
| **G1** grade | grader 30001 | none | harness (ro), trusted tree (ro), baseline archive extract (ro), final evidence extract (ro), tmpfs `/scratch` | `pms-agentic evaluate` **without** `--host-commands`: no agent process; agent modules run only inside the AG-00.1 Node-permission sandbox | stdout → runner |
| **G2** host-build grade | grader 30001 | none | same as G1 | `evaluate --host-commands`: agent-written build scripts run here | stdout → runner, used only for `host.build` and a consistency check |

Invariants by construction:

- The baseline and the final evidence are archives written by the runner and
  extracted into fresh read-only mounts for each grader. **Implementation
  (§11.2 item 2):** P and E run in the runner process; host code reads the
  workspace only without following links, during the agent phase only
  through the bounded non-blocking delta walker, and archives it only after
  every agent process is gone.
- Harness code and the trusted tree are read-only in every grader. Grader
  results leave only through the container's stdout, read by the runner.
  There is no result file a build could overwrite.
- **Two-pass grading.** G1 grades everything except `host.build` with no
  agent build process. G2 runs the same evaluation with host commands, as a
  non-dumpable grader process, so the build cannot reach its descriptors or
  memory (observed, §4.4). The build can still signal the grader (observed:
  signals are allowed), so:
  - if G2 completes and every non-`host.build` check equals G1's, G2's
    verdict is used;
  - if G2 dies, times out or disagrees with G1, `host.build` is
    `aborted-by-agent-code` and the verdict cannot be `pass`. This rule is
    monotone toward non-success, and the runner reimplements no oracle
    aggregation.
- Event steps with `compile` (none in corpus 1.4.3) are refused: they would
  compile with the agent-writable `node_modules`. Tasks with
  `workspace.services` or `browser: true` (none in 1.4.3) are refused.

### 4.3 Network (R1)

Docker's default `internal` network keeps a host-side bridge address that
containers can reach. On this host a probe of a dummy host service through it
**timed out**, which shows only that this host's firewall currently drops it.
That is host state, not a guarantee. The design therefore uses:

- a **per-attempt** `--internal` network with
  `com.docker.network.bridge.gateway_mode_ipv4=isolated` and no IPv6. Observed
  (Docker 29.2.1): the bridge has no host address, and the gateway address is
  assigned to the first container. From an agent container, the host service
  on the docker0 address, the LAN address and the host's global IPv6 address
  were all `ENETUNREACH`; `1.1.1.1:443` and `8.8.8.8:53` were `ENETUNREACH`;
  external DNS failed (`EAI_AGAIN`). A network created with `--ipv6` and
  `gateway_mode_ipv6=isolated` also had no IPv6 route out (observed);
- a **per-attempt** egress proxy container, the only other member of the
  attempt network, also attached to an egress network. Observed: an agent
  reached its own proxy by name and address; an agent on another attempt's
  network got `ENETUNREACH` to that proxy and to its egress address; the proxy
  reached `api.anthropic.com`;
- the proxy is CONNECT-only, allows `host:443` from the per-CLI allowlist and
  logs each CONNECT (host, decision, bytes, times). The allowlist is finalized
  from the smoke run's proxy log. Observed: with no ChatGPT login, Codex
  targeted `wss://api.openai.com/v1/responses`; with a ChatGPT login,
  `chatgpt.com` is expected (unverified).

**Self-test validity.** The isolation self-test (§9.3) result is bound to the
digest of: Docker server version, network create options, agent and proxy
image ids, proxy allowlist, kernel release and the host's **stable routable
address set**: every non-loopback address except link-local ones
(`169.254.0.0/16`, `fe80::/10`), addresses of Docker interfaces (`docker*`,
`br-*`, `veth*`) and any address inside a Docker network's subnet. Docker
networks, bridges and container veths created or removed between the
self-test and preflight (by the self-test itself, by attempts or by other
projects on the host) therefore leave the binding unchanged, while a change
of a genuine routable address still invalidates it. The self-test (at its
start) and preflight compute these facts with the same function. It expires
after 24 h. A provider-backed attempt refuses to start without a valid
result for its exact binding.

### 4.4 Telemetry and failure-signal integrity (R3)

**Trust classes:**

- `harness`: harness timers, container state and exit codes, cgroup counters,
  proxy logs, grading results. Trusted.
- `cli-attested`: reserved for a CLI stream behind a protection boundary
  **demonstrated by a test** (§0.4): every same-UID path to the stream closed,
  not merely unobserved. No such boundary is demonstrated today: the paths
  below are partly closed (execute-only binaries) and partly only sampled
  (inherited descriptors, control sockets). The implementation therefore
  never emits `cli-attested`.
- `cli-unattested`: every CLI stream today. Stream-derived token, usage and
  cost values are at most `estimate`, method `cli-stream-unattested`; stream
  events still drive classification and retries, but every retried
  repetition is `contested` (§5.3).

**Protection: execute-only CLI binaries.** Linux makes a process that execs a
binary it cannot read non-dumpable; its `/proc/<pid>` entries then belong to
root. Observed in the probe image, as the agent UID with no capabilities:

| Target process | `/proc/pid/fd/1` open for write | `/proc/pid/environ` | `/proc/pid/fd` list | `/proc/pid/mem` | signal |
| --- | --- | --- | --- | --- | --- |
| readable `node` / `claude` / `codex` | allowed | allowed | allowed | denied (Yama `ptrace_scope = 1`) | allowed |
| execute-only `node` / `claude` / `codex` (`root:root 0711`) | **EACCES** | **EACCES** | **EACCES** | EACCES | allowed |

So with execute-only binaries, tool processes of the same UID cannot write
into the CLI's stdout through `/proc` or read its environment. The remaining
paths:

- **Inherited descriptors.** A tool child would hold the stream only if the
  CLI passed its stdout to it. Both CLIs capture tool output (Codex
  `aggregated_output`, source), which implies piped stdio; that is
  inference, not observation. A **channel-audit sidecar** (harness image,
  `--pid container:<agent>`, `CAP_SYS_PTRACE`, no network, no mounts) samples
  the descriptor tables of all agent-UID processes. It checks that none holds
  the CLI's stdout pipe and that the CLI's `/proc` entries are root-owned
  (non-dumpable confirmed at runtime). A finding is a breach observation.
  Sampling can miss a short-lived holder: it is an audit, never a
  demonstration, so a clean audit does not make a stream `cli-attested`.
- **CLI control channels.** Claude listens on `/tmp/cc-socks/<n>.sock`, mode
  0600, owned by the agent UID (observed). Same-UID processes can connect,
  and what that protocol allows is unknown. Codex `exec` created no daemon
  socket in the offline run (observed); its `daemon_auto_start` feature is
  enabled by default (observed in `features list`). The audit records
  connections to these sockets; any connection from a non-CLI process is a
  breach observation. Residual risk: documented, not closed.

**Audit identification (observed, smoke run and agent image).** The CLI is
the direct child of the `run-cli.mjs` launcher that `docker exec` started
(parent PID 0, which no process in the container can produce), not a
process whose arguments name the CLI: the launcher's own arguments contain
`/opt/cli/claude`. Non-dumpability is read from the owner of
`/proc/<pid>/environ`: `/proc/<pid>` itself always belongs to the task's
effective UID, even for a non-dumpable task (`task_dump_owner`). In the
agent image during an offline Claude Code run, `/proc/<cli>` was owned by
the agent UID while `/proc/<cli>/fd` and `environ` were root-owned, and the
agent UID got EACCES on both: the CLI is non-dumpable as designed.
Foreign holders are counted per process, excluding exactly the launcher and
the CLI (the CLI holds the stream twice: fd 1 and a duplicate). The first
smoke run's `cliNonDumpable: false` and its 2 holders per sample were these
three misreadings. A sample that did not see the CLI (taken before it
started or after it ended) has no count; the summary covers the samples
that saw it and is unknown when there are none.
- **Self-inflicted failures.** Agent code can kill the CLI (signals are
  allowed) or exhaust the quota with the credential it can read (§4.10).
  Neither forges a stream: a kill without a provider error is
  `abnormal-exit` (never retried), and quota exhaustion is handled by §5.3.

**Not chosen in this issue:** a TLS-terminating proxy would give
provider-authenticated usage and status codes independent of the CLI. It
needs custom CA injection into both CLIs and parsing of the provider
protocols (Codex uses WebSockets, observed), and is left as a possible
follow-up.

### 4.5 Capability enforcement matrix (R7)

Rule: a withheld capability must be **prevented** when its exercise could
change graded evidence, reach outside the container or affect the user's
credentials. It may be **detected** (exercised, recorded as a breach, attempt
non-successful) only when its exercise is contained in the container, cannot
change graded evidence, and is visible to the harness. If neither holds, the
task is **refused** (`unsupported / not run`). The rule itself is open
question 2.

| Capability withheld | Mechanism | Class | Evidence |
| --- | --- | --- | --- |
| `workspace.write` (9 tasks) | workspace mounted read-only in A | prevent | observed EROFS; writes to `/tmp` cannot affect grading |
| `git.write` | `/workspace/.git` bind-mounted read-only | prevent | observed: `git status`/`diff` work, `git commit` fails with EROFS |
| `design-system.edit` | definition sources of the fixture (`project.definition` files or directory) bind-mounted read-only over the writable workspace; generated output stays writable because legitimate builds rewrite it | prevent (definitions) + detect (generated output, via `generated.consistent` and `definition.diff`) | observed: write → EROFS, rename onto or delete → EBUSY |
| `network.registry` | no route except the proxy, whose allowlist has provider hosts only | prevent | observed probes (§4.3) |
| `package.install` | network prevention above; a local install (from files already in the container) only changes `node_modules`, which grading never uses (trusted tree, §4.8) | prevent (network) + detect (local: `node_modules` tree digest before/after, computed in E; transcript) | design |
| `host.build` (9 read-only tasks) | the read-only workspace prevents build output in the workspace; a build to `/tmp` is possible because tools need Node | detect-and-fail (transcript `verify` class, §2.4) | Q12 |
| `host.dev-server` (withheld in every task) | a dev server can listen inside the container; nothing outside can reach it | detect-and-fail (transcript) | Q12 |
| web tools (Q4) | Claude: tools absent from `init.tools`; Codex: `web_search="disabled"` | Claude prevent (observed evidence); Codex prevent by configuration (source evidence) + detect-and-fail (`web_search` items) | Q12 |
| subagents (Q4) | Claude: `Agent` not in tools; Codex: `agents.enabled=false` | prevent (observed evidence for both) + detect (`Agent` tool use, `collab_tool_call` items) | §3.3 |
| `network: package-registry` tasks (installation, 3) | requires the read-only local mirror (Q2) | refuse until the mirror exists | reported `unsupported / not run` |

Provider-side tools create no new proxy destination, so the proxy does not
enforce them. They are enforced only by tool configuration and detected in
the stream.

### 4.6 Credentials (R9, Q1)

**Credential source (required, recorded).** Each provider of a matrix has a
`credentials.<provider>` entry in the run configuration: a mode
(`access-only`, `refresh-capable-copy`, or `none` for adapter fixtures only),
an optional `fallback: refresh-capable-copy` after `access-only`, and a
**source** `{ configDir, account }`. The credential file is the CLI's own file
inside that directory: `.credentials.json` for Claude (the account's
`CLAUDE_CONFIG_DIR`), `auth.json` for Codex (`CODEX_HOME`). There is **no
default directory**: a missing entry, a missing source, a relative path or a
missing or non-regular credential file refuses the matrix before any attempt
(an `lstat`, names and modes only). In particular the runner never falls back
to `~/.claude`. **The user rule is enforced in code** (`SOURCE_POLICY`): a
Claude source must be exactly `~/.claude-t3/team-2` with account
`claude-team-2`, a Codex source exactly `~/.codex`; every component below
home must be a real directory (no symbolic link, no alias) and its real path
the policy path. The check runs before any read, again before each attempt
reads the file, and again in crash recovery before any write-back. Synthetic
sources (`synthetic: true`) are exempt and allowed only in adapter-fixture
matrices. Under the user's subscription rule, Claude models under
evaluation authenticate with the **claude-team-2** account
(`configDir: "~/.claude-t3/team-2"`, `account: "claude-team-2"`); Codex may use
`~/.codex`. The matrix record (`credentialSources`) and every attempt record
(`credential.source`) carry the directory (home shown as `~`), the file name
and the account label, never contents. Write-back (mode B) and crash recovery
target that same resolved file.

The user's existing login files are the source. The runner reads them at run
time and never logs them; this design read only their names and modes.

**Mode A: access-only (preferred if supported).** The runner derives a reduced
credential with no refresh token: for Claude, the access token in
`CLAUDE_CODE_OAUTH_TOKEN`; for Codex, `codex login --with-access-token` inside
the tmpfs. An attempt starts only if the token's remaining lifetime exceeds
the attempt budget plus a margin. The user's refresh token never enters a
container, so the user's own login cannot be rotated by a run.
Feasibility (observed in the smoke run): Claude Code 2.1.303 runs with
`CLAUDE_CODE_OAUTH_TOKEN`; Codex 0.163.0 **rejects** a ChatGPT login's
access token (`Error logging in with access token: agent identity JWT
payload is not valid JSON`; the option expects an agent identity token), so
mode A is infeasible for Codex ChatGPT logins and a matrix using one
declares `mode: refresh-capable-copy` for Codex.

**Fallback on a rejected login.** A login rejected inside the container is a
credential failure of that provider, never of the matrix: the attempt's
containers are removed (and their removal verified), then the attempt
starts again in mode B if `fallback: refresh-capable-copy` is declared,
recording `accessOnlyRefused` and the redacted login error. Without a
declared fallback the provider gets a durable refusal and its repetition is
`missing` with class `infrastructure`, code `credential-login`; the other
providers' cells go on. The same applies when the token's lifetime is too
short.

**Mode B: refresh-capable copy.** The full file is copied into the agent
tmpfs. Because the refresh token is shared with the user's own sessions,
mode B forces concurrency 1 per provider. Teardown order, for completion,
timeout, cancellation and failures alike:

1. The CLI ends or is stopped (§3.8).
2. The runner kills every agent-UID process
   (`docker exec -u 10001 … kill(-1, SIGKILL)`) and verifies none remain.
   PID 1 is a harness-UID supervisor that reaps orphans. Observed: PID 1
   survives `kill -9 -1` from the agent UID, and processes not reaped by
   PID 1 remain as zombies.
3. **Export, before tmpfs destruction:** an execute-only Node exporter opens
   the credential path with `O_NOFOLLOW`, requires a regular file of at most
   64 KiB, and writes it to the exec stream.
4. The runner validates the export **as untrusted input**: valid JSON with the
   same key structure and value types as the copied original. If the refresh
   token is unchanged, nothing is written.
5. If it changed: **compare-and-swap** on the host file. If the host file's
   sha256 still equals the pre-copy value, write a backup (`0600`, runner
   state directory outside the repository, last 3 kept), write a temp file
   `0600` in the same directory, fsync, rename atomically, fsync the
   directory. If the host file changed meanwhile (the user's own CLI
   refreshed), nothing is overwritten, the conflict is recorded and the
   provider is halted for the user to re-login.
6. Any export failure (missing file, symlink, FIFO, oversize, invalid JSON,
   shape mismatch): the host file is untouched, the provider is halted, and
   the record says `credential-export-failed`. The provider may already have
   rotated the token server-side; that is the accepted risk.
7. The redaction set (all secret leaf values of the original **and** the
   exported credential) is complete **before** any artifact of the attempt is
   persisted. Until then the stream and stderr are held in runner-private
   temporary files (`0600`), redacted on persistence and deleted.
8. Only now is the agent container removed and its tmpfs destroyed.

Crash recovery: every resource of an attempt (agent container, proxy,
network, or the local fixture executor's process group) is recorded in the
attempt's private state **before** it is created. At start-up, the runner
recovers every stale attempt whatever its credential mode: kills the agent
processes, exports and writes back (mode B, policy re-checked), removes the
containers and network and **verifies** their removal, then deletes every
private file and working copy. Provider-backed starts also sweep resources
carrying the attempt labels. A credential export failure, a write-back
conflict, an unverified cleanup or a failed recovery is a **durable refusal**
of the provider (`<state>/refusals/<provider>.json`): later matrices do not
run that provider until the operator resolves it
(`pms-agentic-runner resolve-refusal <provider>`).

Rules in both modes: no host home path is mounted; the credential is
delivered on the exec stdin into tmpfs (not `docker run -e`, which persists
it in container configuration); P, E, G1, G2 and the proxy never hold a
credential. Observed: an execute-only CLI's environment is unreadable by
other same-UID processes. Tool children inherit the environment and can read
tmpfs files, so the agent can read the credential: residual risk.

### 4.7 Order of an attempt

1. Preconditions: product build binding and trusted tree digests (§4.8),
   image ids, CLI digests, `pms-agentic validate`, clean checkout, isolation
   self-test validity (§4.3), held-out refusal (§4.9), and the capability
   matrix (refuse unsupported tasks).
2. P: materialize, offline install from the verified fixture closure, check
   that the workspace's installed `@pandamstyle/*` equals the tarballs,
   `prepare`, archive the scope baseline.
3. A: start the supervisor, deliver the credential, `docker exec` the CLI;
   parse the stream; E applies triggered events (and the same steps to the
   baseline archive) and records workspace deltas; the sidecar audits.
4. Teardown (§4.6) with credential export.
5. Archive the final workspace evidence from a P-type container (no-follow).
6. G1, then G2 if the task has a `host.build` check.
7. Redact, bound and persist; leak scan; write the record.

### 4.8 Product build and grading compiler (invariant G)

**Binding.** A run is bound to the product build by digest
(`pms-agentic-product-build/v1`):

- epoch, which must be an epoch of `corpus.json` listing the source commit;
- source commit and tree;
- the source archive sha256, needed for the agent docs;
- the five `@pandamstyle/*` registry tarballs (sha256 and SHA-512
  integrity);
- the Node runtime archive sha256;
- the agent-docs tree digest, extracted from the source archive;
- provenance: the CE manifest sha256 and path;
- the store-copy verification result.

The runner binds **only** to the product tarballs, Node and the source
archive. It does not bind to the CE closure or npm cache: the corpus's
fixtures pin other versions, and the cache inventory is not reproducible by a
rebuild (core-evolution facts, PR #103). Chromium is not consumed by corpus
1.4.3 (no browser task), so it is not bound.

**Store.** Observed: on a copy of the store, `node tools/baselines/archive.mjs
verify --store <copy> --replay` (from a clone at `e2a864b`; the manifest sha256
is `acdefef3…2884`, identical on `main`) passed 42/42 checks in 15.8 s. The
original store contains historical unrecorded writes (core-evolution fact),
and the replay writes npm-cache metadata. So the runner:

- **only reads from a verified copy**, never from the original store, and
  never trusts files outside the manifest's inventory;
- verifies itself the sha256 of every artifact it consumes, and records the
  `archive.mjs verify` result when available.

**Grading compiler.** `evaluate` resolves `@pandamstyle/compiler` through
`findPackage`, which walks **ancestors** of the scratch workspace and falls
back to any `node_modules` above it (observed in `project-worker.mjs`; the
default scratch root is `os.tmpdir()`). The repository's own `node_modules`
links the workspace packages built from `HEAD`. Therefore, for every
provider-backed attempt:

1. The trusted tree is built in P by an offline install from the verified
   fixture closure. Every installed `@pandamstyle/*` package directory is
   compared file by file (sha256, nested `node_modules` excluded) with the
   `package/` entries of the corresponding digest-verified Alpha 1 tarball.
   Any difference refuses the attempt.
2. The record carries `trustedTree.digest` (`pms-tree-sha256/v1`, no-follow,
   links as targets) and `trustedTree.pandamstyleDigest`. Before each grading
   pass the runner recomputes the digest and **refuses** (`harness:
   trusted-tree`) if the tree is missing or differs.
3. `evaluate` is always called with `--trusted-node-modules /trusted/…` and
   `--scratch /scratch`. Inside the grader image `/scratch`, `/` and every
   ancestor have no `node_modules`; the image build and the self-test assert
   it. Missing `--trusted-node-modules` is a hard error in provider-backed
   mode. The ancestor fallback is allowed only in `adapter-fixture`/dev mode,
   which is labelled and never aggregated with provider-backed records.
4. `prepare` compile steps resolve the compiler from the workspace's own
   install, which item 1's check covers, and whose ancestors have no
   `node_modules` in P.

The harness's own dependencies (`@babel/*`, jsdom in `dom/`) come from the
runner commit's lockfiles and are part of the harness identity (§1.3), not of
the product.

### 4.9 Held-out tasks (F1)

In AG-00.2 the refusal is **unconditional**: every id in
`heldout/MANIFEST.json` (16, observed), any task with `split: heldout`, and
any `--heldout-dir` argument are refused before materialization, whatever the
environment says. The runner has no unseal path and never reads the
passphrase variable. AG-12.2 final qualification will need a separate,
reviewed change. Held-out artifacts must then stay unpublished. That path is
declarative here, as is candidate packing from a commit.

### 4.10 Residual risks

| Risk | Covering layers |
| --- | --- |
| The agent reads the credential and uses it (exfiltration through allowlisted hosts, quota misuse, induced rate limits) | bounded attempt time; proxy byte and connection accounting with anomaly flags; transcript scan for credential paths and variable names; exact-match scans of stream, final message and workspace; `contested` handling of infrastructure failures (§5.3); mode A when feasible |
| Same-UID control of the CLI through its sockets | channel audit; streams are `cli-unattested`; breach observation |
| Kernel escape (rootful Docker, no user-namespace remap) | non-root, no capabilities, `no-new-privileges`, seccomp, AppArmor, read-only root, no Docker socket, short-lived containers |
| Disk exhaustion through the workspace mount | size sampling with a kill cap (`resource-limit`); size-limited tmpfs |
| Hostile workspace content (links, FIFOs, huge files) | host code reads the live workspace only through the bounded `O_NOFOLLOW`/`O_NONBLOCK` delta walker (§11.2 item 2); archives are taken after every agent process is gone, without following links or reading special files; size bounds |

## 5. Failure taxonomy and retries

### 5.1 Classes

Classification is a pure function of: exit status and signal; structured CLI
fields (Claude `is_error`, `terminal_reason`, assistant `error` enum,
`api_error_status`, rate-limit status; Codex terminal event type and
pattern-matched terminal message); container state; harness timers and
harness errors. It never sees the verdict, the workspace or model/tool text.

| Class | Codes | In success statistics | Retried |
| --- | --- | --- | --- |
| `agent` | `completed`, `budget-timeout`, `budget-max-tool-calls`, `cli-max-turns`, `context-exhausted` (Claude `prompt_too_long`) | yes (budget codes are non-success) | never |
| `agent-resource` | `resource-limit` | yes, non-success | never |
| `agent-abnormal` | `abnormal-exit` (CLI gone without a provider error), `aborted-by-agent-code` (G2) | yes, non-success | never |
| `policy` | `tool-policy-breach` (web/subagent use), `credential-leak` | yes, non-success | never |
| `infrastructure` | `rate-limit` (Claude `rate_limit`, `rejected` rate-limit status; Codex usage-limit pattern), `capacity` (`overloaded`; server-overloaded pattern), `provider-error` (`server_error`; stream disconnected after the CLI's own retries), `auth` (`authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `verification_required`, `billing_error`, `cloud_credential_error`; auth pattern), `container`, `proxy` | no: excluded and reported | yes, except `auth` (halts the provider) |
| `unclassified` | terminal error matching no structured value or pattern (Claude `unknown`, unmatched Codex message, unknown `terminal_reason`) | no: excluded and reported, and counted in the conservative bound (§5.3) | never |
| `harness` | `adapter-stream`, `config-integrity`, `model-fidelity`, `drift`, `install`, `prepare`, `trusted-tree`, `evaluate-error`, `redaction`, `credential-export-failed`, `cancelled` | no: invalid | never; systematic codes halt the matrix |

Precedence: `harness` > `policy` > `infrastructure`/`unclassified` >
`agent-*`. `invalid_request` and `model_not_found` are `config-integrity`.
`max_output_tokens` is an agent outcome.

### 5.2 Retry policy

- Only `infrastructure` attempts are retried, from scratch, up to 3 attempts
  per repetition. Backoff uses `resetsAt` when reported, otherwise
  60 s × 2^k, capped at 30 min, inside the operator time window (Q8).
- A repetition with no valid attempt is `missing` and its cell
  `incomplete`; AG-00.3 cannot freeze a threshold on an incomplete cell
  without an explicit decision.
- `unsupported / not run` tasks (§4.5) are listed per cell, never failed or
  dropped.

### 5.3 Contested attempts (R3)

Infrastructure failures are classified from the CLI stream, which is
`cli-unattested` (§4.4), and the agent can also provoke real provider
failures with the credential it can read. So (§0.4) **every repetition that
consumed an infrastructure retry is `contested`**, whatever its stream,
proxy log or breach observations show; those observations are recorded as
supporting detail.

The report gives each cell's success as a point estimate (the failed attempt
excluded, the retry's outcome counted) **and** as a conservative lower bound
(every contested or `unclassified` repetition counted as non-success). A
retry decision therefore never silently improves a result, and no stream
event alone establishes that a retry was unbiased.

## 6. Evidence and raw traces (R4)

### 6.1 Oracle-relevant set

The oracle-relevant set of a workspace is every path **except** the oracles'
own `ALWAYS_IGNORED` globs (`node_modules/**`, `**/node_modules/**`,
`.git/**`; read from the locked harness, not duplicated). Harness-ignored
output such as `.pandamstyle/**` and the state file **is** in the set, because
`generated.consistent` reads it.

Evidence archives (baseline and final) are tar archives written inside a
container without following links:

- regular files with their bytes;
- symbolic links as link entries with their target text;
- directories, including empty ones;
- special files as metadata only;
- `node_modules` excluded, its tree digest recorded instead;
- `.git` archived separately for audit, bounded, outside the set.

### 6.2 Graded bytes vs stored bytes

Grading reads the unredacted evidence extract. The stored archive is the same
bytes unless redaction or a size bound changed something:

- a secret found in an oracle-relevant file is replaced by a same-length
  marker in the stored copy, the attempt is flagged `credential-leak`, and
  the evidence becomes `redacted`;
- a transcript, final message or observation whose redacted copy differs from
  the graded copy makes the evidence `redacted`;
- an archive over its bound (default 64 MiB, `node_modules` excluded) is not
  stored (`incomplete`).

### 6.3 Replay exactness

`evidence.completeness` is `complete`, `redacted` or `incomplete`. Re-grading
is labelled `exact` only for `complete`. For the others the runner refuses
the label and reports `non-exact` with the affected paths.

### 6.4 Storage, bounds and retention

- Run root `~/.local/share/pandamstyle-agentic-runs/` by default. Refused
  inside the repository except gitignored `.pms-bench/` for fixture runs.
- Raw stream bounded at 64 MiB per attempt (head and tail kept with a
  marker); metrics are computed from the complete stream before truncation;
  stderr bounded at 1 MiB. Truncation never affects the oracle-relevant set
  or the normalized transcript. An oversized transcript makes the evidence
  `incomplete`.
- Redaction (before any write, §4.6 step 7): exact secret values in raw,
  JSON-escaped, base64 and URL-encoded forms; token patterns; the host user's
  home path, and the user name in home-directory paths (`/home/<user>`,
  `/Users/<user>`), not every word equal to it (a CI user is called
  `runner`). A post-write scan failing deletes the artifact
  (`harness:redaction`).
- Q10: leak-scanned `matrix.json`, `product-build.json`, records,
  evaluations and reports may be committed by AG-00.3. Raw artifacts stay
  local through the baseline review and are pruned explicitly
  (`prune --older-than`).

## 7. Report

`report.json` (`pms-agentic-run-report/v1`) and Markdown:

- **Per cell:** every repetition's verdict, termination, class, attempts,
  contested flag and evidence completeness; every metric's full list of
  values with min/median/max, never a mean alone. Unknowns are counted and
  excluded from statistics.
- **Per-task × model failures:** failing required checks with oracle reasons,
  by class.
- **Policy and scope breaches:** every attempt with realized scope
  violations, integrity or static failures, denials and detections from §4.5,
  credential-path access, stream anomalies, channel-audit findings, model
  fidelity violations, whatever the verdict.
- **Per model:** `k/n` success per workflow and case type, with `n_valid`,
  `n_planned`, missing, `unsupported / not run`, and the point estimate with
  its conservative bound (§5.3).
- **Infrastructure:** attempts, retries and events per provider.
- **Environment:** comparability keys, product build digest, trusted tree
  digests, image ids, CLI digests, load summary.

AG-00.3 consumes `report.json` and the records; its thresholds are bound to
comparability keys.

## 8. Comparability and instrumentation isolation (AC4)

- The product is never modified. Alpha 1 is installed from its verified
  tarballs, and the grading compiler is the same artifact (§4.8).
- The agent receives exactly the corpus prompt and the product's own agent
  docs. The runner adds no system prompt, hooks, MCP servers, skills or
  memory. The CLIs' built-in context (Claude's built-in plugins, Codex's
  bundled system skills) is recorded as effective configuration.
- Telemetry is passive: CLI output, cgroup, proxy log, harness timers, and
  workspace digests taken from outside the agent's processes.
- The only interventions are the corpus's own events.
- The same runner, images, CLI configuration and budgets apply to every
  product build, and the comparability key enforces it (§1.4).
- The runner and its drafts live in `runner/`, outside the digest-locked
  `src/` and `schema/`, so the corpus lock is unchanged.

## 9. Test plan

### 9.1 Adapter fixtures (CI; deterministic; no provider; no Docker)

Fake `claude` and `codex` executables replay streams written from the pinned
contracts (§3.4–3.5) and the observed offline outputs.

| Id | Fixture | Proves |
| --- | --- | --- |
| F1 | Claude success: init, tool calls, `modelUsage`, cost | parsing, transcript, tool counts, cost `estimate` |
| F2 | Codex success with non-zero usage | tokens observed; cost `unknown` |
| F3 | Codex `turn.completed` with all-zero usage (no usage notification upstream) | `unknown`, never 0 (AC2) |
| F4 | Codex non-zero input/output, zero cached and reasoning counters | details `unknown`, totals `observed` |
| F5 | Codex several `turn.completed` with growing cumulative usage | last value used, no sum |
| F6 | Claude error result with zero usage, `modelUsage: {}`, synthetic message (the observed shape) | all tokens and cost `unknown` |
| F7 | Claude duplicate assistant events per `message.id`; `modelUsage` vs per-message disagreement | de-duplication; `discrepancy` recorded for input and cache counters, never for output snapshots |
| F8 | Claude cache read/creation and thinking counters | additive and subset rules; normalized fields |
| F9 | `costBasis: unknown` | cost `unknown` |
| F10 | Claude `rate_limit` error with `rejected` rate-limit event; Codex usage-limit message | `infrastructure:rate-limit`, backoff from `resetsAt` |
| F11 | `overloaded`; Codex server-overloaded message | `capacity` |
| F12 | `authentication_failed` (observed shape: `subtype: success`, `is_error: true`); Codex auth message | `auth`, provider halted |
| F13 | Codex `error` "Reconnecting…" events followed by `turn.completed` | not terminal; noise counted |
| F14 | Codex unmatched `turn.failed` message; Claude `unknown` error; unknown `terminal_reason` | `unclassified`, not retried, conservative bound |
| F15 | Codex `item.completed` error "model rerouted: a -> b (…)" | `model-fidelity` |
| F16 | Claude `model_refusal_fallback`; a main-loop `message.model` ≠ requested | `model-fidelity` |
| F17 | Claude legitimate auxiliary model in `modelUsage` | auxiliary usage reported; no violation |
| F18 | Claude `init.tools` containing `WebSearch`; Codex `web_search` and `collab_tool_call` items | `config-integrity` / `tool-policy-breach` |
| F19 | interrupted Codex turn without terminal event, with and without a harness signal | budget/cancel vs `abnormal-exit` |
| F20 | stream integrity: events before init, two terminal events, events after the terminal one, invalid JSON | `adapter-stream` |
| F21 | a fake execute-only CLI whose fake tool child tries `/proc/<ppid>/fd/1` injection and environment reads | blocked (EACCES); the stream stays `cli-unattested` (§0.4: blocking these paths is not a demonstrated boundary) (needs Docker: §9.3) |
| F22 | a fake CLI that leaks its stdout into a child, which writes a valid, complete replacement stream | usage stays `estimate` (`cli-stream-unattested`); a retry it causes is `contested`; the replaced stream is never `observed` |
| F23 | text in tool output and model messages mimicking errors and JSON events | classification unchanged |
| F24 | shell-mediated write (`sed -i`) between a failed and a passing build | repair detected through the workspace delta |
| F25 | `npm run build \|\| true`; `build && test` | `compound` → coverage incomplete → first-pass `unknown` |
| F26 | missing exit status; interrupted item | coverage incomplete |
| F27 | custom verification script name | `unknown` class → coverage incomplete; compiler time unattributed |
| F28 | timeouts: SIGINT/SIGTERM/kill escalation | `budget-timeout`, partial stream kept |
| F29 | `maxToolCalls` reached; Claude `error_max_turns` | distinct codes |
| F30 | round trip: modified generated file + added symlink → archive → re-grade | identical check statuses (the reviewer's probe) |
| F31 | secret inside an oracle-relevant file | `redacted` evidence; replay `non-exact`; `credential-leak` |
| F32 | oversized workspace / transcript | `incomplete`; replay `non-exact` |
| F33 | FIFO, hard link and dangling link in the final workspace | archived as metadata; no hang; scope check unchanged |
| F34 | two attempts differing only in session id, attempt dir, timestamps, host load or commit SHA (same harness bytes) | equal keys |
| F35 | one mutation per projection field; a product-only change | unequal key naming the field; equal key for the product-only change |
| F36 | Codex/Claude streams with web or subagent tool use | breach, non-success |
| F37 | read-only task in which the agent builds into `/tmp` | `host.build` detection recorded |
| F38 | local `npm install` into `node_modules` | detected through the `node_modules` digest |
| F39 | task with a `package-registry` network, services, browser or compile events | refused, `unsupported / not run` |
| F40 | G2 build script that kills the grader | `aborted-by-agent-code`; verdict not `pass` |
| F41 | G2 build script that tries to write harness, trusted tree or evidence mounts | EROFS; consistency with G1 holds |
| F42 | G2 build script that prints a forged `evaluate` result to its own stdout | ignored (captured by `spawnSync`, not the grader's stdout) |
| F43 | G1/G2 disagreement on a non-host check | not `pass`; flagged |
| F44 | mode B: refreshed token, valid shape, host unchanged | host replaced atomically; backup kept; both tokens in the redaction set |
| F45 | mode B: no refresh | host untouched |
| F46 | export is a symlink / FIFO / oversized / invalid JSON / wrong shape / missing | host untouched; provider halted |
| F47 | host file changed during the attempt | no overwrite; conflict; halt |
| F48 | cancellation during the agent phase and during export | export completed or safely abandoned; cleanup |
| F49 | runner crash with a live container | recovery export and cleanup at next start |
| F50 | refreshed token printed in the stream before export | not persisted unredacted |
| F51 | provider-backed evaluate without `--trusted-node-modules` | hard error before grading |
| F52 | trusted tree digest mismatch; a `@pandamstyle/*` file differing from the tarball | refused (`harness:trusted-tree`) |
| F53 | a `node_modules` directory placed in an ancestor of the scratch path | refused by the ancestor check |
| F54 | every held-out manifest id; `--heldout-dir`; any purpose variable | refused before materialization |
| F55 | CLI version or binary digest drift | refused |
| F56 | report over synthetic records: fails, unknowns, missing, unsupported, contested | distributions, breaches, bounds (AC3) |
| F57 | schema validation of every record, config and report | completeness |
| F58 | a shell script performing fail → repair → pass and exiting 0, run through `npm run verify` | no repair detected (lower bound 0); `firstPassSuccess` `unknown` because an opaque command ran (§0.4) |
| F59 | credential source: no entry, no source, relative path, missing file; the claude-team-2 directory; Codex `~/.codex` | refused before any attempt / resolved to the account's file and recorded with `~` (§4.6) |

### 9.2 Class-level checks

- Unknown-as-zero: a lint over the accounting modules, plus a property test
  that removes or zeroes random usage fields and asserts no affected value
  becomes `observed` without its provenance rule.
- Classification independence: the classifier's signature has no verdict,
  workspace or free-text input. Exception: the Codex terminal message, which
  is matched only against the pinned pattern table; tested with randomized
  text.
- Redaction: secrets injected in every channel and encoding.
- Key projection: the F35 mutation table is generated from the projection
  definition, so a field added to the projection without a test fails.

### 9.3 Isolation self-test (local, Docker; required before provider-backed runs)

Run with test images and no credential:

- **Network:** from an agent container, assert:
  - connection failure to a dummy host service on every host address (each
    bridge gateway, LAN, IPv6 global);
  - connection failure to external addresses, and no external DNS;
  - no reach into another attempt's network;
  - its own proxy reachable, and only allowlisted CONNECT targets accepted.
- **Process and filesystem:**
  - same-UID access to an execute-only process's `/proc/<pid>/fd`,
    `environ` and `mem` is denied;
  - read-only workspace, `.git` and definition mounts deny writes, renames
    and deletes;
  - no capabilities, non-root, no host path but the declared mounts;
  - pids and memory limits are enforced;
  - PID 1 survives `kill -1` from the agent UID.
- **Grader:** no `node_modules` above `/scratch`; trusted tree read-only; G2
  build-script tampering cases.
- **Mutations:** removing each mechanism (isolated gateway mode,
  execute-only mode, a read-only mount) makes the self-test fail.

Every network and process item above was observed once during this design
with ad hoc probes (Appendix A). The self-test turns them into a repeatable,
bound check.

### 9.4 Authorized smoke run (only after the orchestrator's explicit go)

- `discovery-positive-card-vocabulary` and
  `composition-positive-order-summary` × `claude-haiku-5-5`,
  `claude-sonnet-5-5`, `gpt-6.1-sol` × 1 repetition = **6 attempts**;
  concurrency 1; at most one infrastructure retry; stop at the first
  `harness`, `auth` or credential-export problem; hard stop at 2 h.
- Prerequisites: user cost/quota check, heads-up to the core-evolution
  orchestrator, valid self-test. **No effort flag** is passed in the smoke
  run: it observes each CLI's effective effort, which the baseline then pins
  (Q3).
- It records, beyond the normal artifacts, a telemetry availability table
  per CLI under subscription auth, which settles these unverified items:
  - presence and semantics of tokens, cost and `costBasis`;
  - Claude `init.effort` and `message.model` exactness;
  - auxiliary model keys;
  - Codex served-model visibility and error shapes;
  - the provider hosts contacted;
  - whether mode A (access-only) works for each CLI and whether mode B
    refreshes;
  - tool-result exit-status forms;
  - additive/subset token consistency;
  - channel-audit results.
- **First run (2026-10-19, `ffd2590`), observed:** discovery × both Claude
  models completed in mode A (verdict pass, only `api.anthropic.com:443`
  contacted); the Codex access-only login was rejected (§4.6) and the
  container error halted the whole matrix, so the remaining four attempts
  never ran. It also showed a spurious usage `discrepancy` (output
  snapshots, §2.2) and a channel audit that misidentified the CLI (§4.4).
  All three are fixed (§11.2 item 20). Its records are not kept.
- **Re-run (2026-10-19, `5e6521d`, matrix `smoke-20261019-r2`), observed.**
  Self-test of the exact binding passed (51 checks, binding `6af12df3…`);
  all 6 attempts ran once (14:35:31–14:39:18Z including preflight), none
  retried, contested or missing. Records, evaluations and the report, leak-scanned, are in
  [`smoke/2026-10-19/`](smoke/2026-10-19/). Discovery: pass and success for
  all three models. Composition: oracle verdict pass (haiku, sol) and fail
  (sonnet: it deleted the untracked `..pandamstyle.pms-state.json`,
  `generated-untouched`), but **all three are `capability-breach`**, a
  false positive (finding 1 below). Resolution of the items above:
  - *Tokens, cost, `costBasis`:* confirmed for Claude (`modelUsage` input,
    cache read and write, output; `costUSD` with `costBasis: list`; values
    `estimate`, `cli-stream-unattested`). Codex `turn.completed.usage` has
    `input_tokens` (cached included), `cached_input_tokens`,
    `cache_write_input_tokens: 0`, `output_tokens` and
    `reasoning_output_tokens: 0`; there is **no cost** field (cost
    `unknown`), and the zero cache-write and reasoning counters stay
    `unknown` (default-zero rule).
  - *Claude `init.effort`:* corrected: `init` has no effort value, only
    `per_turn_effort_active: true`; the effective effort is `unknown` for
    both CLIs with no effort flag (the baseline must pin it, Q3).
    `message.model` equals the requested id exactly (fidelity `faithful`).
  - *Auxiliary model keys:* none observed (`modelUsage` holds only the
    requested model).
  - *Codex served model:* not visible in the stream (`servedModels:
    unknown`, `no-reroute-surfaced`). Error shapes: still unverified (no
    Codex error occurred).
  - *Provider hosts:* Claude: only `api.anthropic.com:443` (3 connections
    per attempt). Codex: `chatgpt.com:443` (17–20 connections, about 35 MB
    down per attempt) and denied attempts to `ab.chatgpt.com` and six
    `sdmntpr*.oaiusercontent.com` hosts (12 per attempt), without visible
    effect on the attempt. `registry.npmjs.org` was denied once whenever an
    agent ran `npm` (npm's update check; no install command was run). The
    proxy settings are honoured by both CLIs (every connection went through
    the proxy; no other route exists, §4.3).
  - *Mode A / mode B:* mode A works for Claude Code; it is infeasible for
    Codex ChatGPT logins (§4.6), so Codex ran in mode B: export
    `unchanged` on both attempts, no refresh, no write-back, no backup;
    both host credential files byte-identical before and after. Refresh
    rotation under mode B stays unverified (the token did not need a
    refresh).
  - *Tool-result exit status:* Claude `tool_result` carries `is_error`
    `true`/`false` or omits it (absent counted as unknown); Codex
    `command_execution` carries `exit_code` and `status`
    (`completed`/`failed`).
  - *Token consistency:* Claude input fields are additive (uncached + cache
    read + cache write = total); thinking counts stayed below output, as a
    subset would; Codex `cached_input_tokens` is within `input_tokens`.
    Neither relation is provable from the stream.
  - *Duplicate usage:* confirmed (up to 24 `assistant` events for 8
    `message.id`s); the cross-check found no disagreement on any attempt.
  - *Channel audit:* every attempt `cliNonDumpable: true`,
    `foreignStreamHolders: 0` (1–4 samples).
  - *Rate limits:* Claude `rate_limit_event`: `five_hour` allowed,
    utilization 0.25, overage rejected (`org_level_disabled`); Codex
    reports none.
- **Defects found by the re-run (not fixed here; §11.2 item 22):**
  1. `local-install` is detected from a `node_modules` digest that also
     covers tool caches: Vite's `npm run build` leaves an empty
     `node_modules/.vite-temp` directory (reproduced offline, with no
     agent), so every legitimate build is a breach and success is
     understated.
  2. Codex runs commands through `bash -lc`; the login shell's
     `/etc/profile` resets `PATH` to the Debian default, so `npm` was not
     found (exit 127) until the agent added `/opt/node/bin` itself. Claude's
     tool shell keeps the image `PATH`. The environments are not equal.
- A successful smoke run cannot confirm rate-limit, capacity, quota
  exhaustion, refresh rotation under conflict, cancellation escalation or
  resource-limit behavior. Those stay covered by fixtures and are labelled
  unverified against real providers.

## 10. Open questions for the orchestrator

None. The effort values (Q3) and the detection-only denials (Q12) were decided
by the user (§0.3); R3 and R5 follow the conservative amendment (§0.4).

No oracle API change is required: two-pass grading uses `evaluate` as it is.

## 11. Implementation

### 11.1 Map

Entry point: [`bin/pms-agentic-runner.mjs`](bin/pms-agentic-runner.mjs)
(`validate-config`, `run`, `report`, `compare`, `regrade`, `copy-store`,
`bind`, `trusted-tree`, `selftest --matrix`, `recover`, `refusals`,
`resolve-refusal`, `prune`). Tests: `yarn bench:agentic:runner:test`
(adapter fixtures, no Docker) and `yarn bench:agentic:runner:docker-test`
(credential-free Docker integration with a fake CLI image; §11.3).

| Section | Code (`src/` unless noted) | Tests (`__tests__/`) |
| --- | --- | --- |
| §1.1–1.3 units, record, identity | `matrix.mjs`, `attempt.mjs`, `identity.mjs`, `schema/run-record.v1.schema.json` | every fixture run validates its records and report (F57, `helpers.mjs`) |
| §1.4 comparability | `comparability.mjs`, `matrix.mjs` `projectionFor` (per-cell closure) | `evidence.test.mjs` F34, F35; `measurement.test.mjs` B11 |
| §1.5 replay, resume | `regrade.mjs` (integrity and identity first), `matrix.mjs` `matrixIdentity`, `repetitionState` | `evidence.test.mjs` F30; `measurement.test.mjs` B10, B12; `review-r2.test.mjs` B10, B12 |
| §2.1–2.2 measured values, tokens | `measured.mjs`, `adapters/*.mjs` | `adapters.test.mjs` F1–F9; `smoke-fixes-2.test.mjs` observed Claude usage shape; `metrics.test.mjs` lint and property test |
| §2.4 repairs, first pass, attribution | `commands.mjs` (`command-classes/v4`) | `metrics.test.mjs` F24–F27, F58; `measurement.test.mjs` B8; `review-r2.test.mjs` B8 |
| §3 adapters, budgets | `adapters/*.mjs`, `attempt.mjs` `agentPhase` | `adapters.test.mjs` F10–F20, F23, F28, F29 |
| §3.2 container-visible paths | executors' `visiblePaths` | `docker.test.mjs` B6 |
| §3.7 version pinning | `docker.mjs` identity checks, `provider.mjs` | `product-build.test.mjs` F55 |
| §4.2 roles, confinement, grading | `safefs.mjs`, `workspace.mjs`, `docker.mjs`, `attempt.mjs` `grade` | `confinement.test.mjs` B1; `policy-report.test.mjs` F40, F43; `docker.test.mjs` B7 |
| §4.3 network, proxy | `docker.mjs`, `container/connect-proxy.mjs`, `selftest.mjs` | `isolation-units.test.mjs`; `docker.test.mjs` B5 |
| §4.4 stream integrity | `measured.mjs`, `container/channel-audit.mjs`, `docker.mjs` `summarizeAudits` | `adapters.test.mjs` F20, F22, F23; `smoke-fixes-2.test.mjs` (audit over the observed process table); `isolation-units.test.mjs` summary; `docker.test.mjs` channel audit; self-test (F21) |
| §4.5 capability matrix | `capabilities.mjs` | `adapters.test.mjs` F18, F36–F38; `policy-report.test.mjs` F39 |
| §4.6 credentials, source policy, recovery, refusals | `credentials.mjs`, `recovery.mjs`, `refusals.mjs`, `container/*` | `credentials.test.mjs` F31, F44–F50, F59; `confinement.test.mjs` B3, B4; `review-r2.test.mjs` B2, B4; `smoke-fixes-2.test.mjs` login fallback and provider refusal; `docker.test.mjs` B4, login fallback |
| §4.8 product build, trusted tree, closures | `store.mjs`, `trusted-tree.mjs` `installFixtureClosure`, `provider.mjs` | `product-build.test.mjs` G, F51–F53; `measurement.test.mjs` B11 |
| §4.9 held-out | `capabilities.mjs` `heldoutRefusal`, CLI | `policy-report.test.mjs` F54 |
| §5 failures, retries, contested | `classify.mjs`, `matrix.mjs` | `adapters.test.mjs` F10–F16, F22; `measurement.test.mjs` B10 |
| §6 evidence, redaction, bounds | `workspace.mjs` staging, `evidence.mjs`, `redact.mjs` (chunked scans), `stream.mjs` (bounded splitter and sink), `attempt.mjs` `writeRecord` | `evidence.test.mjs` F30–F33; `confinement.test.mjs` B2; `measurement.test.mjs` B13 |
| §7 report | `report.mjs` (seeded from the planned matrix), CLI `writeReport` | `policy-report.test.mjs` F56, F57; `measurement.test.mjs` B9 |
| §9.3 isolation self-test | `selftest.mjs`, `container/probe-*.mjs`, `docker.mjs` `stableHostAddresses` | `selftest-binding.test.mjs`; `docker.test.mjs` B5; §11.3 |

### 11.2 Where the implementation differs from or completes this note

Each item was found while implementing, testing or in review round 1
(B1–B13), and the note above was corrected where it stated something false.

1. **Agent and grader UID.** The agent runs as the runner's own host UID (not
   10001), so the bind-mounted workspace is writable without `CAP_CHOWN`.
   Graders run as the same UID (not 30001), so they can read the
   runner-private (0700) staging they get as read-only mounts; nothing else
   of the host is mounted and no agent process exists when they run (B7).
   The self-test checks non-root, no capabilities and `no-new-privileges`.
2. **P and E in the runner process, confined (B1).** Materialization, the
   offline install and `prepare` run before any agent code exists. While the
   agent runs, and afterwards, every host operation on the workspace goes
   through `safefs`: each path component is resolved beneath an open
   directory handle (`/proc/self/fd/<fd>/<name>`, `O_NOFOLLOW`), so a link
   anywhere in a path, a directory swapped after it was opened, a root link
   (`node_modules` itself a link) or a file swapped for a FIFO is refused,
   never followed or blocking. Corpus events (every step kind), delta and
   size samples, the `node_modules` state, the post-run staging copy and leak
   scans use it. Grading and archives read only the staging copy.
3. **Private working copies (B2).** `.private` and `.work` are 0700; the
   unredacted workspace, baseline, staging, oracle inputs and raw streams
   are removed on every exit path (including exceptions) and by crash
   recovery. `record.json`, `matrix.json`, `outcomes.json` and reports are
   redacted and scanned like the other artifacts.
4. **Incremental bounds (B13).** Raw stdout and stderr are stored by a
   line-aligned head/tail sink while streaming; the parser never buffers a
   line beyond 8 MiB (`line-too-long` anomaly); leak scans read in bounded
   chunks; the whole-workspace byte cap (`workspaceBytesCap`) is checked at
   every tool result and stops the agent as `resource-limit`; staging stops
   at the evidence bound, which makes the evidence `incomplete` (unstaged
   files are listed as unstored) and the attempt `harness: evidence-bound`,
   never graded on partial bytes. A truncated stream, transcript or final
   message makes the evidence `incomplete`.
5. **Two-pass grading is not reached by corpus 1.4.3.** Only the three
   installation tasks have a `host.build` check, and they are refused until
   the local mirror exists (Q2). G2 is tested at the `grade` level (F40,
   F43); F41 and F42 have no automated test (review follow-up F2).
6. **Codex duplicate terminal events.** §2.2 (last cumulative usage) and F20
   (an anomaly) both hold, F5.
7. **Missing audit and proxy data are unknown.** No audit sample (local
   executor, or an attempt shorter than the first sample) gives `null`
   fields; proxy accounting (`integrity.proxy`) is read before the proxy is
   removed. Anomaly thresholds and the control-socket audit are not
   implemented (review follow-up F1).
8. **Planned matrix in reports (B9).** Reports are seeded from the planned
   task × model × repetition matrix: a cell or repetition without records is
   listed with its reason and stays in every denominator; unsupported cells
   are listed per cell and excluded from runnable denominators.
9. **Resume (B10).** A matrix resumes only with the identical configuration,
   harness, product build and dependencies (`identityDigest`); records of
   another matrix, cell, model or kind refuse the resume; duplicate model
   keys or tasks are invalid; crashed attempts (a directory without a record)
   count as used and contested; cancelled attempts do not count; a
   non-retryable invalid final attempt stays `missing`. Attempt indices can
   therefore exceed `maxAttempts`. The load sampler now covers the attempt
   itself (review follow-up F3, trivial).
10. **Credential source** (§4.6): required, recorded, enforced (B3), with
    durable refusals and resource-tracked recovery (B4).
11. **Fixture closures (B11).** A provider-backed `run` needs `--setup`
    (`pms-agentic-provider-setup/v1`) with a closure (`package.json`,
    `package-lock.json`, optional offline cache) for the fixture of every
    runnable task; a missing one refuses preflight. Each workspace is
    installed with `npm ci --offline --ignore-scripts`, its `@pandamstyle/*`
    packages verified against the tarballs before the agent starts, and the
    closure's lock digests are recorded (`install`) and enter that cell's
    comparability projection. Producing the closures is not implemented.
12. **Regrade (B12).** Artifacts, evidence blobs, set digests, harness
    identity and (for trusted-tree records) the supplied trusted tree are
    verified first; integrity failures refuse; identity differences or
    incomplete evidence give `non-exact`; provider-backed records never use
    the ancestor fallback.
13. **Self-test (B5).** It takes the run configuration (agent, proxy and
    grader images, per-provider allowlists, container limits), probes with
    those images and the runner's own argv builders, and writes a result
    bound to `selftestBinding(config, facts)`, the function preflight uses;
    it never builds or re-tags images. Not covered: the memory limit and the
    G2 tampering cases (follow-up F2); IPv6 link-local host addresses are
    recorded as skipped; the allowlisted CONNECT is checked from the proxy's
    decision log (the upstream answer is not part of the property, but the
    proxy does open a TCP connection to the first allowlisted host).
14. **Workspace deltas race a fast CLI.** Samples are taken when the harness
    receives a tool result; a CLI that runs its next tool before the harness
    reads the stream defeats the sample (repairs stay a lower bound). The
    fake CLI pauses after each tool result, as a real CLI waits for the
    model.
15. **Review round 2 (B2, B4, B8, B10, B12).**
    - B2: an attempt's redaction set forwards every secret to the matrix's
      set the moment it is learned, so text persisted on any exit path
      (exceptions before or after resource creation, teardown and export
      errors, refusals, `outcomes.json`, the outcomes the CLI prints) is
      redacted; refusal reasons are redacted too.
    - B4: `DockerExecutor.start` records every resource name before
      creating anything and, if a later step fails, removes what it created
      and verifies the removal; `runAttempt` also removes registered
      resources without a handle (`cleanupResources`), and anything it cannot
      verify (or a throwing teardown) keeps the recovery state and records a
      durable refusal. The matrix removes `.private` only when empty, so
      retained state survives its exit and is recovered at the next start.
      A teardown runs once; a second call rethrows the first error.
    - B8: command table v3 (option grammar, git never transparent,
      writes outside the workspace).
    - B10: the matrix identity binds the selected inputs before any reuse:
      each planned task's fixture closure as declared by its installer
      (`installer.identity`, the lock digests; provider runs declare them
      from the setup's closures) and the grading dependencies (mode, trusted
      tree digests). Every planned repetition is checked before anything
      runs; a record whose install differs from the declared closure, or
      whose installer declares nothing, refuses the resume before any
      mutation; an install that differs from its declaration is refused.
    - B12: the record binds each evidence manifest's bytes
      (`evidence.manifests`), so `stored`, `storedSha256`, `mode` and
      `completeness` cannot change; the completeness the entries imply must
      match the manifest's and the record's; and the extraction is checked
      against the manifest (every entry, original bytes, links, modes,
      nothing extra) before grading. Any failure refuses the regrade.
16. **Bounded verification micro-fix (user decision).**
    - B4: Docker cleanup counts an object as gone only on the daemon's
      definitive answer naming it ("No such container: <name>", "network
      <name> not found"); any other inspection failure (daemon unreachable,
      timeout) is `unknown`, which keeps the recovery state and records a
      durable refusal, like a removal that failed.
    - B8: `command-classes/v4`: any unquoted glob, brace or tilde character
      in any word makes a command opaque.
    - Flaky test fixed: the local-recovery test read the pid of
      `setsid sleep` before the child had called `setsid()` (observed in
      300 of 300 runs), so a recovery that ran first found no process group
      and the process survived under full-suite load. The test now waits
      until the process leads its own group (the executor's group exists
      before `spawn` returns), and recovery waits, bounded, for killed
      members to be reaped.
17. **Accepted residuals (user decision).** Records are not tamper-evident
    against the machine operator. Regrade and resume integrity checks
    detect inconsistency between the runner's own private records
    (`matrix.json`, `record.json`, evidence manifests and blobs), not a
    coordinated forgery of all of them: an operator who rewrites a record
    together with its manifests and digests can make a forged attempt look
    consistent (review classes B10 and B12). Only the operator can do this;
    the evaluated agent never has access to these files.
18. **Stable self-test host binding (after merge, main CI).** The binding
    first included every non-loopback host address, so Docker bridges,
    container veths and IPv6 link-local addresses created or removed
    between the self-test and preflight (the self-test's own networks, CI
    runners, restarting containers of other projects) changed it and
    preflight refused a self-test that had passed. It now binds the stable
    routable set of §4.3 (`stableHostAddresses`), computed by the same
    `currentFacts` in both places. The probes still target every host
    address and bridge gateway.
19. **Smoke-run preparation findings (no model call).** Preparing the
    authorized smoke run on `aebb19a` showed three implementation defects:
    - the fixture installer required every product package of the binding,
      while a fixture installs only those its `package.json` declares (the
      storefront: core, compiler, vite). It now requires the declared ones,
      verifies every installed one against its tarball and refuses any
      installed `@pandamstyle/*` package outside the product build (§4.7);
    - Codex 0.163.0's `debug prompt-input` accepts neither `--strict-config`
      nor `-m` (observed), so the evidence render failed and every Codex
      attempt would have been `config-integrity`. It now passes the model as
      `-c model=…` with the attempt's overrides; the values are still
      type-validated (an unknown `web_search` variant fails) and the attempt
      runs `codex exec --strict-config` (§3.3);
    - the agent image copied only `bin/codex`, so Codex lost the helpers it
      finds next to its executable (`codex-code-mode-host`, bundled `rg`,
      `bwrap`) and reported Code Mode unavailable. `/opt/cli/codex` is now a
      link into the execute-only vendor tree (§3.7).
20. **First smoke run findings (observed, §9.4).** Three defects, fixed
    with tests built from the observed shapes (synthetic credentials only):
    - a rejected Codex access-only login was a container error that halted
      the matrix. The executors now raise a coded `credential-login`
      failure; the attempt falls back to the declared mode B or refuses only
      that provider (§4.6). Codex mode A is infeasible for ChatGPT logins;
    - the usage cross-check compared per-message output snapshots and
      reported a spurious disagreement; it compares input and cache
      counters only (§2.2);
    - the channel audit took the launcher for the CLI, read dumpability from
      `/proc/<pid>` and counted the CLI's own descriptors as foreign holders;
      a sample that missed the CLI counted as clean (§4.4). The fixed audit
      runs in the Docker integration tests.
21. **Provider-backed path.** Its preflight refusals are tested; the
    containers, staging, grading and self-test binding run in the
    credential-free Docker integration tests. The first smoke run executed
    it end to end for Claude (binding of the real store, trusted tree from
    the real tarballs, CLI identity of the real binaries); the re-run
    executed it for all three models (§9.4).
22. **Open defects from the smoke re-run (§9.4).** The `local-install`
    filesystem detector counts tool caches under `node_modules` (Vite's
    `.vite-temp`), and the agent image's login shell drops `/opt/node/bin`
    from `PATH` for Codex. Neither is fixed yet; the composition outcomes of
    the re-run are therefore not evidence of a breach.

### 11.3 Isolation self-test and Docker integration

`yarn bench:agentic:runner:docker-test` builds a harness image and a fixture
agent image (fake CLIs; tags `pms-agentic-test-*`), runs the self-test for
that configuration and checks that preflight's `requireValidSelfTest`
accepts it and refuses another configuration, then runs real attempts (agent
container, per-attempt proxy and network, fake Codex and Claude, grading in
the grader container with a test-only trusted tree). Local result (Docker
29.2.1, kernel 6.8.0-146-generic): passed (B5, B6, B7, and B4: a failure
injected after each resource-creation step over real Docker, the invalid CPU
limit case, an unverifiable cleanup retained, refused and recovered, and a
daemon outage during rollback treated as unknown, then recovered; the
channel audit identifying the non-dumpable fake CLI with no foreign holder,
and a tool child holding the stream; a rejected Codex access-only login
falling back to mode B).
The `agentic-corpus` CI job runs the same tests as extra steps.

## Appendix A: probes and sources

All probes ran without network access for the CLI and without credentials;
none could reach a model.

| Id | What | Result |
| --- | --- | --- |
| P1 | Docker 29.2.1 networks: default `internal`, `internal` + `gateway_mode_ipv4=isolated`, the same with `--ipv6` + `gateway_mode_ipv6=isolated`; dummy host HTTP service on all addresses; Node TCP/DNS probe as UID 10001 without capabilities | default internal: gateway → TIMEOUT (dropped by this host's current firewall state); isolated: no host address on the bridge, docker0/LAN/IPv6-global host addresses and external addresses `ENETUNREACH`, external DNS `EAI_AGAIN`; per-attempt proxy reachable by name and address; another attempt's network `ENETUNREACH`; proxy egress to `api.anthropic.com` OK |
| P2 | probe image (`node:22-bookworm-slim@sha256:c3de60bf…`) with `claude`, `codex` and `node` copied `root:root 0711`; same-UID access from a second process | execute-only binaries run (`2.1.303`, `0.163.0`); non-dumpable: `fd/1` write, `environ`, `fd` list → EACCES; readable copies allow them; signals allowed; Yama `ptrace_scope = 1` |
| P3 | `claude -p` with the §3.2 flags, no network, no credentials | `init` fields as in §3.3; the env variables remove the telemetry plugin and auto-memory; `/tmp/cc-socks/<n>.sock` 0600 agent-owned; auth failure: `<synthetic>` message with `error: authentication_failed`, result `subtype: success`, `is_error: true`, `terminal_reason: api_error`, zero usage and cost, `modelUsage: {}`, exit 1 |
| P4 | `codex features list`, `debug prompt-input`, `debug models`, `exec --json` with the §3.2 flags, no network, no credentials | `agents.enabled=false` removes the multi-agent instructions, `--disable multi_agent` does not; `web_search` variants validated; strict config accepts the §3.2 keys; `error` "Reconnecting… n/5" events and an `item.completed` error item, no terminal event within 60 s; `CODEX_HOME` state files, no daemon socket; target `wss://api.openai.com/v1/responses`; catalog: `gpt-6.1-sol` default effort `low` |
| P5 | PID 1 (Node) container; `kill -9 -1` from the agent UID | PID 1 survives; killed children remain zombies (no reaping) |
| P6 | read-only `.git` and read-only file bind mounts in a writable workspace | `git status`/`diff` OK, `git commit` EROFS; file write EROFS; rename onto and delete EBUSY |
| P7 | `archive.mjs verify --store <copy> --replay` from a clone at `e2a864b` | 42/42 passed, 15.8 s; manifest sha256 `acdefef3…2884` |
| S1 | Codex `rust-v0.163.0`: `exec/src/exec_events.rs`, `exec/src/event_processor_with_jsonl_output.rs`, `codex-api/src/sse/responses.rs`, `core/src/config/mod.rs` | §2.2, §3.3, §3.5 |
| S2 | Claude Agent SDK `0.3.303` `sdk.d.ts` (tarball sha256 `86dc2947…71fc`, `claudeCodeVersion: 2.1.303`) | §2.2, §3.4, §3.6 |
| S3 | `benchmarks/agentic/src/oracles/project-worker.mjs` (`findPackage`), `evaluate.mjs` (`ALWAYS_IGNORED`, default scratch, `host.build` environment) | §4.8, §6.1 |
