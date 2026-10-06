# ADR 0002: Central runtime package name

Status: Accepted. Date: 2026-09-30. Decisions: ARCH-02.

## Context

PandamStyle is a standalone compiler/runtime for agent composition. This
record documents one architectural decision used in the Alpha 1 product. See
the [package architecture](../package-architecture-v1.md),
[public API](../public-api-v0.1.md), and [installation contract](../../agent-install.md)
for current package boundaries and supported integrations.

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

These decisions are architecture background for the Alpha 1 source. Current
support combinations and mode constraints are defined in the
[installation contract](../../agent-install.md), with package details in
[package architecture](../package-architecture-v1.md), [public API](../public-api-v0.1.md),
[generated ABI](../generated-design-system-abi-v1.md), and
[diagnostics protocol](../diagnostics-protocol-v1.md).
