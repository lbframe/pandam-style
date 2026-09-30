# PandamStyle Master Implementation Plan

**Status:** Canonical execution plan  
**Baseline:** `d49a7eabf6a6df4eda44cc405f6824158fafd4be`  
**Repository:** `lbframe/pandam-style`  
**Purpose:** Reorganize PandamStyle into a standalone, first-class library designed as PandamStyle from day one, while preserving the proven compiler semantics, incremental architecture, diagnostics, and performance work already completed.

---

## 0. Canonical product definition

PandamStyle is a **standalone CSS/design-system compiler and runtime**.

It is **not**:

- a StyleX wrapper;
- a Panda CSS wrapper;
- a compatibility layer over donor libraries;
- an LB Frame abstraction layer;
- a meta-package that requires applications to install StyleX or Panda alongside PandamStyle.

Historical source ancestry is implementation history, not the target product architecture.

The target product must expose PandamStyle-owned packages, PandamStyle-owned runtime semantics, PandamStyle-owned compiler semantics, and PandamStyle-owned integrations.

The core product principle remains:

> **The page-generation LLM performs composition, not micro-design.**

Agents compose with authorized design-system vocabulary. The compiler enforces constraints and returns structured diagnostics suitable for a generation → validation → repair loop.

---

# 1. Non-negotiable migration invariants

These rules govern every implementation batch.

1. **No permanent compatibility layer.**
2. **No donor package survives in the target architecture.**
3. **No donor source checkout survives in the target repository.**
4. Useful behavior is migrated; useless historical structure is deleted.
5. Git history is the archive. Do not keep `/legacy`, `/old-stylex`, `/archive`, or equivalent trees merely for historical comfort.
6. Legal attribution and provenance are preserved without preserving legacy architecture.
7. No semantic regression is accepted for structural convenience.
8. No failing test is deleted or weakened merely to unblock migration.
9. Fresh correctness and incremental correctness must be independently proven against expected behavior.
10. All production hosts use one compiler/project authority.
11. No host owns a second semantic cache or alternate truth model.
12. No public npm package is created solely because an internal directory exists.
13. The large Next.js pilot does not begin until standalone PandamStyle packaging is real.
14. Native rewrites are evidence-gated; no Rust/Oxc/SWC rewrite based on fashion or assumed speed.
15. The final repository must look like a library designed as PandamStyle from day one.
16. Binding/provenance semantics remain identity-based and fail closed on ambiguity.
17. `incremental(revision N) == fresh(revision N)` remains a required invariant, but not the only oracle.
18. The current verified warm-path architecture is preserved unless a measured, host-visible requirement justifies change.
19. Donor names such as `@stylexjs/*` and `@pandacss/*` must not appear in the final production dependency graph.
20. Every batch must state exactly what is being migrated, what is intentionally deleted, and what remains temporary.

---

# 2. Target public package architecture

The current target package model is:

```text
@pandamstyle/core
@pandamstyle/compiler
@pandamstyle/vite
@pandamstyle/next
```

These names are provisional until Phase 0 is formally accepted, but package responsibilities must remain separated by runtime/build/integration concerns.

## `@pandamstyle/core`

Small application/runtime package.

Owns:

- composition of compiled style references;
- finite recipe selectors;
- theme/runtime references;
- runtime types;
- the compiled-code ABI used by generated design-system modules.

Must not own:

- Babel;
- filesystem access;
- project graphs;
- configuration loading;
- Vite/Next integration;
- compiler session state.

## `@pandamstyle/compiler`

Build-time and project-service package.

Owns:

- parsing/frontend integration;
- semantic analysis;
- binding-aware provenance;
- design-system registry and policy;
- module/resolution graph;
- incremental project state;
- CSS generation and ordering;
- diagnostics protocol;
- artifact generation;
- transactional publication;
- CLI/project SDK.

## `@pandamstyle/vite`

Thin host adapter.

Must use the canonical compiler/project service. It must not contain an alternate compiler or alternate incremental semantics.

## `@pandamstyle/next`

Framework integration.

Webpack and Turbopack support must be qualified separately. A webpack implementation is not Turbopack support.

---

# 3. Target internal compiler domains

Compiler stages are internal directories, not separate npm packages unless later evidence proves a real public/package boundary.

Proposed internal structure:

