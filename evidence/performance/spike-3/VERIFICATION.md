# Spike 3 — verification record

## Result

`./verify-pms.sh` → **VERIFICATION OK**

```
tested commit  : 18618117f8cdcbb1aa21e4b1fcfa8cab981a642d
tested tree    : f3d623b8db64042176eff14bfcb302f23e4ae7d8
branch         : perf/pandamstyle-spike-3-publication-css-2026-09
working tree   : dirty (as found, before this run wrote anything)
batch base     : e5ff62b4a925405dcf9fb415faa00df4b68aeaa9  (refs/remotes/origin/feat/pandamstyle-native-compiler)
```

`complete: true`, `skippedSteps: []`, `failedSteps: []`. **No skip flags were used** —
`PMS_SKIP_INSTALL` and `PMS_SKIP_PILOT` were both left unset and both steps ran.

The "working tree: dirty" line is the record of the state as this run found it, which
is Spike 3's own uncommitted evidence at the time. It is reported, not corrected: the
run measured the tree, and the tree was subsequently committed.

## Steps

| # | step | status | exit | acceptance |
|---|---|---|---|---|
| 1 | install | passed | 0 | passed |
| 2 | build | passed | 0 | passed |
| 3 | upstream-babel-plugin | passed | 0 | passed |
| 4 | upstream-stylex | passed | 0 | passed |
| 5 | pandamstyle | passed | 0 | passed |
| 6 | pilot | passed | 0 | passed |
| 7 | artifacts | passed | 0 | passed |
| 8 | summary | passed | 0 | passed |

## Regression counts

| suite | observed | expected baseline | delta | explanation |
|---|---|---|---|---|
| upstream babel-plugin | 1007 passed / 64 skipped / 42 suites | 1007 / 64 / 42 | unchanged | — |
| upstream stylex | 99 passed / 4 suites | 99 / 4 | unchanged | — |
| **PandamStyle** | **333 passed / 14 suites** | 283 / 12 | **+50** | new Spike 3 tests: `incremental-publication-test.js` (38) and `incremental-css-test.js` (12) |
| benchmark harness | 34 passed | 34 | unchanged | — |

Every increase is explained by new tests. **No existing test was removed, skipped or
weakened.** The 283-test baseline passes unchanged on the Spike 3 tree, which is the
load-bearing part of this table: the new publisher and the new CSS state did not
change the behaviour of anything Spike 2 proved.

## Other required checks

| check | result |
|---|---|
| `npm run lint:report` | clean |
| `npm run prettier:report` | clean |
| `node --test benchmarks/pandamstyle/tests/bench.test.js` | 34 passed, 0 failed |
| `python3 benchmarks/pandamstyle/summarize.py --self-test` | ok |

## Campaigns

| campaign | jobs | ok | errors | wall |
|---|---|---|---|---|
| c1000-t1000-r100-s809, 3 variants, 11 scenarios, 2 warm states, 3 iterations | 144 | 144 | **0** | 649 s |
| c10000-t1000-r100-s307, 3 variants, 8 scenarios, 2 warm states, 2 iterations | 72 | 72 | **0** | 2582 s |

## Fresh-rebuild oracle

| variant | revisions | mismatches | errors | verdict |
|---|---|---|---|---|
| `session_full_publish` | 54 | 0 | 0 | `equivalent` |
| `session_incremental_publish` | 54 | 0 | 0 | `equivalent` |
| `session_incremental_publish_css` | 54 | 0 | 0 | `equivalent` |

The oracle gained an explicit `generation-file-set` check for Spike 3. Comparing only
the files a fresh rebuild *expects* cannot detect a stale file it does not have, which
is the class of defect Spike 2 documented and could not catch.

## Disk capacity before c10000

The filesystem was at **100% with 518 MB free** — the exact condition that ended the
Spike 2 c10000 run. Reclaiming regenerable caches brought it to 7.9 GB, and the c10000
scenario set was chosen and recorded in `../corpora/c10000-capacity-and-scenario-plan.md`
**before** the campaign started. The run completed 72/72 with 0 errors and the
filesystem stable afterwards.

`PMS_DISCARD_JOB_PROJECT=1` was set, and the campaign metadata records
`retention.discard_job_project_copy`.

## Environment

One environment change was made outside the repository, and it is recorded here
because it affects reproducibility of the install step:

```
yarn config set cache-folder /dev/shm/pms-yarn-cache
```

The yarn download cache was moved to a tmpfs. This was necessary because the disk was
at 100% and `yarn install --frozen-lockfile` — step 1 of this verification —
re-populates a ~4.7 GB cache, which failed twice with ENOSPC. Pointing the cache at
tmpfs means the install downloads happen in RAM and the filesystem never holds the
4.7 GB. It changes nothing about what is installed. **To restore the machine's
previous behaviour: `yarn config delete cache-folder`.**

## Files in this directory

| file | what it is |
|---|---|
| `verify-pms-summary.json` | `verify-pms.sh`'s own `summary.json`, unmodified |
| `verify-pms.log` | the full run log |
