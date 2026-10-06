---
name: pandamstyle
description: Build and repair interfaces with PandamStyle's constrained design-system vocabulary, or install, audit, migrate, and benchmark PandamStyle in a project.
---

# PandamStyle

Use this skill when a project uses PandamStyle or the user asks to build with,
install, audit, migrate to, repair, or benchmark it. Building interfaces is the
primary workflow.

> The page-generation LLM performs composition, not micro-design.

Compose with the project's existing design-system vocabulary, then let the
compiler validate the result. Agents compose; PandamStyle enforces the design
system.

## Route by intent

Read only the contract for the requested task. Resolve paths from the PandamStyle
repository root; in another project use the canonical links below. For exact API
questions, start with [`docs/reference/README.md`](../../../docs/reference/README.md)
and open only the relevant reference page.

| User intent | Read |
| --- | --- |
| “Build this page/component with PandamStyle” | [`docs/agent-use.md`](../../../docs/agent-use.md), then the relevant reference page |
| “Install PandamStyle here” | [`docs/agent-install.md`](../../../docs/agent-install.md) |
| “Audit this project” | [`docs/agent-audit.md`](../../../docs/agent-audit.md) |
| “Plan a migration” | [`docs/agent-audit.md`](../../../docs/agent-audit.md), then [`docs/agent-migration.md`](../../../docs/agent-migration.md) |
| “Migrate this project” | Audit result, [`docs/agent-migration.md`](../../../docs/agent-migration.md), and [`docs/agent-use.md`](../../../docs/agent-use.md) |
| “Benchmark or compare this project” | [`docs/agent-benchmark.md`](../../../docs/agent-benchmark.md) |
| “Fix a PandamStyle compiler error” | [`docs/agent-repair.md`](../../../docs/agent-repair.md), then the relevant reference page |

Canonical public documents use `https://github.com/lbframe/pandam-style/blob/main/` followed by the same `docs/...` path. Do not load every contract for a single task.

## Build with the project vocabulary

Before changing styles, inspect the PandamStyle configuration, generated design
module and nearby components. Follow the project's existing tokens, recipes,
slot recipes, compound variants, patterns, themes and registered conditions.
Use generated types and compiler diagnostics as constraints; do not bypass them
with casts or raw style channels.

Choose the narrowest existing primitive that expresses the intent:

| Need | Prefer |
| --- | --- |
| A design-approved value such as spacing, color or type | Existing semantic token |
| A small, unique treatment with no reusable component or layout meaning | An allowed static style using project vocabulary |
| Reusable component variants | Existing recipe |
| Coordinated styles across named component parts | Existing slot recipe |
| A supported combination of recipe variants | Existing compound variant |
| A standard constrained layout | Existing pattern |
| A named palette or semantic token mapping | Existing theme |

Do not invent arbitrary values, unsupported CSS, runtime style objects, new
tokens, or design-system entities to make a compile error disappear. If the
design system lacks a needed concept, check `agent-use.md` for the documented
extension path; otherwise report the gap instead of guessing.

For a build task, follow:

```text
intent → existing PandamStyle vocabulary → compose → compile → diagnose → repair → compile again
```

Use the project's documented compile/check path. Do not invent commands. Make a
local repair when possible; do not rewrite a component or design system to fix a
single diagnostic.

## Modification boundaries

- Installation is separate from migration. Installing MUST preserve the
  existing styling system; stop if the detected host is not qualified by the
  install contract.
- An audit MUST be read-only.
- Migration MUST preserve visible behavior unless the user explicitly requests
  a design change. Plan first, migrate in bounded batches, compile and verify
  each batch, and do not silently redesign.
- A benchmark estimate MUST say that no workload was executed. A deep result
  MUST report what was measured, what was unavailable, and any material
  environment difference. Never invent or relabel measurements.
- Do not claim a workflow, command, host, or API is supported just because a
  dependency appears compatible. Follow the current contract and qualified
  evidence.

When work is complete, report the files changed, checks run and their outcome,
diagnostics repaired or remaining, and any unsupported or unmeasured areas.
