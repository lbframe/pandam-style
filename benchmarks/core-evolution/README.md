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
unpinned. A reproduction sets `PMS_CHROMIUM` to the archived engine and
`PMS_BROWSER_PIN` to its pin; see
[Browser evidence on the archived engine](#browser-evidence-on-the-archived-engine).

### Store and reconstruction

Large binaries are never committed. The store lives outside Git, by default in
`~/.local/share/pandamstyle-baselines/alpha1/`:

```text
source/            git archive of 415e055
packages/registry/ published tarballs
packages/source-pack[-repeat]/  two clean-checkout packs
closure/           executable closure (node_modules installed from the lockfile)
npm-cache/         npm cache able to reinstall the closure offline (bound by npm-cache.v1.json)
node/              Node archives and SHASUMS; extracted 22.22.0
engines/ms-playwright/  Chromium 148 and its headless shell
fonts/             resolved font files
```

Reconstruct and verify it from any checkout that contains this directory:

```sh
node tools/baselines/archive.mjs build --store <empty dir>  # registry, nodejs.org, Playwright CDN
node tools/baselines/archive.mjs verify --store <dir> --replay --rebuilt  # a rebuilt store
node tools/baselines/archive.mjs verify --store <copy of the archived store> --replay
node tools/baselines/archive.mjs closure --store <dir> --dest <dir>  # offline closure copy
node tools/baselines/archive.mjs verify --committed  # no store: what Git proves
```

`verify` recomputes every digest of the manifest. `--replay` then re-creates the
source archive and reinstalls the closure offline with `npm ci --offline`. The
reinstalled tree must be byte-identical to the recorded one, apart from npm's
hidden `.package-lock.json`. `verify --committed` needs no store: it runs only
the checks that Git objects and committed files can prove. Those are the source
tree, the release tag commit, product equivalence, the lockfiles, the packages'
closure lockfile entries, and the assets and corpora file by file.

The store and `manifest.v1.json` are immutable. Run `verify --replay` and any
digest recomputation on a copy of the store, because an offline `npm ci` writes
npm logs and index entries into the cache it uses.

Every tree digest is non-vacuous. Tree selections are file-level, so a filter
never prunes the directories above a file it includes. `verify` and `build` fail
when a tree covers no files, or fewer than its recorded count.
`node tools/baselines/tree-digest-regression.mjs [--store <copy>]` is the
regression test for this class.

**Erratum: the npm cache binding.**

- In `manifest.v1.json`, `closure.npmCache.tree` is vacuous: `e3b0c442…`, 0
  files. It was recorded with a filter that pruned `_cacache` itself, so it
  binds nothing, and earlier `verify` runs compared two empty digests.
- The manifest stays unchanged because `budgets.v1.json` binds its digest.
- The binding is
  [`epochs/alpha1/npm-cache.v1.json`](epochs/alpha1/npm-cache.v1.json), in two
  parts:
  - **`lockedTarballs` (reproducible):** all 102 lockfile packages installed in
    the closure, each cached with bytes matching its lockfile integrity, with
    digest `5af5774a…`. It is checked on every store. A store rebuilt by
    `archive.mjs build` reproduces it exactly.
  - **`contentTree` (archived identity):** the content-addressed entries of the
    archived store's cache (`_cacache/content-v2`): 314 files, 460,115,581
    bytes, SHA-256 `4fa28496…`. The original `npm install` also cached 212
    registry-metadata entries, which a rebuilt store does not reproduce.
    `verify --rebuilt` reports that difference as a note; a plain `verify`
    requires the archived inventory.
- **A rebuilt cache is not a fixed inventory.**
  - A rebuild must contain the **102 required installed-package tarballs**
    (135,164,055 bytes). It may contain additional optional entries.
  - The exact rebuilt inventory depends on npm behavior. In the PR #103
    review, a fresh build with the archived Node 22.22.0 and npm 10.9.4 cached
    106 files: the 102 tarballs and 4 uninstalled WASM dependencies of the
    Rspack binding. All 106 match their lockfile integrity values.
  - `verify --rebuilt` proves the 102 tarballs only. It is never evidence of
    full archived-store identity.
- `verify` reports the manifest field as a note, never as a check.
- The offline replay was sound throughout: npm checks every tarball against the
  lockfile integrity, and the reinstalled tree digest was compared with the
  manifest.

### Browser evidence on the archived engine

[`epochs/alpha1/browser.v1.json`](epochs/alpha1/browser.v1.json) pins the
identity that the archived Chromium engine reports: `Google Chrome for Testing
148.0.7778.96`. The manifest binds the engine bytes; this record is a separate
versioned file, and the manifest is unchanged. A tooling test checks that the
pin names the manifest's `chromium` engine and its `browserVersion`.

Run a qualification harness against the archived engine from the repository
root:

```sh
PMS_CHROMIUM=<store>/engines/ms-playwright/chromium-1223/chrome-linux64/chrome \
PMS_BROWSER_PIN=benchmarks/core-evolution/epochs/alpha1/browser.v1.json \
  node tools/semantic-oracle/run.js .pms-bench/<dir>
```

The same variables apply to `tools/pms/qualify-next.mjs` and
`tools/pilot/run-rsbuild-qualification.js`. Each harness records `browser`
(executable, product, version, `expected` and `pin`) in its report. It stops
before any case or build if the binary reports another identity.

**First runs (#94), 2026-10-21, at `03f1bfd` plus this change [executed].**

- **Engine bytes.** Before the runs, the engine trees were recomputed read-only
  with `fileTreeDigest` and `ENGINE_FILES` from `tools/baselines/archive.mjs`.
  Both match the manifest: `chromium` `f003730a…` (303 files) and
  `chromium-headless-shell` `d8c653b0…` (287 files).
- **Identity.** All three harnesses recorded `Google Chrome for Testing
  148.0.7778.96` with `matchesExpected: true` against the alpha1 pin.
- **Semantic oracle.** 148 of 154 tests passed. The 6 `browser.*` cases failed,
  and `failedCount` is 6. Each of those cases aborts with `FATAL
  zygote_host_impl_linux.cc:128 No usable sandbox!`.
- **Rsbuild qualification.** The run stops at its first browser launch
  (`chromiumSandbox: true`) with the same abort.
- **Next qualification.** It launches with `--no-sandbox`, so it runs on the
  archived engine. The production lanes passed. The Turbopack semantic-dev
  matrix failed in two runs, each time with "unobserved condition" browser
  timeouts on different rows: 2 of 80, then 10 of 80. A control run with the
  workstation's Google Chrome 145.0.7632.116 passed that matrix 80 of 80. It
  then failed the readiness assertion of the performance report
  (`nextReadyObservedAt`). Other jobs loaded the workstation during these
  runs, with a load average from 7 to 20 on 16 threads. These runs do not show
  whether the matrix failures come from the engine or from the load.
  **[unresolved]**

**Cause of the sandbox abort.** The cause is the same as F2 in the
[CI repair record](../../docs/research/core-evolution-ci-repair.md). Ubuntu
24.04 sets `kernel.apparmor_restrict_unprivileged_userns = 1`. Only binaries
with an AppArmor profile that grants `userns` can create the browser sandbox.
Google Chrome has such a profile for `/opt/google/chrome/chrome`; the store
path has none. The store is read-only, so its `chrome_sandbox` SUID helper is
not installed.

**Remaining work.** It is not done in this repository, because it needs host
access or a change in launch policy:

- Grant `userns` to the store's engine path with a host AppArmor profile, of
  the same form as Chrome's. This keeps the harness launch flags and the
  sandbox unchanged.
- Rerun the Next qualification on an otherwise idle host, to settle the
  Turbopack matrix result.

## Executable baseline and agentic-optimizations reuse

The `alpha1` closure is the CE measurement closure. It holds the published
packages with the exact hosts these measurements use, such as React 19.3.0 as in
the Alpha 1 package qualification. It is not an installation for AG tasks or
other consumers, whose fixtures pin their own hosts (the AG fixtures pin React
19.2.0, among others) and need their own per-fixture closures.

The reusable parts of the store are:

- the Alpha 1 product tarballs (`packages/registry/`);
- the Node runtimes (`node/`);
- the Chromium engine (`engines/`).

All three are digest-bound by the manifest. AG-00.3 (#7) reuses them:

1. Run `node tools/baselines/archive.mjs verify --replay` on a copy of the
   store.
2. Install the archived product tarballs into its own closures, and run with
   `<store>/node/node-v22.22.0-linux-x64/bin/node` and the archived Chromium.
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

`results/<label>/raw.json` holds every sample. It also records:

- the environment: CPU, cores, memory, governor, kernel, OS, filesystem and Node
  binary digest;
- the harness file digests and the epoch identities;
- the per-sample and per-batch load records.

`results/<label>/summary.json` is derived from it. Paths under the home
directory are written as `~`. Process names and command lines are never
recorded.

| Run                      | Epochs                        | Samples       | Load                                                                                 |
| ------------------------ | ----------------------------- | ------------- | ------------------------------------------------------------------------------------ |
| `alpha1-final-1`         | `alpha1`, `alpha1-replay`     | 232, 0 failed | max 1-minute load average 12.26; mean whole-machine CPU per sample 18.7% (max 52.5%) |
| `alpha1-final-2`         | `alpha1`, `alpha1-replay`     | 232, 0 failed | max 1-minute load average 5.63; mean CPU per sample 11.5% (max 38.7%)                |
| `gate-injected-slowdown` | `alpha1`, `injected-slowdown` | 190, 0 failed | max 1-minute load average 2.88; mean CPU per sample 10.0% (max 17.1%)                |
| `alpha1-v2-sk-b2`        | `alpha1`, `alpha1-replay`     | 232, 0 failed | max 1-minute load average 10.19; mean CPU per sample 15.8% (max 93.4%)               |
| `alpha1-v2-sk-b3`        | `alpha1`, `alpha1-replay`     | 232, 0 failed | max 1-minute load average 1.81; mean CPU per sample 9.2% (max 25.4%)                 |
| `alpha1-v3-sk-c1`        | `alpha1`, `alpha1-replay`     | 232, 0 failed | max 1-minute load average 1.78; mean CPU per sample 9.1% (max 14.3%)                 |
| `alpha1-v3-sk-c4`        | `alpha1`, `alpha1-replay`     | 232, 0 failed | max 1-minute load average 1.61; mean CPU per sample 9.1% (max 13.5%)                 |

- The two `alpha1-final` runs are the version 1 baseline.
  [`gate-null-alpha1-replay.json`](results/gate-null-alpha1-replay.json) is the
  gate on both runs with the identical artifact as candidate, under version 1:
  `pass`, 110 of 110 budgets.
- The two `alpha1-v2-sk` runs are the version 2 baseline, measured on the
  dedicated measurement host (see below).
  [`gate-null-alpha1-replay-v2.json`](results/gate-null-alpha1-replay-v2.json)
  is the gate on both runs with the identical artifact as candidate, under
  version 2: `pass`, 110 of 110 budgets, no reconciliation error.
- The two `alpha1-v3-sk` runs are the version 3 baseline, measured on the same
  host.
  [`gate-null-alpha1-replay-v3.json`](results/gate-null-alpha1-replay-v3.json)
  is the gate on both runs with the identical artifact as candidate, under
  version 3: `pass`, 110 of 110 budgets, no reconciliation error.
- `gate-injected-slowdown` checks the gate itself. Its candidate, built by
  [`make-candidate.mjs`](results/gate-injected-slowdown/make-candidate.mjs), is
  `alpha1` with every compiler session call slowed by 30%. The fixture, CE-00.2
  corpus and c1000 workloads ran interleaved with the `alpha1` control.
  [`gate.json`](results/gate-injected-slowdown/gate.json) is `fail`: 28 timing
  budgets fail with median paired ratios of 1.13–1.31, against the version 1
  limits of 1.10.

### Version 2 baseline provenance

The version 2 baseline was measured on a dedicated measurement host (AMD Ryzen 7
9800X3D, 16 logical cores, Ubuntu 24.04.5, kernel 7.0.0-31), from a
digest-identical copy of the Alpha 1 store, at harness commit `159f95c`. The
host also runs the repository's self-hosted CI jobs, and other interactive
sessions of the same account. Every attempt below used the final plan with the
`alpha1` and `alpha1-replay` epochs. A private process sampler logged, every 15
s, each process using half a core or more, with its control group; only the
counts below are published.

Admissibility rules, each fixed before the data it judges existed:

- **Registered (2026-10-20), series A attempts 1–4:** 232 of 232 samples, 0
  failed; every cell's null comparison (`alpha1-replay` against `alpha1`) within
  the noise ceiling of the budgets in force (version 1); and no foreign heavy
  load (half a core or more) other than CI jobs.
- **Amended (2026-10-20), from attempt 5, prospective only:** the foreign-load
  clause was dropped. The host runs other interactive agent sessions, so the
  clause could not be met reliably, and it was stricter than the policy, whose
  protection against load is the paired control and the noise ceiling. Foreign
  load is recorded, not disqualifying. Attempts 1–4 stay judged under the
  registered rule.
- **Series B (pre-registered 2026-10-21, 12:15 UTC):** an attempt starts only
  when no CI job worker runs and the 1-minute load average is below 1.0, checked
  every 60 s; a started attempt always runs to the end; admissibility is the
  amended rule; at most 4 attempts; the freeze uses the first two admissible
  attempts in order.

In the table, "worst noise" is the largest control spread against its version 1
noise ceiling, and the windows are the sampler's 15-second windows with a
foreign process at half a core or more.

| Attempt              | Rule       | Verdict                                                                            | Worst noise / ceiling | Max 1-min load | CI windows | Other windows |
| -------------------- | ---------- | ---------------------------------------------------------------------------------- | --------------------- | -------------- | ---------- | ------------- |
| A1 `alpha1-v2-sk-1`  | registered | not admissible: a non-CI process at 1.19 cores in one window                       | 0.083 / 0.10          | 4.97           | 15 of 116  | 1             |
| A2 `alpha1-v2-sk-2`  | registered | not admissible: 16 cells over the noise ceiling                                    | 0.253 / 0.10          | 8.60           | 64 of 116  | 3             |
| A3 `alpha1-v2-sk-3`  | registered | not admissible: a non-CI process at 1.32 cores in one window                       | 0.071 / 0.10          | 8.33           | 35 of 119  | 1             |
| A4 `alpha1-v2-sk-4`  | registered | not admissible: 4 cells over the noise ceiling, and a non-CI process in one window | 0.190 / 0.10          | 6.45           | 37 of 118  | 3             |
| A5 `alpha1-v2-sk-5`  | amended    | not admissible: 5 cells over the noise ceiling                                     | 0.222 / 0.10          | 12.29          | 56 of 121  | 3             |
| A6 `alpha1-v2-sk-6`  | amended    | not admissible: 2 cells over the noise ceiling                                     | 0.144 / 0.10          | 13.43          | 34 of 119  | 1             |
| A7 `alpha1-v2-sk-7`  | amended    | not admissible: 1 cell over the noise ceiling                                      | 0.226 / 0.10          | 9.35           | 27 of 117  | 3             |
| A8 `alpha1-v2-sk-8`  | amended    | stopped at sample 5 of 232: two admissible attempts were no longer reachable       | —                     | —              | —          | —             |
| B1 `alpha1-v2-sk-b1` | amended    | not admissible: 2 cells over the noise ceiling                                     | 0.206 / 0.10          | 10.84          | 50 of 120  | 5             |
| B2 `alpha1-v2-sk-b2` | amended    | **admissible**                                                                     | 0.063 / 0.10          | 10.19          | 22 of 116  | 0             |
| B3 `alpha1-v2-sk-b3` | amended    | **admissible**                                                                     | 0.080 / 0.10          | 1.81           | 0 of 115   | 1             |

- Series A (attempts 1–8) closed without two admissible attempts. The cell that
  most often exceeded its ceiling was synthetic-c1000
  `incremental.local-style.toDiagnosticsMs` (0.14–0.23 under CI load, 0.02 and
  0.07 in attempts 1 and 3).
- Series B stopped after B3: B2 and B3 are the first two admissible attempts,
  and `budgets.v2.json` is frozen from them. B4 was never started.
- B3's one other window is an interactive agent session process (`claude`) at
  1.00 core. Under the amended rule it is recorded, not disqualifying.
- Host condition: at 13:28 UTC on 2026-10-21, before B3 started, the shared
  organisation CI label was removed from the measurement host's runners, so
  other repositories' CI jobs no longer run there. No rule changed.
- Excluded, never pooled: `alpha1-v2-final-1` and a partial second run (49 of
  232 samples), measured on the version 1 host before the measurement moved.
  They ran on a different host from the version 2 baseline, and the first was
  contaminated by concurrent activity of this work.
- Only B2 and B3 are committed. Every attempt's result file, logs and verdict
  are kept outside the repository with the measurement work.

### Version 3 baseline provenance

Version 3 re-derives every budget from a new baseline (the change policy rejects
reused result files), measured on the same host and store copy at commit
`7cb9fe9`, with the same harness files as version 2.

- **Series C (pre-registered 2026-10-21, 19:01 UTC):** the series B start
  condition (no CI job worker and a 1-minute load average below 1.0, checked
  every 60 s and logged), no abort once started, and the same private process
  sampler. An attempt is admissible with 232 of 232 samples, 0 failed, every
  cell's null comparison within the version 2 noise ceiling, and no foreign
  process at half a core or more in any sampler window. Stop at two admissible
  attempts, at most 4. High-mode rounds of the c10000 peak-RSS cells (above 1.6
  GB) are kept as evidence, never excluded.

| Attempt              | Verdict                                                                                    | Worst noise / v2 ceiling | Max 1-min load | Foreign windows | c10000 high-mode rounds (`alpha1`, `alpha1-replay`) |
| -------------------- | ------------------------------------------------------------------------------------------ | ------------------------ | -------------- | --------------- | --------------------------------------------------- |
| C1 `alpha1-v3-sk-c1` | **admissible**                                                                             | 0.066 / 0.20             | 1.78           | 0 of 115        | 0 of 5, 1 of 5 (both cells)                         |
| C2 `alpha1-v3-sk-c2` | not admissible: 2 windows with a foreign process (1.18 cores, and a login-message process) | 0.079 / 0.15             | 1.81           | 2 of 115        | 1 of 5, 0 of 5 (both cells)                         |
| C3 `alpha1-v3-sk-c3` | not admissible: 1 window with a foreign process at 0.50 core                               | 0.046 / 0.15             | 1.83           | 1 of 115        | 0 of 5, 0 of 5                                      |
| C4 `alpha1-v3-sk-c4` | **admissible**                                                                             | 0.035 / 0.10             | 1.61           | 0 of 115        | 0 of 5, 0 of 5                                      |

- C1 and C4 are the first two admissible attempts; `budgets.v3.json` is frozen
  from them.
- The foreign processes in C2 and C3 were interactive agent sessions (`claude`)
  of the host's account. C2's login-message process (`landscape-sysinfo`) was
  most likely started by this work's own status polling: every SSH session
  regenerates the login message. From C3 on, the polling used one SSH connection
  per 10 minutes.

## Budgets

[`budget-policy.v3.json`](budget-policy.v3.json) is the versioned threshold rule
in force. It lists the budgeted metrics, the metrics that stay `unknown`, the
change policy and, for every budget that loosened relative to version 2, a
relaxation with its justification. [`budgets.v3.json`](budgets.v3.json) is
generated from the policy and the version 3 baseline runs by
`budgets.mjs freeze`, never by hand. Rerunning the same freeze command must
reproduce it byte for byte.

Versions 1 and 2 ([`budget-policy.v1.json`](budget-policy.v1.json),
[`budgets.v1.json`](budgets.v1.json),
[`budget-policy.v2.json`](budget-policy.v2.json),
[`budgets.v2.json`](budgets.v2.json)) are superseded and stay committed,
unchanged: the gate verifies the chain from version 3 back to version 1.

- **Version 2 (CE-00.3, #42):** raises only the paired-ratio timing floor, from
  1.10 to 1.25, for the measured cost of the always-on browser-target feature
  checking of CE-01.1 (#44): under version 1 its candidate failed five paired
  timing budgets at median ratios of 1.118 to 1.166. The floor is cumulative
  against `alpha1` for the whole epic, so the remaining headroom is small and
  later lots must not assume more. CE-12.3 (#76) owns recovering the cost.

  - Every other rule is unchanged. The budgets are re-derived from the new
    baseline, so noise ceilings and absolute memory limits follow its
    measurements. The 55 relaxations are generated from the derivation with the
    gate's own predicate: 48 timing budgets at the new floor (some with
    re-derived noise ceilings), 5 absolute memory medians (+0.08% to +1.16%) and
    the 2 c10000 peak-RSS cells.
  - **Host binding:** the version 2 absolute limits, in particular the two
    c10000 peak-RSS cells, derive from the measurement host's `alpha1` medians
    and are bound to that host. A gate run measured on another host is outside
    the version 2 contract.

- **Version 3 (CE-00.3, #42, #76):** changes one rule. The two c10000 peak-RSS
  budgets are judged on the minimum over all samples instead of the median.

  - Why: peak RSS of these cells is bimodal on the measurement host as well.
    When a V8 mark-compact lands mid full compile (about 19 s in, about 520 MB
    live), the next heap limit is about four times that and the session peaks at
    2.1–2.2 GB; otherwise it stays near 1.2–1.4 GB. `alpha1` itself reaches the
    high mode in about a quarter of rounds, so it would fail its own version 2
    median limit about 10% of the time. Every version 2 baseline sample happened
    to be in the low mode, which gave a CV of 0.5% and an absolute median limit.
    This was diagnosed on the CE-01.1 candidate's gate run; the CE-01.1 verdict
    itself is not part of this change.
  - Why the minimum: garbage-collector headroom is one-sided additive noise on
    peak RSS, so the minimum estimates the working-set floor. High-mode rounds
    stay in the evidence and cannot fail the budget alone; a real growth of the
    floor still does (the regression matrix checks both).
  - Every other rule is unchanged. All budgets are re-derived from the series C
    baseline: 6 relaxations (the 2 statistic changes, and 4 absolute memory
    medians re-derived, +0.05% to +1.04%) and 16 tightenings (noise ceilings and
    absolute medians, from the quieter baseline). The host binding of version 2
    still applies.

- **Timing and runtime (paired ratios):** for each round, the candidate sample
  is divided by the adjacent `alpha1` sample. A budget passes when the upper
  bound of the bootstrap interval of the median ratio is within the limit, fails
  when the median ratio exceeds it, and is otherwise `inconclusive`.
  - Limit: the larger of a floor and the largest null upper bound
    (`alpha1-replay` against `alpha1`) in each baseline batch and pooled,
    rounded up to 0.05. Floors are 25% for time (10% in version 1), 15% for
    runtime selection and 10% for memory measured as a ratio.
  - Noise ceiling: if the `alpha1` control's interquartile range over median
    exceeds max(0.10, 2 × the noisiest baseline batch), the budget is
    `inconclusive`. So are runs without adjacent `alpha1` pairs or with fewer
    than 5 pairs.
  - Absolute times are kept as informational evidence only.
- **Memory:** peak RSS proved stable under the shared load (pilot CV 0.2–4.4%).
  A cell whose baseline CV is at most 5% gets an absolute limit on the candidate
  median, baseline median × max(1.10, 1 + 3 CV), rounded up to 0.05. Any other
  cell is a paired ratio.
  - Statistic: a policy may set a per-budget statistic
    (`thresholdRule.statistic`). The default is the median. `min` is allowed
    only for absolute peak-RSS budgets: limit = baseline minimum × max(1.10, 1 +
    3 CV of the minima of each baseline run and epoch), rounded up to 0.05, and
    the gate compares the candidate's minimum with it. An explicit `median`
    override derives and gates exactly like no override. The gate refuses `min`
    anywhere else, any unknown statistic, a duplicate override and an override
    that matches no budget, and treats a statistic change as a loosening that
    needs a relaxation.
  - c10000 peak RSS: on the version 1 host it is bimodal (about 1.05 GB or about
    2.3 GB, in both epochs of the identical artifact), so in version 1 its two
    cells fell back to paired ratios with limits of 2.15 and 2.30 and noise
    ceilings of 1.9 and 2.2, which detect only a gross regression. Version 2
    measured a CV of about 0.5% on the measurement host and gave both cells
    absolute median limits, stating that the bimodality was a property of the
    version 1 host. That statement was wrong: the measurement host is bimodal
    too, and the version 2 baseline only happened to sample the low mode.
    Version 3 judges both cells on the minimum.
- **Deterministic outputs:** absolute limits on the frozen `alpha1` values.
  - 5% for CSS bytes, rule and declaration counts and host bundle bytes.
  - 10% for generated modules.
  - 0 for the finite recipe selection domain.
- **Consistency:** incremental output must still equal canonical output.
- **Unknown:** metrics with no baseline stay `unknown` with an owning lot. They
  are listed by every gate report and never count as passing.
- **Gate verdicts:**
  - `pass`: every budget passes and every input is validated;
  - `fail`: a failing budget or failed candidate sample, an `alpha1` control or
    environment that is not the pinned one, a changed workloads record, or
    budgets and policy provenance that do not verify;
  - `inconclusive`: missing, failed, invalid, duplicated, unplanned or
    non-adjacent observations, too few pairs, a noise ceiling exceeded, an
    interval straddling a limit, an uncommitted or different harness or plan, an
    unidentified candidate, or the same run given twice;
  - `incomplete`: a budgeted workload was not run;
  - `not-release`: budgets that are not the committed version in force.
  - Only `pass` passes.

**Gate input validation.** A verdict is computed from run files, budgets,
policy, manifest and workloads records. Every input it depends on is validated,
and anything that cannot be validated fails closed.

- **Provenance:** in release mode, the budgets, policy, manifest, workloads
  record and harness come from Git at the evaluated revision (`--rev`, default
  `HEAD`). The gate uses the highest committed `budgets.vN.json` and verifies it
  back to version 1:

  - unchanged since first committed;
  - its `budget-policy.vN.json`, the manifest, the workloads record and every
    baseline evidence file are committed with matching digests;
  - it re-derives byte for byte from them;
  - it is a valid successor of its predecessor.

  A `--budgets` file that is not byte-identical to that committed version is
  evaluated in `not-release` mode.

- **Reconciliation:** before any statistic, every run is reconciled 1:1 against
  cells derived only from the committed plan of the baseline, the workloads
  record, the harness, the manifest and the frozen pins at the evaluated
  revision. Every object has exact keys (nothing missing or extra) and typed
  values.

  - Sample cells: exactly one sample per epoch, workload, kind and round for
    every planned kind of each measured workload, with adjacent pairs and
    contiguous indexes.
  - Nested cells: every incremental edit of the workload, in order, with every
    planned iteration, and every canonical comparison, whose `equal` flags must
    agree with the recorded digests.
  - Runtime values: `null` only when the matching call count is zero.
  - CPU times (`userCpuMs`, `systemCpuMs`) may be zero, since the kernel can
    account them in ticks; negative, non-finite and missing values are invalid.
    Durations, peak RSS, sizes and counts must be positive.
  - The run's `workloads` list must name exactly the measured workloads, with
    the committed content digests. It never selects what is inspected. A planned
    workload is either entirely absent from a run (its budgets are not run) or
    complete.

  Any reconciliation error makes the verdict non-passing.

- **Control and environment:** the run holds exactly the `alpha1` control and
  the candidate. The control's package integrities, installed `@pandamstyle`
  tree digest, closure lockfile digest and host versions must equal the
  manifest's. The Node version and binary digest must equal the frozen pins.
- **Candidate identity:** fully recorded and well formed: package integrities,
  tree digest and lockfile digest. It must be identical across all pooled runs,
  as must the control's.
- **Observations:** a failed candidate sample fails the budget. Any other
  missing, failed, invalid or non-adjacent observation makes it `inconclusive`.
  Each result reports its observation counts.

`node tools/baselines/gate-regression.mjs` runs the class-level regression
matrix of these rules. It runs on the committed runs, on temporary clones with
altered history, and through a seeded omission and perturbation fuzzer:

- **Mutations:** deletion, null/NaN/negative/string substitution and
  duplication.
- **Coverage:** every node outside the samples, and every normalized sample
  path, at least once per applicable mutation, plus a random sample.
- **Invariant:** a failing run never becomes `pass`. A passing run stays `pass`
  only for a verdict- and budget-invariant mutation of an informational field:
  the verdict and every budget result are identical, compared field by field.
  The gate does read some informational fields: `label` for duplicate-run
  detection, and `load.before`, which it copies into its report.

The trust boundary is unchanged: complete, well-formed values produced by the
harness are trusted.

```sh
node tools/baselines/measure.mjs --plan final --label <label> \
  --epoch alpha1=<store>/closure --epoch <candidate>=<candidate closure> \
  --node <store>/node/node-v22.22.0-linux-x64/bin/node
node tools/baselines/budgets.mjs gate --rev <evaluated revision> \
  --results benchmarks/core-evolution/results/<label>/raw.json --candidate <candidate>
```

**No retrospective weakening.**

- Committed policy, budget, workload, derivation, manifest, closure and result
  files are frozen. The release gate verifies the budgets in force at the
  evaluated revision, and their evidence and predecessors, from Git, and fails
  on any difference.
- A new budgets version needs:
  - a `budget-policy.vN.json` with a justification;
  - the exact predecessor, by path and SHA-256;
  - a new comparable baseline run, because reused result files are rejected;
  - a justified relaxation entry for every loosened or removed budget.

**Committed-record check.** `node tools/baselines/validate-records.mjs` runs in
the CI `static` job. It needs the full Git history, but no store and no network.
It reuses the existing commands:

| Check                  | What it proves                                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest`             | `archive.mjs verify --committed` passes                                                                                                               |
| `workloads`            | `workloads.mjs digest` reports every frozen workload as `frozen`                                                                                      |
| `ce-corpus derivation` | `workloads/ce-corpus.v1.json` equals the candidates of the pinned accounting and policy less its recorded exclusions, with matching inputs and totals |
| `budgets`              | every `budgets.vN.json` re-freezes byte for byte from its policy and baseline runs with the current derivation                                        |
| `frozen`               | every file here except this README that is published in the base is byte-identical at `HEAD` and in the working tree                                  |

- **Intended coupling.** The `budgets` check binds the current derivation to
  every committed policy version on purpose. A derivation change must keep each
  committed `budgets.vN.json` reproducible, as the version 3 change did.
- **Evidence is not recomputed.** Committed results, summaries and gate reports
  are evidence. The `frozen` rule protects their bytes, and they are not
  re-derived with today's scripts.
- **Base.** The base of the `frozen` rule is the merge base of `HEAD` and
  `origin/main`, or `HEAD`'s first parent when `HEAD` is already on
  `origin/main`. On a push to `main`, CI passes the tip before the push
  (`--base`), because a rebase merge can push several commits at once.
- **Unpublished files.** Files absent from the base are not constrained by
  `frozen`: they may change until they merge. Their other checks still apply.
  Removing or renaming a published file fails.

`--mutations` commits one edit per class to a temporary clone, with the same
base, and requires the clone's validator to fail that class. The classes are:

- a manifest digest and the source tree;
- a frozen workload, also with its digest re-bound;
- a synthetic workload seed;
- result samples, a summary and a gate report;
- a budget limit;
- a frozen file edited, left uncommitted or removed.

An unmutated clone must pass. The run then applies the `frozen` rule to
temporary repositories with real Git histories:

- direct branches;
- a pull-request merge ref and a merge commit;
- squash and rebase;
- a multi-commit push to `main`;
- detached `HEAD`;
- a file added then edited before its merge (accepted), or after it (rejected).

Two checks stay local-only, because they need the archived store:

- the store digests: `archive.mjs verify --store <copy> --replay`;
- the CE-00.2 corpus exclusions, which only the Alpha 1 compiler decides:
  `derive-ce-corpus.mjs --closure <store>/closure`, then `git diff`.

The measurements themselves cannot be re-observed.
