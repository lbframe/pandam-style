# P0 Engineering Specification

## 1. Strict Tokens

### Goal

Allow the design system to declare which CSS properties or property groups are token-only.

Example configuration:

```ts
export default defineStyleSystem({
  strict: {
    colors: true,
    spacing: true,
    radius: true,
    typography: true,
    shadows: true,
    breakpoints: true,
    motion: true,
  }
})
```

### Required behavior

Invalid:

```ts
const styles = css.create({
  card: {
    padding: "17px",
    backgroundColor: "#141414",
    borderRadius: "11px",
  }
})
```

Valid:

```ts
const styles = css.create({
  card: {
    padding: "space.md",
    backgroundColor: "surface.primary",
    borderRadius: "radius.lg",
  }
})
```

### Enforcement

Must happen at compile/build time.

Lint-only enforcement is insufficient.

---

## 2. Semantic Tokens

Support two layers:

### Primitive

```ts
gray.50
gray.100
gray.900
blue.500
space.4
radius.3
```

### Semantic

```ts
surface.primary
surface.elevated
text.primary
text.secondary
border.subtle
action.primary
action.primaryHover
shadow.overlay
control.radius
```

Semantic tokens may alias primitives.

Agent-facing APIs should prefer semantic tokens.

---

## 3. Theme-Derived TypeScript Types

Given:

```ts
spacing: {
  xs: "4px",
  sm: "8px",
  md: "16px",
  lg: "24px",
  xl: "32px",
}
```

Generate type-safe authoring:

```ts
padding: "md" // valid
padding: "mediumish" // type error
```

This applies to:
- colors
- semantic colors
- spacing
- radii
- shadows
- typography
- breakpoints
- motion tokens
- conditions

No duplicated manual union types.

---

## 4. Recipes

Required API shape may differ after repo analysis, but capabilities must include:

```ts
const button = recipe({
  base: {
    borderRadius: "control.radius",
  },

  variants: {
    variant: {
      primary: {},
      secondary: {},
      ghost: {},
    },

    size: {
      sm: {},
      md: {},
      lg: {},
    },
  },

  defaultVariants: {
    variant: "primary",
    size: "md",
  },
})
```

Required:
- base styles
- variants
- default variants
- full TypeScript inference
- generated static CSS
- no runtime style interpreter

---

## 5. Controlled Conditions

Applications must use declared conditions rather than arbitrary media queries where policy requires it.

Example:

```ts
conditions: {
  sm: "@media (min-width: 640px)",
  md: "@media (min-width: 768px)",
  lg: "@media (min-width: 1024px)",
  reducedMotion: "@media (prefers-reduced-motion: reduce)",
  hoverCapable: "@media (hover: hover)",
}
```

Desired authoring ergonomics:

```ts
padding: {
  base: "space.md",
  md: "space.lg",
}
```

or an equivalent StyleX-compatible syntax.

Arbitrary breakpoints should be rejectable in strict mode.

---

## 6. Agent-Friendly Diagnostics

Errors are part of the API.

Bad:

```text
Invalid value.
```

Good:

```text
LBSS1004: Raw spacing value "17px" is forbidden for property "padding".

Strict spacing tokens are enabled.

Allowed tokens:
- space.sm = 8px
- space.md = 16px
- space.lg = 24px

Closest token: space.md (16px)

Replace:
  padding: "17px"

With:
  padding: "space.md"
```

Diagnostics should expose structured metadata where possible:

```json
{
  "code": "LBSS1004",
  "category": "strict-token",
  "property": "padding",
  "received": "17px",
  "suggestions": ["space.md"],
  "autofixable": true
}
```

This is essential for coding agents.

---

## 7. Public Import Boundary

Add a way to enforce that product packages do not import raw StyleX directly.

This may be implemented via:
- package export boundaries;
- internal/private package structure;
- ESLint/architecture rule;
- compiler plugin;
- or a combination.

The important requirement is that raw StyleX remains an implementation detail for normal product code.
