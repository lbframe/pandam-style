# Phase 6 + 7 reconciliation boundary

The dedicated integration worktree starts at Phase 7 final head
`7641b51b14881c7eb84f1772b879cc041868c2e0`. It ports Phase 6 functional
commits `6b3c5866` and `02f6f36d`, preserving the completed source worktrees
and the initial checkout. Both historical delivery records remain unchanged.
The two integration contracts are complementary; no contradiction was found.

## Authorities

`packages/compiler/src/design-system/registry/snapshot.js` owns one deeply
frozen `pandamstyle-canonical-design-system` snapshot. Its identity is
`systemId`, `registryDigest`, `abiVersion`, `compilerContractVersion`, and
`manifestSchemaVersion`. Normalized vocabulary, compiled refs, CSS inputs,
manifest, capabilities, candidates, repairs and generated declarations are
projections of this snapshot. The underlying frozen registry is compiler IR
inside this authority, never a Project Service catalog reconstructed from JSON.

`packages/compiler/src/api/project.js` remains the sole production lifecycle
authority: queue, revisions, validation, watchers, leases, publication tickets,
generation association, recovery and close. Its private incremental owner
consumes snapshot projections. CLI uses the public service; `/host` projects
four operations and adds no semantic state. Fresh execution and inspection
remain private, independent qualification paths.

Candidates come from `candidateDomainOf(snapshot, query)`; the service checks
the exact revision and enforces public visibility. Offset/limit apply before
enveloping, preserving declaration order across pages. The service no longer
sorts individual pages. Candidate entry metadata is read directly from snapshot
vocabulary, without another token map. Structured diagnostic token, recipe,
condition and theme domains come from `repairDomainOf(snapshot, query)` via a
private callback; diagnostics contribute observed facts and repair operations,
not a second universe. Neither query exposes private vocabulary or the snapshot.

Diagnostics Protocol v1 retains its established lexicographic presentation of
the bounded diagnostic prefix. The canonical candidate/repair domain and the
paginated service query retain declaration order. This serialization distinction
preserves the unchanged independently authored protocol expectation and does
not introduce another registry or change domain membership.

## Six manually reviewed overlaps

| File | Phase 6 intent | Phase 7 intent | Combined resolution and proof |
| --- | --- | --- | --- |
| `packages/compiler/src/project/session/index.js` | Snapshot projections, declarations, artifact set, candidates/repairs, CSS identity | Private incremental owner, independent generations, publication origin/association, resource cleanup | Retain Phase 7 owner and lifecycle arguments; consume Phase 6 snapshot and stage all five members. Candidate digest authenticates complete canonical set including filenames. Close clears declarations too. Reconciliation cold reopen, mutation, isolation and publication tests plus existing project API tests. |
| `packages/compiler/src/project/session/fresh.js` | Generate same JS/types/manifest/CSS/set | Independent test oracle | Retain separate fresh execution and graph context; add canonical projections and five-member staging using the existing transaction. Phase 6 projection tests, differential suite and semantic oracle. |
| `packages/compiler/src/artifacts/publication/transaction.js` | Account declarations as `types` | Single publisher, durable intent/recovery, tickets supplied by service, origin/association, reuse | Retain all Phase 7 recovery and generation code; add `types` accounting and verify actual canonical staging before durable intent. Named staging failure seams are test-only. Service adversarial mixed-member tests, three staging failures, canonical crash recovery and original publication suite. |
| `packages/compiler/src/observability/metrics.js` | Snapshot/types/manifest/set timings | Queue/lifecycle timings | Union of metrics; existing collector and non-semantic behavior retained. Phase 6 mutation/projection reports and public service performance profile measure both. |
| `tests/support/compiler-inspection.js` | Private projection/coherence helpers | Private service/resource/host helpers | Union of inspection exports in the excluded test bundle. Public package exports remain unchanged; SDK surface and donor package qualification verify exclusion. |
| `packages/compiler/__tests__/pandamstyle/transactional-generation-test.js` | Authenticate canonical `__pandamstyle` marker | CLI failure must operate on a changed candidate after cold reuse | Preserve changed-source failure scenarios and update marker extraction. Named artifact assertions now include declarations and `artifacts.json`. Original transaction/CLI suite plus reconciliation adversarial cases jointly prove both contracts. |

Unresolved overlaps: **0**. Git's mechanical application was clean; every
shared delta was reviewed for behavioral ownership. No wholesale ours/theirs
resolution was used and no phase implementation was replaced wholesale.

## Artifact and identity boundary

The set is `design.js`, `design.d.ts`, `manifest.json`, `styles.css`, and
`artifacts.json`; configurable facade filenames retain adjacent declarations.
`artifacts.json` records the common identity and SHA-256/byte length of the four
payloads. `artifactSetDigest` authenticates identity, filenames and payload
records; metadata cannot include its own recursively computed digest.
All five are staged in the existing publisher. The publisher validates the
actual staging files against the metadata before writing durable commit intent,
and verifies metadata bytes still match their prepared publication record.
Foreign JS, declaration, manifest, CSS or altered set digest rejects before
installation. Rollback preserves the prior files and generation.

| Identity | Meaning |
| --- | --- |
| Snapshot identity | Design vocabulary and compiler/ABI/schema contract; no lifecycle fields |
| `artifactSetDigest` | Content identity of canonical DS projections, including project-extracted CSS; no lifecycle identities |
| `RevisionId` | Full project/session/local sequence tuple for one accepted mutation |
| Publication candidate digest | Complete canonical metadata plus page output digests, revision and coverage/audit inputs; binds a single-use ticket |
| `artifactDigest` / `GenerationId` | Digest of all committed project files / durable publication lineage counter |
| `artifactRevision` | Original full revision that committed the generation's bytes |
| `associationRevision` | Current full revision associated with new or reused bytes |

Identical cold reopen preserves the generation and origin, and associates the
new session revision. Changed token values, declaration order, recipe domains,
themes or conditions cannot reuse a changed canonical set. The declaration
order adversary retains `registryDigest` and page JS but changes declaration
bytes, proving reuse is not based only on registry identity or page JS.

An accepted DS mutation advances exactly one revision, revokes prepared tickets,
builds one snapshot with one required global fallback, and refreshes all
projections before one validated publication. Revision-bound reads reject old
revisions; previously returned immutable artifacts remain historical evidence.
Runtime refs and canonical set members omit lifecycle fields.

## Qualification and scope

The new reconciliation suite adds canonical set reuse, staging failures,
foreign staged members, unchanged page JS, candidate ordering, privacy,
same-systemId/distinct-digest isolation, queue ordering and canonical crash
recovery. Existing Phase 6 type/mutation tests and Phase 7 SDK, watcher, resource,
concurrency and transaction tests remain required. The official verifier retains
the nine-step order and unchanged semantic expectations. Changes to the
counterfeit-generated-source fixture only adapt the authenticated marker;
its independent rejection expectation is unchanged.

`tools/pms/reconciliation-service-profile.cjs` measures the public queue and a
10k global mutation. The existing Phase D/agent-loop harness measures local
10k work shape in isolated cell processes; timings are observations, not SLAs.
New evidence must identify the combined tested commit/tree. Final qualification
and authorization are recorded in `phase-6-7-reconciliation-delivery.md`.

This batch adds no host package, release implementation, deferred capability,
native backend or donor compatibility path. Phase 8 and Phase 9 execution are
outside its scope. No PR, main merge or package publication is part of delivery.
