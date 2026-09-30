# Semantic gap register

Status: frozen Phase 1 target/current discrepancy register. These are bounded
existing deficiencies, **not passing semantics**. Their target assertions live
in `tests/semantic/cases/`; exact structured observed evidence is emitted per
revision in the
[Phase 1 report](../../evidence/phase-1-semantic-oracle/REPORT.md). The oracle
checks both the target mismatch boundary and authored observed facts. Unrelated
differences fail rather than being absorbed by a gap.

For **every entry below**: migration must preserve current behavior: **NO**;
target behavior already frozen: **YES**. No production change is made in Phase 1
because its authorized scope is verification, not product repair. Resolution
phases indicate the owning future migration batch; that batch must explicitly
review and promote the repaired case, with a contract reference and reviewable
diff. Phase 1 does not authorize fixing these before its own closure.

## SG-01 — static omission/empty composition

- Cases: `props.omissions`, `props.empty`.
- Contract: [public API, props](public-api-v0.1.md),
  [ABI ref composition](generated-design-system-abi-v1.md).
- Target: null/false conditional omissions introduce no classes; empty props
  returns `{}`. Static analysis admits these accepted forms.
- Current: null/false produce two `PMS_UNVERIFIED_PROPS_SOURCE` errors; empty
  props produces one. Both lanes reject the source before runtime execution.
- Migration risk: an extracted validator could canonize this narrower input
  domain and silently reject valid composition.
- Expected resolution: Phase 3 compiler provenance validation.

## SG-02 — immutable local intrinsic alias

- Case: `forward.local-alias`.
- Contract: [public API binding authority](public-api-v0.1.md),
  [ADR 0004](adr/0004-generated-import-model.md).
- Target: a proven immutable local alias of authenticated create retains binding
  identity; its resulting ref is valid for composition.
- Current: the alias call is not recognized as create, so props rejects its
  result with `PMS_UNVERIFIED_PROPS_SOURCE` in both lanes.
- Migration risk: spelling-based recognition could replace identity provenance.
- Expected resolution: Phase 3 binding/provenance frontend.

## SG-03 — stale design-system CSS after invalid rename and repair

- Case: `token.rename-removal`.
- Contract: [public API token rename and revisions](public-api-v0.1.md),
  [ADR 0006](adr/0006-single-project-authority.md), master-plan incremental
  equivalence.
- Target: renaming `spacing.md` to `spacing.medium` invalidates the old
  consumer; its repaired revision contains the renamed variable/value and equals
  fresh.
- Current: fresh repaired output defines medium; incremental retains the prior
  design-system owner contribution defining the removed md variable. The new
  consumer references the medium variable, which is not defined. The authored
  observed evidence pins the old declaration and ordered base values separately
  from the renamed target. Revision 1 and rejection at revision 2 remain
  correct.
- Migration risk: stale shared-owner state can pass acceptance while producing
  browser-visible missing token values; two-cache consistency is insufficient.
- Expected resolution: Phase 3 revision/design-system CSS invalidation.

## SG-04 — deleted positive edges retained instead of negative resolution

- Cases: `resolution.deleted-restored`, `resolution.rename-import-repair`,
  `resolution.relay-added-removed`.
- Contract: [ADR 0006](adr/0006-single-project-authority.md),
  [public API coverage/revisions](public-api-v0.1.md),
  [diagnostic coverage facts](diagnostics-protocol-v1.md).
- Target: deletion/rename removes the target from coverage, diagnoses the
  originating import request, records a real negative dependency, and repairs
  correctly after source/import restoration.
- Current: incremental retains the removed positive edge and covers the missing
  target. It diagnoses `<unparseable>` in that target rather than the consumer's
  import. For the ordinary dependency, fresh negative count is 1 and incremental
  count is 0. Fresh and incremental reject, but their coverage and diagnostic
  contexts differ. Restored/import-repaired revisions agree again.
- Migration risk: false coverage and missing negative dependencies can cause
  later creation or resolution changes to go unvalidated.
- Expected resolution: Phase 3 project graph/resolution invalidation.

## SG-05 — historical agent envelope versus Diagnostics Protocol v1

- Case: `diagnostics.protocol-v1`.
- Contract:
  [Diagnostics Protocol v1 normative shape and field semantics](diagnostics-protocol-v1.md),
  [public API exact revision identity](public-api-v0.1.md).
- Target: `pandamstyle-diagnostics-result`, schema 1, ABI 1, full
  project/session/ revision association and completeness; all mandatory envelope
  and diagnostic fields. Source/role are distinct, candidates are structured
  entries, and repairs/coverage/affected-region/query fields follow the frozen
  protocol. Session identity is opaque and must agree between envelope and
  diagnostic.
- Current: `pandamstyle-agent-result`, numeric revisionId, no full identity, ABI
  or completeness, source.role nested in source, missing end coordinates,
  expected domain/visibility/static fields, string candidates, old repair and
  query shapes, missing diagnostic/envelope totals and affected-region fields.
  Actual gap evidence retains historical structured fields; no adapter
  fabricates a target envelope to hide the discrepancy.
- Migration risk: transport migration may silently bless incomplete revision or
  coverage authority, or treat prose as machine repair instructions.
- Expected resolution: Phase 3 compiler SDK diagnostics protocol migration.

## SG-06 — wrong-category repair loses expected category

- Case: `diagnostics.category-repair`.
- Contract:
  [Diagnostics Protocol v1 category repairs](diagnostics-protocol-v1.md).
