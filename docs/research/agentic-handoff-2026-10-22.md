# Agentic optimizations (epic #4) — handoff, 2026-10-22

The CI and perf host (**sk**) and the agent host (**kh**) were shut down on the owner's request until further notice.
Every unmerged piece of epic #4 work is pushed to GitHub; nothing lives only on those machines any more. Work resumes
from **T3 Code on the owner's Mac**. This note is self-contained: the orchestrator's local briefs, memory and agent
transcripts stayed on kh and are not needed.

This branch is a **snapshot, not a release**. Merge to main only through the individual PRs below, under the rules of
`docs/agent-delivery-protocol.md`.

## 1. Where everything is

| Ref | Head | What it is |
|---|---|---|
| `main` | 8e0145e (at shutdown) | #5–#10 done (see §2) |
| `agentic/handoff-2026-10-22` | this branch | main 8e0145e + #155 + #153 merged together + this note. Snapshot only (see §9) |
| `agentic/ag-02.1-bridge` | fab00db | PR #155 (draft, base main) — #11 code, PR 1 of 2 |
| `agentic/ag-03.1-metadata` | a813ebd | PR #153 (draft, base main) — #12 code, review converged, perf gate failed |
| `agentic/ag-03.1-metadata-perf-wip` | aa4d5e1 | Untested perf WIP for #153, parent 0f3c550 = a813ebd merged with main 8e0145e |
| `core-evolution/handoff-2026-10-22` | — | Parallel epic's handoff: `docs/research/ce-handoff-2026-10-22.md` |
| `core-evolution/ce-02.2b-perf-wip-handoff` | 48e728f | Parallel epic's perf WIP on the **same timing cell** as #153 |

## 2. Done (on main)

Closed: #5, #6, #7 (AG-00 baseline frozen), #8 (AG-01.1 operation registry, #131 + #135), #9 (AG-01.2 audit operations,
#140 + #144), #10 (AG-13.1 surface inventory, #139). Also merged: #137 (AG-03.1 design note), #146 (AG-02.1 design
note), #145 (CI: docker-test images unique per run + daemon-wide lock). **6 of 33 tasks closed.**

## 3. Resuming from the Mac: what works and what does not

| Need | On the Mac | Notes |
|---|---|---|
| Read/edit code, git, `gh` | yes | |
| `yarn install --frozen-lockfile`, `yarn build`, lint, prettier, flow, tsc, typos 1.50.2, AgentDoc | yes | Node 22 (`.nvmrc`; CI pins 22.22.0), yarn 1.22.22 |
| Most compiler unit tests | yes | |
| **#11 bridge and #9 audit behaviour** | **no** | Linux-only by design (`/proc/self/fd`, `O_PATH`); on macOS they fail closed with `unsupported-capability`. Their tests must run on Linux: a Linux container with its own `yarn install`, or kh once back |
| agentic-corpus / docker-test suites | Linux Docker only | |
| **PR CI** | **no while sk is off** | Every workflow is `runs-on: [self-hosted, sk]` (`.github/workflows/tests.yml`, `agentdoc.yml`): jobs stay queued. "Merge on green CI" is impossible until sk is back, unless the owner decides to change the runner (affects the parallel epic too) |
| **Product perf gate (CE-00.3)** | **no** | Run only by the parallel epic's orchestrator on sk, in announced windows. #153 cannot merge without it |
| Codex reviews | yes | T3 Codex provider, or `codex exec --skip-git-repo-check -m gpt-6.1-sol -s danger-full-access -C <dir> -o <out> "<prompt>" < /dev/null` |
| Alpha 1 baseline store, held-out passphrase | no (kh only) | Not needed for #11 or #12; needed only for later agentic qualifications |

**Bottom line:** from the Mac you can finish the code, tests that are not Linux-only, and reviews of both PRs. Merging
#155 needs CI (sk) plus a Linux test run; merging #153 also needs the perf gate (sk).

## 4. #11 — AG-02.1 owner bridge, PR #155

**State.** Two full Codex rounds + one bounded verification done. R1–R3 fixed; R4 only partly: **BV1 is a surviving
block, waiting for the owner's decision.** No perf gate needed (published bundles byte-identical to main's).

**BV1.** `packages/compiler/src/agent/bridge/runtime-dir.js:158-172`: when start-up refuses a runtime directory that
this call created, the cleanup `fs.rmdirSync(anchored(parent, leaf))` removes whatever empty directory is *now* at that
name, without checking it is still the directory this call created. If another process swapped in its own empty
directory meanwhile, that one is removed. (Before fix round 2, at e947cc6, there was no cleanup at all.)

**Owner decision (one of):**
- **A — recommended:** one exceptional mini-fix, then one bounded check. Preferred fix: drop the cleanup step; the
  prospective real-path placement check already refuses before `mkdir`, so a refused directory is not created in the
  first place. Alternative: identity-checked removal (compare `dev`/`ino` of the pinned descriptor with the entry just
  before removing; leave it in place on mismatch).
