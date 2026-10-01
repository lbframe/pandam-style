# Phase 6 + Phase 7 reconciliation delivery

## Repository and source identity

- Branch: `integration/pandamstyle-phase-6-7-reconciliation-2026-10`.
- Dedicated worktree: `/home/kyle/work/pandam-style-phase-6-7-reconciliation-2026-10`.
- Structural base, Phase 7 head: `7641b51b14881c7eb84f1772b879cc041868c2e0`.
- Phase 7 source tree: `f56047a49f82ea142014908606a24e08d459c341`.
- Phase 6 source head: `345ff45aed5ad83a3b363633ea60a7c0bc82e283`.
- Phase 6 source tree: `4d867730333122d65e39039c102c275add36776a`.
- Common Phase 5 base: `dd93bd4da211333bacf4c470554e5daab009e84e`;
  tree `306f083735fca2be5aa84fc03ef5164dd139d8cf`.
- Protected local and remote `main`: `71fcc045b18eb215f0c3a815bb8c8d15a9f99489`.

Implementation commits:

| Commit | Purpose |
| --- | --- |
| `038399b7c7a1810acde9846150a810a534980c40` | Integrate Phase 6 canonical snapshot, runtime/types/manifest/CSS/set projections and retained qualification into the Phase 7 base |
| `c4c6b07a7124370b4d9de04bafc8101a7a497c7d` | Reconcile canonical candidate/repair boundaries, complete-set publication authentication, cold reuse, staging failures, isolation, concurrency and performance support |

**Tested commit:** `c4c6b07a7124370b4d9de04bafc8101a7a497c7d`.
**Tested tree:** `a1ec19d6f9d13fb37496c2f8b2df036342937bd9`.
The official verifier captured a clean source checkout before writing evidence.
All final tests and performance samples use that implementation. No source,
test, verifier or semantic expectation changes follow the tested commit.

The evidence-only final commit is the commit containing this delivery document;
its tree is that commit's tree. Its exact final commit/tree and remote head are
reported in the external completion record: embedding a commit's own hash in
its contents would change that hash. The final diff is limited to
`evidence/phase-6-7-reconciliation/**` and this delivery document. Completion
requires the authorized branch push, matching local/remote heads and a clean
worktree, all checked after the closure commit.

## Protected worktrees

| Checkout | HEAD before and after | Result |
| --- | --- | --- |
| Phase 6 | `345ff45aed5ad83a3b363633ea60a7c0bc82e283` | Unchanged, clean |
| Phase 7 | `7641b51b14881c7eb84f1772b879cc041868c2e0` | Unchanged, clean |
| Initial checkout `/home/kyle/work/pandam-style` | `dd93bd4da211333bacf4c470554e5daab009e84e` | Unchanged, clean |

The initial checkout is on the Phase 5 cleanup branch; it is not checked out on
`main`. Both `main` references and actual remote main remain at the mandated
`71fcc045…` commit. See
[worktree isolation evidence](../../evidence/phase-6-7-reconciliation/worktree-isolation-report.json).
Both historical Phase 6 and Phase 7 delivery documents are preserved unchanged.

## Authorities and overlaps

The two source integration contracts are complementary; no contradiction was
found. There are exactly two authorities with separate responsibilities:

- `packages/compiler/src/design-system/registry/snapshot.js` creates the deeply
  frozen `pandamstyle-canonical-design-system`. Its identity fields are
  `systemId`, `registryDigest`, `abiVersion`, `compilerContractVersion` and
  `manifestSchemaVersion`. It alone owns normalized vocabulary, capabilities,
  semantic relations, catalogs, compiled refs and generated projections.
- `packages/compiler/src/api/project.js` remains the sole production Project
  Service lifecycle/publication authority: serialized queue, revision and
  validation sequencing, tickets, leases, watcher journal, generation
  origin/association, recovery and close. The private incremental owner
  consumes snapshot projections; it does not reconstruct catalogs.

Candidate vocabulary comes from `candidateDomainOf(snapshot, query)` with
public visibility, declaration ordering, category filtering, pagination and
exact revision checks. There is no separate candidate registry or token map.
Structured token/recipe/condition/theme repair vocabulary comes from
`repairDomainOf(snapshot, query)` through a private diagnostics callback.
There is no separate repair registry. Diagnostics Protocol v1 retains its
frozen bounded-prefix lexical presentation; canonical domains retain their
Phase 6 ordering. Public SDK and authored expectations are unchanged.

