# ADR 0001: Package topology

Status: Accepted. Date: 2026-09-30. Decisions: ARCH-01.

## Context

PandamStyle is a standalone compiler/runtime for agent composition. This
record documents one architectural decision used in the Alpha 1 product. See
the [package architecture](../package-architecture-v1.md),
[public API](../public-api-v0.1.md), and [installation contract](../../agent-install.md)
for current package boundaries and supported integrations.

## Decision

Five release boundaries: @pandamstyle/core, @pandamstyle/compiler,
@pandamstyle/vite, @pandamstyle/next, and @pandamstyle/rsbuild. CLI, watcher,
and config live in compiler. No internal domain is an npm package.

## Alternatives and rationale

One monolithic package would expose Node code beside browser code and couple
host releases. More packages for tokens, graphs or protocols add versioning
without an independent consumer boundary.

## Consequences and acceptance evidence

Packaging must prove browser/build separation and zero donor
runtime/peer/bundled imports; Host integration support is limited to the versions and modes in the Alpha 1 installation contract.

These decisions are architecture background for the Alpha 1 source. Current
support combinations and mode constraints are defined in the
[installation contract](../../agent-install.md), with package details in
[package architecture](../package-architecture-v1.md), [public API](../public-api-v0.1.md),
[generated ABI](../generated-design-system-abi-v1.md), and
[diagnostics protocol](../diagnostics-protocol-v1.md).
