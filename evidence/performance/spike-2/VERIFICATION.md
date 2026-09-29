# Spike 2 verification record

This is the FINAL qualification run for Spike 2. It was taken from a clean
checkout of the exact delivered source/report tree, with no skip flags, and
it is the run the Spike 2 verdict rests on.

## What was verified, and what was deliberately not re-run

`verify-pms.sh` below was executed on the tree named in this file. The
benchmark campaigns were **not** rerun and **no measurement was regenerated**
for this closure: the c1000 and c10000 campaigns, the corpus manifests, the
incremental-vs-fresh-rebuild oracle verdicts and the 1,000-revision memory
trace were produced earlier and are committed unchanged. This pass only
re-ran the qualification suite against the delivered head, because the head
had moved three commits past the previously verified source commit.

- tested commit: `f1fe0625d6958a637cdc71118a4e244493fe2b57`
- tested tree: `7a5060ad8bf517c52dd35ec2608996752490e4b4`
- working tree at the start of the run: `clean`
- branch: `perf/pandamstyle-spike-2-incremental-2026-09`
- complete: `True`
- skipped steps: `none`
- failed steps: `none`

## `verify-pms.sh`

Final line: `VERIFICATION OK`. Exit status 0.

| step | status | exit | counts |
| --- | --- | ---: | --- |
| `install` | passed | 0 | — |
| `build` | passed | 0 | — |
| `upstream-babel-plugin` | passed | 0 | 1007 passed / 64 skipped |
| `upstream-stylex` | passed | 0 | 99 passed |
| `pandamstyle` | passed | 0 | 283 passed |
| `pilot` | passed | 0 | — |
| `artifacts` | passed | 0 | — |

`PMS_SKIP_INSTALL`, `PMS_SKIP_PILOT` and `PMS_ONLY_STEPS` were **not** set:
`skippedSteps` is empty and the summary records that.

## The other required checks, same tree

| check | result |
| --- | --- |
| `npm run lint:report` | exit 0, no findings |
| `npm run prettier:report` | exit 0, all matched files use Prettier code style |
| `node --test benchmarks/pandamstyle/tests/bench.test.js` | **34 passed, 0 failed** |
| `python3 benchmarks/pandamstyle/summarize.py --self-test` | pass |

## Test-count reconciliation

| suite | expected | observed | delta |
| --- | ---: | ---: | ---: |
| upstream `babel-plugin` | 1007 passed / 64 skipped | 1007 / 64 | none |
| upstream `stylex` | 99 passed | 99 | none |
| PandamStyle | 268 passed | 283 | **+15** |
| benchmark harness | 29 passed | 34 | **+5** |

The +15 PandamStyle tests and the +5 harness tests are the Spike 2 tests
added by this batch. No pre-existing test was changed, removed, skipped or
relaxed, which is why the three legacy counts are bit-for-bit what they were
before the batch.

## What the run directory keeps, and what it does not

A run directory keeps its durable evidence: `env.json`, `summary.json`,
`steps.tsv` and the per-step logs. The pilot work tree and the generated
artifacts are rebuildable outputs and are excluded, by the same rule the
repository already applies to every other run directory. The raw per-step
logs are matched by the repository's `*.log*` pattern and stay local; the
counts they carry are reproduced above and in `summary.json`.

## Environment prerequisites, recorded rather than hidden

- The Spike 1 engine-vs-engine oracle test inside the harness suite needs a
  baseline worktree with a `node_modules` symlink (`../pms-baseline`). Without
  one the baseline's ESM bundle cannot resolve `@babel/core` and the test
  fails with a `build-verdict` divergence. The worktree was linked for this
  run; it is an environment fact, not a code change.
- The machine's filesystem reached 100% capacity during the campaign phase.
  It forced the c10000 campaign to a six-scenario set and to
  `PMS_DISCARD_JOB_PROJECT=1` (recorded in the campaign metadata). No job
  errored and no job timed out, and the qualification run above was
  unaffected.