Six overlaps were manually reviewed, with **zero unresolved**:

1. `packages/compiler/__tests__/pandamstyle/transactional-generation-test.js`
2. `packages/compiler/src/artifacts/publication/transaction.js`
3. `packages/compiler/src/observability/metrics.js`
4. `packages/compiler/src/project/session/fresh.js`
5. `packages/compiler/src/project/session/index.js`
6. `tests/support/compiler-inspection.js`

[The reconciliation boundary](phase-6-7-reconciliation.md) documents each
phase's intent, combined resolution and proving tests. No wholesale ours/theirs
resolution was used. Fresh execution remains independent and test-only.
Watcher remains an input journal through the same service queue. `/host`
projects only artifact read, prepare, commit and abort.

The public root exports remain `createProjectSession`, `PmsError`, `Codes`,
`formatDiagnostic`, `COMPILER_ABI_VERSION`, `DIAGNOSTICS_RESULT_KIND` and
`DIAGNOSTICS_RESULT_SCHEMA_VERSION`; `/config` exposes `defineConfig`, `token`,
and `/host` exposes `createHostBridge`. The canonical snapshot and private
session/graph state are not public exports. Exact built runtime exports are in
[SDK surface evidence](../../evidence/phase-6-7-reconciliation/sdk-surface-report.json).

## Canonical publication and identities

The coherent set is `design.js`, adjacent `design.d.ts`, `manifest.json`,
`styles.css`, and `artifacts.json` (the facade filename remains configurable).
All payloads derive from one canonical snapshot. Metadata authenticates the
common design identity, filenames, four payload SHA-256 values and byte lengths
through `artifactSetDigest`. Metadata cannot recursively hash itself.

The existing Phase 7 publisher stages all five, accounts declarations as
`types`, then validates the actual staged canonical bytes before durable commit
intent. It also checks metadata still matches the prepared file record.
There is one publisher and one recovery mechanism. Foreign JS, declarations,
manifest, CSS and altered set digest are all rejected at service level before
installation. Failed staging after declarations, manifest or metadata leaves
the prior tree and generation current; consumed tickets remain single-use.
Canonical durable-intent recovery passes.

| Identity | Meaning |
| --- | --- |
| Snapshot identity | DS vocabulary and ABI/compiler/schema contract |
| `artifactSetDigest` | Content identity of the canonical projections, including emitted CSS |
| `RevisionId` | Accepted project/session/local sequence transition |
| Ticket candidate digest | Full canonical metadata plus page digests, revision and coverage/audit inputs |
| `artifactDigest` / `GenerationId` | Complete committed project bytes / durable project publication lineage |
| `artifactRevision` | Full revision that originally committed those bytes |
| `associationRevision` | Current revision associated with new or reused generation |

Runtime refs, canonical snapshot identity and consumer members contain no
lifecycle identities. Lifecycle receipt fields remain service-owned.

Cold reopen with identical complete bytes preserves GenerationId and artifact
origin, then associates the new session revision. Changed token value,
declaration vocabulary order, recipe domain, theme or condition cannot reuse a
changed canonical set. The declaration-order adversary keeps registryDigest and
page JS identical while declarations and artifactSetDigest change.

One accepted DS mutation advances one revision, rebuilds once with one expected
global fallback, revokes stale tickets, rejects stale reads and publishes once
after validation. An invalid revision cannot publish. Returned artifact views
remain immutable historical values, and stale revisions cannot read newer ones.

Actual observations and published-byte validation are in
[artifact coherence](../../evidence/phase-6-7-reconciliation/artifact-coherence-report.json),
[cold reopen](../../evidence/phase-6-7-reconciliation/cold-reopen-artifact-set-reuse-report.json),
and [publication/recovery](../../evidence/phase-6-7-reconciliation/publication-recovery-report.json).

## Types, privacy, isolation and concurrency

The adjacent declarations preserve public/category token unions, property and
condition constraints, recipe axis/value unions, theme names and ABI 1.
Retained JS/type vocabulary parity assertions pass. The new positive TypeScript
fixture passes in **663.079 ms**; the negative fixture rejects all eleven
intended invalid lines 2–12 in **738.760 ms**. Qualification declarations are
**9,488 bytes**; corpus declaration size is reported separately below.

