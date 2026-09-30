# Semantic migration oracle v1

Status: Phase 1 qualification infrastructure. Contract/case/report schema
version

1. Authoritative inputs are the canonical [master plan](../../master-plan.md),
   the accepted Phase 0 contracts and their ADRs. Historical compiler output is
   evidence about implementation, never a substitute for product truth.

## Authority and scope

The oracle lives at `tests/semantic/` with executable tooling at
`tools/semantic-oracle/`. Neither directory is a workspace package. It runs only
in development/CI qualification; no application, generated consumer code or
production package imports it. Production behavior and Phase 0 decisions are
unchanged by this batch.

For every applicable MUST_PRESERVE revision, fresh and incremental executions
each satisfy authored expectations. They also agree with each other. Agreement
alone does not imply correctness: harness integrity tests deliberately feed the
same incorrect acceptance result to both lanes and require failure.

## Durable case format

CommonJS case modules contain serializable data, constructed using pure source
and assertion helpers. They never import a compiler or load execution reports.
The logical schema below is stable across replacement implementations:

| Field                                   | Meaning                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| schemaVersion                           | Integer 1                                                                                                                                  |
| id / title / intent                     | Unique stable identity, human name, independently stated semantic intent                                                                   |
| area / status                           | Inventoried semantic area; exactly MUST_PRESERVE, KNOWN_GAP or DEFERRED                                                                    |
| files                                   | Project-relative POSIX filenames mapped to initial source text                                                                             |
| designSystem                            | Authored JSON; `{$token: "spacing.md"}` denotes a logical token reference, materialized only by the adapter                                |
| roots                                   | Declared coverage directories relative to the fixture project                                                                              |
| initialRevision                         | 1 for an executable sequence; null for deferred concepts                                                                                   |
| revisions                               | Ordered initial state and mutation transactions, each with a label and expected assertions                                                 |
| freshApplicable / incrementalApplicable | Explicit booleans; lifecycle-only cases use incremental execution                                                                          |
| contractReferences / notes              | Controlling repository contract/ADR paths and limitations                                                                                  |
| observe                                 | Semantic observations requested: runtime exports, coverage, forwarding, CSS ownership, browser results, runtime guard or diagnostic bounds |
| gapId / gapReason / targetMismatchPaths | Required bounded current deficiency for KNOWN_GAP                                                                                          |
| comparisonMismatchPaths                 | Explicit semantic differences allowed only for a registered gap                                                                            |

Every revision may `write`, `remove`, or `rename` relative files, or replace the
design-system input. All writes in a transaction happen before one accepted
revision. `publish: false` and `publicationFailure` model explicit staging and
failure injection inside the test adapter. They are not production features.

Each revision has a nonempty `expected` array, optionally `freshExpected` and
`incrementalExpected`. An assertion is `{path, op, value}`; slash-separated
paths select semantic fields. Default `equal` compares complete values. `fields`
matches selected object fields but preserves array length/order; `includes` and
`excludes` assert rule membership. `length`, `keys`, `requiredKeys`,
`nonEmptyString`, `sameAsPath` and `atLeast` express explicit shape/domain
facts. `sameAsRevision` references an earlier observation of the **same lane**,
only for authored temporal guarantees such as byte preservation. It never
derives product expected values from fresh compilation. Unknown operations fail.

Known gaps also require independently specified `observed`, `freshObserved` or
`incrementalObserved` assertions per revision and lane. These pin the evidence
of the current deficiency separately from the target. A mismatch outside the
registered boundary fails. If the implementation meets the whole target, the
registration fails and demands explicit review/promotion to MUST_PRESERVE.

Deferred cases have no sources, executable revisions or fabricated outputs.
Their classification is checked against the accepted deferral decision.

## Status and report interpretation

