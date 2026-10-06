# Diagnostics protocol v1

Status: Public Alpha 1 diagnostics contract. Schema version:
`1`; document kind: `pandamstyle-diagnostics-result`. The public contract is
defined by the schema below. No permanent compatibility transport is required.

Human-readable message is convenience. Structured fields are authoritative.
Unknown code means an unknown rule, not permission to parse prose or assume
success. The compiler SDK owns protocol implementation/types; the runtime owns
only a minimal selection-error subset. No Node dependency enters core.

## Normative JSON shape (ARCH-16)

```json
{
  "documentKind": "pandamstyle-diagnostics-result",
  "schemaVersion": 1,
  "revision": { "projectId": "app", "sessionId": "s1", "revisionId": 2 },
  "designSystem": { "systemId": "app-ui", "registryDigest": "sha256:example" },
  "abiVersion": 1,
  "ok": false,
  "completeness": {
    "status": "complete",
    "scope": "declared-project",
    "discovery": "verified-explicit",
    "evidence": "host-reported-set",
    "resyncRequired": false
  },
  "diagnostics": [
    {
      "schemaVersion": 1,
      "code": "PMS_FORBIDDEN_VALUE",
      "severity": "error",
      "phase": "policy",
      "rule": "tokens.category",
      "message": "padding requires a public spacing token",
      "source": {
        "file": "src/Actions.tsx",
        "line": 8,
        "column": 14,
        "endLine": 8,
        "endColumn": 20,
        "label": null
      },
      "role": "page",
      "context": {
        "namespace": "row",
        "property": "padding",
        "conditionPath": [],
        "actual": "12px"
      },
      "expected": {
        "category": "spacing",
        "visibility": "public",
        "static": true,
        "domain": null
      },
      "candidates": [{ "tokenId": "spacing.md", "category": "spacing" }],
      "candidatesTotal": 1,
      "candidatesTruncated": false,
      "candidatesQuery": {
        "method": "candidateTokens",
        "category": "spacing",
        "offset": 0,
        "limit": 32
      },
      "repair": {
        "kind": "replace-with-token",
        "applicable": true,
        "target": { "property": "padding" },
        "expected": { "category": "spacing" },
        "reason": null
      },
      "autofix": null,
      "affectedRegion": {
        "file": "src/Actions.tsx",
        "namespace": "row",
        "property": "padding",
        "conditionPath": []
      },
      "coverage": { "analysed": true, "origin": "root", "failed": true },
      "revision": { "projectId": "app", "sessionId": "s1", "revisionId": 2 }
    }
  ],
  "diagnosticsTotal": 1,
  "diagnosticsTruncated": false,
  "affected": {
    "entries": [{ "file": "src/Actions.tsx", "role": "page" }],
    "total": 1,
    "truncated": false
  },
  "generation": {
    "published": false,
    "generationId": null,
    "artifactRevision": null
  },
  "milestones": {
    "diagnosticsReady": true,
    "generationReady": false,
    "generationCommitted": false,
    "auditReportReady": false
  },
  "audit": { "requested": false, "materialized": false, "document": null },
  "incremental": { "fullFallback": false, "reason": null }
}
```

Example digest/session strings are illustrative, not observed production IDs.
Full revision identity in each diagnostic must equal envelope revision. All
listed fields are required; unavailable source/end/domain/region/coverage data
uses explicit null rather than invented precision. Arrays default to empty;
totals are nonnegative integers or null only when unknowable, never false zero.

## Field semantics

| Field                       | Contract                                                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| schemaVersion/documentKind  | Must be checked before interpretation; breaking shape/meaning requires a new version; envelope versions independent of ABI/package semver             |
| code                        | Stable `PMS_*` identifier; semantics cannot silently change; new codes are additive, unknown errors still fail                                        |
| severity                    | `error`, `warning` or `info`; any error or incomplete validation prevents ok true                                                                     |
| phase/rule                  | Stable machine identifiers for stage and violated invariant; null rule when no known rule; never derived from message                                 |
| source                      | Project-relative POSIX file identity, 1-based line/column and exclusive end, nullable location; label only for display; no role encoded into filename |
| role                        | Explicit `page`, `design-system`, `generated` or configured role; null when unknown; author and consumer privileges remain distinct                   |
| context                     | Structured observed property/axis/path/value/import/provenance facts, bounded where needed; no code execution or secret/environment dump              |
| expected                    | Structured category/visibility/domain/static/provenance requirement; finite domains include totals/query when capped                                  |
| candidates                  | Deterministic ordered admissible entries scoped to this revision/role; ranking is not selection or autofix authorization                              |
| candidate totals/truncation | Total is full domain cardinality, not returned length; truncated true iff omitted entries; queries require same revision identity                     |
| repair                      | `{ kind, applicable, target, expected, reason }`; known suggested operation or explicit non-applicability; never fabricate a safe fix from prose      |
| autofix                     | null in protocol v1; structured suggestion is not edit authorization; future automatic edit policy needs a separately versioned contract              |
| affectedRegion/coverage     | Local failed region and known analysis/origin evidence; full closure/relay paths are paginated or audit detail, not mandatory hot-path payload        |
| revision                    | Exact evaluated snapshot; stale query/result cannot claim validity for current source                                                                 |
| completeness                | Validation coverage verdict and input trust evidence, distinct from list truncation and audit materialization                                         |
| generation/milestones/audit | Distinguish diagnostics ready, staged artifacts, committed generation, actual audit existence                                                         |

