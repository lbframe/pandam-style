# ADR 0010: Host adapter isolation

Status: proposed pending exact canonical master-plan reconciliation. Date:
2026-09-30. Phase: architecture/specification only. Decisions: ARCH-18, ARCH-19.

## Context

PandamStyle is a standalone compiler/runtime for agent composition. The audited
baseline is d49a7eabf6a6df4eda44cc405f6824158fafd4be; existing revision-based
compiler assets must survive migration. The phase brief is available but
master-plan.md is missing. Acceptance must wait for its exact contents; this ADR
does not amend or replace the plan.

## Decision

Vite and Next adapters use only the public/advanced compiler SDK and immutable
revision-bound artifacts/tickets. Hosts own
bundling/chunking/loading/HMR/framework lifecycle; compiler owns
CSS/design/provenance/generation truth.

## Alternatives and rationale

Private compiler imports and adapter rule maps create alternate compilers. Next
webpack integration cannot certify Turbopack.

## Consequences and acceptance evidence

Accept domain tree with private observability added. Host failure aborts
canonical staged publication. Backend support is explicit and tested separately;
advanced HMR/native implementation remains deferred.

Normative details: [public API](../public-api-v0.1.md),
[packages](../package-architecture-v1.md),
[ABI](../generated-design-system-abi-v1.md),
[diagnostics](../diagnostics-protocol-v1.md),
[module map](../current-to-target-module-map.md) and
[target tree](../target-repository-tree.md). No production source, manifests,
dependencies, moves or deletions belong to this ADR batch.
