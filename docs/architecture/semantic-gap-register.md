# Semantic gap register

Status: Phase 1 discrepancy history with Phase 2 and Phase 3 resolutions
recorded below. Target assertions remain unchanged in `tests/semantic/cases/`;
the reconciliation oracle checks the combined implementation. SG-01 through
SG-13 are promoted to `MUST_PRESERVE`. The Phase 1 observations below are
historical, not descriptions of the current implementation.

The Phase 1 target behavior remains frozen for every entry. Phase 3 reviewed and
promoted the repaired cases with their authored expectations intact. The Phase 1
observations explain the original migration risk.

## SG-01 — static omission/empty composition — resolved in Phase 3

- Cases: `props.omissions`, `props.empty`.
- Contract: [public API, props](public-api-v0.1.md),
  [ABI ref composition](generated-design-system-abi-v1.md).
- Target: null/false conditional omissions introduce no classes; empty props
  returns `{}`. Static analysis admits these accepted forms.
- Phase 1 observed: null/false produced two `PMS_UNVERIFIED_PROPS_SOURCE`
  errors; empty props produces one. Both lanes reject the source before runtime
  execution.
- Migration risk: an extracted validator could canonize this narrower input
  domain and silently reject valid composition.
- Resolution: Phase 3 compiler provenance validation; cases promoted to
  `MUST_PRESERVE`.

## SG-02 — immutable local intrinsic alias — resolved in Phase 3

- Case: `forward.local-alias`.
- Contract: [public API binding authority](public-api-v0.1.md),
  [ADR 0004](adr/0004-generated-import-model.md).
- Target: a proven immutable local alias of authenticated create retains binding
  identity; its resulting ref is valid for composition.
- Phase 1 observed: the alias call was not recognized as create, so props
  rejected its result with `PMS_UNVERIFIED_PROPS_SOURCE` in both lanes.
- Migration risk: spelling-based recognition could replace identity provenance.
- Resolution: Phase 3 binding/provenance frontend; case promoted to
  `MUST_PRESERVE`.

## SG-03 — stale design-system CSS after invalid rename and repair — resolved in Phase 3

- Case: `token.rename-removal`.
- Contract: [public API token rename and revisions](public-api-v0.1.md),
  [ADR 0006](adr/0006-single-project-authority.md), master-plan incremental
  equivalence.
- Target: renaming `spacing.md` to `spacing.medium` invalidates the old
  consumer; its repaired revision contains the renamed variable/value and equals
  fresh.
- Phase 1 observed: fresh repaired output defined medium; incremental retained
  the prior design-system owner contribution defining the removed md variable.
  The new consumer references the medium variable, which is not defined. The
  authored observed evidence pins the old declaration and ordered base values
  separately from the renamed target. Revision 1 and rejection at revision 2
  remain correct.
- Migration risk: stale shared-owner state can pass acceptance while producing
  browser-visible missing token values; two-cache consistency is insufficient.
- Resolution: Phase 3 revision/design-system CSS invalidation; case promoted to
  `MUST_PRESERVE`.

## SG-04 — deleted positive edges retained instead of negative resolution — resolved in Phase 3

- Cases: `resolution.deleted-restored`, `resolution.rename-import-repair`,
  `resolution.relay-added-removed`.
- Contract: [ADR 0006](adr/0006-single-project-authority.md),
  [public API coverage/revisions](public-api-v0.1.md),
  [diagnostic coverage facts](diagnostics-protocol-v1.md).
- Target: deletion/rename removes the target from coverage, diagnoses the
  originating import request, records a real negative dependency, and repairs
  correctly after source/import restoration.
- Phase 1 observed: incremental retained the removed positive edge and covered
  the missing target. It diagnoses `<unparseable>` in that target rather than
  the consumer's import. For the ordinary dependency, fresh negative count is 1
  and incremental count is 0. Fresh and incremental reject, but their coverage
  and diagnostic contexts differ. Restored/import-repaired revisions agree
  again.
