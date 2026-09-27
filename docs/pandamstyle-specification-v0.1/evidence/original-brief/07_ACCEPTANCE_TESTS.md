# Acceptance Tests

These tests describe behavior, not necessarily final API syntax.

## Strict token acceptance

### PASS

```ts
padding: "space.md"
```

### FAIL

```ts
padding: "17px"
```

Expected:
- compile-time error
- stable error code
- nearest-token suggestion

---

## Color acceptance

### PASS

```ts
backgroundColor: "surface.primary"
```

### FAIL

```ts
backgroundColor: "#111111"
```

Expected:
- compile-time rejection under strict color mode
- semantic-token recommendation when mapping exists

---

## Breakpoint acceptance

### PASS

```ts
padding: {
  base: "space.md",
  md: "space.lg"
}
```

### FAIL

```ts
"@media (min-width: 823px)": {
  padding: "space.lg"
}
```

when strict named breakpoints are enabled.

---

## Recipe typing

Given:

```ts
variants: {
  size: {
    sm: {},
    md: {},
    lg: {}
  }
}
```

This must fail TypeScript:

```ts
button({ size: "medium" })
```

---

## Slot recipe typing

Given slots:

```ts
["root", "header", "body"]
```

This must fail:

```ts
styles.footer
```

---

## Direct import boundary

In product package:

```ts
import stylex from "@stylexjs/stylex"
```

Expected:
- architecture/lint/build failure

Infrastructure package may explicitly allow it.

---

## Diagnostic stability

Error codes should be stable enough for automated agents and tooling to consume.

Example:

```text
LBSS1004
```

must retain meaning across compatible releases.

---

## Static output

Recipes, variants and conditions must preserve StyleX's static extraction principles.

Do not introduce a runtime CSS interpreter merely to emulate Panda ergonomics.

---

## Type generation

Changing theme tokens should update generated TypeScript types automatically.

Removing a token must surface compile errors at every stale usage.

---

## Manifest

A build should be able to produce a machine-readable design-system manifest containing at minimum:
- tokens
- semantic tokens
- conditions
- recipes
- recipe variants
- policies