```text
packages/compiler/src/
  api/
  protocol/

  frontend/
    babel/
    resolution/

  semantics/
    provenance/
    conformance/

  design-system/
    registry/
    tokens/
    themes/
    conditions/
    recipes/
    policy/

  engine/
    atomic/
    lowering/
    ordering/

  project/
    session/
    mutations/
    graph/
    css-state/

  artifacts/
    javascript/
    types/
    css/
    metadata/
    publication/

  hosts/
    watcher/
```

The final tree may differ after Phase 0/architecture review, but the design principle is fixed: **internal modularity without gratuitous npm fragmentation**.

---

# 4. Canonical dependency direction

Target dependency direction:

```text
Application source
      ↓
Generated Design System
      ↓
@pandamstyle/core

Host adapter
      ↓
@pandamstyle/compiler public project SDK
      ↓
Compiler internals
      ↓
PandamStyle-owned semantic + CSS engine
```

Forbidden production directions:

```text
@pandamstyle/core      X→ @stylexjs/*
@pandamstyle/core      X→ @pandacss/*
@pandamstyle/compiler  X→ donor-owned runtime/compiler packages
host adapter           X→ private compiler internals
application source     X→ compiler internals
```

---

# 5. Phase plan

## Phase 0 — Freeze product architecture and public contracts

### Goal

Decide exactly what product is being built before moving implementation.

### Required decisions

Freeze:

- public package model;
- authoring API;
- generated design-system ABI;
- compiler public SDK;
- diagnostics protocol;
- package/runtime/compiler boundaries.

Explicitly decide the future of the current authoring concepts:

```text
create
props
token
recipes
themes
conditions
variants
slot recipes
patterns
```

For each: `KEEP`, `REDESIGN`, or `REMOVE`.

### Deliverables

- `docs/architecture/public-api-v0.1.md`
- `docs/architecture/package-architecture-v1.md`
- `docs/architecture/generated-design-system-abi-v1.md`
- `docs/architecture/diagnostics-protocol-v1.md`
- ADRs for the accepted package/API decisions.

### Exit gate

No unresolved ambiguity about package ownership or the authoring/runtime/compiler boundary.

No structural implementation begins before this gate.

---

## Phase 1 — Freeze semantic truth and migration safety net

### Goal

Create a strong independent semantic oracle before large-scale movement/deletion.

### Required coverage

- tokens;
- semantic tokens;
- themes;
- conditions;
- style creation/composition;
- recipes;
- forwarding/re-exports;
- binding provenance;
- invalid raw values;
- module resolution;
- negative resolution;
- add/delete/rename;
- incremental CSS;
- publication;
- diagnostics;
- coverage;
- revision correctness.

### Required oracle model

```text
expected semantics
      ==
fresh target
      ==
incremental target
```

Old implementation comparison is used only when the old behavior is independently known to be correct.

### Exit gate

A migration can move/delete code and still prove semantic correctness independently.

---

## Phase 2 — Build the real `@pandamstyle/core`

### Goal

Create the standalone PandamStyle runtime/application package.

### Work

- move/reimplement the required runtime composition logic;
- move finite recipe selection logic;
- define compiled style reference types;
- define runtime ABI;
- update generated design-system modules to import PandamStyle-owned runtime APIs;
- eliminate runtime imports from `@stylexjs/stylex` and other donor packages.

### Forbidden

Do not move compiler machinery into core.

### Exit gate

A packed external consumer can run PandamStyle-generated code with:

```text
0 runtime dependencies on @stylexjs/*
0 runtime dependencies on @pandacss/*
```

---

## Phase 3 — Re-home and restructure `@pandamstyle/compiler`

### Goal

Make the compiler structurally owned by PandamStyle instead of living inside StyleX-shaped directories.

### Work

Move the current PandamStyle compiler modules out of:

```text
packages/@stylexjs/babel-plugin/pandamstyle/
```

into PandamStyle-owned compiler domains.

The current ~27 PandamStyle compiler modules must be mapped explicitly to their target domains before movement.

### Additional work

- shrink the public compiler root exports;
- separate stable SDK from internal state/perf/testing utilities;
- preserve binding-aware provenance;
- preserve incremental session semantics;
- preserve diagnostics and publication behavior.

### Exit gate

