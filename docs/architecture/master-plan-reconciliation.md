# Canonical master-plan reconciliation

Status: Accepted Phase 0 contracts. All canonical sections 0–11 were read in
full against the existing contracts and ADRs; this is reconciliation, not a
repeat architecture audit or an implementation change.

Canonical input: `/tmp/cmux-drop-18435ef2-21b2-49ab-8953-3bf90c4c1cae.md`.
Repository copy: [master-plan.md](../../master-plan.md). SHA-256:
`78f5e4ee1dca36113b4a618d00f2f9c457096ec16cebd0ebc620be07d9a2e68d`. The copy is
byte-identical; no newline normalization or metadata update occurs. The plan's
original next-action checkpoint is preserved; the
[delivery record](phase-0-delivery.md) records this later closure.

Original base: `d49a7eabf6a6df4eda44cc405f6824158fafd4be`. Previous Phase 0
commit: `8e8c9423fef341be741f0437ceddf71f2d8d48dc`, tree
`6769b873ea0df1c6cc0db3d7399e8c2574dc8262`.

## Classification and evidence

MATCH means the frozen decision implements the plan's requirement. STRONGER BUT
COMPATIBLE means a more specific restriction or protocol detail preserves the
plan's direction and gates. CONTRADICTION means an incompatible decision;
MISSING means required contract coverage is absent. Classifications below refer
to the final reconciled contracts, not delivered production implementation. The
tables with a Classification column form the counted matrix. Corrections to the
incoming candidates are separately recorded below.

Final counted matrix: **86 rows — MATCH 66; STRONGER BUT COMPATIBLE 20;
CONTRADICTION 0; MISSING 0.** All twenty migration invariants are checked.

Evidence abbreviations link to the complete existing contracts:

- API: [public API v0.1](public-api-v0.1.md).
- PKG: [package architecture v1](package-architecture-v1.md).
- ABI: [generated design-system ABI v1](generated-design-system-abi-v1.md).
- DIAG: [diagnostics protocol v1](diagnostics-protocol-v1.md).
- MAP: [current-to-target module map](current-to-target-module-map.md).
- TREE: [target repository tree](target-repository-tree.md).
- DELIVERY: [Phase 0 delivery](phase-0-delivery.md).

## All twenty non-negotiable migration invariants

The INV numbers correspond exactly to master-plan section 1, in original order.

