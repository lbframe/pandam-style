# Core evolution CE-00.4: inherited CI failures and their repairs

Status: diagnosis and repair record for
[CE-00.4](https://github.com/lbframe/pandam-style/issues/43). Baseline:
the immutable Alpha 1 commit `415e05539fcb5d36a78226112b5cf488b200b1aa`
(tree `26928afeac8822d4789141d7094ccfaf601942ed`).

No product source, generated output, expectation, snapshot, inventory, case or
denominator changed. All repairs are in `.github/workflows/tests.yml` and
`.github/workflows/typos.toml`.

Each claim below is labeled:
- **[executed]**: shown by a command whose output is retained or cited;
- **[unverified]**: from reading source or configuration only.

The `tests` workflow failed on `415e055` and on every later run. Two jobs
failed: `spelling`, with 17 findings, and `pandamstyle`, where `./verify-pms.sh`
failed 3 of its 12 required steps.

## Reproduction at `415e055`

| Failure | Reproduction |
| --- | --- |
| spelling | [Run 39128604698](https://github.com/lbframe/pandam-style/actions/runs/39128604698), job 117678908257: typos v1.50.2, 17 errors **[executed]**. Locally, `typos-cli 1.50.2` on a clean `git archive 415e055` tree with the same configuration gives the same 17 findings, exit 2 **[executed]** |
| semantic-oracle, package-qualification, next-qualification | Job 117678908026 of run 39128604698 failed these three steps **[executed]**, but the verifier's step logs stay on the runner. A temporary diagnostic job then checked out `415e055` exactly and ran `./verify-pms.sh` with log upload ([run 39166471855](https://github.com/lbframe/pandam-style/actions/runs/39166471855), job 117790346375). Result: the same 3 steps failed, 1033 passed and 6 failed, 1 of 62 suites failed. The branch merge tree failed identically **[executed]**. The job existed only for this reproduction and is not in the delivered workflow |

Locally at `415e055`, the semantic oracle passes 20/20 suites and 154/154
tests with this workstation's snap Chromium **[executed]**.

Retained evidence:
- [`core-evolution-ci-repair/baseline-415e055/`](core-evolution-ci-repair/baseline-415e055/)
  holds the original failures.
- [`repaired-ci-run-39167443930/`](core-evolution-ci-repair/repaired-ci-run-39167443930/)
  holds the corrected results.

Each `*.step-log.txt` file is the verifier's `evidence/native/<step>.log`,
byte for byte. Only the extension changed, because the repository ignores
`*.log`. Spelling skips that directory because it quotes the findings
verbatim.

## Failure records

### F1: spelling, 17 findings

- **Cause.** typos 1.50.2 flags tokens that are not misspelled English
  **[executed]**:
  - **9 × `unparseable`.** The compiler emits `<unparseable>`. A temporary
    probe made a covered file of the `valid` fixture unreadable, and
    `buildProject` threw `PMS_COVERAGE_GAP` (`coverage.local-imports`) with
    `context.request: "<unparseable>"`, the same text in the message, and
    `form: "unreadable"`. The other hits are comments naming that state.
  - **4 × the Stylus `.styl` extension.** These are in the stylesheet rejection
    lists of `frontend/babel/evaluate.js` and `project/graph/resolution.js`.
  - **1 × the second half of "ANDed".** A probe containing "separate axes are
    ANDed." reports the `Ded` token under the old configuration and passes
    under the new one. The word is in the "Responsive behavior and finite
    selection" section of `docs/agent-use.md`, line 125.
  - **3 French words.** Two are in a demonstrator comment in
    `registry/build-system.js` and one is a section label in
    `policy/properties.js`. The retained typos output quotes them.
- **Class.** Checker configuration: the configuration had no justified
  exceptions for an emitted identifier, a file extension, a technical verb or
  quoted French text.
- **Affected requirement.**
  [Documentation integrity](../CONSTRAINTS.md#documentation-integrity), the
  repository spelling gate.
- **Repair.** In `.github/workflows/typos.toml`:
  - `.styl` is accepted only after `.` or `|`;
  - the two exact French comment phrases and the exact French label are
    accepted;
  - "ANDed" is accepted as a whole identifier;
  - the word `unparseable` is accepted, because changing the emitted string
    would be a product behavior change.
- **Why the files were left unchanged.**
  - `evaluate.js`, `resolution.js` and `properties.js` are pinned
    reviewed-override evidence: their current SHA-256 digests appear in the
    AgentDoc configuration **[executed]**.
  - Changing the `properties.js` label made `agentdoc validate` fail with
    `AGENTDOC_OVERRIDE_STALE` **[executed]**.
  - Rewording "ANDed" made it fail with `AGENTDOC_NORMATIVE_SOURCE_STALE` on
    `docs/agent-use.md#responsive-behavior-and-finite-selection` **[executed]**.
    Both edits were reverted.
  - `build-system.js` is not pinned **[executed]**. Translating its comment is
    still a product-source edit that needs orchestrator approval, so it is a
    proposed follow-up.
- **Pin.** The action is now `crate-ci/typos@v1.50.2`, the release that
  reported the findings and checked the repair. This records an exact checker
  identity, as #43's identity criterion requires. On the repaired run, CI
  downloaded `crate-ci/typos@v1.50.2` (SHA `512fc24f…`) and typos v1.50.2, and
  the deprecation warning is gone **[executed]**.
- **Sensitivity.** A probe that uses each flagged spelling on its own, outside
  these contexts, is still reported: 5 of 5 **[executed]**.
- **Spelling denominator.** Every file that `main`'s configuration scans is
  still scanned (393 → 394; the new file is this record). The only skipped
  additions are the 21 retained evidence files **[executed]**.
- **Before → after.** 17 findings, exit 2 → 0 findings, exit 0, on the clean
  `415e055` tree and on this branch **[executed]**. CI `spelling` succeeded.
- **Product behavior.** Unchanged.

### F2: semantic-oracle, 6 failed tests in `browser-test.js`

- **Cause in CI [executed].** All six `browser.*` cases fail with
  `Semantic browser execution failed`, with a fatal abort in
  `content::ZygoteHostImpl::Init()`. Runner facts:
  - `chromium` on `PATH` resolves to `/usr/bin/chromium`, which links to
    `/usr/local/share/chromium/chrome-linux/chrome`;
  - `kernel.apparmor_restrict_unprivileged_userns = 1`;
  - `/opt/google/chrome/chrome` exists.

  These are in `ci-run-39166471855/runner-browser-facts.txt`.
- **Mechanism, reproduced locally [executed].** This workstation is Ubuntu
  24.04 with the same sysctl. `/etc/apparmor.d/chrome` grants `userns` to the
  path `/opt/google/chrome/chrome` only.
  - The identical Chrome binary copied to another path, without the SUID helper,
    aborts with `FATAL zygote_host_impl_linux.cc:128 No usable sandbox!`. At
    `/opt/google/chrome/chrome` it renders.
  - Through the oracle harness, `PMS_CHROMIUM=<copy>` fails 6/6 with that
    message, and `PMS_CHROMIUM=/opt/google/chrome/chrome` passes 6/6.

  The sandbox abort also shows that the harness launches with its sandbox
  enabled.
- **Not verified.** That the runner's Chromium has no AppArmor profile was not
  listed on the runner **[unverified]**. Only the abort site and the sysctl
  were observed there.
- **Class.** Infrastructure.
- **Affected requirement.**
  [Provenance and qualification](../CONSTRAINTS.md#provenance-and-qualification):
  the semantic oracle's browser evidence class.
- **Repair.** The `pandamstyle` job sets `PMS_CHROMIUM=/opt/google/chrome/chrome`,
  a variable the harness already reads. No case, expectation, timeout or
  launch flag changes. The browser that ran is the runner image's Google
  Chrome; Next qualification reports `Chrome/155.0.8059.39` for it. The
  semantic oracle does not record a version.
- **Before → after [executed].**
  - Tests: 148/154 → 154/154; suites: 19/20 → 20/20.
  - Oracle `failedCount`: 6 → 0; `unknownCount`: 0 → 0.
  - The same 135 case IDs, with statuses of 133 `MUST_PRESERVE` and 2
    `DEFERRED`.
  - Only the 6 `browser.*` rows changed their match flags, to all `true`.
    Every other row, including the deferred ones, is identical.
- **Product behavior.** Unchanged.

### F3: package-qualification

- **Cause [executed].** `node-version: '22.x'` resolved to v22.23.3 (`env.json`).
  The step fails with `Expected values to be strictly equal: + 'v22.23.3'
  - 'v22.22.0'`.
- **Class.** Toolchain version drift.
- **Affected requirement.** Package qualification for
  [qualified hosts](../agent-install.md#qualified-hosts).
- **Repair.** The `pandamstyle` job pins `node-version: '22.22.0'`, the value
  the assertion requires and `.github/workflows/agentdoc.yml` already uses.
  The `engines` ranges and the assertions are unchanged.
- **Before → after [executed].** Exit 1 → exit 0, `pass: true`; `env.json`
  reports Node v22.22.0.
- **Product behavior.** Unchanged.

### F4: next-qualification

- **Cause [executed].** `Browser was not found at the configured executablePath
  (/usr/local/bin/chromium)`, so the run stopped at browser launch. The runner
  has no `/usr/local/bin/chromium` (`runner-browser-facts.txt`).
- **Not verified.** That F3's Node drift would have failed it next is based on
  reading the `assert.equal(process.version, 'v22.22.0')` in
  `qualify-next-semantic-dev.mjs` **[unverified]**.
- **Class.** Infrastructure.
- **Affected requirement.** Next.js 16.3.8 webpack and Turbopack
  [host qualification](../agent-install.md#qualified-hosts), including the
  verifier's `phase10Complete` assertion for `TURBOPACK-DEV-SETTLEMENT`.
- **Repair.** The same `PMS_CHROMIUM` value and Node pin.
- **Before → after [executed].** `pass: false, phase10Complete: false` →
  `pass: true, phase10Complete: true`.
- **Product behavior.** Unchanged.

## Corrected result

All results in this section are **[executed]**.

[Run 39167443930](https://github.com/lbframe/pandam-style/actions/runs/39167443930)
ran the verifier under the repaired settings twice:
- on the unchanged baseline (temporary job 117793243713; tree `26928afe…`);
- on the branch merge tree (`pandamstyle`, job 117793243769).

Both report `verification verdict: verified`, 12 of 12 steps passed with
none skipped, 1039 passed, 0 failed, 0 skipped, and 62/62 suites. The
failing runs had the same denominator: 1033 + 6 tests and 62 suites.

Generated artifact files are byte-identical across the failing baseline run,
the repaired baseline run and the branch run:
- `valid-fixture-generation/{artifacts,manifest,coverage,build-report}.json`;
- `generated-runtime-imports.json`;
- package proof and package manifests.

The external-install and core-package proof reports differ only in temporary
paths and timings.

The two pilot reports also differ in revision and session IDs, CSS revisions,
digests, messages and HMR event counts. To check that this is run-to-run
variance, two runs from the same environment were compared: the two failing
runs, then the two repaired runs. Before-versus-after shows the same set of
differing keys as those same-environment comparisons, plus `node`, which
records the pinned runtime. The pilot step passed in every run.

## Verification commands

- Spelling: `typos --config .github/workflows/typos.toml --format brief` with
  `typos-cli 1.50.2`, run on `git archive 415e055`, `git archive main` and
  `git archive HEAD`; `typos --files` to compare the scanned files.
- Browser mechanism:
  `PMS_CHROMIUM=<binary> PMS_SEMANTIC_REPORT_DIR=<dir> node node_modules/jest/bin/jest.js --config tools/semantic-oracle/jest.config.js --ci --runInBand tests/semantic/__tests__/browser-test.js`,
  plus a direct `--headless --dump-dom` launch of each binary.
- Emitted identifier: a temporary Jest probe using
  `packages/compiler/__tests__/pandamstyle/session-helpers.js`, not committed.
- Pins: `agentdoc validate` after a temporary edit, then reverted;
  `sha256sum` compared with the AgentDoc configuration.
- Verifier: `./verify-pms.sh` in CI runs 39166471855 and 39167443930. It was
  not run in full locally.

## Proposed follow-ups (not implemented)

- Upload `evidence/native` from the `pandamstyle` job as a workflow artifact,
  so a failing step can be diagnosed from the run.
- Unify the browser defaults in the tooling: `chromium` on `PATH`,
  `/usr/local/bin/chromium` and `/opt/google/chrome/chrome`. Document
  `PMS_CHROMIUM` in `tools/README.md`.
- Record the browser executable and version in the semantic oracle report.
  Keep more than the last 1200 characters of browser stderr; the truncation
  hid the `No usable sandbox` line in CI.
- Pin, or record, the CI browser binary. The runner image's Google Chrome
  changes with the image.
- With orchestrator approval, translate the French demonstrator comments.
  `properties.js` would then need AgentDoc re-review and repinning.
