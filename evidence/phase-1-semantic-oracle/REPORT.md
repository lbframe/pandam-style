# Phase 1 semantic oracle qualification

Full qualification **verified** the frozen implementation commit. All nine
required steps executed; complete is true, failedSteps and skippedSteps are
empty. No production compiler/runtime code or accepted Phase 0 contract changed.

| Identity                                                  | Value                                            |
| --------------------------------------------------------- | ------------------------------------------------ |
| Branch                                                    | test/pandamstyle-phase-1-semantic-oracle-2026-09 |
| Base commit                                               | acc35bd082d852dda3d332e1e7c6130df57402ee         |
| Base tree                                                 | f7ad97d7d4d672e544bc05c0498298d1d549d099         |
| Tested implementation commit                              | 1612c4ee6119ffb55158d1909db7edaf075cf4b3         |
| Tested tree                                               | 09cfb57097b1aa04e3a18baf6a72b815491209c4         |
| Main, unchanged                                           | 71fcc045b18eb215f0c3a815bb8c8d15a9f99489         |
| Master plan and all requested Phase 0 contracts/ADRs read | YES                                              |
| Oracle schema                                             | 1                                                |
| Source matched tested tree during oracle execution        | true                                             |

The evidence-only closure commit is the commit first adding this report and
`docs/architecture/phase-1-delivery.md`; its tree is that commit's tree. Exact
resolved closure/remote hashes are returned after commit and push. A commit
cannot embed its own hash without changing it. Resolve the immutable creation
identity with:

```sh
git log --diff-filter=A --format='%H%n%T' -- docs/architecture/phase-1-delivery.md
```

## What was tested

Canonical assets are in `tests/semantic/`, with repository-only tooling in
`tools/semantic-oracle/`. Pure case/expectation modules do not import a compiler
or read result evidence. The test-only implementation adapter reaches today's
compiler through its package/project APIs and confines graph/CSS/failure probes
to that boundary. Fresh one-shot builds run independently of persistent
incremental sessions. Actual transformed modules and generated selectors are
evaluated; Chromium computes actual CSS and hydrates an actual compiled App.

There are **129 cases: 108 MUST_PRESERVE, 17 KNOWN_GAP, 4 DEFERRED**. Failed
qualification cases: **0**. Unknown/unclassified cases: **0**. The 148 Jest
tests comprise those 129 case/classification tests plus 19 harness integrity
tests, across 20 suites. Green gap registration is not target success.

| Comparison, MUST_PRESERVE only   | Applicable cases | Passed/equal | Failed/unequal | Applicable revisions | Passed/equal revisions |
| -------------------------------- | ---------------: | -----------: | -------------: | -------------------: | ---------------------: |
| Fresh vs authored expected       |              105 |          105 |              0 |                  135 |                    135 |
| Incremental vs authored expected |              108 |          108 |              0 |                  142 |                    142 |
| Fresh vs incremental             |              105 |          105 |              0 |                  135 |                    135 |

Fresh applicability excludes three lifecycle-only cases: staged publication
failure, superseded uncommitted publication, and incremental diagnostic
truncation. Known-gap target results remain separately false/null where
appropriate in the machine report, including the four registered sequences whose
fresh and incremental projections differ. They are not added to the
MUST_PRESERVE pass totals. Deferred concepts execute no absent product feature.

## Case matrix

