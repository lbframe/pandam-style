# ADR 0004: Generated design-system import model

Status: Accepted after exact canonical master-plan reconciliation. Date:
2026-09-30. Phase: architecture/specification only. Decisions: ARCH-04.

## Context

PandamStyle is a standalone compiler/runtime for agent composition. The audited
baseline is d49a7eabf6a6df4eda44cc405f6824158fafd4be; existing revision-based
compiler assets must survive migration. The exact canonical
[master plan](../../../master-plan.md) is now present and this decision has been
checked in the [reconciliation matrix](../master-plan-reconciliation.md). This
ADR does not amend or replace the plan.

## Decision

Application source imports create/token/props/recipes/themes from the
authenticated generated design module (Model A). Core has no duplicate
create/token value API.

## Alternatives and rationale

Model B separates generic intrinsics from design authority and requires extra
provenance and typing context. An unscoped facade cannot hold project-specific
domains without generation.

## Consequences and acceptance evidence

Named/namespace/barrel exports resolve by binding identity; ambiguity and
mutable escapes fail closed. Generated facade/types/manifest use the same
registry identity.

Normative details: [public API](../public-api-v0.1.md),
[packages](../package-architecture-v1.md),
[ABI](../generated-design-system-abi-v1.md),
[diagnostics](../diagnostics-protocol-v1.md),
[module map](../current-to-target-module-map.md) and
[target tree](../target-repository-tree.md). No production source, manifests,
dependencies, moves or deletions belong to this ADR batch.
