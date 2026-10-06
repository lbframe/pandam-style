# ADR 0009: Generated types ownership

Status: Accepted. Date: 2026-09-30. Decisions: ARCH-17.

## Context

PandamStyle is a standalone compiler/runtime for agent composition. This
record documents one architectural decision used in the Alpha 1 product. See
the [package architecture](../package-architecture-v1.md),
[public API](../public-api-v0.1.md), and [installation contract](../../agent-install.md)
for current package boundaries and supported integrations.

## Decision

Core owns runtime types. The compiler owns SDK, protocol, and configuration
types and emits adjacent per-system declarations from the same validated
design-system definition as the generated module.

## Alternatives and rationale

Generic unrestricted string/record typing loses vocabulary authority; an
independent types package duplicates release/version responsibility.

## Consequences and acceptance evidence

Type-only imports do not pull compiler code into the application runtime.
Generated types describe token categories and paths, finite recipe domains,
themes, slots, and supported layout patterns. Compiler validation remains
authoritative.

These decisions are architecture background for the Alpha 1 source. Current
support combinations and mode constraints are defined in the
[installation contract](../../agent-install.md), with package details in
[package architecture](../package-architecture-v1.md), [public API](../public-api-v0.1.md),
[generated ABI](../generated-design-system-abi-v1.md), and
[diagnostics protocol](../diagnostics-protocol-v1.md).
