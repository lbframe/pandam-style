# ADR 0005: Runtime/compiler boundary

Status: Accepted. Date: 2026-09-30. Decisions: ARCH-13, ARCH-14.

## Context

PandamStyle is a standalone compiler/runtime for agent composition. This
record documents one architectural decision used in the Alpha 1 product. See
the [package architecture](../package-architecture-v1.md),
[public API](../public-api-v0.1.md), and [installation contract](../../agent-install.md)
for current package boundaries and supported integrations.

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

These decisions are architecture background for the Alpha 1 source. Current
support combinations and mode constraints are defined in the
[installation contract](../../agent-install.md), with package details in
[package architecture](../package-architecture-v1.md), [public API](../public-api-v0.1.md),
[generated ABI](../generated-design-system-abi-v1.md), and
[diagnostics protocol](../diagnostics-protocol-v1.md).
