# Context

LB Frame is building an agent-friendly frontend stack.

Current intended frontend direction:

```text
APP
├── TanStack Start
├── TanStack Router
├── TanStack Query
└── TanStack Form

DATA / BACKEND
├── Better Auth
├── Drizzle ORM
├── PostgreSQL
└── Zod

UI
├── Framework UI LB maison
│   ├── Panda CSS ideas
│   ├── StyleX engine
│   └── Ark UI
└── Fontsource
```

The original direction was to use Panda CSS first, then potentially revisit a StyleX-based stack.

The current decision is to move forward with a StyleX fork and graft the strongest Panda ideas onto it.

## Why

StyleX provides a strong low-level foundation:
- static extraction
- deterministic generated CSS
- colocated styles
- compiler-aware behavior
- typeable APIs
- strong runtime characteristics

Panda brings several important design-system concepts that are particularly useful for AI-generated interfaces:
- strict tokens
- semantic tokens
- recipes
- patterns
- controlled responsive conditions
- generated design-system APIs

These are valuable because AI agents tend to introduce arbitrary visual decisions unless the system explicitly constrains them.

The resulting system should be optimized for:
1. human developers;
2. coding agents;
3. page-generation agents;
4. automated review and visual regression systems.

## Agent-friendly definition

A styling system is agent-friendly when:

- valid choices are enumerable;
- invalid choices fail early;
- errors explain how to repair themselves;
- the API exposes intent rather than raw implementation details;
- the agent is prevented from inventing local design primitives;
- global visual consistency is structurally easier than one-off styling;
- machine-readable metadata exists for available tokens, variants, patterns and constraints.

The system must favor deterministic composition over unconstrained CSS generation.
