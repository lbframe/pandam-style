# Baseline and budget tooling

CE-00.3 tooling for the frozen Alpha 1 baseline epoch and the core-evolution
non-regression budgets. The records, methodology and policy are described in
[`benchmarks/core-evolution`](../../benchmarks/core-evolution/README.md). This
tooling changes no product behavior and is not part of the product test suites.
It uses Node built-ins only. `derive-ce-corpus.mjs` also imports the CE-00.2
classifier, which needs the repository install.

| File                   | Purpose                                                                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib.mjs`              | Digests, tree digests, statistics (median, nearest-rank p95, order-statistic intervals, bootstrap ratio), environment and machine-load records, the quiet rule          |
| `archive.mjs`          | `build`, `manifest`, `verify [--replay]` and `closure --dest` for the digest-bound Alpha 1 store                                                                        |
| `workloads.mjs`        | Materializes frozen workloads from Git objects, the derived corpus record or the seeded generator, and refuses any other digest; `digest` and `materialize` subcommands |
| `derive-ce-corpus.mjs` | Derives `workloads/ce-corpus.v1.json` from the CE-00.2 accounting and the Alpha 1 policy at pinned commits, excluding what the Alpha 1 compiler rejects                 |
| `sample.mjs`           | One fresh-process sample: `compile`, `consistency`, `runtime` or `vite`                                                                                                 |
| `measure.mjs`          | Interleaved, load-recording batches with a quiet-machine gate; writes `raw.json` and `summary.json`                                                                     |
| `summarize.mjs`        | Metric definitions and summaries; pools runs and compares epochs                                                                                                        |
| `budgets.mjs`          | `freeze` (policy + baseline runs → budgets) and `gate` (candidate against `alpha1`, same run) with policy-chain checks                                                  |

## Commands

```sh
# Store: reconstruct, verify, and get an offline closure copy.
node tools/baselines/archive.mjs build --store <empty dir>
node tools/baselines/archive.mjs verify --replay
node tools/baselines/archive.mjs closure --dest <dir>

# Workloads: check the frozen digests.
node tools/baselines/workloads.mjs digest

# Measure (final plan, quiet machine required).
node tools/baselines/measure.mjs --plan final --require-quiet --label <label> \
  --epoch alpha1=<store>/closure --epoch <name>=<closure> \
  --node <store>/node/node-v22.22.0-linux-x64/bin/node

# Budgets: freeze (only for a new policy version), then gate a candidate.
node tools/baselines/budgets.mjs freeze --policy <budget-policy.vN.json> \
  --results <raw.json> --results <raw.json> --out <budgets.vN.json>
node tools/baselines/budgets.mjs gate --budgets <budgets.vN.json> \
  --results <raw.json> --candidate <name>
```

`measure.mjs` exits with status 3 and writes `READY-TO-MEASURE.json` when the
machine stays busy past `--quiet-wait-minutes` (default 40). In that case
nothing is measured.

A candidate closure holds the candidate's packed tarballs and the same host pins
as `benchmarks/core-evolution/epochs/alpha1/closure/package.json`, installed
with `npm install --ignore-scripts`. Measure it in the same run as `alpha1`. The
gate rejects results without both epochs.

Rerunning `budgets.mjs freeze` with the committed policy and the committed
baseline results must reproduce `budgets.v1.json` byte for byte. `gate` fails
when the budgets file differs from the version of the commit that added it, or
when a later version breaks the policy chain (see the
[benchmark README](../../benchmarks/core-evolution/README.md#budgets)).
