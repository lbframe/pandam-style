# PandamStyle product contract

## Audience and purpose

PandamStyle is exclusively for AI/LLM agents. This is the mandatory product
audience and design objective for its language, SDK, CLI, diagnostics, workflows
and documentation. Agents compose interfaces from an explicitly constrained
design-system vocabulary. The product reduces arbitrary micro-design by making
the compiler enforce the approved semantics.

This section sets product policy; it does not claim that Alpha 1 has already
removed every surface inherited from human-oriented tooling. Implementation
status and the accepted removal plan are recorded below.

## Vocabulary authority

The design-system definition owns semantic tokens, finite value domains,
conditions, recipes, slots, variants, themes and supported patterns. Consumer
agents select and compose that vocabulary. They must not silently add tokens,
broaden domains, introduce raw style channels or weaken policy to repair an
interface. An authorized design-system change is a separate operation from
consumer composition; the existing [use contract](agent-use.md) defines that
workflow boundary.

Compiler validation is authoritative over generated types and LLM output.
Types describe the validated vocabulary; a cast or successful typecheck cannot
authorize compiler-invalid source. Missing vocabulary is an explicit gap to
report or change under authorization.

## Compilation and repair

The compiler generates each project's design module and adjacent declarations
from the same validated definition. Generated output is compiler-owned and
must be regenerated, never manually patched. Compilation statically extracts
CSS. At execution time, the runtime composes precompiled references and finite
selections; it must not inject styles or interpret arbitrary style objects.

One canonical Project Service owns revision identity, validation and publication.
Hosts integrate that service while retaining bundler and framework lifecycle
responsibilities. They must not duplicate compiler policy or publish alternate
generated truth. Structured diagnostics support the agent's generation →
compilation → repair loop. A typecheck, a diagnostic result and a committed
generation are distinct outcomes.

## Current status and planned change

The repository implements Alpha 1 (`0.1.0-alpha.1` in the five package
manifests). Its [installation contract](agent-install.md) is the source for
qualified host versions and modes; broader compatibility cannot be inferred
from dependency ranges. The release is not a production-stability claim.

Alpha 1 still includes formatted diagnostic output, CLI usage/configuration
messages and a browser diagnostic display overlay; examples include
[`api/cli.js`](../packages/compiler/src/api/cli.js) and
[`vite/src/index.js`](../packages/vite/src/index.js). These presentation paths
are known deviations from
the exclusive agent audience. [AG-13 in the accepted plan](architecture/agentic-optimizations-plan.md)
requires removing surfaces reserved for human use. The
[accepted review](architecture/agentic-optimizations-review.md) records the plan's
review, not completion of its implementation. The wider agentic optimization
roadmap is future work; this documentation migration implements none of it.

Source review supports the current architecture documented here. This migration
does not establish new runtime, performance, browser or host qualifications.