- Target: spacing category appears in machine expected and repair.expected.
- Current: both fields are null while context.expected correctly says spacing.
- Migration risk: an agent cannot safely select the right repair domain.
- Expected resolution: Phase 3 diagnostic normalization.

## SG-07 — private-token repair suggests a forbidden page privilege

- Case: `diagnostics.private-repair`.
- Contract:
  [Diagnostics Protocol v1 private-token repairs](diagnostics-protocol-v1.md),
  [public API private-token boundary](public-api-v0.1.md).
- Target: structured replace-with-token repair scoped to public color
  vocabulary, with target property and category; no page access to private
  channels.
- Current: old use-public-token repair has no structured target/category and its
  `how` prose suggests explicitly allowing the private page channel.
- Migration risk: copying old repair prose weakens frozen product policy.
- Expected resolution: Phase 3 diagnostics/repair protocol migration.

## SG-08 — syntax failures lose available parser coordinates

- Cases: `syntax.incomplete-edit`, `syntax.error-affected`.
- Contract:
  [Diagnostics Protocol v1 source and nullable precision](diagnostics-protocol-v1.md).
- Target: source identity and known parser coordinates remain useful; incomplete
  fixture EOF is line 3 column 1; affected-file syntax error is line 2
  column 11. Repaired syntax validates normally. No new parser diagnostic code
  is invented.
- Current: generic `PMS_COVERAGE_GAP`, rule coverage.local-imports, request
  `<unparseable>`, unreadable context and null location. Source filename
  survives but useful available parser coordinates are discarded in both lanes.
- Migration risk: extraction could canonize a generic internal/coverage failure
  that cannot guide repair of incomplete agent edits.
- Expected resolution: Phase 3 parser-to-diagnostic mapping.

## SG-09 — generation receipt omits origin/association identities

- Case: `publication.noop-generation`.
- Contract: [public API RevisionId/GenerationId table](public-api-v0.1.md),
  [ADR 0006](adr/0006-single-project-authority.md).
- Target: generation receipt names both artifact origin revision and current
  association revision. The latter is revision 2; artifact origin remains a
  committed revision and generationId agrees with the current publication.
- Current: publisher rewrites metadata and advances to GenerationId 2 with
  generationReused false, and lacks the required origin/association fields.
  Allocating a generation for changed metadata bytes is not itself a defect;
  byte-identical reuse is permitted, not forced by this expectation. Other tests
  separately prove invalid/staged-failed publication preserves the previous
  generation and files.
- Migration risk: revision identity is mistaken for artifact generation
  identity.
- Expected resolution: Phase 3 publication receipt/generation identity
  migration.

## SG-10 — private recipe exposed in consumer manifest

- Case: `recipe.private-visibility`.
- Contract:
  [public API recipe visibility, explicit baseline gap requirement](public-api-v0.1.md).
- Target: consumer recipe vocabulary contains button and bare, excluding secret.
- Current: generated manifest/selector vocabulary exposes the private secret
  recipe. The expectation remains the public vocabulary, not historical output.
- Migration risk: generator re-homing carries author-only vocabulary into pages.
- Expected resolution: Phase 3 generated consumer visibility filtering.

## SG-11 — counterfeit generated metadata receives intrinsic authority

- Case: `provenance.generated-authentication`.
- Contract: [generated ABI authentication](generated-design-system-abi-v1.md),
  [ADR 0004](adr/0004-generated-import-model.md),
  [Protocol artifact mismatch](diagnostics-protocol-v1.md).
- Target: an arbitrary module copying generated markers is rejected with
  `PMS_GENERATED_ARTIFACT_MISMATCH`; only authenticated service-owned origin
  confers helper identity.
- Current: a user module with the same systemId and deliberately forged digest
  is accepted as an intrinsic source. This is distinct from the passing tests
  proving ordinary same-spelling functions and ambiguous stars lack authority.
- Migration risk: marker shape could become a permanent authority bypass.
- Expected resolution: Phase 3 generated artifact authentication.

## SG-12 — runtime malformed refs lack structured rejection

- Case: `props.runtime-malformed`.
- Contract: [public API runtime malformed refs](public-api-v0.1.md),
  [ABI runtime format checks](generated-design-system-abi-v1.md).
- Target: generated runtime props rejects `{className: 'invented'}` with
  structured `PMS_UNVERIFIED_PROPS_SOURCE` selection error.
- Current: actual generated props accepts the raw object without throwing. The
  adapter invokes the actual generated function; it does not simulate rejection.
  Passing static spoofing tests do not establish this runtime guard.
- Migration risk: new core inherits permissive donor format behavior.
- Expected resolution: Phase 2 core composition/runtime selection errors.

## SG-13 — smaller requested diagnostic bounds ignored

- Case: `diagnostics.smaller-bound`.
- Contract:
  [Diagnostics Protocol v1 bounded candidate queries/results](diagnostics-protocol-v1.md).
- Target: requested bound 2 returns two candidates, full total 3, truncation
  true.
- Current: session agentResult ignores candidateLimit 2, returning three
  candidates and truncation false. Default-bound behavior is separately passing
  at 32 of 37 public candidates in `diagnostics.truncation`.
- Migration risk: compact host result limits become unreliable despite correct
  default-bound tests.
- Expected resolution: Phase 3 diagnostics host options/query binding.

## Deferred concepts

`deferred.slots`, `deferred.compounds`, `deferred.patterns` follow
[ADR 0003](adr/0003-authoring-api.md): Phase 12 after Phase 11.
`deferred.advanced-themes` follows the
[public API theme deferral](public-api-v0.1.md) for advanced axes/runtime
generation. No executable expectation or claim of delivered behavior exists for
these concepts.