- **B:** accept BV1 as a residual (record it on the PR and in a follow-up issue).

**Steps after the decision.**
1. (A only) Run prompt 4.1 with an implementer, then prompt 4.2 with Codex. A `block` from 4.2 goes back to the owner.
2. Merge `origin/main` into `agentic/ag-02.1-bridge`. Expected conflicts: none in code; at most `CHANGELOG.md` and
   `agentdoc/agentdoc.config.yaml` pins (repin per `docs/agentdoc.md`).
3. Run the full compiler suite **on Linux** (bridge suites included), `yarn build`, lint, prettier, flow,
   `tsc --noEmit --strict`, typos, AgentDoc validate/compile/check `--strict`. Check that the bundles are still byte-identical
   to main's (`lib/index.mjs`, `lib/cli.mjs`).
4. Push once, mark ready (no CE measurement window open), wait for CI on sk, merge with a merge commit, and post a review
   record comment on the PR. #11 stays **open**: PR 2 (standalone `session.open`, `discover`) has not started.

### Prompt 4.1 — BV1 mini-fix (implementer)

```text
Repository lbframe/pandam-style, PR #155 (branch agentic/ag-02.1-bridge, head fab00db), issue #11. The review is
closed except one surviving finding the owner allowed one exceptional fix for. Fix exactly this, nothing else
(docs/agent-delivery-protocol.md is binding; other observations -> follow-ups):

BV1 (packages/compiler/src/agent/bridge/runtime-dir.js:158-172): after a start-up refusal, the cleanup removes the
runtime directory by name without checking that the entry is still the directory this call created; a different empty
directory placed at that name meanwhile is removed. Class: a removal/mutation that acts on a path name instead of the
object this call created and checked. Fix: <OWNER CHOICE: remove the cleanup step entirely (the prospective placement
check already refuses before mkdir) | identity-checked removal comparing dev/ino of the pinned descriptor with the
entry, leaving it in place on mismatch>. Audit the start-up path for any other removal or mutation by name.
Tests: refusal leaves no directory of ours behind (or documents why it cannot occur), and a swapped-in directory is
never removed; add a mutation showing the test fails without the fix. Keep the earlier refusal tests (runtime dir
equal to or inside the project, outDir, each watch root: mode, contents and mtime unchanged) passing.
Linux-only code: run the bridge suites on Linux. Checks: full compiler suite, yarn build, lint, prettier, flow,
tsc --noEmit --strict, typos 1.50.2, AgentDoc validate/compile/check --strict; bundles byte-identical to main.
One commit ending with "Co-Authored-By: <model attribution>", one push, PR stays draft.
LAST message: the fix, where, before/after evidence, mutation evidence, checks, head SHA.
```

### Prompt 4.2 — bounded check (Codex)

```text
Correctness check of one fix in lbframe/pandam-style, PR #155, in a read-only detached worktree of the new head
(git fetch origin agentic/ag-02.1-bridge; git worktree add <tmp> <new head>; remove it at the end). Do not edit,
push or comment on GitHub. Scope strictly: git diff fab00db <new head>.
Finding BV1: after a start-up refusal, runtime-dir.js removed the runtime directory by name without checking it was
still the directory this call created, so a different empty directory at that name could be removed. Claimed fix:
<describe>. Check ONLY: (1) is BV1 fixed for its whole category (no removal or mutation by name of an object this call
did not create and check, on any start-up path); (2) does the diff introduce a new defect (block): e.g. a sound
runtime directory refused, a refused directory left with changed modes, bundles no longer byte-identical to main.
Anything else is at most follow-up. Run the bridge suites (Linux).
LAST message: BV1 fixed / not fixed with evidence; any new defect as a table
(ID | block/follow-up | file:line | problem | evidence | fix); commands with results.
```

## 5. #12 — AG-03.1 vocabulary metadata, PR #153

**State.** Review converged (two Codex rounds + bounded verification, no residual). Perf gate under budgets v4
**failed 109/110**: `ce-corpus incremental.token-value.toDiagnosticsMs`, median ratio 1.309 [1.285, 1.363] against a
1.25 limit (control spread 0.005, so the cost is real). Absolute: 2.15 → 2.41 ms per token-value edit;
alpha1-valid-fixture +0.11 ms; c1000/c10000 token-value toDiagnostics +5–7 %. RSS fine, validate time almost
unchanged. The cost is in producing diagnostics after the registry rebuild that every token-value edit triggers, and
**ce-corpus declares no `meta` at all**.

