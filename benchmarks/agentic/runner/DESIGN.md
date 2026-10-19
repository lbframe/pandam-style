# AG-00.2 runner: design note

Status: **design note for review; no runner code exists yet.** This note
defines how the multi-model evaluation runner of
[issue #6](https://github.com/lbframe/pandam-style/issues/6) will work. It is
written before implementation as the
[delivery protocol](../../../docs/agent-delivery-protocol.md) requires, because
the runner has a privacy surface (subscription credentials), a security surface
(it executes agent-written code) and an adversarial surface (the evaluated
agent can try to influence its own score). Nothing here is a shipped API. The
drafts in [`schema/`](schema/) are marked `draft` and may change during
implementation review.

Inputs this note builds on:

- the [corpus README](../README.md), in particular its runner contract and the
  **required runner precondition** (isolated execution);
- the [held-out access policy](../heldout/ACCESS-POLICY.md);
- lot AG-00 of the accepted
  [plan](../../../docs/architecture/agentic-optimizations-plan.md) (unchanged);
- the Alpha 1 baseline epoch manifest of the core-evolution epic
  (`benchmarks/core-evolution/epochs/alpha1/manifest.v1.json`, draft PR #99,
  not on `main`).

Every factual claim about the CLIs, the host or the store is labelled:

- **observed**: seen during this design by local inspection (`--help`,
  `--version`, file listings, `strings` on the installed binaries, Docker
  metadata). No model call was made. A string in a binary proves that the
  identifier exists, not how it behaves.
- **unverified**: inferred or documented elsewhere but not observed here. The
  implementation must not depend on an unverified behavior without a fixture
  test for both outcomes, and the authorized smoke run (section 9.3) turns the
  listed unverified items into observations.

## 0. Requirement map

| Issue item | Covered by |
| --- | --- |
| Deliverable 1: model IDs, provider/version, parameters, budgets, repetitions, prompts, task revision, environment | §1 run record, §3 adapters, §4.6 product build |
| Deliverable 2: success, first-pass success, repair cycles, tool calls, tokens, cost, time, visual fidelity, vocabulary, scope | §2 metrics |
| Deliverable 3: compiler/tool/agent cost separation; unknown stays unknown; estimates labelled | §2.3, §2.4 |
| Deliverable 4: raw traces and failures, bounded and redacted; deterministic vs provider-backed | §5 failures, §6 traces, §1.1 `kind` |
| AC1: replay or compare with exact inputs/configuration identified | §1.3 comparability key, §1.4 replay |
| AC2: missing telemetry never zero nor an observation | §2.1 measured-value rule, §9 fixtures F3–F6 |
| AC3: distributions and per-task/model failures incl. policy/scope breaches | §7 report |
| AC4: instrumentation isolated, reference comparable | §8 |
| Targeted verification: adapter fixtures, then bounded authorized smoke run | §9 |

## 1. Run record

### 1.1 Units and identity

- **Matrix**: one invocation of the runner over tasks × models ×
  repetitions, for one product build. It has a resolved configuration
  (`matrix.json`) and a `matrixId`.
- **Cell**: task × model configuration.
- **Repetition** `r` in `1..R` (baseline `R = 3`): an independent sample of a
  cell. Its index is assigned when it is planned, never according to its
  outcome.
- **Attempt** `a` in `1..A`: one execution of a repetition. A repetition
  normally has one attempt; a new attempt starts from scratch only after an
  infrastructure failure (§5.2). Every attempt is recorded, valid or not.

Every record carries `kind`:

- `provider-backed`: a real CLI talking to a real provider;
- `adapter-fixture`: a fake CLI replaying a recorded or synthetic stream
  (tests, CI).

Reports refuse to aggregate records of different kinds, and fixture records
are labelled synthetic wherever they appear (deliverable 4).

### 1.2 Fields

Draft schemas: [`schema/run-config.draft.schema.json`](schema/run-config.draft.schema.json),
[`schema/run-record.draft.schema.json`](schema/run-record.draft.schema.json),
[`schema/product-build.draft.schema.json`](schema/product-build.draft.schema.json).
Each attempt record contains:

| Group | Fields |
| --- | --- |
| Identity | `schema`, `kind`, `matrixId`, `cell` (task id, model key), `repetition`, `attempt`, `comparabilityKey` (§1.3) |
| Task | task id, split (always `development` in this issue), workflow, case type, epoch evaluated, corpus version, `corpus.lock.json` sha256, the lock's task digest (`pms-tree-sha256/v1`) and harness digests (schemas, oracles, report contract, DOM tree) |
| Prompt | verbatim prompt text as sent (`prompt.md` beside the record) and its sha256; the docs path substituted into it; the delivery channel (argv or stdin) |
| Model configuration | requested model id (`claude-haiku-5-5`, `claude-sonnet-5-5`, `gpt-6.1-sol`), served model id(s) as reported by the stream (or `unknown`), reasoning effort, max turns, permission mode, tool allowlist and denylist, sandbox flags, every CLI argument verbatim, every environment variable *name* passed to the CLI and the values of the non-secret ones, the CLI configuration files written by the harness (verbatim and sha256) |
| CLI identity | CLI name, `--version` output inside the image, sha256 of the CLI binary in the image, expected values from `matrix.json` |
| Provider info | everything the stream reports that identifies the service: session/thread id, served model, service tier, rate-limit state, API retry events. Fields the CLI does not report are `unknown`. |
| Budgets | task `timeoutSeconds` and `maxTurns`, the effective values, which limit fired (if any), and container resource limits |
| Product build | product build binding digest and its contents (§4.6): epoch, source commit/tree, package tarball digests, Node digest, agent-docs tree digest, provenance (CE manifest sha256) |
| Execution environment | image id (sha256) and base image digest; Docker server version; kernel; CPU model and count; memory; 1-minute load average sampled every 5 s during the attempt; container cgroup CPU time, memory peak and pids peak; harness checkout commit and clean/dirty state; runner tree digest |
| Timestamps | UTC wall-clock start/end of each phase (materialize, install, prepare, agent, events, evaluate) and monotonic durations |
| Outcome | termination (`completed`, `budget-timeout`, `budget-max-turns`, `resource-limit`, `abnormal-exit`, `infrastructure`, `harness`), failure class and code (§5), retry decision |
| Metrics | the measured values of §2, each with status and source |
| Artifacts | relative paths and sha256 of: prompt, bounded raw stream, stderr, normalized transcript, observations, final message, oracle result, baseline and final workspace archives, proxy log, host samples; truncation and redaction markers |

### 1.3 Comparability key

`comparabilityKey` is the sha256 of the canonical JSON of everything that
defines the experiment **except** the product build binding, the repetition
and attempt indices, and timestamps: task digest, epoch, prompt sha256, model
configuration, CLI identity, budgets, container limits, image id, harness
digests and runner tree digest. Two attempts with equal keys differ only in
the product build under test (and sampling). `compare` refuses to pair
attempts whose keys differ and lists the fields that differ. A frozen AG-00.3
threshold is bound to one key per cell.

### 1.4 Replay

"Replay" has two meanings, both supported:

1. **Re-evaluation (deterministic).** The attempt persists the scope baseline
   and the final workspace (excluding `node_modules` and harness-ignored
   output, §6), the transcript, observations and final message. Re-running
   `pms-agentic evaluate` with the recorded corpus/harness digests and the
   recorded trusted install reproduces the oracle result exactly; with a newer
   oracle version it gives a comparable re-grading, labelled with that
   version.
2. **Re-execution (same inputs, new sample).** `matrix.json` plus the product
   build binding, the image id and the credential *method* (never the secret)
   identify every input. Re-running a cell with them produces a new sample
   with an equal `comparabilityKey`. Model outputs are not deterministic, so
   re-execution is compared statistically (§7), never byte for byte.

## 2. Metrics

### 2.1 Measured-value rule (AC2)

Every non-oracle metric is a measured value:

```json
{ "status": "observed | estimate | unknown", "value": 123, "unit": "tokens",
  "source": "claude.result.usage", "method": null }
```

- `observed`: reported by the named source in this attempt.
- `estimate`: computed or reported as an approximation; `method` is required
  and names how (for example `claude-cli-api-equivalent`), and the report
  prints it as an estimate.
- `unknown`: `value` is `null`. A missing field, an absent event or an
  unparseable value is `unknown`, never `0`.

Aggregation follows the same rule: a sum over components is `unknown` if any
component is unknown; the known partial sum may be reported only as a
labelled `lowerBound`. The accounting modules may not contain a default to
zero (`?? 0`, `|| 0`); a lint test enforces this class (§9.2).

### 2.2 Metric table

Availability per CLI is from local inspection only (§3). "Strings" means the
field name exists in the installed binary; its presence in a subscription
session's stream is **unverified** until the smoke run.

| Metric | Definition | Source | `claude -p` (2.1.303) | `codex exec` (0.163.0) |
| --- | --- | --- | --- | --- |
| Task success | oracle `verdict = pass` **and** termination `completed` within budget (Q7) | oracle result + harness | harness | harness |
| Outcome split | `success.application`, `success.diagnosis`, `success.report` | oracle result | harness | harness |
| First-pass success | task success with zero repair cycles (Q5) | transcript + oracle | derived | derived |
| Repair cycles | failed verification command → ≥1 workspace write → later verification command; count of such sequences | normalized transcript (pattern table versioned with the runner) | exit status from tool result (unverified field) | `exit_code` on `command_execution` items (strings) |
| Tool calls | count by normalized tool kind (`command`, `file-read`, `file-write`, `search`, `other`) | stream | `tool_use` blocks (unverified layout) | `item.*` types `command_execution`, `file_change`, `mcp_tool_call`, `web_search` (strings) |
| Agent steps | model responses | stream | `num_turns` in result (strings) | not observed; `unknown` |
| Input tokens | uncached input, cache read and cache write reported separately | stream | `usage`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `modelUsage` (strings) | `turn.completed` usage, `cached_input_tokens` (strings) |
| Output tokens | output, with reasoning output separate when reported | stream | `usage.output_tokens` (strings) | `output_tokens`, `reasoning_output_tokens` (strings) |
| Cost | see §2.4 | stream | `total_cost_usd`, `costUSD` (strings): `estimate`, method `claude-cli-api-equivalent` | `cost_usd` exists as a string; its event is not identified: `unknown` unless observed |
| Elapsed time | harness monotonic duration of the agent phase; CLI-reported durations kept beside it | harness + stream | `duration_ms`, `duration_api_ms` (strings) | not observed; harness only |
| Visual fidelity | `visual.fidelity` check | oracle | `unmeasured` (no method in corpus 1.4.3; Q6) | same |
| Vocabulary compliance | all required `static.forbidden`, `definition.diff`, `generated.consistent` checks pass, plus the token assertions of required `render.styles` checks; reported with the per-check breakdown | oracle result | harness | harness |
| Scope violations | realized: `scope.diff` violations (writes outside writable globs, protected writes, deletions, symlinks); attempted: denied egress (proxy log), read-only filesystem denials, CLI permission denials (`permission_denials`, strings), credential-path access in the transcript (§4.4) | oracle + proxy + stream + transcript scan | all | all except CLI permission denials (none in bypass mode) |
| Model fidelity | every served model id equals the requested one; no fallback event | stream | `message.model`, `modelUsage` keys, `model_fallback`/`model_refusal_fallback` events (strings) | not observed: `unknown`, reported as such |
| Infrastructure noise | API retries, rate-limit events, compaction events | stream | `api_retry`, `rate_limit_event`, `compact_boundary` (strings) | `rate_limits`, `stream_disconnected` (strings) |

The oracle verdict is computed outside the agent container (§4) and is the
only source of success. The agent's own report (`pms-eval-report/v1`) is used
by the oracles exactly as in AG-00.1 and never as a success signal by the
runner.

### 2.3 Compiler, tool and agent cost (deliverable 3)

Three accounts, never summed into one number:

- **Agent cost**: model tokens and the CLI cost estimate, per served model.
  Claude Code makes auxiliary calls with other models (visible as additional
  `modelUsage` keys, unverified); they are agent cost but reported per model so
  the evaluated model's own usage stays separable.
- **Tool cost**: number of tool calls by kind; bytes of tool output returned to
  the model (context cost, `observed` from the stream; a token count of it is
  only an `estimate`); tool wall time from harness receive timestamps between
  a call and its result (`estimate`, method `harness-receive-time`, since
  provider and parsing latency are included); container CPU time from cgroup
  (`observed`, includes the CLI process itself, labelled so).
- **Compiler cost**: (a) agent-invoked compiler and host builds, identified by
  the versioned verification-command table: count, exit status and
  harness-observed time (`estimate`, same method); (b) harness-side compile
  work (`prepare` steps, oracle compilation), timed by the harness and
  reported in a separate harness section that is never attributed to the
  agent.

### 2.4 Cost under subscription authentication

Runs authenticate with the user's subscriptions, not API keys. Consequently:

- No attempt has a billed cost. The report never prints a cost as billed.
- Claude's `total_cost_usd` (if present) is recorded as `estimate`, method
  `claude-cli-api-equivalent` (the CLI's own price computation; unverified
  whether it is populated under OAuth).
- Codex cost is `unknown` unless the smoke run shows a reported field; if it
  appears, it is labelled with its observed meaning.
- The runner computes no price-table estimate in this issue. A later
  estimate from tokens must cite a versioned price table (source, date,
  digest) and is a separate field.
- Subscription quota consumption is not measurable by the runner; rate-limit
  events are recorded as reported.

### 2.5 Time under a busy host

The host is shared (16 CPUs, other projects running). Wall-clock latency is
noisy, so:

- deterministic metrics (verdicts, tool calls, tokens when reported, repair
  cycles) are primary;
- every attempt records the 1-minute load series, CPU time and CLI-reported
  durations when present;
- the matrix can **interleave** cells across product builds (ABAB order per
  task × model × repetition) so that latency comparisons are paired; the
  report gives paired ratios for interleaved pairs and labels every absolute
  latency `indicative`.

## 3. Adapters

Each adapter is a pure module: `buildInvocation(cellConfig) → {argv, env,
files}` and `parse(stream) → {events, transcript, metrics, termination}`,
plus a process controller shared by both. The parsers are tested with
fixtures without Docker (§9).

### 3.1 Observed CLI surface

`claude` 2.1.303 (`claude --help`, observed):

- `-p/--print`, `--output-format stream-json`, `--verbose`, `--model`,
  `--effort <low|medium|high|xhigh|max>`, `--permission-mode
  <acceptEdits|auto|bypassPermissions|manual|dontAsk|plan>`,
  `--permission-prompts none`, `--tools`, `--allowedTools`,
  `--disallowedTools`, `--strict-mcp-config`, `--mcp-config`,
  `--setting-sources`, `--settings`, `--no-session-persistence`,
  `--session-id`, `--disable-slash-commands`, `--fallback-model`,
  `--max-budget-usd` ("spend on API calls"), `setup-token` ("long-lived
  authentication token (requires Claude subscription)").
- `--bare` reads Anthropic auth only from `ANTHROPIC_API_KEY` or an
  `apiKeyHelper`; "OAuth and keychain are never read". It is therefore
  unusable with subscription authentication.
- In `-p` mode "settings files that fail validation are silently ignored".
  The runner therefore does not rely on a settings file for any policy.
- `--max-turns` is **not** in `--help`, but the string `--max-turns` and the
  result subtype `error_max_turns` are in the binary (hidden flag;
  behavior unverified).
- The binary contains `Error: When using --print, --output-format=stream-json
  requires --verbose` (so `--verbose` is passed).
- Binary strings (behavior unverified): `CLAUDE_CODE_OAUTH_TOKEN`,
  `CLAUDE_CONFIG_DIR`, `DISABLE_AUTOUPDATER`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`,
  `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`; hosts `api.anthropic.com`,
  `platform.claude.com`, `claude.ai/oauth`, `sentry.io`.

`codex` 0.163.0 (`codex exec --help`, observed):

- `--json` (JSONL events on stdout), `-m/--model`, `-c key=value`,
  `-s/--sandbox <read-only|workspace-write|danger-full-access>`,
  `--dangerously-bypass-approvals-and-sandbox` ("intended solely for running
  in environments that are externally sandboxed"), `-C/--cd`,
  `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config` ("auth still
  uses `CODEX_HOME`"), `--ignore-rules`, `--strict-config` (error on unknown
  `config.toml` fields), `-o/--output-last-message`, prompt from stdin with
  `-`.
- No max-turns option exists in `codex exec --help`.
- `codex login` offers `--with-api-key`, `--with-access-token` (reads
  `CODEX_ACCESS_TOKEN`-style input from stdin) and `--device-auth`.
- Binary strings (behavior unverified): `thread.started`, `turn.started`,
  `turn.completed`, `turn.failed`, `item.started`, `item.updated`,
  `item.completed`, item types `agent_message`, `reasoning`,
  `command_execution`, `file_change`, `mcp_tool_call`, `web_search`,
  `todo_list`; `exit_code`, `aggregated_output`, `cached_input_tokens`,
  `reasoning_output_tokens`, `rate_limits`, `usage_limit_reached`,
  `server_overloaded`, `stream_disconnected`, `cost_usd`,
  `model_reasoning_effort`, `approval_policy`, `check_for_update_on_startup`,
  `CODEX_HOME`, `HTTPS_PROXY`, `SSL_CERT_FILE`, `CODEX_CA_CERTIFICATE`; hosts
  `chatgpt.com`, `auth.openai.com`, `api.openai.com`.

### 3.2 Invocations

Claude (inside the agent container, working directory `/workspace`):

```sh
claude -p "<prompt>" \
  --output-format stream-json --verbose \
  --model <claude-haiku-5-5|claude-sonnet-5-5> --effort <matrix value> \
  --max-turns <task maxTurns>            # backstop only, see Q11
  --permission-mode bypassPermissions \
  --tools "<allowlist from capabilities>" \
  --strict-mcp-config --disable-slash-commands \
  --setting-sources "" --no-session-persistence \
  --session-id <uuid chosen by the harness>
```

Environment: `HOME` and `CLAUDE_CONFIG_DIR` on tmpfs, credential per §4.3,
`DISABLE_AUTOUPDATER=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
`DISABLE_TELEMETRY=1`, `HTTPS_PROXY` to the egress proxy. No
`--fallback-model`, no `--append-system-prompt`, no hooks, plugins or MCP
servers. Whether `--setting-sources ""` is accepted is unverified; if not, the
clean `CLAUDE_CONFIG_DIR` alone guarantees that no user settings exist.

Codex:

```sh
codex exec - --json --strict-config --ephemeral --ignore-rules \
  --model gpt-6.1-sol -c model_reasoning_effort="<matrix value>" \
  --dangerously-bypass-approvals-and-sandbox \
  --skip-git-repo-check -C /workspace -o /run/agent/last-message.txt
```

with `CODEX_HOME` on tmpfs holding only the credential and a harness-written
`config.toml` (recorded verbatim). `--strict-config` makes a misspelled key an
error instead of a silently ignored setting.

Symmetric policy choice: both CLIs run with their own approval layer
**bypassed** and their own sandbox **off**. Capability enforcement is done
identically for both by the container (§4.2); a CLI-specific permission layer
would make the two agents' environments differ. Codex's own Linux sandbox is
also unlikely to work under Docker's default seccomp profile (unverified).
Tool availability (not permission) is still restricted per CLI: no web
fetch/search and no subagents (Q4).

### 3.3 Effective-configuration check

Settings can be silently ignored (observed for Claude settings files), so the
adapter verifies the effective configuration from the stream before trusting
an attempt: Claude's `system`/`init` event (model, tool list, permission mode,
CLI version: field names unverified) and every assistant `message.model`.
A mismatch, or any fallback event, makes the attempt invalid
(`harness:config-integrity`) and halts the matrix. For Codex, where no served
model was observed in the event strings, served model is `unknown` and the
report states it.

### 3.4 Stream parsing

- Lines are parsed as JSONL as they arrive. Unparseable lines, an event
  before `init`, a second terminal event, or events after the terminal event
  are **stream-integrity anomalies**; any anomaly makes the attempt
  `harness:adapter-stream` (not retried, §5).
- Claude may emit several `assistant` events for one API message; usage is
  de-duplicated by message id. The result event's totals are recorded as their
  own source; a disagreement with the per-message sum is recorded as
  `discrepancy`, never silently resolved (unverified behavior; fixture F5–F6).
- The normalized transcript (oracle input) contains
  `{"type":"command","command":…}` for shell commands (as the corpus README
  requires) and adds `file-write`, `file-read`, `search` and `tool` entries
  with the tool-call index and harness receive time. The existing
  `transcript.commands` oracle only reads `type: "command"`.
- Workspace events (`after-tool-calls`, `after-file-write`, `after-seconds`)
  are triggered from the parsed stream: after the N-th tool **result**, after a
  `file-write` matching the glob, or after the given time. The harness applies
  the event (§4.5) and records `event:<id>` as `applied`, `not-applied` or
  `not-triggered`, with the tool-call index and time.

### 3.5 Version pinning and drift

- The CLI binaries are copied into the image from a pinned source and
  identified by sha256 (observed on this host: `claude.exe`
  `375988f4…191450`, `codex` `399ff69c…4215`); `--version` is checked inside
  the image at matrix start. `matrix.json` names the expected version and
  digest; any difference refuses the matrix.
- Autoupdate is disabled (`DISABLE_AUTOUPDATER=1`; Codex
  `check_for_update_on_startup=false`, key from strings, unverified) and the
  root filesystem is read-only, so the CLI cannot change during a matrix.
- A host-side CLI update (the host install auto-updates) does not affect
  existing images; adopting it is a new image, hence a new comparability key.

### 3.6 Timeouts and cancellation

- Wall-clock budget = task `timeoutSeconds`, measured by the harness from CLI
  spawn. At expiry: SIGINT to the CLI, SIGTERM after 15 s, `docker kill`
  (SIGKILL to the whole container) after 30 s. The partial stream is kept;
  termination `budget-timeout`.
- Turn budget = task `maxTurns`, enforced by the harness on normalized tool
  calls for both CLIs (Codex has no flag); Claude's hidden `--max-turns` is a
  backstop. Termination `budget-max-turns`, recording which limit fired.
- The container is the process group: killing it kills every background
  process the agent started. The final workspace is read only after the
  container has stopped.
- Operator cancellation (SIGINT to the runner) kills running containers,
  writes `harness:cancelled` records, and leaves the matrix resumable:
  repetitions with a recorded valid attempt are skipped on resume.

## 4. Isolation and credentials

### 4.1 Threat model

**Assets:** the user's subscription credentials and quota; the host's files
(home directory, other projects, `~/.claude`, `~/.codex`, the baseline store,
this repository); the integrity of verdicts and metrics.

**Adversary:** the evaluated agent, possibly following prompt-injected
instructions in task material (the corpus deliberately contains such tasks).
As in AG-00.1, it may cut corners or try known bypasses, and it may run any
code inside its container. It does not have kernel exploits or knowledge of
the harness internals.

**Not trusted:** everything inside the agent container (the CLI process too,
since the agent's shell runs as the same user and can read or signal it),
every byte of the workspace after the agent started, and every byte of the
stream that originates from model or tool output.

**Trusted:** the host-side runner, the evaluator container's harness code,
the verified product build artifacts, the image built by the runner.

### 4.2 Containers

Three roles, each a fresh container per attempt (`--rm`):

1. **Agent container**: runs the CLI.
2. **Harness container**: installs dependencies, runs `prepare`, applies
   workspace events, and runs `pms-agentic evaluate --host-commands`. No
   credentials, `--network none`.
3. **Egress proxy**: one per matrix; the agent container's only route.

Agent container settings:

- image built by the runner from a base image pinned by digest, plus Node
  22.22.0 from the verified product build store and the pinned CLI binaries;
  identified by its image id (sha256);
- `--user` a non-root uid/gid; `--cap-drop ALL`;
  `--security-opt no-new-privileges`; Docker's default seccomp and AppArmor
  profiles (observed: `apparmor`, `seccomp builtin`, `cgroupns`);
- `--read-only` root filesystem; tmpfs for `/tmp` and the agent home
  (`/run/agent`, mode 0700, size-limited);
- one bind mount: the attempt's workspace at `/workspace` (read-write, or
  read-only when `workspace.write` is withheld); the product's agent docs
  read-only at a fixed path; nothing else from the host. No home directory
  path, no `~/.claude`, no `~/.codex`, no Docker socket, no repository
  checkout, no baseline store;
- `--cpus`, `--memory` = `--memory-swap`, `--pids-limit`, `--ulimit nofile`
  from `matrix.json`; wall clock per §3.6;
- network: attached only to an `--internal` Docker network whose only other
  member is the egress proxy; `--dns` points nowhere, so name resolution
  happens only at the proxy (closing DNS as a side channel).

Egress proxy: a small CONNECT-only proxy (harness code) that allows `host:443`
from a per-CLI allowlist and logs every CONNECT (host, allowed/denied, bytes
each way, times). Initial allowlists from the binaries' strings:
`api.anthropic.com` (Claude) and `chatgpt.com`, `auth.openai.com` (Codex);
telemetry and error-reporting hosts are denied. The exact required set is
unverified and is finalized from the smoke run's proxy log; any change is a new
comparability key. Both CLIs contain `HTTPS_PROXY` handling (strings); whether
every request honors it is unverified, which is why the network is internal:
a request that ignores the proxy has no route at all.

What is enforced by construction, per capability:

| Capability withheld | Enforcement |
| --- | --- |
| `workspace.write` (9 read-only tasks) | workspace mounted read-only |
| `git.write` | `/workspace/.git` additionally bind-mounted read-only |
| `network.registry`, `package.install` | no route: the proxy allowlist contains provider hosts only; installs fail |
| `host.build` (read-only tasks) | read-only workspace (build output cannot be written); otherwise detected by oracles and transcript |
| `design-system.edit` | detected, not prevented: protected paths are inside the writable tree and legitimate builds rewrite generated output; `scope.diff` and `definition.diff` fail the run |
| `host.dev-server` | not granted by any 1.4.3 task; listening inside the container has no route out; detected in the transcript |

Unsupported task features are refused, not approximated: `workspace.services`
and `environment.browser: true` (no 1.4.3 task uses them), and
`network: package-registry` until Q2 is decided (the 3 installation tasks).

`bubblewrap` (0.9.0, present) is not needed: the CLIs' own sandboxes are off
and Docker provides the boundary.

### 4.3 Credentials

Rules that hold by construction:

1. The runner never mounts a host home path. It never reads `~/.claude`,
   `~/.claude.json` or `~/.codex` except to copy the single credential file in
   the fallback method below, and never writes there.
2. Credentials live only in a tmpfs inside the agent container, written by
   the entrypoint from the runner's stdin (not `docker cp`, which does not
   write into tmpfs, and not `docker run -e`, which would persist the secret in
   the container configuration). The tmpfs dies with the container.
