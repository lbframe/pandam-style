# Spike 1 verification record

**Node v22.22.0** (the repository's `.nvmrc` pin), yarn 1.22.22, npm 11.11.1.
No install was skipped. No pilot was skipped. `./verify-pms.sh` ran to
completion with `VERIFICATION OK`.

`./verify-pms.sh` writes its own durable evidence to `evidence/native/`
(`summary.json`, `env.json`, per-step logs, `steps.tsv`). This file is the
narrative record of what was required, what was run, and what the numbers were.

---

## What was verified, and against exactly which commit

The evidence above was produced from a **clean checkout**, so the numbers below
describe the tree that is committed rather than a working copy that happened to
resemble it.

| | |
| --- | --- |
| tested commit | `32cf2e6aa681aa192880a80dc83a20ac564a4529` |
| tested tree | `c84607f7596d35db20e9dfd3b3d2457c40d6a7f5` |
| working tree at start | `clean` |
| batch base | `e5ff62b4a925405dcf9fb415faa00df4b68aeaa9` |
| reference engine | `d5702374ac5a685499d14a53bf323d8533e6982d` |

`evidence/native/summary.json` records the same commit, tree and `workingTree:
clean`, so the identity is checkable from the machine-written evidence rather
than only asserted here.

An earlier run of this record is superseded. It was executed against a working
tree that was already dirty and against an earlier commit, and it cannot
identify what it actually tested; the values in this file are from the run
above and from no other.

### Required checks, all run from the clean checkout

| check | command | result |
| --- | --- | --- |
| lint | `npm run lint:report` | clean, exit 0 |
| format | `npm run prettier:report` | clean, exit 0 |
| benchmark suite | `node --test benchmarks/pandamstyle/tests/bench.test.js` | 29/29 |
| summariser self-test | `python3 benchmarks/pandamstyle/summarize.py --self-test` | ok |
| full verification | `./verify-pms.sh` (no skip flags) | `VERIFICATION OK` |

### Two ordering requirements the benchmark suite does not state

Found by running the suite in a fresh checkout, where both failed before either
was built. The suite now asserts both by name.

- The differential-oracle test spawns **both** engines' real CLIs, and each
  needs its own build. The variant engine is
  `packages/@pandamstyle/compiler/lib/index.js`; the reference engine is the
  separate checkout at `PMS_BASELINE_ROOT` (default `../pms-baseline`).
- These fail differently, and only one of them reads as a build problem. A
  missing variant build surfaces as a `build-verdict` divergence
  (`work_eliminated=2`). A missing reference engine is caught first by the
  **expectation gate**, which reports "the reference engine rejected a program
  the scenario expects to be accepted" — a correct refusal, since equivalence
  cannot be assessed if the reference never ran, but one that points at the
  scenario rather than at the checkout.

`./verify-pms.sh`'s build step satisfies both. Run before the suite, the tests
are 29/29; run in a fresh checkout, 28/29 with a misleading message.

---

## Regression suites

Counts are from `evidence/native/summary.json`, produced by the repository's own
verification runner.

| suite | expected baseline | **observed** | step |
| --- | --- | --- | --- |
| upstream `babel-plugin` | 1007 passed / 64 skipped | **1007 passed / 64 skipped** (1071 total, 43 suites) | `upstream-babel-plugin` |
| upstream `stylex` | 99 passed | **99 passed** (4 suites) | `upstream-stylex` |
| PandamStyle | 268 passed | **268 passed** | `pandamstyle` |

**No count changed.** The instrumentation added in this batch is inert without a
collector, and the PandamStyle count is exactly the expected 268. The
benchmark's own suite is new and reported separately below; it does not alter any
of the three counts above.

## `./verify-pms.sh`

```
step install:                  passed (exit 0)
step build:                    passed (exit 0)
step upstream-babel-plugin:    passed (exit 0)
step upstream-stylex:          passed (exit 0)
step pandamstyle:              passed (exit 0)
step pilot:                     passed (exit 0)
step artifacts:                passed (exit 0)

run directory: evidence/native
VERIFICATION OK
```

`complete: true`, `skippedSteps: []`, `failedSteps: []`.

## `npm run lint:report`

```
> eslint . --ext .flow,.js,.jsx,.mjs,.cjs,.ts,.tsx,.mts
(no output — clean)
```

## `npm run prettier:report`

```
> prettier --check "**/*.{js,jsx,mjs,cjs,flow,tsx,mts,ts}"
Checking formatting...
All matched files use Prettier code style!
```

## Benchmark-specific tests

```
node --test benchmarks/pandamstyle/tests/bench.test.js
# tests 29
# pass  29
# fail  0
```

Covering: deterministic corpus generation (byte-identical source and manifest),
same seed → same hashes, different seed → intentional differences, observation
JSONL schema validation, timer sanity and monotonicity, scenario replay
determinism, `summarize.py --self-test`, engine-adapter identity, the
current-vs-optimized differential oracle, negative-case classification, failed
runs staying visible, and corpus-manifest integrity.

`python3 summarize.py --self-test`:

```
self-test ok: upper-rank p95, median, sample variance, session preservation,
error visibility, cache-hit labelling, non-ranking of mismatched correctness,
and malformed-line reporting all behave.
```

## Differential oracle

`node benchmarks/pandamstyle/src/differential.js` — 28 scenario revisions per
corpus, comparing `babel_work_eliminated` against `babel_current` as the
semantic reference.

| corpus | scenarios | verdict | errors |
| --- | ---: | --- | ---: |
| 24 components / 120 tokens / 6 recipes | 28 | **equivalent** | 0 |
| 100 components / 100 tokens / 10 recipes | 28 | **equivalent** | 0 |

Re-run after the final code freeze: still **equivalent, 0 errors**. The two
committed reports are the post-freeze ones, named for the corpus they cover:

| report | corpus |
| --- | --- |
| `diff-c24-post-freeze.json` | 24 components / 120 tokens / 6 recipes |
| `diff-c100-post-freeze.json` | 100 components / 100 tokens / 10 recipes |

Reports: `evidence/performance/spike-1/correctness/`.

## Campaign

| cell | jobs | ok | error | timeout | wall |
| --- | ---: | ---: | ---: | ---: | ---: |
| `c100-t100-r10-s101` | 742 | 742 | 0 | 0 | 931 s |
| `c1000-t1000-r100-s809` | 318 | 318 | 0 | 0 | 2,275 s |
| `c10000-t1000-r100-s307` | 56 | 56 | 0 | 0 | 3,160 s |
| **total (final campaign)** | **1,116** | **1,116** | **0** | **0** | — |

An earlier c100 campaign of the same matrix also ran 742/742 with 0 errors. The
two disagree by a 12.2% cross-campaign median, and the compiler was not
byte-identical between them; this is reported as a measurement-quality limit
(REPORT §15, item 8) and no conclusion rests on c100.

Observations: 66,006 `ok`, 4,640 `unsupported` (the three metrics that cannot be
isolated honestly, each carrying its reason), **0 `error`, 0 `timeout`**.

`unsupported` is not a suppressed failure. It is a phase the compiler cannot
isolate: `sourcemap_ms` (source maps are not requested, so there is no work to
time), `cache_hydrate_ms` (no cache is persisted across processes), and
`cache_validate_ms` (the only cache is a `Map` with no validation step). A
fabricated boundary would have been worse than an admitted gap.

## Corpora

| cell | files | content hash |
| --- | ---: | --- |
| `c100-t100-r10-s101` | 116 | `54b220f78e9fec85…` |
| `c1000-t1000-r100-s809` | 1,020 | `34090021532a3057…` |
| `c10000-t1000-r100-s307` | 10,020 | `65856fb5efe80da3…` |

Regenerating each cell after the formatting pass reproduced **the same content
hash**, which is the proof that `prettier --write` did not change the benchmark
input.

## What was NOT run, and why

| check | status | reason |
| --- | --- | --- |
| `os_cold` | `not_run` | dropping the OS page cache needs privileges this environment does not grant; simulating it would not reproduce a cold cache |
| `bundler_ready_ms` on the CLI path | `unsupported` | driving Vite per cell measures Vite; the Vite adapter is covered by the pilot step of `verify-pms.sh` |
| `cancel_and_retry` | `not_run` | needs a driver that can abort a build mid-publication; the CLI exposes no such seam and the bundler adapter's abort path is not reachable from a scenario |
| `crash_during_publication` | `not_run` | a crash is a correctness property, not a latency; the transactional guarantee is covered by the existing compiler tests |
| 24 of the 27 matrix cells | `not_run` | compute budget; the 100 / 1,000 / 10,000 component diagonal was executed instead, and the unexecuted cells are reported as `not_run`, not estimated |
| Oxc / SWC / Salsa / Rust | **not implemented** | out of scope for Spike 1 by construction; adding a native frontend would make it impossible to attribute a change to removed work rather than to a port |

## Repository hygiene

| requirement | state |
| --- | --- |
| `main` untouched | yes — the branch was created from `d5702374` and no commit was made to `main` |
| no merge | yes |
| no PR opened | yes |
| no package published | yes |
| branch | `perf/pandamstyle-spike-1-2026-09` |
| base | `d5702374ac5a685499d14a53bf323d8533e6982d` (tree `836a24ec91239e148547a9c686041a6f65fe0099`) |
| `evidence/consolidation-2026-09/` and `evidence/native/` preserved | yes — new evidence went to `evidence/performance/spike-1/`; `verify-pms.sh` re-ran and wrote its own run directory, which is its documented behaviour |
| benchmark scratch excluded from lint and format | yes — `.pms-bench/` added to `.eslintrc.js` and `.prettierignore`, with the reason recorded in each file |

## Disk

The campaign, the two worktrees and the upstream install were run on a volume
that reached 100% occupancy at the start of the batch; `npm`'s and Go's
regenerable caches were cleared to make room. No repository content, work
directory, or evidence was deleted. Raw observation data is **not committed**
(§17 of the report): it is digested, hashed, and left in place.