All PandamStyle-native compiler code lives under PandamStyle-owned paths and passes the Phase 1 oracle.

---

## Phase 4 — Absorb the required StyleX-derived engine code

### Goal

Remove donor package boundaries from the actual product engine.

### Work

Identify the StyleX-derived behavior actually required by PandamStyle, including where applicable:

- atomic rule generation;
- property expansion;
- condition canonicalization/order;
- RTL behavior;
- CSS layers;
- hashing;
- deduplication;
- style composition;
- variable handling.

For each retained subsystem choose explicitly:

```text
MOVE
REFACTOR
REWRITE
```

Do not copy entire donor packages by default.

### Exit gate

Production dependency graphs for:

```text
@pandamstyle/core
@pandamstyle/compiler
```

contain:

```text
0 @stylexjs/*
0 @pandacss/*
```

The semantic oracle remains green.

---

## Phase 5 — Delete donor/legacy repository structure

### Goal

Remove all unnecessary historical architecture once required behavior has been absorbed.

### Required deletions

Target state:

```text
packages/@stylexjs/        ABSENT
upstream/stylex/           ABSENT
upstream/panda/            ABSENT
legacy/archive trees       ABSENT
unused donor examples      ABSENT
unused donor tooling       ABSENT
```

Useful tests must be migrated into PandamStyle-owned tests before originals are deleted.

### Attribution

Keep only the provenance/legal material required for derived code, e.g.:

```text
ATTRIBUTIONS.md
LICENSES/
```

with source repositories, relevant source commits, derived subsystems, and required MIT notices.

Do not preserve donor source checkouts for convenience.

### Exit gate

A repository scan confirms donor code/package trees are gone. Remaining donor names are limited to explicit attribution/provenance documentation and source comments where legally/technically necessary.

---

## Phase 6 — Canonical Design System model and generated artifacts

### Goal

Create one source of truth for all design-system projections.

### Canonical flow

```text
Canonical Design System Registry
        │
        ├─ runtime projection
        ├─ CSS projection
        ├─ TypeScript declarations
        ├─ catalog/metadata
        ├─ diagnostics candidates
        └─ repair metadata
```

### Work

Unify generation of:

- tokens;
- semantic tokens;
- themes;
- conditions;
- recipes;
- runtime data;
- CSS;
- TypeScript declarations;
- agent candidates;
- diagnostics/repair suggestions;
- manifest metadata.

Every projection must carry coherent identity/version information.

### Exit gate

Generated `.d.ts` exists and all generated artifacts are proven to come from the same design-system revision/generation.

---

## Phase 7 — Make the Project Service the single production authority

### Goal

All production consumers use one persistent compiler/project model.

### Target

```text
CLI ─────────┐
Vite ────────┤
Next ────────┤
agent host ──┤
watcher ─────┤
             ▼
      Project Service
             ▼
 canonical project session
```

### Work

- make revision-based project state the production authority;
- remove alternate host-specific semantic sessions;
- eliminate process-global mutable semantic state;
- isolate projects/workspaces;
- preserve transaction/publication semantics;
- define stale revision/supersession behavior;
- expose a deliberately small typed project SDK.

### Exit gate

CLI and host adapters do not own alternate semantic caches or alternate compiler truth.

---

## Phase 8 — Build `@pandamstyle/vite` as a thin adapter

### Goal

Make Vite consume the canonical project service instead of acting as a separate compiler path.

### Required qualification

- dev;
- production build;
- local edit;
- invalid → diagnostic → repair;
- add/delete/rename;
- re-export changes;
- design-system changes;
- CSS updates;
- HMR behavior;
- multiple projects/workspaces;
- revision consistency.

### Performance qualification

Measure host-visible Vite latency rather than assuming internal project-session benchmarks automatically represent Vite behavior.

### Exit gate

Vite behavior is semantically equivalent to fresh compiler behavior and uses the same incremental project authority.

---

## Phase 9 — Standalone package/release qualification

### Goal

Treat PandamStyle as publishable without actually publishing it.

### Required qualification

Use local `npm pack` tarballs in an external project.

Verify:

- package exports;
- generated declarations;
- CLI;
- runtime;
- compiler SDK;
- peer/transitive dependencies;
- ESM/CJS decisions;
- tree shaking;
- supported Node versions;
- tarball contents;
- no workspace alias leakage.

