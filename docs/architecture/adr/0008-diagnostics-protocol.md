# ADR 0008: Diagnostics as a versioned protocol

Status: Accepted. Date: 2026-09-30. Decisions: ARCH-16.

## Context

PandamStyle is a standalone compiler/runtime for agent composition. This
record documents one architectural decision used in the Alpha 1 product. See
the [package architecture](../package-architecture-v1.md),
[public API](../public-api-v0.1.md), and [installation contract](../../agent-install.md)
for current package boundaries and supported integrations.

## Decision

Diagnostics protocol v1 uses pandamstyle-diagnostics-result with structured
code/rule/source/role/context/expected/candidates/repair/revision/completeness
fields. Message is convenience, autofix null.

## Alternatives and rationale

Prose parsing, silent truncation and unversioned envelopes make automated repair
unreliable. Compact results must not serialize the full graph.

## Consequences and acceptance evidence

Diagnostics, staged output, committed output, and audits are distinct
milestones. Full candidate and coverage details are revision-bound queries or
audits. Coverage and build reports use separate versioned schemas.

These decisions are architecture background for the Alpha 1 source. Current
support combinations and mode constraints are defined in the
[installation contract](../../agent-install.md), with package details in
[package architecture](../package-architecture-v1.md), [public API](../public-api-v0.1.md),
[generated ABI](../generated-design-system-abi-v1.md), and
[diagnostics protocol](../diagnostics-protocol-v1.md).