- Migration risk: false coverage and missing negative dependencies can cause
  later creation or resolution changes to go unvalidated.
- Resolution: Phase 3 project graph/resolution invalidation; cases promoted to
  `MUST_PRESERVE`.

## SG-05 — historical agent envelope versus Diagnostics Protocol v1 — resolved in Phase 3

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
- Phase 1 observed: `pandamstyle-agent-result`, numeric revisionId, no full
  identity, ABI or completeness, source.role nested in source, missing end
  coordinates, expected domain/visibility/static fields, string candidates, old
  repair and query shapes, missing diagnostic/envelope totals and
  affected-region fields. Actual gap evidence retains historical structured
  fields; no adapter fabricates a target envelope to hide the discrepancy.
- Migration risk: transport migration may silently bless incomplete revision or
  coverage authority, or treat prose as machine repair instructions.
- Resolution: Phase 3 compiler SDK diagnostics protocol migration; case promoted
  to `MUST_PRESERVE`.

## SG-06 — wrong-category repair loses expected category — resolved in Phase 3

- Case: `diagnostics.category-repair`.
- Contract:
  [Diagnostics Protocol v1 category repairs](diagnostics-protocol-v1.md).
- Target: spacing category appears in machine expected and repair.expected.
- Phase 1 observed: both fields were null while context.expected correctly said
  spacing.
- Migration risk: an agent cannot safely select the right repair domain.
- Resolution: Phase 3 diagnostic normalization; case promoted to
  `MUST_PRESERVE`.

## SG-07 — private-token repair suggests a forbidden page privilege — resolved in Phase 3

- Case: `diagnostics.private-repair`.
- Contract:
  [Diagnostics Protocol v1 private-token repairs](diagnostics-protocol-v1.md),
  [public API private-token boundary](public-api-v0.1.md).
- Target: structured replace-with-token repair scoped to public color
  vocabulary, with target property and category; no page access to private
  channels.
- Phase 1 observed: old use-public-token repair had no structured
  target/category and its `how` prose suggested explicitly allowing the private
  page channel.
- Migration risk: copying old repair prose weakens frozen product policy.
- Resolution: Phase 3 diagnostics/repair protocol migration; case promoted to
  `MUST_PRESERVE`.

## SG-08 — syntax failures lose available parser coordinates — resolved in Phase 3

- Cases: `syntax.incomplete-edit`, `syntax.error-affected`.
- Contract:
  [Diagnostics Protocol v1 source and nullable precision](diagnostics-protocol-v1.md).
- Target: source identity and known parser coordinates remain useful; incomplete
  fixture EOF is line 3 column 1; affected-file syntax error is line 2
  column 11. Repaired syntax validates normally. No new parser diagnostic code
  is invented.
- Phase 1 observed: generic `PMS_COVERAGE_GAP`, rule coverage.local-imports,
  request `<unparseable>`, unreadable context and null location. Source filename
  survives but useful available parser coordinates are discarded in both lanes.
- Migration risk: extraction could canonize a generic internal/coverage failure
  that cannot guide repair of incomplete agent edits.
- Resolution: Phase 3 parser-to-diagnostic mapping; cases promoted to
  `MUST_PRESERVE`.

## SG-09 — generation receipt omits origin/association identities — resolved in Phase 3

- Case: `publication.noop-generation`.
- Contract: [public API RevisionId/GenerationId table](public-api-v0.1.md),
  [ADR 0006](adr/0006-single-project-authority.md).
- Target: generation receipt names both artifact origin revision and current
  association revision. The latter is revision 2; artifact origin remains a
  committed revision and generationId agrees with the current publication.
- Phase 1 observed: publisher rewrote metadata and advanced to GenerationId 2
  with generationReused false, and lacks the required origin/association fields.
  Allocating a generation for changed metadata bytes is not itself a defect;
  byte-identical reuse is permitted, not forced by this expectation. Other tests
  separately prove invalid/staged-failed publication preserves the previous
  generation and files.
