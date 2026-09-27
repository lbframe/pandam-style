# Target Architecture

## Layering

```text
Application / Agent-generated UI
        │
        ▼
@lbframe/ui
        │
        ├── Components
        ├── Recipes
        ├── Slot recipes
        ├── Layout patterns
        ├── Semantic tokens
        └── Allowed conditions
        │
        ▼
@lbframe/style-system
        │
        ├── Strict token validator
        ├── Theme/type generation
        ├── Recipe compiler
        ├── Policy engine
        ├── Diagnostics
        └── StyleX-compatible compiler layer
        │
        ▼
Forked StyleX core/compiler
        │
        ▼
Static CSS
```

## Boundary rule

Application code should not import raw StyleX directly except in explicitly approved infrastructure packages.

Preferred:

```tsx
import { css, recipe, token, Stack, Grid } from "@lbframe/ui"
```

Disallowed in regular product code:

```tsx
import stylex from "@stylexjs/stylex"
```

## Design-system ownership

The design system defines:

- primitive tokens
- semantic tokens
- allowed aliases
- typography scale
- spacing scale
- radii
- shadows
- motion
- breakpoints
- named conditions
- component recipes
- compound variants
- slot recipes
- layout patterns
- policy configuration

Product code consumes these primitives.

## Style responsibilities

### StyleX fork owns
- compiler
- static extraction
- generated CSS
- core style representation
- compile-time validation hooks
- type integration
- diagnostics plumbing

### LB Frame design-system layer owns
- actual token values
- semantic naming
- product-specific recipes
- layout patterns
- component APIs
- policy configuration

## Principle

Raw CSS remains an implementation mechanism.

It should not be the normal authoring surface presented to agents.