| Area                |   Total | MUST_PRESERVE | KNOWN_GAP | DEFERRED | Coverage                                                                                                                                                             |
| ------------------- | ------: | ------------: | --------: | -------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tokens              |      12 |            11 |         1 |        0 | Public/semantic/alias, visibility, unknown/category/raw policy, binding alias, local spoof, forged object, rename/removal/repair                                     |
| Themes              |       8 |             8 |         0 |        0 | Base/alternate, overrides, logical identity, semantic token under multiple themes, ordered composition, unknown, mutation                                            |
| Conditions          |       8 |             8 |         0 |        0 | Pseudo/media, base/default, multiple, authored cascade order, unknown, mutation                                                                                      |
| Create              |      11 |            11 |         0 |        0 | Static namespace and multiple keys, constrained values, nested conditions, raw/unsupported/inline channel rejection, computed/spread, shadowing/dynamic forms        |
| Props               |      14 |            11 |         3 |        0 | Single/multiple/ordered/conflicts, recipe/theme refs, nested arrays, invalid/forged input, omissions/empty, runtime malformed input, compiled null cancellation      |
| Recipes             |      15 |            14 |         1 |        0 | Base/defaults, finite one/multiple axes, override/boolean/null/numeric coercion, invalid domains, deterministic selection, result and branch CSS, private visibility |
| Forwarding          |      14 |            13 |         1 |        0 | Direct/renamed/namespace imports, local alias, named/renamed/multi-hop/star/mixed/partial/default forwarding, remove/restore, source remap, ambiguous stars          |
| Provenance          |       3 |             2 |         1 |        0 | Same-spelling ordinary source, incomplete/reassigned authority, counterfeit generated metadata                                                                       |
| Module resolution   |       3 |             1 |         2 |        0 | Existing dependency, deletion/restoration, rename and import repair                                                                                                  |
| Negative resolution |       2 |             1 |         1 |        0 | Missing dependency then created; relay added/removed/restored; real negative dependency count and repair                                                             |
| Coverage            |       6 |             6 |         0 |        0 | Declared roots, local closure, covered forbidden channel without helper import, enter/leave, design-system relay dependency, rename/delete                           |
| Revisions           |       3 |             3 |         0 |        0 | No-change reuse counters, one-file edit with stable-file reuse, multiple-file transaction                                                                            |
| Multi-revision      |       2 |             2 |         0 |        0 | Valid→invalid→repaired with exact previous publication preservation; A→B→A; other required sequences also in resolution/forwarding/CSS cases                         |
| Incremental CSS     |       6 |             6 |         0 |        0 | Declaration replacement, shared ownership 2→1→0, shared rule introduced, conditioned replacement, design token CSS mutation, no-op bytes/owners                      |
| Publication         |       5 |             4 |         1 |        0 | Valid/invalid-first and repair, staged failure rollback, superseded unpublished result, distinct generation receipt association                                      |
| Diagnostics         |       5 |             1 |         4 |        0 | Full target Protocol v1 fields, category/private repair, default truncation 32/37, smaller requested bound                                                           |
| Syntax/incomplete   |       2 |             0 |         2 |        0 | Affected-file error, incomplete edit and valid repair; useful coordinates remain a registered gap                                                                    |
| Deferred            |       4 |             0 |         0 |        4 | Slots, compounds, patterns, advanced theme axes/runtime generation                                                                                                   |
| Browser             |       6 |             6 |         0 |        0 | Token spacing/color, dark scope, composition conflict, shorthand/longhand, media cascade, SSR/hydration                                                              |
| **Total**           | **129** |       **108** |    **17** |    **4** | All required semantic areas represented                                                                                                                              |

Binding origin and forwarding chains are explicit. Ambiguity fails closed in the
MUST_PRESERVE truth model; spelling alone does not confer authority. Negative
resolution changes and coverage are dependencies, not helper-import heuristics.
CSS ownership observes the actual session state through its existing test-only
probe. Invalid and failed staged publication preserve every previously committed
file digest and current generation. Revision and generation are checked
independently. No crash-durability claim is introduced.

## Known gaps

Each gap has authored target assertions, authored current evidence, permitted
mismatch paths, controlling contracts and resolution ownership in the
[gap register](../../docs/architecture/semantic-gap-register.md). Migration must
preserve current defect behavior: **NO** for every entry; target frozen:
**YES**. All 17 KNOWN_GAP cases are bounded existing mismatches, not semantic
passes.

| ID    | Current deficiency                                                                                         | Controlling contract                                  | Expected resolution |
| ----- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------- |
| SG-01 | Static rejection of null/false omissions and empty props                                                   | Public API composition; generated ABI                 | Phase 3             |
| SG-02 | Immutable local intrinsic alias loses authority                                                            | Public API bindings; ADR 0004                         | Phase 3             |
| SG-03 | Token rename-invalid-repair retains stale design-system CSS                                                | Public API revisions/tokens; ADR 0006                 | Phase 3             |
| SG-04 | Deleted positive dependency/relay edges retain wrong coverage and miss negative accounting                 | ADR 0006; public API coverage; diagnostics            | Phase 3             |
| SG-05 | Historical agent-result shape lacks target identity/completeness and diagnostic wire fields                | Diagnostics Protocol v1; public API revision identity | Phase 3             |
| SG-06 | Wrong-category machine repair omits expected category                                                      | Diagnostics Protocol v1                               | Phase 3             |
| SG-07 | Private-token repair lacks structured target/category and suggests forbidden privilege in prose            | Diagnostics Protocol v1; public API private boundary  | Phase 3             |
| SG-08 | Syntax/incomplete errors lose available coordinates                                                        | Diagnostics Protocol v1                               | Phase 3             |
| SG-09 | Generation receipt omits distinct artifact-origin and association identities; no-op reuse remains optional | Public API lifecycle/identity; ADR 0006               | Phase 3             |
| SG-10 | Private recipe appears in consumer manifest/selector vocabulary                                            | Public API explicit recipe visibility gap             | Phase 3             |
| SG-11 | Copied generated marker with forged digest receives intrinsic authority                                    | Generated ABI; ADR 0004; artifact mismatch diagnostic | Phase 3             |
| SG-12 | Runtime accepts malformed raw ref instead of structured rejection                                          | Public API composition; generated ABI                 | Phase 2             |
| SG-13 | Smaller requested candidate bound ignored                                                                  | Diagnostics Protocol v1                               | Phase 3             |

