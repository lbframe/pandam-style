# ADR 0001: Package topology

Status: proposed pending exact canonical master-plan reconciliation. Date:
2026-09-30. Phase: architecture/specification only. Decisions: ARCH-01.

## Context

PandamStyle is a standalone compiler/runtime for agent composition. The audited
baseline is d49a7eabf6a6df4eda44cc405f6824158fafd4be; existing revision-based
compiler assets must survive migration. The phase brief is available but
master-plan.md is missing. Acceptance must wait for its exact contents; this ADR
does not amend or replace the plan.

## Decision

Four release boundaries: @pandamstyle/core, @pandamstyle/compiler,
@pandamstyle/vite and @pandamstyle/next. CLI, watcher and config live in
compiler. No internal domain is an npm package.

## Alternatives and rationale

One monolithic package would expose Node code beside browser code and couple
host releases. More packages for tokens, graphs or protocols add versioning
without an independent consumer boundary.

## Consequences and acceptance evidence

Packaging must prove browser/build separation and zero donor
runtime/peer/bundled imports; Next package remains future work.

Normative details: [public API](../public-api-v0.1.md),
[packages](../package-architecture-v1.md),
[ABI](../generated-design-system-abi-v1.md),
[diagnostics](../diagnostics-protocol-v1.md),
[module map](../current-to-target-module-map.md) and
[target tree](../target-repository-tree.md). No production source, manifests,
dependencies, moves or deletions belong to this ADR batch.