MUST_PRESERVE means accepted current product behavior: every applicable target
check and fresh/incremental equivalence must pass. KNOWN_GAP means a frozen
target is currently unsatisfied: it is never a passing semantic result. DEFERRED
retains an accepted product concept without executing an absent feature.
UNKNOWN, unclassified cases, missing expectations, and unevidenced gaps fail.

The tracked inventory explicitly lists suites and IDs, independently of runtime
file discovery. Git's tracked asset inventory, physical suite discovery, Jest
discovery, executed suite identities, individual test identities/statuses and
aggregate counts must reconcile. Missing tracked fixtures, missing suites,
failed loads, unaccounted tests/suites, skips, todo tests and zero populations
prevent qualification. Editing the inventory is a deliberate reviewed change.

The runner emits `semantic-oracle.json`, `semantic-jest-results.json`,
`semantic-inventory.json` and individual `cases/*.json`. It records tested
commit and tree; total, MUST_PRESERVE, KNOWN_GAP, DEFERRED, failed and unknown
counts; per-case applicability and per-revision observations/checks; contract
references; and separate MUST_PRESERVE case/revision comparison totals.
`failedCount` counts failed case qualification/classification, not known target
mismatches. `knownGapsAreSemanticPasses` is always false. Jest counts include
integrity and classification checks; do not interpret their green registration
tests as target conformance. Qualification also requires verified execution
inventory.

## Semantic projection and normalization

The projection retains acceptance, code/severity/phase/rule, structured context,
token category/visibility, source file and meaningful coordinates, role, repair,
candidates/totals/truncation/autofix, coverage and its origin, binding origin
and relay chain, resolution dependencies, ordered CSS predicates/selectors and
declarations, logical token/theme identity, actual composition winners, recipe
branches/domains/defaults, browser values, revision identity, publication and
generation association, artifact presence and relevant reuse/ownership.

Only the following incidental representation is normalized:

- The isolated project root prefix becomes a project-relative path. Filenames,
  extension, case and coverage origin are retained.
- Atomic class spellings become `&` associated with their **complete rule**.
  Theme classes become logical theme names. Selector combinators, pseudo
  predicates, specificity (`:not(...)` included), at-rule predicates and their
  order remain intact. Runtime class order remains an ordered array of rules.
- Generated CSS variable spellings become `token(logical.path)`. An unrecognized
  variable stays unrecognized; stale variables cannot become a known token.
- Equivalent CSS numeric spelling `.5` becomes `0.5`. Declaration order and all
  other values are retained, except a block containing only unique custom
  properties is sorted by logical variable identity. Those independent CSS
  variable definitions have no declaration-order cascade; duplicate-variable
  blocks and all ordinary property/condition/rule order remain untouched.
- Human diagnostic prose is removed only from semantic diagnostic equality.
  Protocol evidence retains prose, but assertions never parse it to authorize
  repair. Performance durations are removed from protocol observations;
  readiness and publication milestones remain.
- Internal design-system CSS owner allocation strings become `design-system`.
  User file ownership is retained; rule-owner arrays preserve each actual owner.

No code, source location, condition/cascade order, token/theme identity, role,
binding origin, coverage, revision association or publication state is erased.
The browser cases independently test actual CSS behavior so renaming class
identifiers cannot conceal a wrong cascade.

## Fresh and incremental execution

Each lane executes in a separate Node child and isolated filesystem. Incremental
execution uses one public `createProjectSession`, applies each filesystem
transaction, validates and publishes only valid revisions. Fresh execution
rebuilds the identical revision using public `buildProject`, independently of
the incremental session/cache. An isolated rollback-only compiler-session probe
captures the fresh virtual generated-module coverage/resolution answers before
the one-shot publisher removes its overlay.

The test-only adapter uses the current package's project APIs. Coverage order,
forwarding inspection, CSS ownership and staged failure injection are already
test-only facilities; they are isolated here because their graph/ownership/
failure facts matter to observable correctness but the public result cannot yet
provide all of them. No private compiler file is imported by cases or expected
values, and no new production compatibility layer is introduced.

