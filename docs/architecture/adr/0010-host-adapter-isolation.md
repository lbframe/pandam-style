# ADR 0010: Host adapter isolation

Status: Accepted. Date: 2026-09-30. Decisions: ARCH-18, ARCH-19.

## Context

PandamStyle is a standalone compiler/runtime for agent composition. This
record documents one architectural decision used in the Alpha 1 product. See
the [package architecture](../package-architecture-v1.md),
[public API](../public-api-v0.1.md), and [installation contract](../../agent-install.md)
for current package boundaries and supported integrations.

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

These decisions are architecture background for the Alpha 1 source. Current
support combinations and mode constraints are defined in the
[installation contract](../../agent-install.md), with package details in
[package architecture](../package-architecture-v1.md), [public API](../public-api-v0.1.md),
[generated ABI](../generated-design-system-abi-v1.md), and
[diagnostics protocol](../diagnostics-protocol-v1.md).