Private token paths, recipe identifiers and private recipe axis/value names are
absent from all five consumer members and candidate/repair domains. The public
alias to a private target does not expose that target identifier. The measured
10k published set is scanned using private vocabulary from its actual canonical
snapshot; private recipes are exercised by the reconciliation fixture, because
the 10k corpus has none. See
[type qualification](../../evidence/phase-6-7-reconciliation/generated-typescript-report.json)
and [privacy scan](../../evidence/phase-6-7-reconciliation/private-vocabulary-leak-scan.json).

Same systemId with distinct registry digests/vocabularies passes isolation for
snapshots, candidate and repair domains, declarations, artifact reads and
publication tickets. Closing one project leaves the other usable. Existing
Phase 7 isolation/resource tests also run in the combined tree.

All eight required concurrency pairs pass with serialized success, deterministic
stale/closed rejection or ticket revocation: compile/mutation, validate/mutation,
prepare/mutation, candidates/mutation, candidates/close, watcher flush/explicit
mutation, DS mutation/prepared publication and DS mutation/candidates. No mixed
canonical publication occurs. See
[project isolation](../../evidence/phase-6-7-reconciliation/project-isolation-report.json)
and [concurrency](../../evidence/phase-6-7-reconciliation/concurrency-report.json).

## Official qualification

The official `verify-pms.sh` run uses `PMS_BATCH_BASE_REF=7641b51…` and new
output under `evidence/phase-6-7-reconciliation/verify`. All nine steps execute
in order: install, build, pandamstyle, pandamstyle-core, semantic-oracle,
tooling-tests, pilot, artifacts, donor-closure.

- `requiredStepCount=9`, `complete=true`, `verdict=verified`.
- `failedSteps=[]`, `skippedSteps=[]`, `omittedRequiredSteps=[]`.
- **788 passing tests in 51 passing suites**, zero failed or skipped.
- Compiler: 545 tests/25 suites; core: 14/1; oracle: 148/20; tooling: 81/5.
- Semantic oracle: **129 total, 125 MUST_PRESERVE, 0 KNOWN_GAP, 4 DEFERRED,
  0 failed, 0 unknown**. Deferred slots, compound variants, patterns and advanced
  themes remain deferred; expectations were not rewritten.
- All six browser/SSR cases pass fresh/expected, incremental/expected and
  fresh/incremental checks: conflict, media-cascade, shorthand-longhand,
  ssr-hydration, theme-scope and token-values.
- The new reconciliation suite supplies 21 passing recorded observations;
  retained Phase 6 projection/types/mutation and Phase 7 service tests also pass.

See [official summary](../../evidence/phase-6-7-reconciliation/verify/summary.json),
[semantic report](../../evidence/phase-6-7-reconciliation/semantic-oracle-report.json)
and [browser/SSR report](../../evidence/phase-6-7-reconciliation/browser-ssr-report.json).

## Combined 10k performance

Corpus `c10000-t1000-r100-s307-f8`: 10,000 components, 1,000 requested tokens,
100 recipes, seed 307, fanout 8; content hash
`f1d6c857aa6ef311b8deeadf16ff740090f78eaac3ab2d0fa7481e89d46f78be`.
The deterministic definition has 132 public and 30 private tokens, 100 recipes,
eight conditions and two themes. Each local case has three independent child
processes with a warm measured mutation. **18 cells, 1,119 rows, zero failed
cells or error rows**. The harness also records 135 explicit unsupported
placeholders for publication/audit metrics in variants that do not request
those operations; all seven required measured cases have three real samples.

| Local operation | Combined p50 ms | Historical Phase 7 p50 ms | Delta ms | Change |
| --- | ---: | ---: | ---: | ---: |
| Style edit | 63.256 | 59.100 | +4.156 | +7.03% |
| Import edit | 20.793 | 21.574 | -0.780 | -3.62% |
| Re-export edit | 119.472 | 111.121 | +8.351 | +7.52% |
| Unresolved import repair | 65.820 | 63.031 | +2.789 | +4.43% |
| No change | 58.997 | 58.959 | +0.038 | +0.06% |
| Publication ready | 543.813 | 507.407 | +36.407 | +7.18% |
| Publication committed | 677.693 | 629.549 | +48.144 | +7.65% |

