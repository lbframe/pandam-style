# ADR 0006: Single project authority

Status: Accepted. Date: 2026-09-30. Decisions: ARCH-15.

## Context

PandamStyle is a standalone compiler/runtime for agent composition. This
record documents one architectural decision used in the Alpha 1 product. See
the [package architecture](../package-architecture-v1.md),
[public API](../public-api-v0.1.md), and [installation contract](../../agent-install.md)
for current package boundaries and supported integrations.

## Decision

Every production host uses createProjectSession and exact revision identities
through one canonical service owner. Revision acceptance, validation, audit and
publication are distinct lifecycle operations.

## Alternatives and rationale

Host-specific caches can disagree on resolution, coverage and generation
validity. A fresh one-shot algorithm remains an independent oracle, not a second
production authority.

## Consequences and acceptance evidence

Session-owned positive/negative resolution, coverage graph, design-system views
and CSS state survive migration. Stale operations fail; no-op revisions may
reuse committed generations.

These decisions are architecture background for the Alpha 1 source. Current
support combinations and mode constraints are defined in the
[installation contract](../../agent-install.md), with package details in
[package architecture](../package-architecture-v1.md), [public API](../public-api-v0.1.md),
[generated ABI](../generated-design-system-abi-v1.md), and
[diagnostics protocol](../diagnostics-protocol-v1.md).