### Hard gate

Installing PandamStyle must not install donor package trees as PandamStyle dependencies.

### Exit gate

A standalone external project consumes only intended PandamStyle packages and third-party infrastructure dependencies, never donor CSS-library packages.

---

## Phase 10 — Build and qualify `@pandamstyle/next`

### Goal

Add real Next.js integration after the standalone architecture exists.

### Qualification matrix

Treat these separately:

```text
Next + webpack dev
Next + webpack production build
Next + Turbopack dev
Next + Turbopack production build
RSC
client components
SSR
hydration
navigation
cache behavior
multiple workers/processes
```

Do not claim Turbopack support from a webpack plugin.

### Exit gate

The supported Next backends are individually proven and documented.

---

## Phase 11 — Large real Next.js pilot

### Goal

Test the intended product architecture in a substantial external application.

### Scenario

```text
real Next.js template/application
        ↓
install packed PandamStyle packages
        ↓
define/migrate design system
        ↓
migrate a meaningful application area
        ↓
agent edits project
        ↓
invalid → structured diagnostics → repair
        ↓
dev + production build
        ↓
SSR/hydration/navigation
        ↓
performance and correctness evidence
```

### Exit gate

PandamStyle works as a real external library in a meaningful Next.js application without donor CSS-library dependencies.

---

## Phase 12 — Expand design-system capabilities

### Goal

Resume product capability work only after the architecture is stable.

Candidate capabilities:

- slot recipes;
- compound variants;
- patterns/layout primitives;
- advanced themes;
- richer generated types;
- source maps;
- advanced HMR.

Patterns/layout are strategically important because they reduce agent micro-design freedom while preserving composition freedom.

### Exit gate

Each capability has semantic tests, generated type coverage, diagnostics, and incremental invalidation behavior.

---

## Phase 13 — Cold/global architecture and native-code research

### Goal

Optimize cold/global paths only after the product architecture and real integrations are stable.

### Measure first

- cold project initialization;
- global design-system mutation;
- large graph changes;
- RSS/memory;
- parallelism;
- real host-visible build latency.

### Candidate experiments

Only if justified by profiles:

- Oxc frontend;
- Rust core;
- SWC alternative;
- native host integration;
- NAPI/WASM boundaries;
- durable query/database architecture.

### Exit gate

Any native rewrite decision is supported by measured PandamStyle-specific evidence and preserves the semantic oracle.

---

# 6. Parallelization model

## Hard sequential dependency chain

The following chain must remain ordered:

```text
Phase 0
  ↓
Phase 1
  ↓
Phase 2 + Phase 3 (controlled parallel work allowed after contracts are frozen)
  ↓
Phase 4
  ↓
Phase 5
  ↓
Phase 6 + Phase 7 (controlled parallel work allowed)
  ↓
Phase 8 + Phase 9 (partial parallel work allowed)
  ↓
Phase 10
  ↓
Phase 11
  ↓
Phase 12
```

Phase 13 research/profiling can start once the new compiler/project architecture is stable enough to measure, but native implementation must not race ahead of the product migration.

---

# 7. Parallelizable work lanes

## Lane A — Product/API contracts

Primary phases:

```text
0 → 6 → 12
```

Owns:

- authoring API;
- generated ABI;
- design-system model;
- generated types;
- recipes/patterns/themes.

## Lane B — Runtime/package ownership

Primary phases:

```text
2 → 4 → 5 → 9
```

Owns:

- `@pandamstyle/core`;
- absorption of required runtime/engine code;
- deletion of donor packages;
- package closure and tarball qualification.

## Lane C — Compiler/project architecture

Primary phases:

```text
3 → 4 → 7
```

Owns:

- compiler re-homing;
- semantic engine ownership;
- project session authority;
- revision model;
- diagnostics/publication SDK.

## Lane D — Integrations

Primary phases:

```text
8 → 10 → 11
```

Owns:

- Vite;
- Next/webpack;
- Next/Turbopack;
- real external pilot.

## Lane E — Verification

Runs continuously after Phase 1.

Owns:

- semantic expected-value fixtures;
- fresh/incremental oracle;
- repository verification;
- package closure checks;
- browser/SSR/hydration acceptance;
- regression evidence.

## Lane F — Performance research

