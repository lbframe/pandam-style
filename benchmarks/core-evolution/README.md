# Core-evolution baselines and budgets (CE-00.3)

This directory freezes the unchanged PandamStyle Alpha 1 artifact as the
`alpha1` epoch, and the non-regression budgets that every core-evolution change
must meet. Freezing happens before any product behavior changes. The tooling is
in [`tools/baselines`](../../tools/baselines/README.md). Nothing here changes
product behavior or is part of the product test suites.

## Epochs

An epoch is one exact set of package archives plus the host closure that runs
them.

- `alpha1` is the baseline epoch: the published `0.1.0-alpha.1` tarballs, built
  from commit `415e05539fcb5d36a78226112b5cf488b200b1aa`. It never changes.
  Nothing in it may be rebuilt from a later commit.
- `alpha1-replay` is the same artifact, reinstalled offline from the committed
  lockfile and the archived npm cache. Measuring it next to `alpha1` gives the
  null noise of the method.
- An evolved epoch is named after its candidate, for example
  `ce-<lot>-<short sha>`. It gets its own closure, made from tarballs packed at
  that commit with the same host pins, and its own manifest. A comparison always
  names both epochs. Results from different epochs are never pooled.

## Pinned artifacts

[`epochs/alpha1/manifest.v1.json`](epochs/alpha1/manifest.v1.json) is the
digest-bound identity of the baseline. It records:

| Artifact           | Identity                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source             | Commit `415e055`, its tree, and a `git archive \| gzip -n` source archive. The release tag `v0.1.0-alpha.1` (`d5cdac1`) and `f3e8803` have identical package sources, types, manifests and lockfile; they differ in documentation and metadata only                                                                                                                                                                                               |
| Packages           | The five registry tarballs: SHA-256, SHA-512 integrity and SHA-1 shasum, each checked against the registry. There are also two independent `npm pack` builds from a clean checkout of `415e055`. Both builds are byte-reproducible. Four are byte-identical to the registry. `@pandamstyle/compiler` differs in one documentation file only (`docs/architecture/phase-4-engine-absorption-map.md`, edited after the tag); its `lib/` is identical |
| Lockfiles          | `yarn.lock` at `415e055` (workspace build), and the closure [`package.json`](epochs/alpha1/closure/package.json) and [`package-lock.json`](epochs/alpha1/closure/package-lock.json). The lockfile pins the registry integrity of every Alpha 1 tarball                                                                                                                                                                                            |
| Hosts              | Vite 8.3.1 (with `@vitejs/plugin-react` 6.1.1 and Rolldown 1.2.14), Next.js 16.3.8, Rsbuild 2.2.11 with Rspack 2.2.8, React 19.3.0, TypeScript 5.9.3 and `playwright-core` 1.60.0, all in one closure. The manifest also records an installed-tree digest                                                                                                                                                                                         |
| Node               | The official `linux-x64` archives of 22.22.0 (the measurement runtime), 22.12.0 and 24.21.0, each checked against nodejs.org `SHASUMS256.txt`                                                                                                                                                                                                                                                                                                     |
| Engines            | Playwright Chromium 148.0.7778.96 (revision 1223), full browser and headless shell, as tree digests. This is the engine of the CE-00.2 reference check                                                                                                                                                                                                                                                                                            |
| Fonts              | The fontconfig 2.15.0 resolution of every fixture font family (`system-ui`, `sans-serif`, `Georgia`, `serif`, `ui-monospace`, `monospace`), with the resolved DejaVu files archived and digested, and a digest of the full `fc-list`                                                                                                                                                                                                              |
| Assets and corpora | Per-file Git digests of the repository assets, the CE-00.2 proof corpus at `20ce741`, and the Alpha 1 compiler fixtures and Vite pilot at `415e055`                                                                                                                                                                                                                                                                                               |

Some system browsers float and are not pinned: `/usr/local/bin/chromium` and
`/opt/google/chrome/chrome`, which the Alpha 1 qualification scripts launch
unless `PMS_CHROMIUM` is set. The manifest records their observed versions as
unpinned. A reproduction sets `PMS_CHROMIUM` to the archived engine.

### Store and reconstruction

Large binaries are never committed. The store lives outside Git, by default in
`~/.local/share/pandamstyle-baselines/alpha1/`:

```text
source/            git archive of 415e055
packages/registry/ published tarballs
packages/source-pack[-repeat]/  two clean-checkout packs
closure/           executable closure (node_modules installed from the lockfile)
npm-cache/         npm cache able to reinstall the closure offline
node/              Node archives and SHASUMS; extracted 22.22.0
engines/ms-playwright/  Chromium 148 and its headless shell
fonts/             resolved font files
```

Reconstruct and verify it from any checkout that contains this directory:

