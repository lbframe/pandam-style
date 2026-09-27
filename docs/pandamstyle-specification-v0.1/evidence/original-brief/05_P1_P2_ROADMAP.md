# P1 / P2 Roadmap

## P1

### Slot Recipes

Needed for structured components:

```ts
const card = slotRecipe({
  slots: ["root", "header", "body", "footer"],

  variants: {
    density: {
      compact: {},
      comfortable: {},
    },
  },
})
```

Requirements:
- typed slot names
- typed variants
- variant propagation across slots
- static extraction
- conflict detection

### Compound Variants

Example:

```ts
compoundVariants: [
  {
    variant: "primary",
    size: "lg",
    css: { ... }
  }
]
```

### Layout Patterns

Provide a curated composition layer:

- Container
- Section
- Stack
- Cluster
- Grid
- Split
- Bleed
- SidebarLayout
- ContentRail

Patterns should constrain:
- spacing
- max widths
- gaps
- responsive transitions
- alignment
- density

### Per-category Policy Engine

Example:

```ts
strict: {
  colors: "token-only",
  spacing: "token-only",
  radius: "token-only",
  typography: "token-only",
  shadows: "token-only",
  breakpoints: "named-only",

  opacity: "arbitrary",
  flexGrow: "arbitrary",
}
```

Prefer explicit policy semantics over one global boolean.

### Static Guardrails

Detect:
- raw colors
- raw spacing
- raw radius
- raw font size
- raw shadow
- arbitrary breakpoints
- local one-off design primitives
- forbidden overrides
- direct engine imports

---

## P2

### Token Deprecation

```ts
deprecatedTokens: {
  "surface.panel": {
    replacement: "surface.elevated",
    removeAfter: "2.0"
  }
}
```

Diagnostics should guide migration.

### Token Versioning

Expose version metadata in generated manifests.

### Codemods

Automate:
- token renames
- deprecated recipe variants
- import migrations
- condition renames

### Machine-readable Manifest

Generate something like:

```json
{
  "tokens": {},
  "semanticTokens": {},
  "recipes": {},
  "patterns": {},
  "conditions": {},
  "policies": {}
}
```

This becomes an explicit context source for agents.

### Agent Introspection API

Allow tooling to ask:
- what tokens exist?
- what recipe variants exist?
- what layouts are permitted?
- what condition names exist?
- what replacement is preferred for a deprecated token?