Deferred IDs: `deferred.slots`, `deferred.compounds`, `deferred.patterns` (ADR
0003, Phase 12 after Phase 11), and `deferred.advanced-themes` (accepted public
API theme deferral). No slot/compound/pattern implementation was added.

## Full official verifier

Executed on the normal checkout/filesystem, with Node v22.22.0, Yarn 1.22.22,
npm 11.11.1 and Chromium 153.0.8010.47. No capacity workaround was necessary.
The install really executed, including normal postinstall workspace builds; the
pilot really executed. Existing install/build warnings did not fail their
commands or modify tracked source. The run began with a clean working tree.

```sh
env -u PMS_SKIP_INSTALL -u PMS_SKIP_PILOT -u PMS_ONLY_STEPS \
  PMS_BATCH_BASE_REF=docs/pandamstyle-phase-0-contract-freeze-2026-09 \
  PMS_OUT_DIR=/home/kyle/work/pandam-style/evidence/phase-1-semantic-oracle/verify \
  ./verify-pms.sh
```

| Required order        | Kind           | Passed tests | Passed suites | Failed tests/suites | Skipped tests/suites | Verdict  |
| --------------------- | -------------- | -----------: | ------------: | ------------------- | -------------------- | -------- |
| install               | command        |            — |             — | —                   | —                    | verified |
| build                 | command        |            — |             — | —                   | —                    | verified |
| upstream-babel-plugin | test           |         1007 |            42 | 0/0                 | 64/1                 | verified |
| upstream-stylex       | test           |           99 |             4 | 0/0                 | 0/0                  | verified |
| pandamstyle           | test           |          498 |            21 | 0/0                 | 0/0                  | verified |
| semantic-oracle       | test           |          148 |            20 | 0/0                 | 0/0                  | verified |
| tooling-tests         | test           |           69 |             5 | 0/0                 | 0/0                  | verified |
| pilot                 | pilot          |            — |             — | —                   | —                    | verified |
| artifacts             | artifact-check |            — |             — | —                   | —                    | verified |

Global: **1821 passed, 0 failed, 64 skipped tests; 92 passed, 0 failed, 1
skipped suite**. Accounted population: **1885 tests / 93 suites**. The inherited
upstream Babel skip population is unchanged; zero required verifier steps were
skipped. `complete: true`, `verdict: verified`, `failedSteps: []`,
`skippedSteps: []`, stepsVerified: 9.

The required oracle step is declared kind `test` in the official contract table.
Verifier tests cover omitted/skipped/unclassified/countless oracle steps. The
oracle additionally checks its explicit tracked population, physical/Jest
discovery, executed identities and every test status/count. Harness tests cover
unaccounted tests/suites, failed loads, missing assets, zero populations,
unknown statuses, wrong shared results, and output destinations that could
overwrite expectations. No snapshot update or automatic expectation blessing
exists.

## Evidence and limits

- [Machine semantic report](verify/semantic-oracle/semantic-oracle.json) and
  [Jest execution inventory](verify/semantic-oracle/semantic-jest-results.json).
- [Global summary](verify/summary.json), [environment](verify/env.json),
  [step table](verify/steps.tsv), per-step logs and artifact digests.
- Per-case evidence is in `verify/semantic-oracle/cases/`; expectations remain
  in the tested code commit. Generated artifact/pilot payloads follow existing
  repository ignore policy and are reproducible from that commit.

These fixtures qualify the required migration matrix, not every possible
application or future product feature. Historical implementation suites remain
mandatory. Three lifecycle-only MUST_PRESERVE cases have no fresh lane. Full
target protocol, runtime format checks and other registered defects remain
unimplemented. Future ABI import changes may replace the adapter without
rewriting semantic truth; exact fresh/incremental artifact byte checks apply
within one implementation revision. Expectation edits require an explicit
architecture/product decision, contract/ADR reference, reason, declared intended
semantic change and reviewable diff. Known gaps cannot silently become passes.

Closure contains only evidence and delivery documentation beyond the tested
commit. No PR, merge or package publication is part of this delivery. Phase 2
and Phase 3 authorization becomes effective after the evidence-only closure is
pushed and remote equality, clean working tree and unchanged main are confirmed.
