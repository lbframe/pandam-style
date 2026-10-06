# PandamStyle Alpha 1 reference index

Load only the page needed for the current task. Workflow rules live in the
[`agent-*.md` contracts](../agent-use.md), not in this API index.

| Question | Read |
| --- | --- |
| What belongs in the system definition? How do tokens, visibility, conditions and themes work? | [Design-system reference](design-system.md) |
| How do I write consumer styles, tokens, recipes, slot recipes, compound variants, patterns, themes and `props()` composition? | [Authoring reference](authoring.md) |
| What compiler SDK, config helpers, diagnostics, host option types and CLI are actually exported? | [Compiler and host API reference](compiler-api.md) |

Source of truth: public exports and types in `packages/compiler/types/`,
`packages/core/src/types.ts`, generated design-system output and the
corresponding compiler/core tests. Historical architecture pages explain
implementation context; where they differ from the qualified source and tests,
follow the current implementation.

## Validation sources

- [Compiler public API types](../../packages/compiler/types/index.d.ts) and
  [author config types](../../packages/compiler/types/config.d.ts).
- [Core runtime types](../../packages/core/src/types.ts),
  [core exports](../../packages/core/src/index.js), and
  [composition tests](../../packages/core/__tests__/core-test.js).
- [Vite host types](../../packages/vite/types/index.d.ts),
  [Next host types](../../packages/next/types/index.d.ts), and
  [Rsbuild host types](../../packages/rsbuild/types/index.d.ts).
- [Recipe/slot/compound tests](../../packages/compiler/__tests__/pandamstyle/phase-15a-recipes-test.js),
  [pattern tests](../../packages/compiler/__tests__/pandamstyle/phase-15b-patterns-test.js),
  and [theme/type tests](../../packages/compiler/__tests__/pandamstyle/phase-15c-themes-types-test.js).
- [Qualified Vite pilot definition](../../examples/pilots/vite-react/design.pandamstyle.config.js)
  and [consumer module](../../examples/pilots/vite-react/src/pages/App.jsx).