3. The harness and proxy containers never receive a credential, so
   `evaluate --host-commands` (whose host build inherits the process
   environment: observed in `evaluate.mjs`) and agent-written build scripts
   cannot read one.
4. Secret bytes are known to the runner, so every persisted artifact passes an
   exact-match redaction (raw, JSON-escaped, base64, URL-encoded forms) plus
   pattern redaction (§6.2) before it is written. A post-write scan of the
   attempt directory for the secret fails the attempt closed.
5. The clean agent home contains no user configuration: observed on this
   host, `~/.codex` holds `AGENTS.md`, `memories/`, `skills/`, `rules/` and
   profile configs, and `~/.claude` holds `settings.json`, `skills/`,
   `plugins/` and project history. Copying only a credential keeps those out of
   the evaluated agent's context (a comparability requirement as much as a
   privacy one).

Methods (Q1):

- **Recommended: dedicated evaluation credentials.** Claude: a long-lived
  token from `claude setup-token` (observed command), stored by the user in a
  file outside the repository and outside `~/.config/pandamstyle` (default
  `~/.local/share/pandamstyle-agentic/credentials/claude.token`, mode 0600),
  delivered as `CLAUDE_CODE_OAUTH_TOKEN` (string observed; behavior under
  `-p` unverified). Codex: a separate login made with
  `CODEX_HOME=<dedicated dir> codex login --device-auth`, whose credential file
  is copied per attempt. Benefits: revocable independently; no refresh token of
  the user's interactive sessions ever enters a container; a refresh inside
  the container cannot invalidate the user's own login.
