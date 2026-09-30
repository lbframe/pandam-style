# ADR 0007: Donor and legacy deletion policy

Status: Accepted after exact canonical master-plan reconciliation. Date:
2026-09-30. Phase: architecture/specification only. Decisions: ARCH-20.

## Context

PandamStyle is a standalone compiler/runtime for agent composition. The audited
baseline is d49a7eabf6a6df4eda44cc405f6824158fafd4be; existing revision-based
compiler assets must survive migration. The exact canonical
[master plan](../../../master-plan.md) is now present and this decision has been
checked in the [reconciliation matrix](../master-plan-reconciliation.md). This
ADR does not amend or replace the plan.

## Decision

Delete packages/@stylexjs, upstream/stylex and upstream/panda in Phase 5 after
useful behavior/tests and required provenance migrate. Retain legal attribution,
not source archives.

## Alternatives and rationale

legacy/archive/reference-copy trees preserve donor architecture and undermine
standalone ownership. Git history already archives old source.

## Consequences and acceptance evidence

No source deletion in Phase 0. Each later batch lists
moved/deleted/temporary/final assets. Failed tests cannot be weakened to make
deletion pass.

Normative details: [public API](../public-api-v0.1.md),
[packages](../package-architecture-v1.md),
[ABI](../generated-design-system-abi-v1.md),
[diagnostics](../diagnostics-protocol-v1.md),
[module map](../current-to-target-module-map.md) and
[target tree](../target-repository-tree.md). No production source, manifests,
dependencies, moves or deletions belong to this ADR batch.