Default candidate bound 32 and affected-entry bound 64 keep compact results
bounded. Hosts may request smaller bounds; truncation is always explicit.
Candidate and affected query responses must bind the same revision and
deterministic order. Do not put uncapped `context.admitted`, cycle paths or
relay chains into the compact result: long data uses a capped list/total/query
or revision-bound audit reference. Diagnostic lists may be bounded only with
diagnosticsTotal/truncated and a revision-bound full diagnostic query/artifact;
ok considers all diagnostics, not the displayed prefix. Ordinary compact success
size depends on local result counts, not project graph serialization.

Completeness status is `complete`, `partial` or `unknown`. Complete means all
declared coverage has a validated answer under the named discovery evidence;
host-reported-set is explicitly a completeness assumption, not independent
observation of all filesystem mutations. Watcher evidence is `watcher-journal`;
full-discovery evidence is `filesystem-scan`. Loss/resync must produce full
discovery or partial/unknown with ok false. A fully analysed forbidden-value
revision can be complete and invalid. Truncated candidates do not imply partial
validation. External CSS/DOM manipulation outside configured coverage is outside
the guarantee, never silently certified.

## Stable code families and repairs

| Codes                                                                                 | Structured expectation/repair                                                                                                            |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| PMS_UNKNOWN_TOKEN, PMS_DUPLICATE_TOKEN, PMS_TOKEN_CYCLE                               | Declared unique acyclic token graph; choose known token/rename definition/break cycle; global graph defects may lack local repair        |
| PMS_INVALID_TOKEN_CATEGORY, PMS_TOKEN_NOT_PUBLIC, PMS_FORBIDDEN_VALUE                 | Category/visibility or structural domain; choose admissible public token/value; never suggest enabling page access to private vocabulary |
| PMS_UNSUPPORTED_PROPERTY, PMS_UNSUPPORTED_PROPERTY_FORM                               | Supported property/longhand form; no arbitrary raw CSS escape                                                                            |
| PMS_UNKNOWN_CONDITION                                                                 | Named declared condition; choose manifest condition                                                                                      |
| PMS_INVALID_VARIANT_KEY, PMS_INVALID_VARIANT_VALUE                                    | Declared recipe axis/domain/defaults; choose generated selection                                                                         |
| PMS_UNSUPPORTED_FEATURE, PMS_NON_STATIC_VALUE                                         | Capability/static expression required; retain false capability or replace unsupported expression                                         |
| PMS_FORBIDDEN_IMPORT, PMS_FORBIDDEN_STYLE_CHANNEL, PMS_ROLE_VIOLATION                 | Import/channel/role boundary; remove forbidden source or correct author role; do not weaken closed policy                                |
| PMS_UNVERIFIED_JSX_SPREAD, PMS_UNVERIFIED_PROPS_SOURCE, PMS_UNVERIFIED_PROVENANCE     | Identity proof required; repair not automatically applicable when provenance cannot be demonstrated                                      |
| PMS_COVERAGE_GAP                                                                      | Resolve declared source/import/host coverage mismatch; never silently exempt missing source                                              |
| PMS_STALE_REVISION, PMS_SUPERSEDED_REVISION, PMS_INVALID_REVISION, PMS_SESSION_CLOSED | Lifecycle precondition; fetch current state/new transaction or reopen, no retry against silently substituted revision                    |
| PMS_ABI_MISMATCH, PMS_GENERATED_ARTIFACT_MISMATCH                                     | Regenerate using supported compiler/core contract; no donor/raw fallback                                                                 |

Lifecycle and ABI codes use the same structured format. Unknown repairs return
`kind: 'unknown', applicable: false` with
reason; message does not become authority. Full code context must retain binding
ambiguity, resolution edge and role facts required for repair. No diagnostics
weakening merely to preserve a small result.

Runtime selection errors contain schemaVersion/code/severity/phase/rule/context/
expected/candidates/repair/autofix and nullable source/role/revision. Core
cannot invent a compiler revision or certify coverage. The host may attach a
revision only if it proves the executing generated artifacts' identity. Runtime
errors and compiler results share semantic rule codes, not lifecycle
assumptions.

## Audit and protocol evolution

On-demand full audit owns the detailed graph/coverage snapshot and must name
revision, design digest, ABI, published generation when any, materialization
path, bytes/digest and before/after-publication placement. Pending request is
not a file. Post-publication audit cannot rewrite an immutable committed report.
Coverage reports and build reports are separate, versioned documents; a
reference to one does not imply that it has been materialized. No background
work is implied by a result reference.

Additive optional context/extensions/new codes are allowed in v1. Consumers
ignore unknown optional fields but reject unsupported document/schema versions.
Removing mandatory fields or changing coordinate, `ok`, revision, or candidate
semantics requires a new schema. Consumers must use structured fields rather
than infer authority from message text, and compiler changes are checked against
independent authored fixtures.