- **Fallback: copy of the existing login file** (`~/.claude/.credentials.json`
  mode 0600, `~/.codex/auth.json` mode 0600; names and modes observed, contents
  not read). Risk: these files presumably contain refresh tokens (unverified);
  if a CLI refreshes and the provider rotates refresh tokens, the user's own
  host login can be invalidated. Not recommended.

For a credential that refreshes (Codex), the runner serializes attempts per
credential store and, after the container stops, writes back a changed
credential file to the **dedicated** store only after structural validation
(never to `~/.codex`, never logging contents). Whether Codex refreshes during
`exec` is unverified (smoke run item).

### 4.4 Residual risks and covering layers

| Risk | Why it remains | Covering layers |
| --- | --- | --- |
| The agent reads the credential (same uid as the CLI) and sends it out through an allowlisted provider host, or uses it for unrelated requests | the CLI must hold a usable credential; TLS hides request content from the proxy | dedicated revocable credentials (Q1); bounded run time; per-host egress byte accounting with an anomaly flag; transcript scan flags any command touching the credential path or variable name (policy breach); exact-match scan of the final message, workspace and stream; revocation procedure on any finding |
| The agent writes the credential into the workspace or final message | it can read it | the persisted copies are redacted after evaluation; the run is flagged `credential-leak` and the credential is rotated |
| The agent forges CLI stream events (for example by writing to the CLI's stdout through `/proc/<pid>/fd/1`) to fake an infrastructure error and obtain a re-roll, or to fake usage | same uid, same container | stream-integrity checks (§3.4) turn anomalies into non-retried harness errors; retries are capped and reported per cell (§5.2); the transcript scan flags `/proc/*/fd`, `kill`/`pkill` of the CLI; a crash without a provider error event is `abnormal-exit` and never retried |
| Container escape through a kernel vulnerability | rootful Docker without user-namespace remapping (observed) | non-root user, no capabilities, `no-new-privileges`, seccomp, AppArmor, read-only root, no Docker socket, short-lived containers |
| Disk exhaustion through the workspace bind mount | overlay/bind size limits are not available here (unverified) | the runner samples workspace size and kills the attempt at a cap (`resource-limit`); tmpfs mounts are size-limited |
| Hostile workspace content attacking host-side processing (symlinks to host files, FIFOs, huge files) | the workspace is agent-written | all post-run workspace reads happen in the harness container; host-side archiving uses `lstat`, never follows links, skips non-regular files, and is size-bounded |
| Quota exhaustion affecting the user's other work | shared subscription | concurrency cap per provider (Q8), backoff on rate limits, halt on repeated limits |

### 4.5 Order of an attempt

1. Verify product build binding (§4.6), image id, CLI digests, corpus lock
   (`pms-agentic validate`), clean harness checkout, isolation self-test
   freshness (§9.2), held-out guard (§4.7).
2. Harness container: `materialize --files-only` into a fresh attempt
   directory outside the repository; offline install from the verified
   dependency closure (`--ignore-scripts`); copy the pristine install as the
   trusted `node_modules`; `prepare`; snapshot the scope baseline.
3. Start the agent container with the workspace mount and the credential on
   stdin; stream stdout to the parser; apply triggered events through the
   harness container (`pms-agentic event`) and the same steps to the scope
   baseline.
4. Stop the agent container; destroy its tmpfs; record termination.
5. Harness container (no network, no credentials, Node 22.22.0 from the
   store): `pms-agentic evaluate … --trusted-node-modules <pristine>
   --host-commands`.
6. Redact, bound and persist artifacts; scan for secrets; write the record.

### 4.6 Product build binding

A run is bound to a product build by digest, never by a branch name. The
binding (`pms-agentic-product-build/v0-draft`) records:

- epoch (must be an epoch of `corpus.json` whose `product.commits` contains
  the source commit; otherwise the runner refuses);
- source commit, tree and source archive sha256;
- each `@pandamstyle/*` tarball: name, version, file, sha256 and `integrity`
  (SHA-512, equal to npm `dist.integrity` for Alpha 1);
- the Node runtime archive sha256;
- the agent-docs tree (`docs/agent-*.md`, `docs/reference/`,
  `benchmarks/alpha1-reference.json`, extracted from the source archive of the
  same build) and its tree digest;
- provenance: for Alpha 1, `kind: ce-baseline-manifest` with the manifest's
  sha256 and where it was read from; for later candidates,
  `kind: packed-from-commit` (packing is a later hook, not needed for the
  AG-00.3 reference);
- `digest`: sha256 of the canonical binding.

Alpha 1 (observed): the manifest at
`origin/core-evolution/ce-00.3-baselines` (head `f4a7106`) has sha256
`acdefef3…2884`. It lists source commit `415e055` (tree `26928afe`), archive
sha256 `407f68a6…3764`, five registry tarballs with SHA-512 integrities equal
to the registry's, Node 22.22.0 (`9aa8e9d2…7c37`) and a store at
`~/.local/share/pandamstyle-baselines/alpha1`. The runner:

- reads a manifest **file** given on the command line (from `git show` of that
  branch until PR #99 merges, from `main` after) and checks its sha256 against
  the value pinned in `matrix.json`;
- opens the store read-only and verifies, itself, the sha256 of every
  artifact it consumes (it does not depend on `tools/baselines/archive.mjs`
  being merged; when that tool is available, its `verify --replay` result is
  recorded as additional evidence);
- never writes to the store.

The CE closure cannot serve as the fixture install. Observed: the closure pins
React 19.3.0, while the fixtures pin React 19.2.0, `@rsbuild/plugin-react`
2.0.1, `@types/react`, a webpack 5 stack and `clsx`, which the closure lacks.
So the runner builds a **fixture dependency closure** per fixture × product
build: one networked resolution in a credential-free container
(`--ignore-scripts`), with the `@pandamstyle/*` packages taken from the
verified tarballs, producing a lockfile and an offline package cache, both
digest-recorded and referenced by every later attempt (README: "Fixture
`package.json` files pin versions but ship no lockfiles; the runner resolves
dependencies at install time and must record them"). Attempt installs are
offline from it. The pristine result is the oracles'
`--trusted-node-modules`, as the README's runner contract requires; the CE
closure's `node_modules` (suggested by the manifest's `agReuse` note) would
render with a different React than the workspace.

Observed but outside this issue: the manifest records the store's
`npmCache.tree` as 0 files with the empty-input digest, while the store's
`npm-cache/` directory holds about 445 MB. The runner does not consume that
cache; the point is reported to the core-evolution orchestrator.

### 4.7 Held-out tasks

- The runner's task resolver loads development tasks only. Any id listed in
  `heldout/MANIFEST.json` (16 observed), any task with `split: heldout`, and any
  use of `--heldout-dir` is refused unless the matrix purpose is
  `ag-12.2-final-qualification` **and** `PMS_HELDOUT_PURPOSE` has that value.
  The other purposes of the access policy (`seal-verification`,
  `pre-freeze-revision`) are not run purposes and are always refused.
- The runner never calls `heldout unseal` and never reads the passphrase
  variable. In this issue no held-out path is executed; the refusal is tested
  for every manifest id.
- For the future AG-12.2 run, held-out attempts write to a separate run root
  whose raw artifacts are never published (they contain held-out prompts and
  workspaces); only verdicts and metrics per task id may leave it.

## 5. Failure taxonomy

### 5.1 Classes

Classification is a pure function of: CLI exit status and signal, structured
CLI events (terminal result or failure events, API error events with status),
container state (`OOMKilled`, exit code), harness timers and harness errors.
**Its inputs never include the oracle verdict, the workspace, or free text
from model or tool output** (an agent printing "rate limit exceeded" changes
nothing).

| Class | Codes | Counted in success rate | Retried |
| --- | --- | --- | --- |
| `agent` | `completed` (then graded), `budget-timeout`, `budget-max-turns` | yes (a budget code is a non-success) | never |
| `agent-resource` | `resource-limit` (container OOM, pids, workspace size cap) | yes, as non-success; reported separately | never |
| `agent-abnormal` | `abnormal-exit`: the CLI died without a provider error event (crash, killed from inside) | yes, as non-success; reported separately | never |
| `infrastructure` | `rate-limit`, `capacity` (overloaded), `provider-error` (5xx, disconnect after the CLI's own retries), `auth` (expired, revoked), `container` (daemon or image error before the agent started), `proxy` | no: excluded from the denominator and reported | `rate-limit`, `capacity`, `provider-error`, `container`, `proxy`: yes; `auth`: no, halts the provider |
| `harness` | `adapter-stream`, `config-integrity` (model or tool mismatch, fallback), `drift`, `install`, `prepare`, `evaluate-error` (oracle verdict `error`), `redaction`, `cancelled` | no: the attempt is invalid | never automatically; systematic codes (`drift`, `config-integrity`, `redaction`) halt the matrix |

Precedence when several apply: `harness` > `infrastructure` > `agent-*`. A
provider error that terminated the CLI makes the attempt infrastructure even
if the agent had already written files; those files are still archived for
audit but never graded into the statistics.

### 5.2 Retry policy (no success bias)

- Only `infrastructure` attempts are retried, from scratch (new workspace,
  new container, new session). Retrying never depends on the verdict, so it
  cannot re-roll a failure.
- At most `A = 3` attempts per repetition (Q9). Backoff: reset time when the
  stream reports one, otherwise 60 s × 2^k capped at 30 min.
- A repetition without a valid attempt after `A` attempts is `missing`: shown
  in the cell as missing, never as fail and never dropped. A cell with a
  missing repetition is `incomplete`; AG-00.3 cannot freeze a threshold on an
  incomplete cell without an explicit decision.
- Every attempt (valid or not) is in the record and in the report's attempt
  counts, so a cell whose infrastructure failure rate differs from others is
  visible. Long tasks are more exposed to mid-run rate limits; that exposure
  is reported per cell rather than hidden.

## 6. Raw traces

### 6.1 Storage and retention

- Default run root: `~/.local/share/pandamstyle-agentic-runs/` (override
  `--runs-root`). The runner refuses a run root inside the repository except
  the gitignored `.pms-bench/` (fixture runs only).
- Layout: `<matrixId>/matrix.json`, `product-build.json`, `image.json`,
  `cells/<task>/<model>/rep-<r>/attempt-<a>/{record.json, prompt.md,
  stream.jsonl.gz, stderr.log, transcript.jsonl, observations.json,
  final-message.txt, evaluation.json, baseline.tar.gz, workspace.tar.gz,
  proxy.log, host-samples.jsonl}`, then `report.json` and `report.md`.
- Retention: kept until pruned explicitly (`prune --older-than`); no automatic
  deletion. Default publication rule (Q10): `matrix.json`,
  `product-build.json`, `image.json`, every `record.json` and
  `evaluation.json`, and the report may be committed by AG-00.3 after a leak
  scan; raw streams, stderr, workspace archives and proxy logs stay local.
  Held-out artifacts are never committed.

### 6.2 Bounds and redaction

- Metrics are computed from the complete stream while it is read; the
  persisted copy is bounded (default 64 MiB per stream; beyond it, the first
  and last 8 MiB plus a marker with the total byte and event counts). stderr
  is bounded at 1 MiB. Workspace archives exclude `node_modules` and the
  task's harness-ignored outputs, skip links and special files, and are
  bounded (default 64 MiB; overflow is `harness:archive-limit`, recorded).
- Redaction before any write: the exact secret bytes (§4.3); token patterns
  (Anthropic/OpenAI key and OAuth token prefixes, JWT-shaped strings, `Bearer`
  headers); the host user's home path and user name replaced by `~` and
  `<user>`. Identifying account fields found in the stream (for example in
  Claude's `init` event: unverified) are added to an explicit field redaction
  list after the smoke run inspects one real `init` event.
- A post-write scan of each attempt directory for the secret and the patterns
  is part of the attempt; a hit deletes the artifact and records
  `harness:redaction`.

## 7. Report

`report.json` (`pms-agentic-run-report/v0-draft`) and a Markdown rendering:

- **Per cell (task × model):** every repetition's verdict, termination,
  failure class and attempts; the full list of values of each metric
  (tool calls, steps, tokens by kind, cost with status, durations, repair
  cycles), with min/median/max beside the values, never a mean alone.
  Unknown values are shown as unknown and excluded from statistics, with the
  count of unknowns.
- **Per-task × model failures:** failing required check ids and their oracle
  reasons, grouped by class (scope, integrity, static, rendered, report).
- **Policy and scope breaches:** a dedicated section listing every attempt
  with realized scope violations, vocabulary/integrity failures, static
  bypasses, denied egress, read-only denials, credential-path access, stream
  anomalies or model mismatches, whatever the verdict.
- **Per model across tasks:** `k/n` success per workflow and case type, with
  `n_valid` / `n_planned` and missing counts; outcome split (application,
  diagnosis, report) kept apart; no pooled average that hides a failing task.
- **Infrastructure:** attempts, retries, rate-limit and capacity events per
  provider; excluded attempts listed.
- **Environment:** comparability key per cell, product build digest, image
  id, CLI digests, host load summary.

AG-00.3 consumes `report.json` and the records: its frozen thresholds will be
expressed against these fields and bound to the comparability keys, so a later
candidate is compared only with a reference produced under the same key.

## 8. Comparability and instrumentation isolation (AC4)

- The product under test is never modified: Alpha 1 is installed from its
  verified registry tarballs; no shim, patch, logger or wrapper is added to
  `packages/*`, to the installed packages or to the workspace.
- The evaluated agent receives exactly the corpus prompt
  (`pms-agentic prompt`, which already appends the report contract and the
  docs path) and the product's own agent docs. The runner adds no system
  prompt, hooks, MCP servers, skills or memory; user-level configuration is
  absent by construction (§4.3).
- Telemetry is passive: the CLI's own output stream, cgroup counters, the
  proxy log and harness timers. Nothing is injected into the agent's context or
  tools to measure it.
- The only intentional interventions are the corpus's own workspace events,
  applied as the task specifies.
- The same runner, image, CLI configuration and budgets apply to the
  reference and to candidates; only the product build binding differs, and
  the comparability key (§1.3) enforces it.
- The runner lives in `benchmarks/agentic/runner/`, outside the digest-locked
  `src/` and `schema/` of the corpus (observed in `computeLock`), so adding it
  changes neither `corpus.lock.json` nor any oracle. Its own tree digest is
  part of the record. For the same reason the draft schemas are in
  `runner/schema/`, not `schema/`.

## 9. Test plan

### 9.1 Adapter-fixture matrix (CI, deterministic, no provider, no Docker)

Fake `claude` and `codex` executables (Node scripts) replay recorded or
synthetic JSONL streams and behaviors. Fixture streams are written from the
field names observed in §3.1 and replaced with recorded real streams after the
smoke run.

| Id | Fixture | Proves |
| --- | --- | --- |
| F1 | Claude success with tool calls, per-message usage, result totals, cost | parsing, normalized transcript, tool counts, cost labelled `estimate` (D1, D2, D3) |
| F2 | Codex success with `turn.completed` usage, no cost | tokens observed, cost `unknown` (AC2) |
| F3 | no usage anywhere | every token/cost metric `unknown`, never 0 (AC2) |
| F4 | usage on some messages only | total `unknown`, partial sum only as `lowerBound` (AC2) |
| F5 | duplicated assistant events for one message id | de-duplication |
| F6 | result totals disagree with per-message sum | discrepancy recorded, both sources kept |
| F7 | rate-limit events (Claude API error 429 / rejected rate limit; Codex `usage_limit_reached`) | `infrastructure:rate-limit`, retry scheduled with backoff, attempts recorded |
| F8 | overloaded / `server_overloaded` | `infrastructure:capacity` |
| F9 | 401 / auth expired | `infrastructure:auth`, provider halted, no retry |
| F10 | CLI never exits | SIGINT → SIGTERM → kill escalation, `budget-timeout`, partial stream kept |
| F11 | `error_max_turns`; Codex exceeding the tool-call budget | `budget-max-turns`, which limit fired |
| F12 | malformed and truncated lines, events after the terminal event, duplicate terminal events | `harness:adapter-stream`, not retried |
| F13 | exit by signal without a provider error event | `agent-abnormal:abnormal-exit`, not retried |
| F14 | served model differs; fallback event | `harness:config-integrity`, matrix halt |
| F15 | assistant text and tool output containing "rate limit", "overloaded", forged JSON | classification unchanged (classification ignores free text) |
| F16 | fake secret echoed in stream, stderr, final message and workspace files | no persisted artifact contains it in any encoding; `credential-leak` flagged |
| F17 | stream above the size cap | truncation marker, metrics from the full stream |
| F18 | `after-tool-calls` event reached / not reached | `applied` / `not-triggered` observations; baseline receives the same steps |
| F19 | every held-out manifest id; `--heldout-dir` without purpose; other access-policy purposes | refused before any materialization |
| F20 | CLI version or binary digest differs from `matrix.json` | refused (drift) |
| F21 | operator cancellation mid-matrix, then resume | `harness:cancelled` records; resume skips valid repetitions only |
| F22 | final workspace with symlinks to host paths, FIFOs, oversized files | archiving does not follow, block or exceed bounds |
| F23 | report over synthetic records with fails, unknowns, missing repetitions and breaches | distributions kept, failures and breaches listed, unknowns not summed, missing shown (AC3) |
| F24 | two records differing in one configuration field | `compare` refuses and names the field; equal keys pair (AC1) |
| F25 | schema validation of every produced record, config and report | record completeness (D1) |

### 9.2 Class-level checks (self-review)

- **Unknown-as-zero:** lint over the accounting modules forbidding
  zero-defaults, plus a property test that removes random usage fields from
  F1/F2 streams and asserts that no affected aggregate is `observed`.
- **Classification independence:** the classifier's signature has no verdict
  or workspace input; a test runs it over all fixture terminations with
  randomized free text.
- **Redaction:** the F16 secret is injected in every artifact channel and
  every encoding listed in §4.3.
- **Isolation self-test** (local, needs Docker; not in CI): with a test image
  and no credential, assert that the agent container cannot resolve names,
  cannot reach a non-allowlisted host, cannot reach an allowlisted host
  without the proxy, cannot write the read-only workspace or `.git`, has no
  capabilities, runs as non-root, sees no host path but its mounts, and is
  killed at its pids/memory limits. Provider-backed matrices refuse to start
  unless the self-test passed for the current image id.
- **Mutations:** for each row of the capability table (§4.2), disabling the
  enforcement makes the self-test fail.

### 9.3 Authorized smoke run (only after the orchestrator's explicit go)

- Tasks: `discovery-positive-card-vocabulary` (read-only, 600 s / 30 turns)
  and `composition-positive-order-summary` (application with host build,
  900 s / 60 turns). Models: `claude-haiku-5-5`, `claude-sonnet-5-5`,
  `gpt-6.1-sol`. One repetition each: **6 provider-backed attempts**.
- Task budgets are unchanged, so the records are well-formed but are not the
  baseline. Concurrency 1; at most one infrastructure retry per repetition;
  stop at the first `harness` or `auth` failure; hard stop at 2 h wall clock.
- Prerequisites: the user's cost/quota check, a heads-up to the
  core-evolution orchestrator, the isolation self-test, and the credential
  method decided (Q1).
- It must record, in addition to the normal artifacts, a **telemetry
  availability table** per CLI under subscription auth (tokens by kind, cost
  field and meaning, served model, durations, rate-limit state, `init` fields,
  exit statuses of tool results), the proxy's list of contacted hosts, whether
  Codex refreshed its credential, whether `--setting-sources ""`, hidden
  `--max-turns` and `CLAUDE_CODE_OAUTH_TOKEN` behave as assumed, and the
  redaction scan result. Each unverified item of this note is then either
  confirmed in the note or the design is corrected before AG-00.3.

## 10. Open questions for the orchestrator

1. **Credentials (Q1).** Dedicated evaluation credentials (Claude
   `setup-token`, separate Codex login in a dedicated `CODEX_HOME`),
   recommended, or copies of the user's existing login files (risk to the
   user's own sessions through refresh rotation)? Either way the user performs
   the login.
2. **Installation tasks (Q2).** The 3 `network: package-registry` tasks need a
   registry: a local read-only mirror of the pinned closure (reproducible,
   recommended), proxied live npm (realistic, not reproducible), or excluded
   from the AG-00.3 reference and reported as not run?
3. **Reasoning effort (Q3).** Which explicit value per model (Claude
   `--effort`, Codex `model_reasoning_effort`)? It becomes part of the model
   configuration and the comparability key.
4. **Tool surface (Q4).** Disable web search/fetch and subagents for both CLIs
   (recommended: tasks grant no web access and subagents change the measured
   unit)?
5. **First-pass success (Q5).** Transcript-derived (no oracle feedback to the
   agent; recommended), or a multi-attempt protocol where the harness returns
   oracle failures (leaks oracle information, changes the task protocol)?
6. **Visual fidelity (Q6).** Corpus 1.4.3 has no measurement method;
   AG-00.2 reports it `unmeasured`. Accept, or open a follow-up for a visual
   oracle (a corpus change, outside this issue)?
7. **Timeout semantics (Q7).** Success requires normal termination within
   budget (recommended), or the oracle verdict alone?
8. **Quota and concurrency (Q8).** The reference is 47 × 3 × 3 = 423 attempts
   (fewer if Q2 excludes tasks). With concurrency 1 per provider and 10–20
   minutes per attempt, it takes days. Which concurrency and time windows are
   acceptable for the user's shared subscriptions?
9. **Retry cap (Q9).** `A = 3` attempts per repetition and the halt rules of
   §5.2: acceptable?
10. **Publication and retention (Q10).** Commit records, oracle results and
    reports but keep raw streams and workspaces local (recommended)? Any
    retention limit?
11. **Turn budget (Q11).** Enforce `maxTurns` as a cap on normalized tool calls
    for both CLIs (recommended, since Codex reports no per-response boundary),
    with Claude's hidden `--max-turns` as backstop?

No oracle API change is required by this design: the runner uses `evaluate`
with its existing transcript, observations and `--trusted-node-modules`
inputs, and runs it with a credential-free environment.