```sh
node tools/baselines/archive.mjs build --store <empty dir>  # registry, nodejs.org, Playwright CDN
node tools/baselines/archive.mjs verify --store <dir> --replay
node tools/baselines/archive.mjs closure --store <dir> --dest <dir>  # offline closure copy
```

`verify` recomputes every digest of the manifest. `--replay` then re-creates the
source archive and reinstalls the closure offline with `npm ci --offline`. The
reinstalled tree must be byte-identical to the recorded one, apart from npm's
hidden `.package-lock.json`.

## Executable baseline and agentic-optimizations reuse

The closure is the executable Alpha 1 baseline. It holds the published packages
with the exact qualified hosts, installed through their public entry points.
AG-00.3 (#7) runs its multi-model baseline against the same store:

1. Run `node tools/baselines/archive.mjs verify --replay`.
2. Use `<store>/closure/node_modules`, or an offline copy from
   `archive.mjs closure`, with `<store>/node/node-v22.22.0-linux-x64/bin/node`.
3. Label the results with epoch `alpha1`, and cite the manifest path and
   SHA-256.

CE measurements cover compiler cost, output size and runtime selection. They do
not complete the AG multi-model agent-efficiency baseline. They claim nothing
about agent task success.

## Measurement methodology

[`workloads.v1.json`](workloads.v1.json) freezes the inputs. Each workload has a
content digest, and the tooling refuses to materialize a project with any other
digest.

| Workload                           | Source                                                                                                                                                                                                                                                                                                                                                   | Measured                                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `alpha1-valid-fixture`             | The Alpha 1 compiler's valid fixture: 9 modules, conformance design system, read from Git at `415e055`                                                                                                                                                                                                                                                   | full and incremental compile, memory, outputs, runtime selection, incremental and canonical consistency |
| `alpha1-pilot-vite`                | The Alpha 1 Vite React pilot at `415e055`                                                                                                                                                                                                                                                                                                                | Production `vite build` through the epoch's `@pandamstyle/vite`: time, memory, CSS and JS bytes         |
| `ce-corpus`                        | All 562 CE-00.2 corpus declarations that the Alpha 1 policy classifies as expressible, derived by [`derive-ce-corpus.mjs`](../../tools/baselines/derive-ce-corpus.mjs) into [`workloads/ce-corpus.v1.json`](workloads/ce-corpus.v1.json). The Alpha 1 compiler accepts all 562; contexts are flattened, so this is a cost workload, not a fidelity claim | as for the fixture                                                                                      |
| `synthetic-c1000-t200-r20-s307`    | Seeded generator v1: 1,000 components, 200 tokens, 20 recipes, two themes, five conditions, patterns, static and dynamic recipe selection                                                                                                                                                                                                                | as for the fixture                                                                                      |
| `synthetic-c10000-t1000-r100-s307` | The same generator at the scale of the Alpha 1 reference label. It is not byte-identical to the unpublished historical corpus, so the [Alpha 1 reference dataset](../alpha1-reference.json) is not comparable                                                                                                                                            | full and incremental compile, memory, outputs, consistency                                              |

Each sample runs in a fresh Node 22.22.0 process
([`sample.mjs`](../../tools/baselines/sample.mjs)), on a fresh copy of the
project, against the epoch's installed packages, through public entry points
only. Nothing instruments the measured packages.

- **Full compile:** `createProjectSession`, `initialize`, `validate` and
  `compile` in a cold process. Recorded: total time and time to diagnostics,
  compiler import time, CPU time and peak RSS.
- **Incremental compile:** warm `applyChanges` transactions
  (`verified-explicit`) for a local style edit, a token value, a theme value and
  a recipe branch. Each is toggled forward and back, so the project ends in its
  original state. Timings run from the transaction to diagnostics and to
  publication. Iteration 0 is a warm-up and is excluded. Watcher and filesystem
  notification latency is excluded.
- **Outputs:** CSS bytes, plus gzip and brotli sizes. Emitted style rules,
  at-rules, declarations and class names. The compiler's own pre-deduplication
  rule count. Design-system module, declaration and compiled-module bytes.
  Recipe axis values and the finite recipe selection domain (product of axis
  sizes), plus compound variants.
- **Runtime selection:** the compiled modules run once while recording shims
  capture every `props()` call and recipe selection. The recorded calls are then
  replayed against the real runtime, giving ns per call (plus render ns per
  component call).
- **Consistency:** after each forward edit, every generated projection (CSS,
  design-system module, `.d.ts`, manifest, artifact metadata, compiled modules)
  must equal a fresh full compile of the same state, run in a separate session
  on a copy of the project.

[`measure.mjs`](../../tools/baselines/measure.mjs) interleaves epochs within
each round and alternates their order between rounds. It shuffles the order of
workloads per round with seed 307.

- **Shared host:** the measurement host is shared with work outside both epics
  and is never quiet, so absolute times are not comparable across runs. Every
  run therefore includes the unchanged `alpha1` control, interleaved with the
  candidate, and timing budgets use the paired ratio of each round.
- **Load records:** each sample records the load averages before and after it
  and the whole-machine CPU utilisation during it. Each batch records a load
  snapshot (CPU share, foreign busy and heavy-tool cores, no process names)
  before and after, and the batch maxima.
- **Optional quiet rule:** with `--require-quiet`, a batch starts only if
  whole-machine CPU use stays at or below 10% over 5 s and no foreign heavy tool
  process uses half a core or more; after a bounded wait it writes
  `READY-TO-MEASURE.json` and measures nothing. The frozen baseline was measured
  without it.

**Statistics.** Per (epoch, workload, metric), the summary gives the median and
nearest-rank p95 over independent samples, each with a distribution-free 95%
order-statistic interval. `null` means the bound is undefined at that n. An
incremental edit contributes one value per sample: the median of its warm
iterations. All warm iterations are also pooled for the tail. Epoch comparisons
pair the two adjacent samples of each round and report the median of the
per-round ratios, with a seeded 2,000-round percentile bootstrap over pairs.
Deterministic outputs must be identical across samples; they are never averaged.

## Results

`results/<label>/raw.json` holds every sample. It also records the environment
(CPU, cores, memory, governor, kernel, OS, filesystem, Node binary digest), the
harness file digests, the epoch identities and the load records.
`results/<label>/summary.json` is derived from it. The frozen baseline uses two
`final` batches, `alpha1-final-1` and `alpha1-final-2`, each measuring `alpha1`
and `alpha1-replay`.

## Budgets

[`budget-policy.v1.json`](budget-policy.v1.json) is the versioned threshold
rule. It lists the budgeted metrics, the metrics that stay `unknown` and the
change policy. [`budgets.v1.json`](budgets.v1.json) is generated from the policy
and the baseline runs by `budgets.mjs freeze`, never by hand. Rerunning the same
freeze command must reproduce it byte for byte.

- **Timing and runtime (paired ratios):** for each round, the candidate sample
  is divided by the adjacent `alpha1` sample. A budget passes when the upper
  bound of the bootstrap interval of the median ratio is within the limit, fails
  when the median ratio exceeds it, and is otherwise `inconclusive`.
  - Limit: the larger of a floor and the largest null upper bound
    (`alpha1-replay` against `alpha1`) in each baseline batch and pooled,
    rounded up to 0.05. Floors are 10% for time, 15% for runtime selection and
    10% for memory measured as a ratio.
  - Noise ceiling: if the `alpha1` control's interquartile range over median
    exceeds max(0.10, 2 × the noisiest baseline batch), the budget is
    `inconclusive`. So are runs without adjacent `alpha1` pairs or with fewer
    than 5 pairs.
  - Absolute times are kept as informational evidence only.
- **Memory:** peak RSS proved stable under the shared load (pilot CV 0.2–4.4%).
  A cell whose baseline CV is at most 5% gets an absolute limit on the candidate
  median, baseline median × max(1.10, 1 + 3 CV), rounded up to 0.05. Any other
  cell is a paired ratio.
- **Deterministic outputs:** absolute limits on the frozen `alpha1` values.
  - 5% for CSS bytes, rule and declaration counts and host bundle bytes.
  - 10% for generated modules.
  - 0 for the finite recipe selection domain.
- **Consistency:** incremental output must still equal canonical output.
- **Unknown:** metrics with no baseline stay `unknown` with an owning lot. They
  are listed by every gate report and never count as passing.
- **Gate verdicts:**
  - `pass`: every budget passes;
  - `fail`: any failing budget, workload mismatch, changed `alpha1` tarball, or
    policy-chain problem;
  - `inconclusive`: no interleaved `alpha1` control, too few pairs, a noise
    ceiling exceeded, or an interval straddling a limit;
  - `incomplete`: a budgeted metric was not run.
  - Only `pass` passes.

```sh
node tools/baselines/measure.mjs --plan final --label <label> \
  --epoch alpha1=<store>/closure --epoch <candidate>=<candidate closure> \
  --node <store>/node/node-v22.22.0-linux-x64/bin/node
node tools/baselines/budgets.mjs gate --budgets benchmarks/core-evolution/budgets.v1.json \
  --results benchmarks/core-evolution/results/<label>/raw.json --candidate <candidate>
```

**No retrospective weakening.**

- Committed policy, budget, workload, derivation, manifest, closure and result
  files are frozen. The gate compares the budgets file with the version of the
  commit that added it and fails on any difference.
- A new budgets version needs:
  - a `budget-policy.vN.json` with a justification;
  - the exact predecessor, by path and SHA-256;
  - a new comparable baseline run, because reused result files are rejected;
  - a justified relaxation entry for every loosened or removed budget.