| ID     | Canonical requirement                                                         | Classification          | Contract evidence and conclusion                                                                              |
| ------ | ----------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| INV-01 | No permanent compatibility layer                                              | MATCH                   | PKG donor policy; ABI compatibility: no permanent donor facade or compiler/runtime forwarding entry.          |
| INV-02 | No donor package survives in target architecture                              | MATCH                   | PKG forbidden edges; TREE disappearing structures; retained behavior becomes owned internals.                 |
| INV-03 | No donor source checkout survives                                             | MATCH                   | PKG and TREE require deletion of packages/@stylexjs/, upstream/stylex/, upstream/panda/.                      |
| INV-04 | Migrate useful behavior, delete useless structure                             | MATCH                   | MAP inventories retained behavior; TREE deletes obsolete examples/tooling after useful tests migrate.         |
| INV-05 | Git history is archive; no equivalent legacy tree                             | MATCH                   | PKG/TREE forbid legacy/, old-stylex/, archive/, reference-copy/, vendor-history/ and equivalents.             |
| INV-06 | Preserve legal attribution without legacy architecture                        | MATCH                   | PKG/TREE preserve required notices, source commits, ATTRIBUTIONS.md and LICENSES/ only.                       |
| INV-07 | No semantic regression for structural convenience                             | MATCH                   | API oracle obligations and MAP preserve cascade, provenance, resolution, revision and publication semantics.  |
| INV-08 | No deletion/weakening of failing tests to unblock migration                   | MATCH                   | PKG invariant table, MAP test-only seams and DELIVERY Phase 1 prerequisites explicitly prohibit this.         |
| INV-09 | Independently prove fresh and incremental expected behavior                   | MATCH                   | API and DELIVERY require expected semantics == fresh target == incremental target.                            |
| INV-10 | One compiler/project authority for all production hosts                       | MATCH                   | PKG single-service ownership; API stable SDK; CLI/Vite/Next/watcher/agent consume same authority.             |
| INV-11 | No host second semantic cache/truth model                                     | MATCH                   | PKG hosts may cache immutable transport results, never decide semantic validity or own rule maps.             |
| INV-12 | No public npm package merely from an internal directory                       | MATCH                   | Four PKG release boundaries; compiler domains and observability remain internal directories.                  |
| INV-13 | Large Next pilot waits for real standalone packaging                          | MATCH                   | PKG host section, TREE pilot gate and DELIVERY canonical phase sequence.                                      |
| INV-14 | Native rewrite requires measured evidence                                     | MATCH                   | API/PKG/TREE defer production native choice; Phase 13 evidence and explicit approval remain required.         |
| INV-15 | Final tree looks designed as PandamStyle from day one                         | MATCH                   | TREE owned packages/compiler/core/tests/tools; donor-shaped paths disappear.                                  |
| INV-16 | Identity-based provenance, ambiguity fails closed                             | MATCH                   | API imports/composition, ABI artifact authentication and MAP semantics/provenance ownership.                  |
| INV-17 | Same-revision incremental == fresh, plus independent oracle                   | MATCH                   | API identity/oracle sections; DELIVERY forbids relying only on two implementations agreeing.                  |
| INV-18 | Preserve warm-path architecture unless host-visible evidence justifies change | MATCH                   | API structural counters; PKG warm-path preservation; MAP no full aggregation replacement.                     |
| INV-19 | Zero @stylexjs/_ and @pandacss/_ in final production graph                    | STRONGER BUT COMPATIBLE | PKG also checks optional/peer dependencies, bundled imports and generated specifiers; zero remains mandatory. |
| INV-20 | Every batch names migrated/deleted/temporary assets                           | MATCH                   | PKG disposition, TREE phase gates, MAP actions and DELIVERY exact docs-only scope.                            |

## Every Phase 0 decision