All **40** required local work-shape counters match Phase 7, including file
recompile/reuse, closure and DSV examination/reuse and covered-entry iteration.
There are **zero unexpected full fallbacks** and no lost reuse. Publication
now produces declarations and artifact metadata, authenticates the complete
canonical candidate, and validates five staged members; this is an explicit
additional cost. Observed latency increases are reported without an SLA claim.

Historical Phase 7 used corpus hash
`91ad54984875a9226624413db899415bad8ff7427810099f234350e927c964da`;
the generated bridge marker changed, while parameters and dependency topology
are unchanged. These latency deltas are contextual observations, not a causal
comparison on identical bytes. No confidence interval is computed.

The separate public service profile measures one local style transaction and
one global DS mutation. The global mutation advances revision 2 to 3 with
**one design-system rebuild, one global fallback and one committed generation**.
Actual published metadata validates against saved payload bytes and the
corresponding canonical snapshot identity.

| Global measurement | Result |
| --- | ---: |
| Snapshot build | 5.522 ms |
| Declaration generation | 2.279 ms |
| Artifact-set generation, summed measured phases | 1.238 ms |
| Public applyChanges | 50.652 ms |
| Public validate, including global project recompile | 24,052.723 ms |
| Public preparePublication | 210.673 ms |
| Public commitPrepared | 669.214 ms |
| Internal publication total | 397.092 ms |
| JS bytes | 424,563 |
| Declaration bytes | 186,436 |
| Manifest bytes | 62,631 |
| CSS bytes | 27,281 |
| Artifact metadata bytes | 984 |
| Total five-member canonical bytes | 701,895 |

The declaration size matches Phase 6's reference. Total bytes are two above
the historical 701,893: CSS is two bytes larger after this sample's preceding
local style edit; JS, declarations, manifest and metadata sizes match. This is
not an identical mutated-input comparison. The global sample has no wrapper
confidence interval and is separate from the local incremental-engine cells.
Queue wait/run and per-phase publication timings are recorded per operation;
snapshot/type/set costs are measured, not hard-coded acceptance thresholds.

See [combined performance](../../evidence/phase-6-7-reconciliation/combined-performance-report.json)
and [public service measurements](../../evidence/phase-6-7-reconciliation/performance/service-performance.json).

## Donor/package closure

Official donor closure passes with zero production donor-engine edges and no
findings. All thirteen forbidden paths are absent: `packages/@stylexjs`,
`packages/style-value-parser`, `upstream/stylex`, `upstream/panda`, `legacy`,
`archive`, `vendor`, `old-stylex`, `stylex-reference`, `panda-reference`,
`reference-copy`, `vendor-history`, `donor-backup`.

Both public packages remain donor-free for dependencies/imports. The core
packed-consumer proof has no runtime dependencies, donor imports, Node builtin
imports or workspace leakage, and its runtime/ABI checks pass. The compiler
export/import/packed closure is retained in the actual official report. See
[donor/package evidence](../../evidence/phase-6-7-reconciliation/donor-package-closure-report.json).

## Closure and scope

Combined architecture, semantic, types/privacy, isolation/concurrency,
publication/recovery/reuse, performance and donor gates pass. The external
completion record binds the evidence-only final commit/tree and confirms branch
push, local/remote equality, final clean status and unchanged protected heads.
Tested-to-final changes contain evidence and this delivery record only.

- Phase 6: **CLOSED**.
- Phase 7: **CLOSED**.
- Phase 6 + 7 reconciliation: **CLOSED** after the recorded Git delivery checks.
- Phase 8: **AUTHORIZED**, not started in this batch.
- Phase 9: **AUTHORIZED**, not started in this batch.

The canonical immutable Design System snapshot is the sole authority for
vocabulary and generated projections. The revision-based Project Service is
the sole authority for project lifecycle and publication. The complete
JS/CSS/types/manifest/artifact set is revision-safe and transactionally coherent,
with semantic and isolation guarantees verified. The combined architecture is
ready for host and release qualification; Phase 8 and Phase 9 may proceed in
partial parallel.

No PR was created, no merge to main occurred, and no packages were published.
No Vite/Next host package, release implementation, native backend or deferred
capability was started. The evidence-only closure and authorized branch push
complete this integration batch.
