# ADR 0005: Runtime/compiler boundary

Status: proposed pending exact canonical master-plan reconciliation. Date:
2026-09-30. Phase: architecture/specification only. Decisions: ARCH-13, ARCH-14.

## Context

PandamStyle is a standalone compiler/runtime for agent composition. The audited
baseline is d49a7eabf6a6df4eda44cc405f6824158fafd4be; existing revision-based
compiler assets must survive migration. The phase brief is available but
master-plan.md is missing. Acceptance must wait for its exact contents; this ADR
does not amend or replace the plan.

## Decision

Core reads compiled refs and selects finite recipe data. Compiler owns source
evaluation, token trust/category validation, extraction, graphs and publication;
compiler may use core shared finite selection.

## Alternatives and rationale

Shipping compiler/runtime as a browser entry blurs ownership; a runtime CSS
object interpreter contradicts constrained extracted vocabulary. No separate
protocol package is needed.

## Consequences and acceptance evidence

ABI 1 is donor-free and version checked. Core has no filesystem/Babel/React/host
dependency; browser bundles and independent composition vectors verify the
boundary.

Normative details: [public API](../public-api-v0.1.md),
[packages](../package-architecture-v1.md),
[ABI](../generated-design-system-abi-v1.md),
[diagnostics](../diagnostics-protocol-v1.md),
[module map](../current-to-target-module-map.md) and
[target tree](../target-repository-tree.md). No production source, manifests,
dependencies, moves or deletions belong to this ADR batch.