The null-cancellation composition vector translates a compiler-produced ref's
conflict keys into a compiled tombstone ref inside the adapter. It invokes the
actual generated props function, with independently expected no surviving class.
This test-only representation access is necessary because a compiled tombstone
is a core composition input, not permission for a page to author raw objects.
Future adapters translate this same semantic vector to their owned ref format.

The adapter evaluates actual transformed modules and actual generated runtime
selectors; it does not simulate props or recipes. The browser transport uses
actual CSS, bundled transformed App code, React server rendering and Chromium
hydration. Chromium's sandbox stays enabled; its isolated home scratch directory
avoids Snap Chromium's private `/tmp` filesystem. Browser executable selection
is an environment prerequisite, not a semantic expectation.

## Semantic truth versus temporary artifact bytes

Authored expectations do not freeze donor module specifiers or hashed class
names. Phase 2 intentionally changes generated donor imports to PandamStyle
core; an adapter replacement can accommodate that accepted ABI/package move. It
may not change logical token/theme identity, source provenance authorization,
composition, cascade or publication truth.

Inside one tested implementation revision, fresh/incremental equivalence also
compares actual bytes of CSS, transformed modules, generated facade/types and
manifest. Only the manifest's temporary project-root prefix is relocated;
module/CSS bytes are otherwise exact. Coverage/build-report metadata has
different execution accounting between lanes and is compared semantically.
Invalid or failed incremental publication additionally preserves SHA-256 digests
of **every** previously committed file, including metadata. Publication state,
revision and generation are checked independently; fresh builds cannot assert
historical incremental lineage.

## Expectation authorship and change policy

Sources, mutations, intent and expected values were written from Phase 0 and
specific finite decisions before using implementation results to assess them.
Execution revealed deficiencies; their authored targets remain unchanged and
current mismatches are separately bounded in the gap register. No current output
was dumped into a semantic golden or accepted automatically. Exact current
fingerprints appear only in **observed gap evidence**, never as target truth.

**A migration implementation may change the implementation adapter, but it may
not silently change semantic expectations.** Any expectation change requires a
contract/ADR reference, reason, intentional semantic change declaration and
reviewable diff. A gap fix requires an explicit promotion review; an unrelated
regression cannot be relabeled KNOWN_GAP to make verification green.

There is no update-all, snapshot-update, record, blessing or golden-regeneration
mechanism. The runner writes only execution evidence into a caller-selected
directory below repository `evidence/` or `.pms-bench/`. Source destinations and
symlink redirections are rejected before deletion or writing. Candidate
observations are evidence, never expectations.

## Required matrix and limitations

The inventory covers tokens; base/alternate themes; pseudo/media conditions and
ordering; static create and closed channels; props and conflicts; finite recipe
selection; identity-based imports, aliases and forwarding; missing and repaired
resolution; coverage closure independent of helper imports; revision
transactions; shared CSS ownership; invalid/staged/superseded publication;
structured diagnostics; syntax/incomplete repair; and multi-step A→B→A,
forwarding repair, rename repair and shared-owner removal. The delivery report
gives exact counts and the case matrix. The
[gap register](semantic-gap-register.md) is part of qualification.

Slots, compounds and patterns follow ADR 0003's Phase 12 deferral. Advanced
theme axes/runtime generation remain deferred under the public API's theme
decision. These small fixtures qualify the migration-relevant matrix; they do
not claim exhaustive application coverage, crash durability, future host
implementations, Vite migration or Next support. Historical implementation tests
remain required.

## Official verification

The required order is install → build → upstream-babel-plugin → upstream-stylex
→ pandamstyle → semantic-oracle → tooling-tests → pilot → artifacts.
`semantic-oracle` is a required `test` contract with real counts. Missing,
unclassified or skipped steps prevent a complete verified run. Development
subset commands can still yield the existing incomplete verdict; they cannot
qualify delivery. Full qualification skips no required step.
