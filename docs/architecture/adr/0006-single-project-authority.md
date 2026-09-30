# ADR 0006: Single project authority

Status: Accepted after exact canonical master-plan reconciliation. Date:
2026-09-30. Phase: architecture/specification only. Decisions: ARCH-15.

## Context

PandamStyle is a standalone compiler/runtime for agent composition. The audited
baseline is d49a7eabf6a6df4eda44cc405f6824158fafd4be; existing revision-based
compiler assets must survive migration. The exact canonical
[master plan](../../../master-plan.md) is now present and this decision has been
checked in the [reconciliation matrix](../master-plan-reconciliation.md). This
ADR does not amend or replace the plan.

## Decision

Every production host uses createProjectSession and exact revision identities
through one canonical service owner. Revision acceptance, validation, audit and
publication are distinct lifecycle operations.

## Alternatives and rationale

Host-specific caches can disagree on resolution, coverage and generation
validity. A fresh one-shot algorithm remains an independent oracle, not a second
production authority.

## Consequences and acceptance evidence

Session-owned positive/negative resolution, coverage graph, design-system views
and CSS state survive migration. Stale operations fail; no-op revisions may
reuse committed generations.

Normative details: [public API](../public-api-v0.1.md),
[packages](../package-architecture-v1.md),
[ABI](../generated-design-system-abi-v1.md),
[diagnostics](../diagnostics-protocol-v1.md),
[module map](../current-to-target-module-map.md) and
[target tree](../target-repository-tree.md). No production source, manifests,
dependencies, moves or deletions belong to this ADR batch.