| ID      | Canonical anchor and frozen decision                     | Classification          | Evidence                                                                                                           |
| ------- | -------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| ARCH-01 | Sections 2/5 Phase 0: four public release boundaries     | MATCH                   | PKG and ADR 0001: core/compiler/vite/next only.                                                                    |
| ARCH-02 | Section 2: exact @pandamstyle package names              | MATCH                   | PKG and ADR 0002; provisional names accepted without renaming.                                                     |
| ARCH-03 | Sections 0/5 Phase 0: constrained authoring API          | STRONGER BUT COMPATIBLE | API closed value/channel policy details agent composition; no raw CSS escape.                                      |
| ARCH-04 | Section 4: Application → Generated Design System → core  | MATCH                   | API Model A and ADR 0004 accepted; type-only core imports add no runtime edge.                                     |
| ARCH-05 | Phase 0 token disposition; Phase 6 token projections     | STRONGER BUT COMPATIBLE | API KEEP literal-path token, generated category unions, author/page trust separation.                              |
| ARCH-06 | Phase 0 create disposition                               | STRONGER BUT COMPATIBLE | API KEEP static namespace primitive, compile-time sentinel and authenticated vocabulary.                           |
| ARCH-07 | Section 2 core composition; Phase 0 props disposition    | STRONGER BUT COMPATIBLE | API KEEP ordered compiled refs, SSR-safe composition, no arbitrary classes/styles.                                 |
| ARCH-08 | Section 2 finite selectors; Phase 0 recipes/variants     | STRONGER BUT COMPATIBLE | API KEEP system-owned axes/defaults; ABI finite branch data and selection ordering.                                |
| ARCH-09 | Phase 0 themes/conditions; Phase 6 canonical projections | STRONGER BUT COMPATIBLE | API KEEP projected theme refs and named conditions preserving selector semantics.                                  |
| ARCH-10 | Phases 0/12 slot recipes                                 | MATCH                   | API/ADR 0003 KEEP concept; DEFER implementation until Phase 12 after Phase 11; slots false.                        |
| ARCH-11 | Phase 12 compound variants                               | MATCH                   | API/ADR 0003 KEEP concept; DEFER finite clause implementation; capability false.                                   |
| ARCH-12 | Phases 0/12 patterns/layout                              | MATCH                   | API/ADR 0003 KEEP concept; DEFER schema-constrained StyleRef producers; no components/raw expansion.               |
| ARCH-13 | Sections 2/4 and Phases 0/2/6 generated ABI              | STRONGER BUT COMPATIBLE | ABI 1 specifies refs, conflict keys, sentinels, compatibility and authentication without donor fields.             |
| ARCH-14 | Section 2 compiler ownership and Phase 7 small SDK       | STRONGER BUT COMPATIBLE | API stable root/config and advanced public host bridge; no mutable internals.                                      |
| ARCH-15 | Phases 6/7 revision/generation correctness               | STRONGER BUT COMPATIBLE | API separates project/session/revision/generation/design/ABI identities, stale/superseded tickets and no-op reuse. |
| ARCH-16 | Sections 0/2 and Phases 0/6/7 diagnostics                | STRONGER BUT COMPATIBLE | DIAG protocol 1 versioned envelope, candidates/repair/completeness/revision; message convenience only.             |
| ARCH-17 | Section 2 runtime types and Phase 6 generated types      | STRONGER BUT COMPATIBLE | ABI/ADR 0009: core runtime types; compiler SDK/types generator; adjacent declarations share registry identity.     |
| ARCH-18 | Section 3 internal compiler domains                      | STRONGER BUT COMPATIBLE | PKG/TREE/MAP retain every canonical domain; private observability is allowed by section 3's tree flexibility.      |
| ARCH-19 | Sections 2/4 and Phases 7/8/10 host boundary             | STRONGER BUT COMPATIBLE | API/PKG public immutable artifact/ticket bridge; no host semantics or private imports; separate Next backends.     |
| ARCH-20 | Phase 5 donor/legacy deletion policy                     | MATCH                   | PKG/TREE/ADR 0007 require deletion, migrated useful tests and legal provenance only.                               |

All 27 module rows remain unchanged. All compiler source targets are within the
canonical api, protocol, frontend, semantics, design-system, engine, project,
artifacts or hosts domains, plus the compatible private observability domain.
Runtime/finite selection targets belong to core, Vite integration to vite, and
test/benchmark seams to owned tests/benchmarks. The three package integration
rows and all 73 root-export classifications are preserved. No module moves or
new destination implementation occurs.

## Phase gates and later delivery obligations

These rows freeze sequencing/ownership; future implementation exit gates remain
unfulfilled. Phase 0 closure does not claim the overall migration complete.

