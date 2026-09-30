# PandamStyle tooling verification step — September 2026

PandamStyle repository verification now includes the verification tooling itself.
`tools/pms` is an independent required test-bearing step, its test and suite
integrity contributes to the official run verdict, a green run can still report
`complete: true` / `verified`, and this change has no effect on normal AI-agent
use of the PandamStyle compiler.

## Identity and delivery

- Repository: `lbframe/pandam-style`.
- Branch: `fix/pandamstyle-tooling-verification-step-2026-09`.
- Base: `73b10666a9440d86fb92721da8ff597916b80b16`.
- Implementation and tested commit: `70fdf83096e0dc7bf0cc9d1c92b797114c8edc70`.
- Tested tree: `8f372622808c8bbd432465b823e0e1ecfc10398f`.
- Starting working tree: clean, captured before the verifier wrote evidence.
- Final delivery adds only this evidence directory to the tested commit. Final
  local/remote head identifiers are reported in the delivery response and Git
  history; no implementation changes follow the tested commit.
- Local and remote `main` remain `71fcc045b18eb215f0c3a815bb8c8d15a9f99489`.
- PR: none. Merge: none. Package publication: none. The pilot's local `npm pack`
  and tarball installation are qualification steps, not publication.

## Official verification

The exact, unedited [summary](summary.json) is the authoritative run result.
The official `./verify-pms.sh` completed with exit 0 and all eight steps, without
skip flags or step filters. [Command environment](command-environment.json)
records the exact invocation and temporary environment overrides. Root disk
space was low, so temporary files, npm cache and pilot workspace were scoped to
`/dev/shm` for this invocation. This is an environment accommodation, not a
semantic requirement, and does not change persistent machine configuration.

| Order | Step | Contract kind | Status / verdict | Counts |
| ---: | --- | --- | --- | --- |
| 1 | install | command | passed / verified | null |
| 2 | build | command | passed / verified | null |
| 3 | upstream-babel-plugin | test | passed / verified | independent test/suite counts |
| 4 | upstream-stylex | test | passed / verified | independent test/suite counts |
| 5 | pandamstyle | test | passed / verified | independent test/suite counts |
| 6 | tooling-tests | test | passed / verified | independent test/suite counts |
| 7 | pilot | pilot | passed / verified | null |
| 8 | artifacts | artifact-check | passed / verified | null |

Tooling follows compiler suites and precedes pilot/artifact qualification so its
population remains independently reported. Command/pilot contracts require
successful execution; the artifact contract additionally requires nonempty
digests. Test steps retain all existing test/suite integrity findings and also
reject a missing Tests line or missing totals. Unknown steps remain
`STEP_UNCLASSIFIED`; they never inherit another step's contract.

| Population | Tests passed | Failed | Skipped | Suites passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| upstream-babel-plugin | 1007 | 0 | 64 | 42 | 0 | 1 |
| upstream-stylex | 99 | 0 | 0 | 4 | 0 | 0 |
| pandamstyle | 498 | 0 | 0 | 21 | 0 | 0 |
| tooling-tests | 62 | 0 | 0 | 4 | 0 | 0 |
| Global test-bearing totals | 1666 | 0 | 64 | 71 | 0 | 1 |

- `complete: true`.
- `verification.verdict: verified`.
- `failedSteps: []`; `skippedSteps: []`.
- Eight steps verified; no integrity findings.
- Totals are derived from the four test-bearing steps, never hard-coded.

## Tooling command and inventory

The official command is:

```sh
node tools/pms/run-tooling-tests.js <run-directory>
```

It uses the existing root Jest environment and executes the equivalent of:

```sh
node_modules/.bin/jest --runInBand --ci tools/pms/__tests__
```

The helper adds `--json --outputFile <run-directory>/tooling-jest-results.json`
to preserve execution evidence, and first checks `--listTests --json` discovery.
The intended inventory is derived from `tools/pms/__tests__/**/*-test.js` on
disk, not a maintained list or frozen count. Empty inventory, discovery
disagreement, nonzero Jest exit, missing/incomplete execution results and suites
that did not pass all fail the command. The official summary independently
assesses the raw Jest count lines under the normal `kind: test` contract.

[Inventory](tooling-inventory.json), [Jest execution results](tooling-jest-results.json)
and [raw tooling log](tooling-tests.log) preserve both population and outcome.
The baseline was 43 tests in 3 suites; this batch adds 19 tests and one suite,
yielding 62 tests in 4 suites. PandamStyle remains 498 tests in 21 suites.

## Regression coverage and acceptance

`tools/pms/__tests__/tooling-verification-test.js` adds 19 tests exercising:

- Actual eight-step runner/summary success, with independent compiler/tooling
  counts, summed totals, `complete: true`, `verified`, no failed/skipped steps.
- Tooling command failure, failed test and suite-load failure, including output
  that contradicts a successful process exit.
- Missing counts, missing Tests or Test Suites lines, missing totals, and
  unreconciled test/suite counts.
- Missing discovery/execution populations and empty inventory.
- Omitted and skipped required tooling step through the actual runner.
- Existing `EXIT_CODE_DISAGREES` and `EXIT_CODE_MISSING` findings for tooling.
- Real Jest test failure and real Jest suite-load failure propagation.
- Broken parser bootstrap: nonzero verifier exit, previous green summary removed,
  underlying error logged, raw evidence preserved, no invented passing summary.

The full-run fixture substitutes costly commands while using the actual shell
runner, tooling helper, contract dispatcher, parser, summary and exit decision.
Its green eight-step result is `complete: true`, `verified`, `failedSteps: []`,
`skippedSteps: []`; its illustrative pre-batch population is 1647 passed tests
and 70 passed suites, plus the 64 skipped tests and one skipped suite.
The separate actual official run above qualifies the implementation commit.

The existing unknown-step regression remains in `step-contracts-test.js`, whose
classification assertions now explicitly include `tooling-tests`. Existing
parser, Jest configuration and historical step-contract fixtures still pass.
All TOOL-AC-01 through TOOL-AC-17 are satisfied by the implementation, regression
coverage, final eight-step run and unchanged-scope checks.

Targeted checks also passed: Bash syntax, ESLint and formatting on modified
tooling JavaScript, implementation diff whitespace, and the tooling suite before
the official run. The repository commit hook's formatting/lint checks passed.

## Scope and remaining gaps

- Compiler source changed: no, including
  `packages/@stylexjs/babel-plugin/pandamstyle/`.
- Agent runtime changed: no. Sessions, results, diagnostics, coverage graph,
  design-system views, CSS, publication, watchers, fresh and incremental
  compilation are unchanged. Normal AI-agent requests do not launch this gate
  or Jest.
- Performance evidence changed: no. No Spike 1–4, c1000 or c10000 performance
  campaign was rerun.
- Strategic checkpoint updated: yes, tooling inclusion is resolved. STOP general
  warm-path optimization remains the decision; the next product batch remains
  independent.
- Remaining gaps in this batch: none. This selected repository gate does not
  claim root-wide upstream testing or completion of unrelated product/browser,
  type, SSR or host qualification work.

All changed paths are listed in [files-changed.txt](files-changed.txt).
Historical evidence is untouched. The evidence commit preserves the exact
tested summary and raw per-step logs; regenerable heavy artifacts/pilot work
are excluded, with [artifact digests](artifact-digests.txt) retained.
