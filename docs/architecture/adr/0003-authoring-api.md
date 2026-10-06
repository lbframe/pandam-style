# ADR 0003: Authoring API

Status: Accepted. Date: 2026-09-30. Decisions: ARCH-03, ARCH-05,
ARCH-06, ARCH-07, ARCH-08, ARCH-09, ARCH-10, ARCH-11, ARCH-12.

## Context

PandamStyle is a standalone compiler/runtime for agent composition. This
record documents one architectural decision used in the Alpha 1 product. See
the [package architecture](../package-architecture-v1.md),
[public API](../public-api-v0.1.md), and [installation contract](../../agent-install.md)
for current package boundaries and supported integrations.

## Decision

The authoring API includes `create`, `props`, `token`, recipes, themes,
conditions, variants, slot recipes, compound variants, and layout patterns.
The compiler validates declarations and emits finite runtime references;
patterns produce style references rather than React components.

## Alternatives and rationale

Ancestry alone justifies neither replacement nor preservation. Constrained
static namespace styles and finite selectors fit atomic extraction and agent
composition. Nested token-object authoring is rejected in favor of typed literal
paths.

## Consequences and acceptance evidence

Keep semantic, cascade, provenance, and default-selection behavior covered by
independent tests. Agents select from authored recipes and token domains rather
than defining new design-system vocabulary in application code.

These decisions are architecture background for the Alpha 1 source. Current
support combinations and mode constraints are defined in the
[installation contract](../../agent-install.md), with package details in
[package architecture](../package-architecture-v1.md), [public API](../public-api-v0.1.md),
[generated ABI](../generated-design-system-abi-v1.md), and
[diagnostics protocol](../diagnostics-protocol-v1.md).
