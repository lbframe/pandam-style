# ADR 0003: Authoring API

Status: Accepted after exact canonical master-plan reconciliation. Date:
2026-09-30. Phase: architecture/specification only. Decisions: ARCH-03, ARCH-05,
ARCH-06, ARCH-07, ARCH-08, ARCH-09, ARCH-10, ARCH-11, ARCH-12.

## Context

PandamStyle is a standalone compiler/runtime for agent composition. The audited
baseline is d49a7eabf6a6df4eda44cc405f6824158fafd4be; existing revision-based
compiler assets must survive migration. The exact canonical
[master plan](../../../master-plan.md) is now present and this decision has been
checked in the [reconciliation matrix](../master-plan-reconciliation.md). This
ADR does not amend or replace the plan.

## Decision

KEEP create, props, token, recipes, themes, conditions and variants. KEEP slot
recipes, compound variants and patterns as product concepts; DEFER their
implementation to Phase 12 after Phase 11 closes, with compiler
declaration/extraction ownership and core finite selection; patterns are
StyleRef producers, not React components.

## Alternatives and rationale

Ancestry alone justifies neither replacement nor preservation. Constrained
static namespace styles and finite selectors fit atomic extraction and agent
composition. Nested token-object authoring is rejected in favor of typed literal
paths.

## Consequences and acceptance evidence

Preserve independent semantic/cascade/provenance/default fixtures before
adapting serialization. Deferred capabilities remain false; agents cannot
redefine recipes or invent token domains.

Normative details: [public API](../public-api-v0.1.md),
[packages](../package-architecture-v1.md),
[ABI](../generated-design-system-abi-v1.md),
[diagnostics](../diagnostics-protocol-v1.md),
[module map](../current-to-target-module-map.md) and
[target tree](../target-repository-tree.md). No production source, manifests,
dependencies, moves or deletions belong to this ADR batch.
