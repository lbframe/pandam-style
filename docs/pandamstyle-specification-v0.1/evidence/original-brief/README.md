# LB Frame Style System — StyleX Fork + Panda Ideas

## Mission

Fork StyleX and turn it into an **agent-first design-system engine** for LB Frame.

The goal is **not** to merge Panda CSS and StyleX feature-for-feature.

The goal is:

> Keep StyleX as the styling/compiler foundation, then graft onto it the strongest constraint and design-system ideas from Panda CSS so AI agents compose within an explicit visual system instead of improvising micro-design.

Core principle:

> **The page-generation LLM performs composition, not micro-design.**

Application code should consume the LB Frame UI layer, not raw StyleX primitives.

```tsx
import { css, recipe, tokens } from "@lbframe/ui"
```

Avoid direct application imports such as:

```tsx
import stylex from "@stylexjs/stylex"
```

The fork should make invalid design-system behavior difficult or impossible by construction, not merely discourage it in documentation.

---

## What this bundle contains

- `01_CONTEXT.md` — product and architectural context
- `02_TARGET_ARCHITECTURE.md` — desired end-state
- `03_FEATURE_MATRIX.md` — KEEP / PORT / BUILD / DROP
- `04_P0_SPEC.md` — MVP / P0 engineering spec
- `05_P1_P2_ROADMAP.md` — next phases
- `06_AGENT_GUARDRAILS.md` — agent-facing constraints and diagnostics
- `07_ACCEPTANCE_TESTS.md` — executable acceptance criteria
- `08_GPT6_PRO_BRIEF.md` — direct brief to give GPT-6 Pro
- `09_OPEN_QUESTIONS.md` — issues that should be resolved during repository analysis

---

## High-level priorities

### P0
- Strict tokens
- Semantic tokens
- Theme-derived TypeScript types
- Recipes / variants
- Controlled conditions and breakpoints
- Agent-friendly diagnostics
- Direct StyleX import boundary

### P1
- Slot recipes
- Layout patterns
- Compound variants
- Per-category strictness policies
- Design-system lint / static guardrails

### P2
- Token deprecation/versioning
- Migration codemods
- Rich agent metadata / introspection
- Compatibility and migration tooling

---

## Non-goals

Do not blindly copy Panda CSS internals.

Do not create two competing styling APIs.

Do not expose raw StyleX as the normal application-level API.

Do not rely solely on ESLint to enforce critical visual constraints.

Do not build a full design-system component library inside the fork itself. The fork is the **constraint engine / styling substrate**.