- Migration risk: revision identity is mistaken for artifact generation
  identity.
- Resolution: Phase 3 publication receipt/generation identity migration; case
  promoted to `MUST_PRESERVE`.

## SG-10 — private recipe exposed in consumer manifest — resolved in Phase 3

- Case: `recipe.private-visibility`.
- Contract:
  [public API recipe visibility, explicit baseline gap requirement](public-api-v0.1.md).
- Target: consumer recipe vocabulary contains button and bare, excluding secret.
- Phase 1 observed: generated manifest/selector vocabulary exposed the private
  secret recipe. The expectation remains the public vocabulary, not historical
  output.
- Migration risk: generator re-homing carries author-only vocabulary into pages.
- Resolution: Phase 3 generated consumer visibility filtering; case promoted to
  `MUST_PRESERVE`.

## SG-11 — counterfeit generated metadata receives intrinsic authority — resolved in Phase 3

- Case: `provenance.generated-authentication`.
- Contract: [generated ABI authentication](generated-design-system-abi-v1.md),
  [ADR 0004](adr/0004-generated-import-model.md),
  [Protocol artifact mismatch](diagnostics-protocol-v1.md).
- Target: an arbitrary module copying generated markers is rejected with
  `PMS_GENERATED_ARTIFACT_MISMATCH`; only authenticated service-owned origin
  confers helper identity.
- Phase 1 observed: a user module with the same systemId and deliberately forged
  digest was accepted as an intrinsic source. This is distinct from the passing
  tests proving ordinary same-spelling functions and ambiguous stars lack
  authority.
- Migration risk: marker shape could become a permanent authority bypass.
- Resolution: Phase 3 generated artifact authentication; case promoted to
  `MUST_PRESERVE`.

## SG-12 — runtime malformed refs lack structured rejection — resolved in Phase 2

- Case: `props.runtime-malformed`.
- Contract: [public API runtime malformed refs](public-api-v0.1.md),
  [ABI runtime format checks](generated-design-system-abi-v1.md).
- Target: generated runtime props rejects `{className: 'invented'}` with
  structured `PMS_UNVERIFIED_PROPS_SOURCE` selection error.
- Phase 1 observed: actual generated props accepted the raw object without
  throwing. The adapter invokes the actual generated function; it does not
  simulate rejection. Passing static spoofing tests do not establish this
  runtime guard.
- Migration risk: new core inherits permissive donor format behavior.
- Resolution: Phase 2 `@pandamstyle/core` validates every runtime composition
  input and raises `PMS_UNVERIFIED_PROPS_SOURCE` for the malformed object. The
  reconciled generated facade imports core's `props`; the unchanged target
  assertion is promoted from `KNOWN_GAP` to `MUST_PRESERVE`.

## SG-13 — smaller requested diagnostic bounds ignored — resolved in Phase 3

- Case: `diagnostics.smaller-bound`.
- Contract:
  [Diagnostics Protocol v1 bounded candidate queries/results](diagnostics-protocol-v1.md).
- Target: requested bound 2 returns two candidates, full total 3, truncation
  true.
- Phase 1 observed: session agentResult ignored candidateLimit 2, returning
  three candidates and truncation false. Default-bound behavior is separately
  passing at 32 of 37 public candidates in `diagnostics.truncation`.
- Migration risk: compact host result limits become unreliable despite correct
  default-bound tests.
- Resolution: Phase 3 diagnostics host options/query binding; case promoted to
  `MUST_PRESERVE`.

## Deferred concepts

`deferred.slots`, `deferred.compounds`, `deferred.patterns` follow
[ADR 0003](adr/0003-authoring-api.md): Phase 12 after Phase 11.
`deferred.advanced-themes` follows the
[public API theme deferral](public-api-v0.1.md) for advanced axes/runtime
generation. No executable expectation or claim of delivered behavior exists for
these concepts.