**Perf WIP** (`agentic/ag-03.1-metadata-perf-wip`, aa4d5e1). Captured mid-work and **untested**. It touches
`design-system/registry/index.js`, `registry/ingress.js`, `semantics/build.js`, `metadata-classes-test.js` and the
AgentDoc pins. It is the start of skipping and memoizing the semantics build. Treat it as a draft to finish or discard,
not as reviewed code.

**Shared cell with the parallel epic.** CE-02.2 (#154) sits at 1.248 on the same cell. Its WIP memoizes per-token input
digests in `project/session/token-inputs.js` (`core-evolution/ce-02.2b-perf-wip-handoff`). Whichever PR merges second is
gated against a main that already contains the first, so both costs must be close to 0. The CE note proposes an
incremental registry update for token-value edits as the structural fix if per-feature memos are not enough. Agree the
order with the parallel epic before re-gating.

**Steps.**
1. Run prompt 5.1 with an implementer: finish the perf fix from the WIP branch, measure, and run all checks. The A/B
   needs a quiet machine; the Mac is acceptable for a local A/B only if the verdict states the host and load.
2. Run prompt 5.2 with Codex: a bounded check of the perf diff only. It must not change behaviour.
3. Give the final SHA to the parallel epic's orchestrator, who re-gates it on sk under v4 (sk needed).
4. On pass: merge main if needed (only without a code change, or the gate is re-run), mark ready, CI, merge, close #12
   with a completion-evidence comment.

### Prompt 5.1 — perf fix (implementer)

```text
Repository lbframe/pandam-style, PR #153 (branch agentic/ag-03.1-metadata, head a813ebd), issue #12. Review has
converged; this is a performance fix required by the product perf gate, with NO behaviour change. Anything else ->
follow-ups. Start from the untested WIP: git fetch origin; git checkout -B agentic/ag-03.1-metadata
origin/agentic/ag-03.1-metadata-perf-wip (parent = a813ebd merged with main 8e0145e); then merge the current
origin/main and report conflicts. Read docs/research/agentic-handoff-2026-10-22.md §5 on branch
agentic/handoff-2026-10-22 first.
Gate failure (budgets v4): ce-corpus incremental.token-value.toDiagnosticsMs 1.309 vs 1.25 (+0.26 ms per token-value
edit; ce-corpus declares no meta); c1000/c10000 token-value toDiagnostics +5-7%.
Do: (1) profile the token-value edit on ce-corpus with the CE-00.3 harness's incremental.token-value phase (find how it
measures toDiagnosticsMs under tools/ and benchmarks/core-evolution/), A/B main vs branch, locate what AG-03.1 adds.
(2) Make the AG-03.1 cost ~0 when no meta is declared and ~0 on rebuilds where the meta subtrees did not change: skip
the semantics build when no meta is present (cheap presence scan or an ingress flag), build views lazily, memoize
semantics on a digest of the meta inputs. Keep every invariant of docs/architecture/ag-03.1-vocabulary-metadata.md
(privacy, round-trip, digest independence, structured diagnostics: an invalid meta must still be reported on the
revision that introduces it). (3) Evidence: median + IQR for both sides, explicit inside/outside-noise verdict, host and
load noted, >= 20 alternating runs: ce-corpus and alpha1-valid-fixture incremental.token-value toDiagnostics, c1000 and
c10000 token-value. Target: inside noise vs main. (4) Tests: all metadata suites pass; a definition without meta never
enters the semantics build (+ mutation); an unchanged meta subtree is reused across an unrelated edit while a changed
one is rebuilt and validated.
Checks: full compiler + host suites, yarn build, lint, prettier, flow, tsc --noEmit --strict, typos 1.50.2, AgentDoc
validate/compile/check --strict (repin per docs/agentdoc.md). Commits end with "Co-Authored-By: <model attribution>".
ONE push, PR stays draft. Never run the CE perf gate yourself. Do not end your turn while measurements run.
LAST message: where the time went, the change, before/after table with medians/IQR/verdicts, tests + mutation,
checks, head SHA.
```

### Prompt 5.2 — bounded perf-diff check (Codex)

```text
Correctness check of a performance change in lbframe/pandam-style, PR #153 (issue #12), in a read-only detached
worktree of the new head (remove it at the end; do not edit, push or comment). Scope strictly: git diff <head before
the perf fix, merge of main excluded> <new head>. The change must not alter behaviour; it skips or memoizes the
metadata semantics build when no `meta` is declared or when the `meta` inputs did not change.
Check ONLY: (1) for every input, the result (registry.semantics views, diagnostics, digests, compiled output) is
identical to the code before the change: definitions without meta, with meta, meta added/changed/removed between
revisions, an invalid meta introduced on a later revision (must be reported on that revision), unrelated token-value
edits; (2) the memo key covers every input the semantics build reads (a stale result is a block); (3) the new tests
fail when the optimisation is broken. Anything else is at most follow-up. Run the full compiler suite.
LAST message: table (ID | block/follow-up | file:line | problem | evidence | fix); commands with results.
```

## 6. Kick-off prompt for the orchestrator (T3 on the Mac)

```text
You orchestrate epic lbframe/pandam-style#4 "[Epic] Agentic optimizations". Read
docs/research/agentic-handoff-2026-10-22.md on branch agentic/handoff-2026-10-22 (state, rules, ready prompts) and
docs/agent-delivery-protocol.md. Talk to the owner in French, short, with epic totals (x/33). Ask the owner for the
#155 BV1 decision first. Check which hosts are back (sk: CI + perf gate; kh or a Linux container: bridge tests) before
planning merges. Coordinate perf gates and CI timing with the parallel epic's orchestrator (#39); read
docs/research/ce-handoff-2026-10-22.md on core-evolution/handoff-2026-10-22.
```

## 7. Rules to keep

- **Delivery:** one PR per issue. An implementer works in its own worktree. Review is independent and cross-provider
  (Codex gpt-6.1-sol). Merge when CI is green and no blocking finding remains.
- **Protocol (`docs/agent-delivery-protocol.md`):** a reviewed design note comes before code on security, privacy or
  adversarial surfaces. No scope is added in fix rounds. Fixes are class-level, with a mutation per class. Execute,
  don't infer. At most 2 full rounds, then 1 bounded verification. A regression introduced by a fix is a `block`. Only
  the owner accepts a surviving block as a residual: park that PR and continue other work.
- **Review briefs:** write them in correctness vocabulary (defect, unusual input, visibility rule, false accept/reject).
  Attack/adversary/leak/hostile wording gets Codex requests refused. A bounded verification never adds new scenarios.
  Ask reviewers to keep their probe scripts in a named directory.
- **CI budget:** one push per round. Drafts run no CI. No new CI jobs. Merge main into a branch first, or CI stays
  queued on stale workflows.
- **Perf (session path):** reachability test (`reachability.v1.json`) unchanged, bundle bytes of `lib/index.mjs` and
  `lib/cli.mjs` reported, A/B RSS/heap with medians + IQR and an explicit inside/outside-noise verdict. Make no claims
  about mechanisms without controls outside noise.
- **Perf gate (CE-00.3, budgets v4, `--rev 05c3a33`):** run only by the parallel epic, on sk, in announced windows.
  During a window: no CI-triggering action (no ready-marking, no push to a non-draft PR). Draft pushes are fine.
- **AG-00 baseline:** the frozen gates bind runner tree digest
  `27092b35d7369e513fe9e78f0044834896869c42b5fee3d5829d9578633b5636`. Changes under `benchmarks/agentic/runner/` outside
  the digest-excluded paths (`__tests__/**`, `smoke/**`, root `*.md`, `fixtures/bin/fake-cli.mjs`,
  `fixtures/observed/**`) need a new baseline.
- **Secrets:** never read, print or copy the held-out passphrase or credential files. Held-out plaintext is never
  committed. Never write to the Alpha 1 baseline store. Only Claude accounts approved by the owner. Never ask for a
  secret in chat.

## 8. Next tasks once #11 and #12 land

#13 (AG-03.2, after #12; must plan for manifest schema v3 from CE-02.2), #14–#16 (host owner bridges, after #11; hosts
must declare watch roots outside `rootDir`), #17 (after #11 + #10), #30 (after #9 + others), #11 PR 2. Critical path:
8 → 12 → 13 → 23 → 24 → 25 → 26 → 29 → 31 → 32 → 33 → 34 → 35 → 37. Collision zones with the parallel epic: #12/#13 vs
#46/#74, #13 vs #75, #22 vs #47, #9/#23 vs #75, #36/#37 vs #77/#85/#86 — sync before starting.

Follow-up issues: #133 (AG-01.1, plus an inventory delta after CE #156/#150), #142 (AG-03.1 / AG-01.2), #151 (Docker
daemon races left after #145; covered by the runner digest), #120, #108, #102. The parallel epic owns #147 (output
lease) and #134 (identifier limits).

## 9. About this branch

`agentic/handoff-2026-10-22` = main 8e0145e + `agentic/ag-02.1-bridge` (clean merge) + `agentic/ag-03.1-metadata`.
The conflicts between those two were additive and were resolved as a union:
- `protocol/diagnostics.js` Codes: both new codes kept;
- `tests/support/compiler-inspection.js`: both export blocks kept;
- `CHANGELOG.md`: both entries kept;
- `agentdoc/agentdoc.config.yaml`: #155's side kept, so **#153's AgentDoc pins are stale here**.

No tests were run on this combination. The commits were made without the git hooks, because dependencies were not
installed in the snapshot worktree. The perf WIP is **not** merged here. Do not open a PR from this branch; continue on
the per-PR branches.
