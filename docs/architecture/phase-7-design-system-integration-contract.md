# Phase 7 design-system integration contract

Status: Phase 7 boundary contract. This records ownership for later
reconciliation with the independent Phase 6 branch; it does not import or copy
uncommitted Phase 6 work.

## Single-owner boundary

Phase 6 supplies the immutable canonical design-system identity and its artifact
set projections, including `systemId`, `registryDigest`, ABI and compiler
contract identity, manifest, generated module, runtime/CSS/type projections, and
canonical candidate and repair vocabularies.

Phase 7 associates those supplied design artifacts with the project lifecycle:

- the current project/session/revision identity that validated them;
- the `GenerationId` that committed them;
- the `artifactRevision` that produced the bytes;
- the `associationRevision` currently associated with a reused or newly
  committed generation; and
- the publication ticket, recovery and supersession state surrounding commit.

Phase 7 never independently reconstructs token, theme, condition, recipe, slot,
pattern, candidate, or repair vocabulary. Phase 6 never owns project/session
revision state, generation numbering, publication tickets, output locks, or
commit/recovery lifecycle.

## Narrow consumption interface

The Project Service consumes a canonical design artifact snapshot as immutable
data. The snapshot must identify the complete artifact set with its `systemId`,
`registryDigest`, ABI version, compiler contract version, and per-artifact
digests. A single validated service revision selects one snapshot; the service
may retain that snapshot only as session-owned state and may stage its
projections with compiled JS, CSS, manifest, and report in one publication
transaction.

When the snapshot identity changes, the service treats that change as a
revision-bound semantic input and invalidates the affected compiled results
according to the compiler contract. When the output bytes are unchanged and
publication policy permits reuse, the service records a new association without
rewriting the canonical snapshot or changing its origin revision. A failed
publication leaves the previous committed artifact set and its identities
current.

Phase 7's current service reads the repository's existing canonical design
system builder and generated-module interface through its private session owner.
Integrating the Phase 6 immutable snapshot interface is a later reconciliation
task; this document defines the boundary without duplicating Phase 6's
implementation.

## Runtime identity

Generated runtime references continue to contain design-system identity only
where the existing ABI requires it. They omit `sessionId`, `RevisionId`,
`GenerationId`, `artifactRevision`, and `associationRevision`. Those are build
and service lifecycle identities, not runtime design-system references.

## Reconciliation gate

Before Phase 8/9 acceptance, compare this contract with the completed Phase 6
contract and verify that:

1. Phase 6's canonical artifact set is the only source of design vocabulary and
   projections.
2. Phase 7 associates that set with revisions and generations without deriving a
   second registry or candidate universe.
3. Phase 6 does not persist or assign Project Service revision/publication
   identities.
4. Runtime references still omit session, revision, and generation identities.
