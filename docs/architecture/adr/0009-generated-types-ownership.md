# ADR 0009: Generated types ownership

Status: proposed pending exact canonical master-plan reconciliation. Date:
2026-09-30. Phase: architecture/specification only. Decisions: ARCH-17.

## Context

PandamStyle is a standalone compiler/runtime for agent composition. The audited
baseline is d49a7eabf6a6df4eda44cc405f6824158fafd4be; existing revision-based
compiler assets must survive migration. The phase brief is available but
master-plan.md is missing. Acceptance must wait for its exact contents; this ADR
does not amend or replace the plan.

## Decision

Core owns runtime types, compiler owns SDK/protocol/config types, compiler emits
adjacent per-system design.d.ts from the same registry/digest and ABI 1 in
Phase 6.

## Alternatives and rationale

Generic unrestricted string/record typing loses vocabulary authority; an
independent types package duplicates release/version responsibility.

## Consequences and acceptance evidence

Type-only imports do not pull compiler into app. Tokens have category/path
unions; recipes have finite axes/domains; future slots/patterns appear only when
capability is delivered. Compiler validation remains authoritative.

Normative details: [public API](../public-api-v0.1.md),
[packages](../package-architecture-v1.md),
[ABI](../generated-design-system-abi-v1.md),
[diagnostics](../diagnostics-protocol-v1.md),
[module map](../current-to-target-module-map.md) and
[target tree](../target-repository-tree.md). No production source, manifests,
dependencies, moves or deletions belong to this ADR batch.
