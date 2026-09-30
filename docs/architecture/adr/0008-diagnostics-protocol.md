# ADR 0008: Diagnostics as a versioned protocol

Status: proposed pending exact canonical master-plan reconciliation. Date:
2026-09-30. Phase: architecture/specification only. Decisions: ARCH-16.

## Context

PandamStyle is a standalone compiler/runtime for agent composition. The audited
baseline is d49a7eabf6a6df4eda44cc405f6824158fafd4be; existing revision-based
compiler assets must survive migration. The phase brief is available but
master-plan.md is missing. Acceptance must wait for its exact contents; this ADR
does not amend or replace the plan.

## Decision

Diagnostics protocol v1 uses pandamstyle-diagnostics-result with structured
code/rule/source/role/context/expected/candidates/repair/revision/completeness
fields. Message is convenience, autofix null.

## Alternatives and rationale

Prose parsing, silent truncation and unversioned envelopes make automated repair
unreliable. Compact results must not serialize the full graph.

## Consequences and acceptance evidence

Separate diagnostics/staging/commit/audit milestones. Full candidate/coverage
details are revision-bound queries/audits. Existing historical wire versions
need explicit migration mapping.

Normative details: [public API](../public-api-v0.1.md),
[packages](../package-architecture-v1.md),
[ABI](../generated-design-system-abi-v1.md),
[diagnostics](../diagnostics-protocol-v1.md),
[module map](../current-to-target-module-map.md) and
[target tree](../target-repository-tree.md). No production source, manifests,
dependencies, moves or deletions belong to this ADR batch.