| ID    | Canonical phase requirement                                        | Classification | Contract evidence / required future gate                                                                                             |
| ----- | ------------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| PH-00 | Freeze topology/API/ABI/SDK/diagnostics before movement            | MATCH          | API/PKG/ABI/DIAG/MAP/TREE and ten Accepted ADRs; DELIVERY and this reconciliation.                                                   |
| PH-01 | Independent semantic safety net before movement/deletion           | MATCH          | DELIVERY enumerates every required coverage area and oracle; Phase 1 not started here.                                               |
| PH-02 | Standalone core/runtime, no compiler machinery                     | MATCH          | PKG/ABI/MAP assign runtime/finite selection; packed consumer must prove zero donor runtime dependencies.                             |
| PH-03 | Map and re-home native compiler, narrow root SDK                   | MATCH          | MAP 27/27, 73 exports; Phase 1 oracle required; donor absorption remains Phase 4.                                                    |
| PH-04 | Absorb only useful donor engine subsystems                         | MATCH          | MAP handoff requires retained-subsystem MOVE/REFACTOR/REWRITE and recursive closure; zero donor graph, oracle green.                 |
| PH-05 | Delete donor trees after behavior/tests migrate                    | MATCH          | PKG/TREE exact required deletions; repository scan and legal provenance gate.                                                        |
| PH-06 | One canonical registry for every coherent projection               | MATCH          | ABI JS/CSS/types/manifest, DIAG candidates/repair, API generation identity; declarations implemented later.                          |
| PH-07 | One persistent revision-based service, isolated sessions           | MATCH          | API/PKG service lifecycle/publication; no global or host-specific semantic authority.                                                |
| PH-08 | Thin Vite adapter, host-visible correctness/performance            | MATCH          | PKG/MAP; canonical plan's full dev/build/mutations/HMR/workspace/revision and latency qualification retained.                        |
| PH-09 | External npm-pack qualification without publishing                 | MATCH          | ABI ESM-only decision, PKG package boundaries; all canonical export/type/CLI/dependency/Node/tarball/bundle checks remain.           |
| PH-10 | Independently qualify Next webpack and Turbopack                   | MATCH          | PKG/TREE/ADR 0010; canonical RSC/client/SSR/hydration/navigation/cache/worker matrix remains mandatory.                              |
| PH-11 | Substantial external Next pilot after Phase 10                     | MATCH          | PKG/TREE; packed intended architecture and full diagnostic/repair/build/performance evidence required.                               |
| PH-12 | Expand capabilities only after Phase 11 closes                     | MATCH          | API DEFER slots/compounds/patterns/advanced themes; ABI capability/type gates; semantic/type/diagnostic/invalidation proof required. |
| PH-13 | Stable architecture profiling first, native changes evidence-gated | MATCH          | PKG/API/TREE; canonical cold/global/RSS/parallelism/host-latency measurements and explicit native approval retained.                 |

## Parallelization rules and work lanes

| ID     | Canonical section 6/8 gate                                 | Classification | Accepted boundary                                                                                                        |
| ------ | ---------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| PAR-01 | Phase 0 → Phase 1 → Phase 2 + Phase 3 → Phase 4 → Phase 5  | MATCH          | DELIVERY explicit gates; no Phase 2/3 work until both Phase 0/1 close.                                                   |
| PAR-02 | Phase 2 runtime/imports vs Phase 3 compiler/SDK            | MATCH          | API/DELIVERY freeze ABI and require one named future integration owner for shared files/contracts.                       |
| PAR-03 | Phase 6 + Phase 7 after Phase 4/5                          | MATCH          | Canonical sequence retained; projection vs service ownership meets at generation/diagnostics/publication with one owner. |
| PAR-04 | Phase 8 + Phase 9 partial parallelization                  | MATCH          | Final Vite acceptance uses actual standalone Phase 9 package shape; no premature host acceptance.                        |
| PAR-05 | Phase 10 → Phase 11 → Phase 12                             | MATCH          | SDK/service/package closure gates Next; accepted Next gates pilot; pilot gates capability implementation.                |
| PAR-06 | Phase 1 overlap limited; Phase 13 research needs stability | MATCH          | Late Phase 0 overlap only inventory/extraction; native production cannot race migration and requires explicit approval.  |
| LANE-A | Section 7 product/API contracts: 0 → 6 → 12                | MATCH          | API/ABI compiler-owned registry/type generation; deferred features do not reopen frozen API.                             |
| LANE-B | Runtime/package ownership: 2 → 4 → 5 → 9                   | MATCH          | PKG/MAP core ownership, engine absorption, deletion then package closure.                                                |
| LANE-C | Compiler/project architecture: 3 → 4 → 7                   | MATCH          | MAP compiler domains; API revision/diagnostics/publication SDK.                                                          |
| LANE-D | Integrations: 8 → 10 → 11                                  | MATCH          | PKG thin Vite and separate Next backend qualification before external pilot.                                             |
| LANE-E | Continuous verification after Phase 1                      | MATCH          | API/DELIVERY independent fixtures/oracles plus canonical package/browser/host acceptance.                                |
| LANE-F | Performance research after stable checkpoints              | MATCH          | PKG warm-path protection, canonical measured profiling; no premature production native changes.                          |

