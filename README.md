![PandamStyle Alpha 1](assets/pandamstyle-alpha1-banner.webp)

# PandamStyle

PandamStyle is a constrained styling language and compiler. It lets AI coding
agents compose interfaces from design-system semantics instead of inventing
arbitrary micro-design.

**Agents compose. PandamStyle enforces the design system.**

## Install with your agent

Paste this into your coding agent:

```text
Install PandamStyle in this project by following:
https://github.com/lbframe/pandam-style/blob/main/docs/agent-install.md
```

## What your agent can do

- Build interfaces with PandamStyle.
- Compose from tokens, styles, recipes, slot recipes, compound variants,
  patterns, and themes.
- Follow an existing design system rather than inventing visual values.
- Compile, diagnose, and repair invalid PandamStyle output.
- Install for a qualified host while preserving the current styling system.
- Audit a project, plan and execute a migration, and benchmark before and after.

## Start here

```text
Build this interface using the project's PandamStyle design system.
```

```text
Audit this project for migration to PandamStyle.
```

```text
Migrate this project to PandamStyle and verify the result.
```

```text
Benchmark this project with PandamStyle.
```

## Supported stacks

The combinations below are the Alpha 1 host support boundary. The exact
versions and modes matter; compatibility with a package's peer range does not
qualify other versions or bundlers. See the [installation contract](docs/agent-install.md)
for required commands and configuration.

| Stack | Status | Qualified scope |
| --- | --- | --- |
| Vite 8 / Rolldown (tested with Vite 8.3.1) | Supported | Development edits and HMR, production, SSR, source maps |
| Next.js 16 / webpack (tested with 16.3.8) | Supported | Development, production, SSR, source maps |
| Next.js 16 / Turbopack (tested with 16.3.8) | Compatibility-tested | Semantic development and fresh-build equivalence; this is not a general Turbopack production qualification |
| Rsbuild 2.2.11 / Rspack 2.2.8 | Supported | Local and global edits, production, maps, recovery and full-reload policy |
| Other host, bundler, or major-version combinations | Not yet qualified | Do not infer support from package dependency compatibility |

## Why PandamStyle

The design system defines the styling vocabulary; the agent chooses how to
compose it. Semantic tokens, recipes and slot recipes, compound variants,
layout patterns, and themes express reusable design decisions. The compiler
checks those constraints, generates types, and returns actionable diagnostics.
Its incremental Project Service supports a generation → compilation → repair
loop as an agent changes a project.

## Alpha status

PandamStyle Alpha 1 is intended for real-world testing. Its API and behavior may
evolve, and it is not presented as production-stable. Feedback on agent use,
installation, host behavior, and diagnostics is welcome in
[GitHub issues](https://github.com/lbframe/pandam-style/issues).

The Alpha 1 release notes describe the supported package versions and the
release process. Qualification artifacts and development captures are kept out
of this source repository; its CI workflow covers contributor verification.

## Performance reference

The retained [Alpha 1 reference dataset](benchmarks/alpha1-reference.json)
contains synthetic compiler-workload measurements with their method and
environment metadata. They are reference results for those workloads, not
host-visible application latency or predictions for another project.

## Agent documentation

These contracts keep task instructions focused; load only the workflow needed:

- [Install](docs/agent-install.md)
- [Build interfaces](docs/agent-use.md)
- [Audit a project](docs/agent-audit.md)
- [Plan or execute a migration](docs/agent-migration.md)
- [Benchmark](docs/agent-benchmark.md)
- [Repair compiler diagnostics](docs/agent-repair.md) and the [reference](docs/reference/README.md)
- [PandamStyle agent skill](.agents/skills/pandamstyle/SKILL.md)
