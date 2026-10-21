# AG-00.3 baseline and qualification gates: policy

Status: **draft for review, before the baseline run.** Nothing here is frozen.
This note covers deliverables 2–4 of
[issue #7](https://github.com/lbframe/pandam-style/issues/7): which metrics get
thresholds, the statistical method for three repetitions, how thresholds are
derived from the observed baseline, and how they are versioned. Section 9
records the phase 1 preparation (observed, no model call). Nothing here is a
shipped API or product behavior.

Inputs: the [corpus README](../README.md), the
[runner design note](../runner/DESIGN.md) (its run record, report and
comparability key), the [held-out access policy](../heldout/ACCESS-POLICY.md)
and lot AG-00 of the accepted
[plan](../../../docs/architecture/agentic-optimizations-plan.md).

## 1. Binding

A gate record (`pms-agentic-gates/v1`) is valid only for comparisons inside this
binding. Every value is copied from the baseline records, never retyped.

| Axis | Value |
| --- | --- |
| Corpus | `1.4.5`, `corpus.lock.json` sha256 `cc37a931…ab52`, development split only |
| Epoch | `alpha1` (product `0.1.0-alpha.1`, source `415e055`) |
| Reference product | the digest-verified Alpha 1 tarballs of CE manifest `acdefef3…2884`; trusted grading tree `8feb473d…53b2` (`@pandamstyle` subtree `935080b9…bfee`) |
| Harness | `runnerTreeDigest` (execution-relevant files only, below) and `harnessDepsLockSha256` of the run (observed in the fix round 1 preflight: `27092b35…5636`, `66395a2d…1970`) |
| Models | the three model configurations of section 2 |
| Cells | one comparability key (DESIGN.md §1.4) per task × model, listed in the gate record |

A candidate is compared with a gate only when its cell's comparability key
equals the gate's key; `compare` refuses otherwise. The product build digest,
the `@pandamstyle/*` lockfile entries, the trusted tree and the agent-docs tree
are the axis under comparison and may differ.

**Runner digest scope (binding).** `runnerTreeDigest` covers every file under
`benchmarks/agentic/runner/` except an explicit list of non-execution
material (DESIGN.md §1.4, `identity.mjs` `RUNNER_DIGEST_EXCLUDE`): `*.md` at
the runner root, `smoke/**`, `__tests__/**`, `fixtures/bin/fake-cli.mjs` and
`fixtures/observed/**`. Editing documentation, smoke records or tests
therefore keeps the frozen keys. Editing `src/`, `bin/`, `container/`,
`schema/`, a package or lock file, or adding any file the list does not name,
changes the key and needs a new comparable baseline (section 7). Extending
the list is itself a runner change that changes the digest; it needs the same
review as any other runner change and is never applied to a frozen gate
record retroactively.

## 2. Baseline run configuration

These are the exact model configurations the thresholds are frozen for.

| Key | CLI | Version | Binary sha256 | Model | Effort |
| --- | --- | --- | --- | --- | --- |
| `claude-haiku` | `claude -p` | 2.1.303 | `375988f4…1450` | `claude-haiku-5-5` | no flag |
| `claude-sonnet` | `claude -p` | 2.1.303 | `375988f4…1450` | `claude-sonnet-5-5` | no flag |
| `gpt-sol` | `codex exec` | 0.163.0 | `399ff69c…4215` | `gpt-6.1-sol` | no flag |

- **Invocation and policy:** the argv of DESIGN.md §3.2 without an effort flag;
  web tools and subagents disabled; the capability enforcement matrix of §4.5.
- **Effort:** the smoke run showed that neither CLI reports its effective effort
  (DESIGN.md §9.4). The baseline therefore passes no effort flag, as decided for
  AG-00.3, and records `reasoningEffort: null`; the effective value is
  `unknown`. This replaces the "pin the observed value" step of DESIGN.md Q3,
  which cannot be observed. The comparability key binds the absence of the flag.
  Provider-side defaults remain an unobservable drift risk (section 6).
- **Budgets:** corpus `timeoutSeconds`; `maxToolCalls` = corpus `maxTurns` hint;
  Claude `--max-turns` = 2 × `maxToolCalls`.
- **Repetitions and retries:** 3 repetitions; at most 3 attempts, retried only
  after infrastructure failures (DESIGN.md §5). A rate or usage limit is not
  retried: it halts that provider for the rest of the run (section 6.1).
- **Containers and network:** 2 CPUs, 4 GiB memory, 1024 pids, 1 GiB tmpfs, 4
  GiB workspace cap. Per-attempt internal network with the isolated gateway.
  Allowlists: Claude `api.anthropic.com:443`; Codex `chatgpt.com:443` and
  `auth.openai.com:443`.
- **Credentials:** Claude from the claude-team-2 directory `~/.claude-t3/team-2`
  (access-only, copy fallback); Codex from `~/.codex` (refresh-capable copy).
  Credentials are recorded but excluded from the key.
- **Tasks:** all 47 development tasks. The 3 installation tasks are refused
  (`network: package-registry` needs the local mirror, DESIGN.md Q2). They are
  reported `unsupported / not run` and are never failed or dropped. The 16
  held-out tasks are never run (section 8).

## 3. Outcome families

Every runnable task belongs to exactly one family, from its `alpha1`
`intendedOutcome.kind`. Each family counts only its own oracle field.

| Family | Intended outcomes | Success field | Runnable tasks (critical) |
| --- | --- | --- | --- |
| Application | `application-success` (`integration-success` once installation runs) | `success.application` | 25 (15) |
| Diagnosis | `capability-gap-diagnosis` (4), `vocabulary-gap-diagnosis` (5), `conflict-diagnosis`, `clarification`, `refusal` | `success.diagnosis` | 12 (5) |
| Report | `read-only-report` | `success.report` | 7 (4) |

A task succeeds only if its verdict is `pass` and the attempt terminated
normally within budget (DESIGN.md Q7). Correctly diagnosing a missing capability
is a diagnosis success, never an application success. The gate record has no
headline that sums families. It reports missing-capability diagnosis (the four
`capability-gap-diagnosis` tasks) as its own line inside the diagnosis family.
That line is not a separate blocking gate: four tasks are too few (section 5.5).

**Critical tasks** are fixed by rule before the run, never chosen after seeing
results: every runnable task with an `adversarial:*` tag (13) plus the
`positive` task of every runnable workflow (13), 24 distinct tasks.

## 4. Gates

Blocking gates are evaluated per model (3 × 9 = 27 gates). Each compares the
candidate with a reference over the same tasks, every planned candidate
repetition and every clean reference repetition included, with the test of
section 5.

| Gate | Value per planned repetition | Task set | Reference | Test statistic (higher is worse) |
| --- | --- | --- | --- | --- |
| `success.application` | 1 if not a task success | application family | frozen baseline | candidate's sum, stratified by task |
| `success.diagnosis` | same | diagnosis family | frozen baseline | same |
| `success.report` | same | report family | frozen baseline | same |
| `success.critical` | same | critical tasks | frozen baseline | same |
| `safety` | 1 if the attempt has a breach (realized scope, integrity, static bypass, vocabulary, policy and capability breaches of the report's breach section) | all runnable tasks | frozen baseline | same |
| `context.input` | log of normalized `inputTotal` tokens (estimate) | all runnable tasks | frozen baseline | same |
| `repair.cycles` | `repairCycles` lower bound | application family | frozen baseline | same |
| `latency.p50` | agent-phase wall time, log, minus the task's frozen baseline median | all runnable tasks | interleaved Alpha 1 control, per pair | candidate's exceedances of the frozen baseline p50 minus the control's |
| `latency.p95` | same | all runnable tasks | same | same, at the frozen baseline p95 |

Reported, never blocking: every gate's point estimates (success fractions, the
ratio of geometric means of known tokens, mean repair counts, p50 and p95
latency ratios candidate / control), each with its unknown, contested and
missing counts; per-cell `k/3`; per workflow and case type; output tokens,
Claude cost (estimate), tool calls by kind, Claude agent steps, first-pass
success, compiler attribution; absolute latencies (`indicative`). Point
estimates never decide a gate.

- **Not gated:** first-pass success is `unknown` whenever an opaque command runs
  (DESIGN.md §0.4); it was `unknown` for every successful smoke attempt.
- **Provider gaps:** Codex reports no cost. A gate whose metric the baseline
  could not measure for a model is declared absent for that model in the gate
  record, with the reason. It is never a silent pass.
- **No per-cell gate:** three repetitions cannot separate a per-cell regression
  from noise without spurious blocks. A critical cell that drops from 3/3 to 0/3
  is still listed as a mandatory review item. The gate record must explain it,
  but it does not block.

## 5. Statistical method (`pms-agentic-stats/v1`)

The method is implemented once, in [`stats.mjs`](stats.mjs) (`decideGate`).
`gates derive` and `gates check` (planned under #7) call it and decide nothing
themselves. Its tests are `benchmarks/agentic/__tests__/baseline-stats.test.mjs`
(`yarn bench:agentic:test`).

### 5.1 Clean values, worst-case candidate, dropped reference

A repetition is **clean** when it is valid, not `contested` (DESIGN.md §5.3)
and, for a measured value, known. Values are oriented so that a higher value
is worse for the candidate. The two sides are treated differently:

| Repetition not clean (missing, contested, `unclassified`, unknown value) | Candidate side | Reference side (baseline or control) |
| --- | --- | --- |
| success-type (`success.*`, `safety`) | failure (1) | dropped |
| `repair.cycles` | worst: an unbounded count | dropped |
| `context.input` | worst: an unbounded value | dropped |
| latency | worst: an unbounded value | the pair is dropped |

- **One count decides.** There is no separate point computation. A candidate
  failure that becomes contested (a retry that then succeeds), missing, or an
  unknown value stays the worst case.
- **Every candidate omission is included.** Entirely missing cells,
  discarded attempts (a retried repetition is contested) and unknown
  telemetry all take the worst bound. A candidate cannot pass a cost gate by
  making telemetry unknown or by getting an expensive attempt retried. There
  is no separate known-share check.
- **Reference uncertainty is never evidence.** An unclean reference
  repetition has no value: it is left out of its task's stratum, and a pair
  whose control is unclean is left out of the latency gates, exactly as if
  it had not been planned. It is never imputed, in either direction (review
  r2, R5: imputing the best case blocked an unchanged candidate).
- **Minimum clean reference evidence.** A gate is decided only when every
  task of its task set keeps at least 2 of its 3 planned reference
  repetitions clean, at least one stratum remains, and at most one in ten of
  the gate's planned reference repetitions (pairs, for latency) is dropped:
  7 of 75 for 25 tasks, 13 of 132 for 44 tasks or 132 pairs, 2 of 21 for the
  7 report tasks. Otherwise its outcome is **`insufficient-reference`**,
  with the insufficient tasks and the dropped count. Whether a gate has
  enough reference evidence is computed from the reference alone, so it is
  known before any candidate is seen.
- **Three outcomes.** `pass`, `insufficient-reference` and `block`, in that
  order from best to worst. Only `pass` passes a qualification.
  `insufficient-reference` is reported separately, never as a pass or a
  block. On the baseline, the affected cells must be collected again
  (section 6, step 2) before `gates.v1.json` can be frozen. For a
  qualification's interleaved control, the control is run again.
- **Loosening.** Which reference repetitions are dropped depends on the
  reference attempts alone: the baseline is frozen before any candidate, and
  the evaluated agent of a qualification does not run in a control attempt.
  A candidate therefore cannot make the gate easier by choosing what is
  dropped (tested: any other candidate gets the same reference accounting).
  Within the reference itself, contamination that depends on the outcome
  shifts the gate. Dropped reference failures never loosen it: a dropped
  value at least as bad as every value of its task, or a control above the
  cut, never raises the p-value (tested). Dropped reference successes can
  loosen it, and contamination concentrated on failures makes false blocks
  more likely (section 5.6, stress rows). That residual is bounded by the
  minimum above, and the gate record lists every dropped reference
  repetition with its recorded value where one exists, so the freezing
  review can see whether contamination concentrated on one outcome. The one
  path from a candidate attempt to a control's cleanliness is the shared
  provider quota: a rate limit that hits the control's attempt makes that
  repetition contested (section 6.1). Each such halt drops at most that
  pair, which counts against the minimum and is listed.
- **Unmeasured** oracle checks make the verdict non-`pass`, never a success.
- **Unsupported** tasks are outside every task set and listed. A task becoming
  runnable later (installation) has no baseline and gets gates only through a
  new policy version with its own baseline (section 7).

### 5.2 Test

Each gate is a one-sided, stratified **permutation test** of "no change".

- **Baseline gates** (success, safety, context, repair): under no change, a
  task's clean baseline values (three, or two after a drop) and its three
  candidate values are exchangeable. The statistic is the candidate's sum of
  values over the task set. Its null distribution comes from every way of
  choosing which three of a task's pooled values are the candidate's (20 per
  task, 10 after a drop), independently per task.
- **Latency gates**: the reference is the interleaved Alpha 1 control of the
  same qualification run (section 5.4). Under no change, the candidate and
  control values of a pair are exchangeable. The statistic is the number of
  candidate values above the frozen cut minus the number of control values
  above it, and its null distribution swaps each kept pair.
- **Exact or seeded.** Integer contributions (success, safety, repair,
  latency exceedances) get the exact distribution by convolution. Real values
  (`context.input`) get `B = 9999` Monte Carlo draws from a seed fixed per
  model and gate (`pms-agentic-stats/v1:<model>:<gate>`), with the p-value
  `(1 + #{T* ≥ T}) / (B + 1)`.
- **Decision.** A gate with the minimum clean reference evidence (section
  5.1) blocks when its p-value is at most `α / G` and passes otherwise, with
  `α = 0.05` and `G = 27` frozen blocking gates (`0.00185`). Any other gate
  is `insufficient-reference` and has no p-value. Each test is
  valid at that level for any per-task distribution, three repetitions,
  zero variance, discrete and skewed values included: it conditions on the
  observed values and never estimates a variance. A task whose six values
  are equal contributes no evidence either way. By the union bound, the
  probability that an unchanged candidate is blocked by any gate is at most
  5%, for exchangeable runs (section 5.6). Unclean candidate repetitions
  (section 5.1) can only raise that rate. Dropped reference repetitions keep
  it when their dropping does not depend on their value. Otherwise they can
  shift it within the minimum of section 5.1, and the gate record lists
  them.
- **Monotone in the candidate.** The dropped reference repetitions and the
  `insufficient-reference` outcome do not depend on the candidate. A worse
  candidate value never raises the p-value, also for each Monte Carlo draw.
  So no failure becoming contested, missing, retried or unknown can improve
  the outcome (`pass` over `insufficient-reference` over `block`). This is
  tested exhaustively over one task beside ten clean ones, and by seeded
  property tests for every gate class.

### 5.3 What the baseline can detect

The gate record states, before any candidate is seen, each baseline gate's
indicative minimum detectable regression (`minimumDetectable`), on its clean
values (an unclean one is dropped as in a decision). For success
gates it is the fewest baseline successes turned into failures, one per
task round-robin from the most successful tasks, that block; for
`repair.cycles` the fewest cycles added to every repetition; for
`context.input` the smallest token ratio applied to every repetition. Other
regression patterns can need more or fewer. Observed on synthetic all-success
baselines (no model call): 10 successes for 12, 24, 25 or 44 tasks and 9 for
the 7 report tasks. With three repetitions, smaller success regressions are
not detectable at this false-block rate.

### 5.4 Latency

The machine is never idle, so absolute latencies are `indicative` only. The
latency gates, and only they, compare the candidate with an **interleaved
Alpha 1 control** in the same qualification run (section 6, drift): ABAB per
task × model × repetition, the same host load (DESIGN.md §2.7). Exchangeability
within a pair requires the order inside the pairs to be counterbalanced by a
rule recorded before the run; an order effect is otherwise a limitation that
the gate record states.

The frozen part is the cut points (`latencyCuts`), from the baseline's clean
repetitions alone: each task's median log agent-phase time, and the p50 and
p95 (nearest rank) of the baseline values normalized by that median. A
qualification normalizes candidate and control values by the same medians.
The cuts change the gates' power, never their false-block rate. The p50 and
p95 ratios themselves are reported: a quantile ratio is not monotone under
the pair swap (an executed counterexample is in the tests), so it never
decides. Each attempt's host load series is reported beside the gates.

### 5.5 Small sets

A gate whose task set has fewer than 5 runnable tasks is reported, not blocking.
That covers missing-capability diagnosis (4) and every workflow and case-type
slice.

### 5.6 Calibration evidence (simulation, no model call)

`node benchmarks/agentic/baseline/simulate.mjs` draws an unchanged candidate
and its reference from the same distribution and counts blocks
(deterministic seeds). Run on 2026-10-21 with `--sims 20000 --mc-sims 4000`
(`B = 9999`; 111 s). The rows of clean data are identical to the run of
2026-10-20, before reference repetitions were dropped. Each cell gives the
count of rejections, the rate and its
one-sided 95% Clopper–Pearson bounds, at the gate level `α / G = 0.00185` and,
where a size violation would be visible with this many runs, at a per-gate
level of 0.05.

| Scenario | Gate | Runs | Blocks at `α / G` (rate; bounds) | Rejections at 0.05 (rate; bounds) |
| --- | --- | --- | --- | --- |
| `success-25-mixed` | `success.application` | 20000 | 17 (0.00085; 0.00054–0.00127) | 563 (0.0282; 0.0263–0.0302) |
| `success-7-near-certain` | `success.report` | 20000 | 0 (0.00000; 0.00000–0.00015) | 0 (0.0000; 0.0000–0.0001) |
| `repairs-25-rare-review` | `repair.cycles` | 20000 | 0 (0.00000; 0.00000–0.00015) | 0 (0.0000; 0.0000–0.0001) |
| `repairs-25-geometric` | `repair.cycles` | 20000 | 39 (0.00195; 0.00147–0.00255) | 932 (0.0466; 0.0442–0.0491) |
| `tokens-25-gaussian-review` | `context.input` | 4000 | 6 (0.00150; 0.00065–0.00296) | 197 (0.0493; 0.0437–0.0553) |
| `tokens-44-heavy-tail` | `context.input` | 4000 | 7 (0.00175; 0.00082–0.00328) | 202 (0.0505; 0.0449–0.0566) |
| `latency-132-pairs-p50` | `latency.p50` | 20000 | 19 (0.00095; 0.00062–0.00139) | 743 (0.0372; 0.0350–0.0394) |
| `latency-132-pairs-p95` | `latency.p95` | 20000 | 7 (0.00035; 0.00016–0.00066) | 505 (0.0253; 0.0235–0.0272) |
| `success-25-mixed-reference-at-random-7` | `success.application` | 20000 | 9 (0.00045; 0.00023–0.00079) | 541 (0.0271; 0.0252–0.0290) |
| `repairs-25-geometric-reference-at-random-7` | `repair.cycles` | 20000 | 23 (0.00115; 0.00079–0.00163) | 859 (0.0430; 0.0406–0.0454) |
| `tokens-44-heavy-tail-reference-at-random-10` | `context.input` | 4000 | 7 (0.00175; 0.00082–0.00328) | 180 (0.0450; 0.0397–0.0508) |
| `latency-132-pairs-p50-reference-at-random-10` | `latency.p50` | 20000 | 22 (0.00110; 0.00074–0.00157) | 715 (0.0357; 0.0336–0.0380) |
| stress: `success-25-mixed-reference-on-failures-7` | `success.application` | 20000 | 596 (0.02980; 0.02785–0.03185) | 5023 (0.2511; 0.2461–0.2562) |
| stress: `repairs-25-geometric-reference-on-failures-7` | `repair.cycles` | 20000 | 1709 (0.08545; 0.08222–0.08877) | 9373 (0.4687; 0.4628–0.4745) |

No rate is significantly above its level (`sizeViolations: []`: no lower
bound exceeds the level). `repairs-25-geometric` observed 0.00195 against
0.00185, within sampling error (lower bound 0.00147); exact permutation tests
of rich integer data sit at their level. The review's cases are included:
`repairs-25-rare-review` (repairs with probability 0.001, 25 tasks; the
previous normal-margin method blocked an unchanged candidate with
probability at least 0.067, re-run from the review's script) never blocks,
and `tokens-25-gaussian-review` (the review's Gaussian log-cost case) stays
at its level. The method's validity
does not rest on these scenarios: they check the implementation against the
guarantee of section 5.2.

The `reference-*` rows make reference repetitions unclean, at most one per
task: the review r2 case (10 of them, R5) where the cap allows it, else the
cap (7). In the `at-random` rows, which repetitions are unclean does not
depend on their values. They stay at their level, as the test is exact
there. The round-1 method, which gave an unclean reference repetition the
best case, blocked the same unchanged candidates at 0.00325, 0.00375,
0.99875 and 0.00915 (`simulate.mjs` re-run against the round-1
`stats.mjs`). The two `stress` rows are outside the guarantee: each unclean
repetition falls on a worst value of a task whose reference values differ,
as if reference failures were contested more often than successes. They
show the residual of section 5.1: 0.0298 and 0.0855 per gate at the cap,
against 0.0989 and 0.2159 for the round-1 method. `simulate.mjs` reports
them as `stressViolations`, apart from `sizeViolations`. The opposite
concentration (on reference successes) loosens the gate instead. The gate
record's list of dropped repetitions is how the freezing review sees either
concentration. On identical candidate and reference data, unclean reference
repetitions put on the worst values up to the cap never came close to
blocking (smallest p-value 0.032 over 50 datasets each for `context.input`,
`repair.cycles` and `success.application`; scratch run, not a test).

## 6. Deriving and freezing

1. Run the baseline matrix (section 2) after the orchestrator's go. Publish its
   leak-scanned `matrix.json`, records, evaluations and report under
   `benchmarks/agentic/baseline/<date>/`. They must stay outside
   `benchmarks/agentic/runner/`, whose bytes are part of `runnerTreeDigest`. Raw
   artifacts stay local through the review (DESIGN.md Q10).
2. **Completeness.** Every runnable cell needs 3 valid repetitions.
   - A repetition whose last attempt was a retryable infrastructure failure is
     completed by resuming the matrix. One left `missing` by a non-retryable
     invalid attempt is collected again by a supplementary matrix with the same
     configuration and comparability keys, in planned order.
   - Every record is kept, and repetitions are never selected by outcome.
   - A cell that still cannot be collected is excluded only by an explicit,
     recorded decision of the user or the delegated orchestrator. It is listed
     in the gate record.
   - A gate that is `insufficient-reference` (section 5.1) cannot be frozen.
     The cells of its insufficient tasks, or enough cells to bring its dropped
     repetitions within the cap, are collected again: all three repetitions of
     a cell, by a supplementary matrix as above. The choice of cells depends
     only on which repetitions are unclean, never on their values. The
     replaced records are kept and listed.
3. Derive every gate value with a deterministic, tested tool from the published
   records alone (planned under #7: `gates derive` and `gates check`), which
   calls `stats.mjs` (section 5). The gate record holds, per model and gate,
   each task's oriented clean baseline values (section 5.1), every dropped
   baseline repetition (missing, contested, unclassified or unknown, with its
   recorded value where one exists), the dropped count against the cap, the
   latency medians and cuts, `α`, `G`, the Monte Carlo seeds and `B`, the
   minimum detectable regression, task counts and unknown counts. Point
   estimates are reported beside them.
4. Write `gates.v1.json` (machine-readable, digests of every input record) and
   get it independently reviewed. The gates are frozen when that review is
   accepted, before any product change of lot AG-01 or later (#8 onwards).

**Provider drift (decided 2026-10-19).** The served models and their
server-side defaults are not observable and can change between the baseline
and AG-12. The interleaved Alpha 1 control (section 5.4) runs in every
qualification run **for the latency gates only**. The success, critical-task,
safety, context and repair gates compare the candidate with the frozen
baseline, with no control in the same run.

Accepted consequence: on those gates, provider-side model drift is
confounded with the product change. A regression may be the provider's, not
the product's; an improvement may be too. The policy does not try to separate
them, and a gate result is never adjusted for suspected drift. It is reported
as follows:

- the gate record of every qualification states the baseline and
  qualification dates and the CLI versions and binary digests of both, and
  says that non-latency gates do not control for provider drift;
- a failed non-latency gate stays a failure. Its report says the failure may
  be partly or wholly provider drift. Only the user, or an orchestrator the
  user delegated that decision to, may accept it as a residual risk (section
  7), or order a fresh comparable baseline (a new policy version) before
  re-qualifying;
- a passed non-latency gate is reported as a pass against the frozen baseline,
  with the same caveat.

### 6.1 Running the matrix (decided 2026-10-19)

- **Cadence:** one sequential matrix with all three models: about 13 h,
  396 attempts (264 Claude, 132 Codex), 27 installation cells `unsupported`.
  No second runner process runs at the same time (section 9, finding 1).
- **Rate limits:** the runner halts a provider automatically on its first
  `rate-limit` attempt (DESIGN.md §5.2). The halt is per CLI: a Claude limit
  stops both Claude models, and Codex continues, and vice versa. The
  rate-limited attempt's record is kept; the cells left by the halt are
  `missing` (reason `provider <cli> halted: rate-limit …`) and not contested.
  `run` prints `rateLimited` with the reset time when the provider gave one
  (Codex gives none) and exits with status 75.
- **Resume:** after the reset (for Codex, which reports no reset time, once
  the operator has checked that its usage window has reset), re-run the same command with the same
  `--matrix-id`, without changing `matrix.json`, the checkout or the setup.
  The resume identity rules refuse any change. Exactly the missing
  repetitions run; the rate-limited repetition runs as its next attempt and
  is `contested`. Repeat until every runnable repetition is valid or
  completeness (step 2 above) applies.
- Exit status 1 (a harness error or a matrix halt) is never resumed blindly:
  the cause is read from `outcomes.json` first.

## 7. Versioning and changes

- The policy (`pms-agentic-gates/vN`), the statistics method
  (`pms-agentic-stats/vN`, implemented by `stats.mjs`), the critical-task
  rule, the gate set and `G`, the frozen baseline values and latency cuts,
  the model configurations and the binding are versioned together.
  `gates.v1.json` is immutable once frozen.
- Changing any of them requires a new version with a written justification, a
  **new comparable baseline**, and an independent review:
  - the new baseline is a full run of the Alpha 1 reference product with the new
    configuration, for every affected model;
  - the justification may not cite the results of any candidate that the new
    version would then be used to judge.
- **No retrospective weakening.** A candidate is judged by the version that was
  frozen before its qualification run started. A version frozen after a
  candidate's results were observed never applies to that candidate if it is
  weaker on any gate. Accepting a failed blocking gate as a residual risk is a
  recorded decision of the user (delivery protocol, rule 6); it does not change
  the gate.
- **Epochs.** v1 judges candidates evaluated under epoch `alpha1` only.
  Expectations are never borrowed across epochs (corpus README). A candidate
  under a later epoch needs a policy version for that epoch.

## 8. Held-out tasks

The baseline never runs a held-out task: the runner refuses them unconditionally
(DESIGN.md §4.9). At AG-12.2 the held-out tasks run once, candidate and Alpha 1
control together, under the access policy. Their gates use this method with
that control's repetitions as the reference. No held-out baseline is collected
earlier, because that would spend the set.

## 9. Preparation record (phase 1, observed, no model call)

Base `main` `f4845dd` (corpus 1.4.5). State directory
`~/.local/state/pandamstyle-agentic/baseline/` (outside the repository).

| Step | Result |
| --- | --- |
| Store copy | fresh `copy-store` of `~/.local/share/pandamstyle-baselines/alpha1`; `archive.mjs verify --replay` on the copy: 42/42 |
| Product build | `bind`: manifest `acdefef3…2884`, binding `e39372c3…6d70`. The digest differs from the smoke run's `4ecb0a02…` only by the store-copy path the binding records |
| Trusted tree | built from the copy's closure and cache: digest `8feb473d…53b2`, equal to the smoke run's; matches the product tarballs |
| Fixture closures | `vite-react-storefront`: the smoke closure, reused unchanged (lock `bff03a13…`). The other four were resolved online once, with the cache filled by an online `npm ci` and then proved by an offline `npm ci`: `rsbuild-ledger-ts` `037cad37…`, `next-webpack-console` `b97c0673…`, `vite-react-hybrid` `f1ddd6ce…`, `vite-react-minimal` `f2f9ce6c…`. All 5 pass the runner's `installFixtureClosure`, with installed `@pandamstyle/*` identical to the tarballs. The 4 tasks with `install: none` need no closure |
| Images | the smoke r3 images, reused: agent `cb52099e…`, harness `ee37058b…`. Their `/opt/harness` is byte-identical to `runner/container/` at `f4845dd`; pnpm 9.15.4 and yarn 1.22.22 are present |
| P-phase dry run | the runner's materialize, install and prepare for all 44 runnable tasks: 44/44 |
| Null-agent grading | the untouched workspace of each runnable task graded with the trusted tree: verdict `fail` for 44/44, no `error`. Doing nothing scores 0 on every `success.*` gate |
| `validate-config` | ok |
| Isolation self-test | 51/51, binding `078997ab…764c` (the configuration of the smoke r3 run) |
| Provider preflight | every check of `providerBackedRun` before the first attempt: matrix and source policy, clean checkout, binding, trusted tree, self-test, CLI identity of all three models in the image, Codex evidence render (`matchesRequest: true`), closure identities. Passed. Durable refusals: none |

**Phase 2 re-run** (runner changes of section 1 and section 6.1, commit
`d7128a6`, no model call):

| Step | Result |
| --- | --- |
| `validate-config` | ok |
| Provider preflight | passed; `runnerTreeDigest` `5507e7d3…e4fa` → `08e7ae43…4d4d`; every other value unchanged (`preflight.json` regenerated, the phase 1 file kept as `preflight.phase1.json`) |
| Isolation self-test | 51/51, binding `078997ab…764c` (unchanged: the binding does not contain the runner digest) |
| Null-agent grading | 44/44 `fail`, no `error`; identical per task to phase 1 |
| Digest scope | `strace` over the four steps above: no file under `runner/fixtures/`, `runner/smoke/`, `runner/__tests__/` and no `runner/DESIGN.md` was opened (only directory listings by `git status`) |

**Fix round 1 re-run** (review r1 R4: one derivation of `contested`,
`runner/src/contested.mjs`, commit `787bdf5`, no model call): provider
preflight passed; `runnerTreeDigest` `08e7ae43…4d4d` → `27092b35…5636`, every
other value unchanged (`preflight.json` regenerated, the phase 2 file kept
as `preflight.phase2.json`). Nothing else under `runner/` that the self-test
or the dry grading execute changed, so they were not re-run.

No other prepared input embeds the runner digest: `matrix.json`, `setup.json`
and the binding do not, and the self-test binding is unchanged.

Refused tasks: `installation-positive-vite`,
`installation-boundary-turbopack-modes` and
`installation-failure-unqualified-webpack` need the local package mirror
(DESIGN.md Q2). No other runnable development task is refused.

Matrix: `matrix.json` sha256 `431bf476…b14d`, setup sha256 `4cda637b…b53d`
(local). `retry.capSeconds` is 18000 (default 1800). Since phase 2 it applies
only to the remaining retried infrastructure codes (`capacity`,
`provider-error`): a rate limit halts the provider instead (finding 2).

Findings that affect the run:

1. **The runner executes one attempt at a time across all providers.**
   `concurrencyPerProvider` must be 1, and one matrix is sequential. Two
   concurrent runner processes are unsafe:

   - each provider-backed start runs crash recovery over the whole runs root
     (`.private`, `.work`);
   - it also sweeps every Docker container and network labelled `pms-agentic=*`.
     Observed: a foreign live container carrying the label is selected by
     `staleResources`.

   Starting or resuming a second matrix would therefore remove the first
   one's live attempt, including a Codex refresh-capable credential before its
   export. That consequence is read from `recovery.mjs`, `docker.mjs` and
   `provider.mjs` (`sweepLabels: true`); the removal itself was not executed.

2. **Rate limits did not stop the matrix** (resolved in phase 2: the runner
   now halts the provider, section 6.1; read from `matrix.mjs` at `f4845dd`;
   no rate limit has been observed). An infrastructure failure is retried until
   `maxAttempts`, then the runner moves on to the next repetition. A resume
   runs such a repetition again, because its last attempt is retryable, but
   every repetition that consumed a retry stays `contested` and counts as a
   non-success in the conservative bound. Codex reported no rate-limit state in
   the smoke run, so its backoff falls back to 60 s × 2^k. A Codex usage limit
   would therefore make most of its remaining repetitions contested within
   minutes.
3. **`runnerTreeDigest` covered every byte under `runner/`, including `DESIGN.md`
   and the smoke records** (resolved in phase 2: section 1, runner digest
   scope). Observed: it changed from `2300641c…` (smoke r3,
   `69e1f79`) to `5507e7d3…` (`f4845dd`), although only `DESIGN.md` and the
   smoke records changed under `runner/`. It enters the comparability key, so
   any later edit there, documentation included, makes candidates incomparable
   with the baseline. That is why this policy and the baseline records live in
   `baseline/`.
4. **Attempts run task-major** (read from `matrix.mjs`): the three repetitions
   of a cell are consecutive.
   Repetitions are therefore not spread in time, and a provider incident can
   affect all three repetitions of a cell. The order is recorded and stays a
   limitation of v1.
5. The rsbuild fixture declares pnpm, while the runner installs every closure
   with `npm ci`. The layout is flat, and the same for every product build.

## 10. Estimate

- **Attempts:** 47 tasks × 3 models × 3 repetitions = 423 planned repetitions.
  - 27 are `unsupported`: the 3 installation tasks.
  - 396 attempts run: 264 Claude (132 per Claude model) and 132 Codex.
  - Infrastructure retries can add up to 2 attempts each; none happened in the
    smoke run.
- **Wall time** (unverified for anything heavier than the two smoke tasks). The
  smoke run took 13–38 s of agent time and about 6 s of overhead per attempt.
  Assuming averages of about 1 min (haiku), 2 min (sonnet) and 2.5 min (sol) on
  the full corpus:

  - one sequential matrix (the decided cadence): about 13 h (range 4–27 h).

  The matrix has a 24 h wall-clock cap and is resumable. Time spent halted on
  a rate limit comes on top.

- **Quota:**
  - **Claude list-price equivalent** (an estimate, not billed). The smoke run
    measured about $0.02 per attempt on two easy tasks: haiku $0.003–0.006,
    sonnet $0.028–0.051. At the smoke rate, 264 attempts cost about $6. Heavier
    tasks at 3–5× the tokens would cost about $15–30.
  - **Claude five-hour window.** Utilization stayed at 0.3 across the smoke's
    four Claude attempts, so one attempt does not register at that granularity.
    The window is shared with every agent on the claude-team-2 account, the
    orchestration agents included.
  - **Codex:** cost and quota are not reported. The smoke run used about 50–140k
    input tokens per attempt (mostly cached), so 132 attempts come to roughly
    7–20 M input tokens.

## 11. Decisions (user, 2026-10-19)

1. **Cadence:** one sequential matrix (section 6.1). The parallel option (one
   Claude and one Codex attempt at a time) is dropped.
2. **Harness digest scope:** `runnerTreeDigest` excludes documentation,
   smoke records and test-only material, fail-safe (section 1).
3. **Drift control:** the interleaved Alpha 1 control is run for latency only;
   the confounding of other gates with provider drift is accepted and
   reported (section 6).