## Execution discipline

| ID      | Canonical section 10 obligation                             | Classification | Closure evidence / future requirement                                                                              |
| ------- | ----------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------ |
| EXEC-01 | Name relevant phase in each brief                           | MATCH          | This batch is Phase 0 closure only; later briefs name their phases.                                                |
| EXEC-02 | Name satisfied prerequisite gates                           | MATCH          | DELIVERY records accepted Phase 0 contracts and unclosed Phase 1.                                                  |
| EXEC-03 | Exact allowed file/subsystem scope                          | MATCH          | Root master-plan.md plus docs/architecture Markdown only.                                                          |
| EXEC-04 | State what must not change                                  | MATCH          | No production/manifests/dependencies/moves/deletions/main changes.                                                 |
| EXEC-05 | Preserve semantic/oracle requirements                       | MATCH          | API/PKG/MAP/DELIVERY and INV-07 through INV-09/INV-17.                                                             |
| EXEC-06 | Repository verification                                     | MATCH          | DELIVERY targeted docs/byte/blob/map/Git checks; no fresh production test claim.                                   |
| EXEC-07 | Tested commit and evidence-only closure                     | MATCH          | Documentation checks before commit/push; final Git identities reported after execution.                            |
| EXEC-08 | Plan status only after independent verification             | MATCH          | Canonical file unchanged; later completion lives in DELIVERY and final verified report.                            |
| EXEC-09 | No silent package/compatibility/donor/host truth additions  | MATCH          | All frozen forbidden edges remain; this batch has no implementation.                                               |
| EXEC-10 | Stop on implementation contradiction before expanding scope | MATCH          | No implementation authorized here; no plan amendment needed; later contradiction requires explicit plan amendment. |

## ADR reconciliation

| ADR                                           | Classification          | Result / canonical support                                                               |
| --------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| [0001](adr/0001-package-topology.md)          | MATCH                   | Accepted; section 2 four-package topology.                                               |
| [0002](adr/0002-runtime-package-name.md)      | MATCH                   | Accepted; section 2 core ownership/name.                                                 |
| [0003](adr/0003-authoring-api.md)             | STRONGER BUT COMPATIBLE | Accepted after disposition/timing clarification; Phases 0/12.                            |
| [0004](adr/0004-generated-import-model.md)    | MATCH                   | Accepted Model A; exact section 4 dependency direction.                                  |
| [0005](adr/0005-runtime-compiler-boundary.md) | STRONGER BUT COMPATIBLE | Accepted detailed ABI 1; sections 2/4 and Phases 0/2/6.                                  |
| [0006](adr/0006-single-project-authority.md)  | STRONGER BUT COMPATIBLE | Accepted exact revision/lifecycle rules; Phase 7 and INV-10/11/17.                       |
| [0007](adr/0007-donor-deletion-policy.md)     | MATCH                   | Accepted mandatory Phase 5 deletion; INV-01 through INV-06/15/19.                        |
| [0008](adr/0008-diagnostics-protocol.md)      | STRONGER BUT COMPATIBLE | Accepted versioned protocol 1; sections 0/2 and Phases 0/6/7.                            |
| [0009](adr/0009-generated-types-ownership.md) | STRONGER BUT COMPATIBLE | Accepted adjacent declarations/core types; section 2 and Phase 6.                        |
| [0010](adr/0010-host-adapter-isolation.md)    | STRONGER BUT COMPATIBLE | Accepted public artifact bridge/private observability; sections 2/3/4 and Phases 7/8/10. |

