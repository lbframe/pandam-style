# ADR 0007: Donor and legacy deletion policy

Status: Accepted. Date: 2026-09-30. Decisions: ARCH-20.

## Context

PandamStyle is a standalone compiler/runtime for agent composition. This
record documents one architectural decision used in the Alpha 1 product. See
the [package architecture](../package-architecture-v1.md),
[public API](../public-api-v0.1.md), and [installation contract](../../agent-install.md)
for current package boundaries and supported integrations.

## Decision

Do not ship upstream source trees or development archives as PandamStyle
packages. Retain required license notices and source attribution for derived
code.

## Alternatives and rationale

Shipping copied source trees would add unowned architecture and blur package
boundaries. Attribution records describe the upstream sources without including
their historical repositories.

## Consequences and acceptance evidence

The public source tree contains the supported PandamStyle implementation and
required attribution. Verification must not be weakened to make a source
boundary pass.

These decisions are architecture background for the Alpha 1 source. Current
support combinations and mode constraints are defined in the
[installation contract](../../agent-install.md), with package details in
[package architecture](../package-architecture-v1.md), [public API](../public-api-v0.1.md),
[generated ABI](../generated-design-system-abi-v1.md), and
[diagnostics protocol](../diagnostics-protocol-v1.md).
