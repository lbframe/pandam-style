# ADR 0002: Central runtime package name

Status: Accepted after exact canonical master-plan reconciliation. Date:
2026-09-30. Phase: architecture/specification only. Decisions: ARCH-02.

## Context

PandamStyle is a standalone compiler/runtime for agent composition. The audited
baseline is d49a7eabf6a6df4eda44cc405f6824158fafd4be; existing revision-based
compiler assets must survive migration. The exact canonical
[master plan](../../../master-plan.md) is now present and this decision has been
checked in the [reconciliation matrix](../master-plan-reconciliation.md). This
ADR does not amend or replace the plan.

## Decision

Name the browser runtime @pandamstyle/core after choosing its
ABI/composition/selection responsibilities. Reject an unscoped pandamstyle
duplicate facade.

## Alternatives and rationale

@pandamstyle/css suggests unrestricted CSS authoring, dev mislabels production
runtime, pstyle has no clearer responsibility. An unscoped installer or alias
supplies no independent architectural capability.

## Consequences and acceptance evidence

Generated modules import core; application value authoring stays generated and
type-only core imports are permitted.

Normative details: [public API](../public-api-v0.1.md),
[packages](../package-architecture-v1.md),
[ABI](../generated-design-system-abi-v1.md),
[diagnostics](../diagnostics-protocol-v1.md),
[module map](../current-to-target-module-map.md) and
[target tree](../target-repository-tree.md). No production source, manifests,
dependencies, moves or deletions belong to this ADR batch.
