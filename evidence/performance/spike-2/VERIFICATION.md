# Spike 2 verification record

The run below is `./verify-pms.sh` on the committed tree, plus the two checks
`verify-pms.sh` does not cover.

- tested commit: `21b75d005ace33b663e8fa3382710199e65ff00f`
- tested tree: `9072ff1fe0234e795b480155984133b0e063183e`
- working tree at the start of the run: `clean`
- skipped steps: `none`

| step | status | exit | counts |
| --- | --- | ---: | --- |
| `install` | passed | 0 | — |
| `build` | passed | 0 | — |
| `upstream-babel-plugin` | passed | 0 | 1007 passed / 64 skipped |
| `upstream-stylex` | passed | 0 | 99 passed |
| `pandamstyle` | passed | 0 | 283 passed |
| `pilot` | passed | 0 | — |
| `artifacts` | passed | 0 | — |

`PMS_SKIP_INSTALL`, `PMS_SKIP_PILOT` and `PMS_ONLY_STEPS` were NOT set:
`skippedSteps` is empty and the summary says so.

| check | result |
| --- | --- |
| `npm run lint:report` | clean |
| `npm run prettier:report` | clean |
| `node --test benchmarks/pandamstyle/tests/bench.test.js` | 34 passed, 0 failed |
| `python3 benchmarks/pandamstyle/summarize.py --self-test` | pass |
| `node --test` (whole babel-plugin package) | 1,290 passed, 64 skipped, 887 snapshots |

## Test-count reconciliation against the expected baseline

| suite | expected | observed | delta |
| --- | ---: | ---: | ---: |
| upstream `babel-plugin` | 1007 passed / 64 skipped | 1007 / 64 | none |
| upstream `stylex` | 99 passed | 99 | none |
| PandamStyle | 268 passed | 283 | **+15** |
| benchmark harness | 29 passed | 34 | **+5** |

The +15 PandamStyle tests and the +5 harness tests are all new Spike 2 tests:
reuse, changed-file recompilation, reverse-dependency and re-export
invalidation, module add, module delete, file rename, negative-resolution
invalidation, coverage-closure change, stale diagnostic removal, stale
CSS/rule removal, invalid -> repair without restart, global fallback,
transactional failed revision, revision identity, incremental == fresh
rebuild, 1,000-revision memory stability, and zero Babel parses on a
no-change revision. No existing test was changed, removed or relaxed.

## Environment prerequisites, recorded rather than hidden

- The Spike 1 engine-vs-engine oracle test needs a baseline worktree with a
  `node_modules` symlink (`../pms-baseline`). Without one the baseline's ESM
  bundle cannot resolve `@babel/core` and the test fails with a
  `build-verdict` divergence. The worktree was linked for this run; it is an
  environment fact, not a code change.
- The machine's filesystem reached 100% capacity during this batch. It forced
  the c10000 campaign to a six-scenario set and to `PMS_DISCARD_JOB_PROJECT=1`
  (recorded in the campaign metadata). No job errored and no job timed out.