Accepted: 10. Proposed: 0. Rejected/superseded: 0. No replacement ADRs.

## Global acceptance crosswalk

Every section 9 checkbox is a future migration requirement except the contract
freeze itself. Numbering below follows the canonical checkbox order. These
cross-references do not add duplicate counted matrix rows.

| Global gate                                         | Matrix coverage                |
| --------------------------------------------------- | ------------------------------ |
| 1 explicit public contracts                         | ARCH-01 through ARCH-20, PH-00 |
| 2 owned application runtime                         | ARCH-04, ARCH-13, PH-02        |
| 3 owned compiler source                             | ARCH-18, PH-03                 |
| 4/5 zero StyleX/Panda production graph              | INV-19, PH-04, PH-09           |
| 6/7/8 exact donor directory deletions               | INV-03, PH-05                  |
| 9 legal provenance without checkouts                | INV-06, PH-05                  |
| 10 independent fresh/incremental expected semantics | INV-09, INV-17, PH-01          |
| 11 coherent artifact revision/generation            | ARCH-15, PH-06                 |
| 12 shipped generated declarations                   | ARCH-17, PH-06, PH-09          |
| 13 common host project authority                    | INV-10, INV-11, PH-07          |
| 14 canonical-service Vite qualification             | PH-08, PAR-04                  |
| 15 donor-free packed external install               | PH-09                          |
| 16/17 separate Next webpack/Turbopack claims        | PH-10                          |
| 18 large external Next pilot                        | PH-11                          |
| 19 no permanent compatibility shim                  | INV-01                         |
| 20 no historical legacy/archive source tree         | INV-05                         |
| 21 measured native rewrite evidence                 | INV-14, PH-13                  |

## Corrections to incoming candidates

No incompatible architecture decision was found. Three coverage/wording gaps
were resolved without changing the master plan or reopening prior decisions:

1. **MISSING product-disposition spelling:** Phase 0 requires KEEP/REDESIGN/
   REMOVE per concept. The incoming DEFER-only entries reserved architecture but
   did not name that separate disposition. API and ADR 0003 now state KEEP for
   the three reserved concepts while preserving DEFER implementation, false
   capabilities and no exports until Phase 12 after Phase 11 closes.
2. **MISSING explicit Phase 3/4 handoff:** MAP's donor-closure paragraph could
   imply absorption alongside native compiler movement. It now distinguishes
   Phase 3 inventory/native movement from Phase 4 retained donor absorption with
   MOVE/REFACTOR/REWRITE. All 27 destinations remain unchanged.
3. **MISSING complete sequencing/integration prerequisites:** The incoming
   delivery record blocked sequencing because canonical input was absent.
   API/DELIVERY now explicitly require Phase 1 closure before Phase 2/3,
   separate ownership and one named integration owner for shared files in future
   briefs. All later phase/lane gates remain those of sections 6–8.

Stale candidate/proposed/missing-plan status text is updated in all existing
contracts and ten ADRs. TREE adds only the canonical/reconciliation document
presence. No production tests or delivered capability evidence is invented.
Final CONTRADICTION: 0. Final MISSING: 0. Blocking contradictions: none.

## Closure boundary

Phase 0 acceptance is the frozen specification, not implementation of all later
migration invariants. Existing donor trees remain temporary until their gated
deletion. Production source/manifests/dependencies are unchanged; source moved
and deleted: none. `main` remains `71fcc045b18eb215f0c3a815bb8c8d15a9f99489`.
Completion requires the verified clean closure commit, push to the existing
Phase 0 branch and remote/local HEAD equality. Phase 1 is next; it is not begun
here. Phase 2/3 are not authorized until Phase 1 closes. No PR, merge or package
publication.