Can proceed in parallel only as measurement/research after suitable stable checkpoints.

Owns:

- cold/global profiling;
- memory traces;
- native architecture spikes.

Must not change production architecture ahead of the migration gates.

---

# 8. Specific parallelization rules

### Phase 0

Mostly sequential at the decision layer.

Research/sub-analysis can happen in parallel, but package/API/ABI decisions must converge into one accepted contract before implementation.

### Phase 1

Can overlap with late Phase 0 only for inventory/test extraction. Final expected semantics depend on the Phase 0 contract.

### Phase 2 and Phase 3

Can run in parallel **only after Phase 0 and Phase 1** if the generated ABI and compiler/runtime boundary are frozen.

Required separation:

- Phase 2 owns runtime/core and generated runtime imports;
- Phase 3 owns compiler internal movement/public SDK;
- shared files/contracts require explicit integration ownership.

### Phase 4

Must wait until the Phase 2/3 ownership boundaries exist. Subsystems inside Phase 4 may be assigned in parallel if they do not share semantic state.

### Phase 5

Strictly sequential after Phase 4. Deletion happens only after all retained behavior and tests have migrated.

### Phase 6 and Phase 7

Can partially run in parallel after Phase 4/5 if interfaces are frozen:

- Phase 6 owns canonical design-system projections;
- Phase 7 owns revision/project/host authority.

They meet at generation identity and diagnostics/publication contracts, which must have a single owner.

### Phase 8 and Phase 9

Can partially run in parallel:

- Vite adapter work can proceed while package/tarball qualification is developed;
- final Vite acceptance must use the actual standalone package shape from Phase 9.

### Phase 10

Must wait for stable compiler SDK, standalone package closure, and project service.

### Phase 11

Strictly after Phase 10 acceptance. The pilot must test intended architecture, never temporary integration plumbing.

### Phase 12

Implementation should wait until Phase 11 closes. Research/spec work may occur earlier but must not destabilize the migration baseline.

### Phase 13

Profiling/research can run in parallel after the new architecture is stable enough to measure. Production native migration occurs only after evidence and explicit approval.

---

# 9. Global acceptance definition

The rework is not complete until all of the following are true:

```text
[ ] PandamStyle public package/API contracts are explicit and documented.
[ ] Application runtime depends only on PandamStyle-owned runtime code.
[ ] Compiler source lives under PandamStyle-owned architecture.
[ ] Production dependency graph contains no @stylexjs/*.
[ ] Production dependency graph contains no @pandacss/*.
[ ] packages/@stylexjs/ is deleted.
[ ] upstream/stylex/ is deleted.
[ ] upstream/panda/ is deleted.
[ ] Attribution/provenance is preserved without retaining donor source trees.
[ ] Fresh and incremental semantics independently match expected behavior.
[ ] Generated design-system artifacts share one canonical revision/generation identity.
[ ] Generated TypeScript declarations are shipped.
[ ] All production hosts use the same project/compiler authority.
[ ] Vite is qualified against the canonical project service.
[ ] Packed external installation is donor-free.
[ ] Next webpack support is independently qualified if claimed.
[ ] Next Turbopack support is independently qualified if claimed.
[ ] Large external Next.js pilot passes.
[ ] No permanent compatibility or migration shim remains.
[ ] No legacy/archive tree remains solely for historical reference.
[ ] Any native rewrite decision is backed by measured PandamStyle evidence.
```

---

# 10. Execution discipline

For every future implementation brief:

1. Start by naming the relevant phase(s) from this file.
2. State the prerequisite gates already satisfied.
3. State the exact files/subsystems allowed to change.
4. State what must not change.
5. Preserve semantic/oracle requirements.
6. Require repository verification.
7. Require a tested commit and evidence-only closure if applicable.
8. Update this master plan's status only after independent verification.
9. Never silently introduce a new permanent package, compatibility layer, donor dependency, or host-specific semantic engine.
10. If implementation discovers a contradiction with this plan, stop and amend the plan explicitly before expanding scope.

---

# 11. Current next action

**Next required phase: Phase 0 — Freeze product architecture and public contracts.**

Before implementation begins, settle the authoring API and the exact responsibilities of `@pandamstyle/core`, `@pandamstyle/compiler`, `@pandamstyle/vite`, and `@pandamstyle/next`.

