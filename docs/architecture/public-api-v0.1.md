# PandamStyle public API v0.1

This document summarizes the Alpha 1 API boundaries. Detailed authoring
examples and configuration shapes live in the
[design-system reference](../reference/design-system.md) and
[authoring reference](../reference/authoring.md). Exact host versions and
commands are listed in the [agent installation contract](../agent-install.md).

## Application authoring

An application imports its styling vocabulary from the generated design-system
module configured for that project. The module exposes compile-time helpers,
design-system styles, finite recipe selectors, themes, and generated types. The
compiler checks the source and emits application-ready references and CSS.

```jsx
import { create, token, recipes, themes, props } from './.pandamstyle/design.js';

const styles = create({
  row: {
    display: 'flex',
    gap: token('spacing.md'),
    padding: { base: token('spacing.sm'), wide: token('spacing.lg') },
  },
});

export function Actions() {
  return (
    <div {...props(themes.light, styles.row)}>
      <button {...props(recipes.button({ tone: 'primary' }))}>Continue</button>
    </div>
  );
}
```

The design-system definition owns tokens, conditions, themes, recipes,
compound variants, slots, and layout patterns. Application code selects from
that authored vocabulary. Values and selector domains are statically checked;
arbitrary runtime styles and unbounded design-system values are outside the
contract.

## Package APIs

- `@pandamstyle/core` provides the browser-safe runtime for generated style and
  theme references.
- `@pandamstyle/compiler` provides definition helpers, the Project Service,
  diagnostics, generated types, and the command-line interface.
- `@pandamstyle/vite`, `@pandamstyle/next`, and `@pandamstyle/rsbuild` connect
  supported hosts to the compiler service.

Applications author against the generated module. Host adapters use the
compiler's public host interface; they do not implement a second style
compiler or publish generated artifacts independently.

## Project lifecycle

A Project Service initializes a project, accepts explicit source and
configuration changes, validates the current revision, and publishes a
complete generated artifact set. Compilation stages output and commits it
atomically. A failed or invalid revision preserves the last committed output.
Sessions are closed to release watchers and other resources.

Compiler diagnostics carry stable codes and structured context. See the
[diagnostics protocol](diagnostics-protocol-v1.md) and the public package API
references for operation details.
