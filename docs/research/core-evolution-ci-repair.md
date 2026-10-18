# Core evolution CE-00.4: inherited CI failures and their repairs

Status: diagnosis and repair record for
[CE-00.4](https://github.com/lbframe/pandam-style/issues/43). Baseline:
the immutable Alpha 1 commit `415e05539fcb5d36a78226112b5cf488b200b1aa`.
No product source, generated output, expectation, snapshot, case or
denominator changed. Every repair is CI configuration.

The `tests` workflow was red on `415e055` and on every later run of it. Two
jobs failed: `spelling` (17 findings) and `pandamstyle`, the
`./verify-pms.sh` job, with 3 of its 12 required steps failing. Before this
lot, the verifier's per-step logs stayed on the runner, so the job log showed
only which steps failed, not why. The `pandamstyle` job now uploads them as
the `pandamstyle-evidence` artifact.

## Reproduction

| Failure | Original observation | Reproduction at `415e055` |
| --- | --- | --- |
| spelling | [run 39128604698](https://github.com/lbframe/pandam-style/actions/runs/39128604698), job 117678908257: typos v1.50.2 via `crate-ci/typos@v1`, 17 errors | Local `typos-cli 1.50.2` binary on a clean `git archive 415e055` tree with the same configuration: the same 17 findings, exit 2 |
| semantic-oracle, package-qualification, next-qualification | Run 39128604698, job 117678908026: steps failed, logs not retained | A temporary CI job checked out `415e055` exactly and ran `./verify-pms.sh` with log upload ([run 39166471855](https://github.com/lbframe/pandam-style/actions/runs/39166471855), job 117790346375). It reproduced the same steps and counts: 1033 passed, 6 failed, 1 of 62 suites failed. The branch merge tree failed identically in the same run |

The semantic oracle passes locally at `415e055`: 20/20 suites, 154/154
tests, with a snap Chromium whose confinement provides a usable sandbox. The
failures depend on the CI environment, not on the source.

Retained evidence is in [`core-evolution-ci-repair/`](core-evolution-ci-repair/):
`baseline-415e055/` holds the original failures and
`repaired-ci-run-39167443930/` holds the corrected results. A
`*.step-log.txt` file is the verifier's byte-identical `evidence/native/<step>.log`,
renamed only because the repository ignores `*.log`. Spelling deliberately
skips that directory because it quotes the findings verbatim.

## Failure records

### F1: spelling, 17 findings

- **Cause.** typos 1.50.2 flags words that are not English prose errors:
  - 9 × `unparseable`: the emitted coverage-gap request identifier
    `<unparseable>` in `project/graph/coverage.js` and `project/session/fresh.js`,
    plus comments naming that state;
  - 4 × the Stylus `.styl` extension in the compiler's stylesheet rejection
    lists, `frontend/babel/evaluate.js` and `project/graph/resolution.js`;
  - 1 × the second half of "ANDed": the tokenizer splits this boolean verb in
    the `composition-contract` section of `docs/agent-use.md`;
  - 3 French words: two in a demonstrator comment in
    `registry/build-system.js`, and one section label in `policy/properties.js`.
    The retained typos output quotes them verbatim.

  The workflow also used the deprecated floating `crate-ci/typos@v1` tag, so a
  later dictionary release could change the oracle with no repository change.
- **Class.** Fixture/configuration. The checker configuration lacked
  justified exceptions. There was also latent toolchain drift through the
  floating tag.
- **Affected requirement.**
  [Documentation integrity](../CONSTRAINTS.md#documentation-integrity), the
  repository spelling gate.
- **Repair.** `.github/workflows/typos.toml` now accepts:
  - `.styl` only after `.` or `|`;
  - the two exact French comment phrases and the French section label;
  - "ANDed" as a whole identifier;
  - the word `unparseable`, because it is emitted product output.

  The action is pinned to `crate-ci/typos@v1.50.2`, the release that produced
  the findings.

  Why the source was left unchanged: renaming `<unparseable>` would change
  product output, and translating or rewording would break the AgentDoc
  digests pinned on `docs/agent-use.md#composition-contract`, `evaluate.js`,
  `resolution.js` and `properties.js`. Translating the French comments is a
  possible later source-hygiene change; that requires re-review and repinning.
- **Sensitivity.** A probe file containing each flagged spelling on its own,
  outside these contexts, is still reported: 5 of 5.
- **Evidence.**
  - Before: 17 findings, exit 2, in `baseline-415e055/ci-run-39128604698-spelling.txt`
    and `typos-1.50.2-local.txt`.
  - After: 0 findings, exit 0, on the clean `415e055` tree and on this branch
    with the new configuration.
  - CI: `spelling` succeeded in run 39167443930.
- **Product behavior.** Unchanged.

### F2: semantic-oracle, 6 failed tests in `browser-test.js`

- **Cause.** All six `browser.*` cases end with `Semantic browser execution
  failed`. Chromium aborts in `content::ZygoteHostImpl::Init()`. The harness
  launches `chromium` from `PATH` with its sandbox enabled; on the runner that
  is `/usr/local/share/chromium/chrome-linux/chrome`. The runner has
  `kernel.apparmor_restrict_unprivileged_userns = 1`, and that binary has no
  AppArmor user-namespace profile, so it cannot create its sandbox.
  `/opt/google/chrome/chrome` does have one. The `rsbuild-qualification` step
  already launches that browser with `chromiumSandbox: true`, and it passed.
  The facts are in `ci-run-39166471855/runner-browser-facts.txt`.
- **Class.** Infrastructure.
- **Affected requirement.**
  [Provenance and qualification](../CONSTRAINTS.md#provenance-and-qualification);
  the semantic oracle's browser evidence class.
- **Repair.** The `pandamstyle` job sets `PMS_CHROMIUM=/opt/google/chrome/chrome`,
  the harness's existing selection variable. The sandbox stays enabled and no
  case, expectation or timeout changes. In CI the browser identity is the
  runner image's Google Chrome (`Chrome/155.0.8059.39` in run 39167443930), not
  its Chromium snapshot.
- **Evidence.**
  - Local check with `PMS_CHROMIUM=/opt/google/chrome/chrome`: the browser suite
    passes 6/6.
  - Before (CI): 148/154 tests, 19/20 suites, oracle `failedCount: 6`.
  - After (CI): 154/154 tests, 20/20 suites, `failedCount: 0`,
    `unknownCount: 0`, 135 inventoried cases on both sides.
- **Product behavior.** Unchanged.

### F3: package-qualification

- **Cause.** The workflow's `node-version: '22.x'` resolved to v22.23.3. The
  package qualification asserts the qualified host runtime is exactly
  `v22.22.0` (`tools/pms/package-qualification.js`, Vite and Rsbuild matrices),
  next to its pinned `v22.12.0` and `v24.21.0` consumer lanes. The failure is
  `Expected values to be strictly equal: + 'v22.23.3' - 'v22.22.0'`. The
  AgentDoc workflow already pins 22.22.0.
- **Class.** Toolchain version drift.
- **Affected requirement.** Package qualification for
  [qualified hosts](../agent-install.md#qualified-hosts) and the release
  engines contract.
- **Repair.** The `pandamstyle` job pins `node-version: '22.22.0'`. The
  supported `engines` range and the qualification assertions are unchanged.
- **Evidence.** Before: exit 1, Node v22.23.3. After: exit 0, `pass: true`,
  Node v22.22.0.
- **Product behavior.** Unchanged.

### F4: next-qualification

- **Cause.** `tools/pms/qualify-next.mjs` defaults its puppeteer
  `executablePath` to `/usr/local/bin/chromium`, a local workstation path that
  does not exist on the runner: `Browser was not found at the configured
  executablePath`. The run stopped before any later assertion. The
  `qualify-next-semantic-dev.mjs` script it runs next asserts Node `v22.22.0`,
  so F3's drift would have failed it.
- **Class.** Infrastructure, plus the F3 toolchain drift that this failure
  masked.
- **Affected requirement.** Next.js 16.3.8 webpack and Turbopack
  [host qualification](../agent-install.md#qualified-hosts), including the
  verifier's `phase10Complete` assertion for `TURBOPACK-DEV-SETTLEMENT`.
- **Repair.** The same `PMS_CHROMIUM` selection, which `qualify-next.mjs` and
  `qualify-next-semantic-dev.mjs` already honor, plus the F3 Node pin.
- **Evidence.**
  - Before: `pass: false`, `phase10Complete: false`, launch failed.
  - After: `pass: true`, `phase10Complete: true`, Node v22.22.0.
- **Product behavior.** Unchanged.

## Corrected result

[Run 39167443930](https://github.com/lbframe/pandam-style/actions/runs/39167443930)
passed every `tests` job. It ran the verifier twice, under the repaired
environment:
- on the unchanged baseline `415e055` (temporary job 117793243713);
- on the branch merge tree (`pandamstyle`, job 117793243769).

Both report `verification verdict: verified`, 1039 passed, 0 failed,
0 skipped, and 62/62 suites. The denominator equals the failing runs'
1033 + 6 tests and 62 suites. Because the baseline itself turns green, the
inherited failures were environmental, not product defects. The temporary
baseline job was then removed.

## Remaining limitations

- Browser tooling defaults are inconsistent: `chromium` on `PATH`,
  `/usr/local/bin/chromium` and `/opt/google/chrome/chrome`. Only CI selects
  one explicitly. A local run elsewhere still needs `PMS_CHROMIUM`.
- The semantic browser adapter keeps only the last 1200 characters of
  Chromium's stderr, which hid the sandbox message.
- The runner image's Google Chrome version floats with the image. This lot
  pins Node and typos, not the browser binary.
- The other jobs still use `node-version: '22.x'`. They do not assert an exact
  runtime and were not changed.
