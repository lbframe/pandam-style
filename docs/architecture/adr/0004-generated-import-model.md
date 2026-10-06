# ADR 0004: Generated design-system import model

Status: Accepted. Date: 2026-09-30. Decisions: ARCH-04.

## Context

PandamStyle is a standalone compiler/runtime for agent composition. This
record documents one architectural decision used in the Alpha 1 product. See
the [package architecture](../package-architecture-v1.md),
[public API](../public-api-v0.1.md), and [installation contract](../../agent-install.md)
for current package boundaries and supported integrations.

## Decision

Application source imports create/token/props/recipes/themes from the
authenticated generated design module (Model A). Core has no duplicate
create/token value API.

## Alternatives and rationale

Model B separates generic intrinsics from design authority and requires extra
provenance and typing context. An unscoped facade cannot hold project-specific
domains without generation.

## Consequences and acceptance evidence

Named/namespace/barrel exports resolve by binding identity; ambiguity and
mutable escapes fail closed. Generated facade/types/manifest use the same
registry identity.

These decisions are architecture background for the Alpha 1 source. Current
support combinations and mode constraints are defined in the
[installation contract](../../agent-install.md), with package details in
[package architecture](../package-architecture-v1.md), [public API](../public-api-v0.1.md),
[generated ABI](../generated-design-system-abi-v1.md), and
[diagnostics protocol](../diagnostics-protocol-v1.md).
