# Agent Guardrails

## Core rule

Agents should primarily choose among sanctioned design-system decisions.

They should not manufacture local visual systems.

## Violations to detect

Suggested machine-readable rule IDs:

```text
unauthorized-style-import
inline-style
raw-color
raw-spacing
raw-radius
raw-font-size
raw-line-height
raw-shadow
raw-motion
unauthorized-breakpoint
unknown-token
unknown-condition
page-local-design-primitive
forbidden-component-override
recipe-variant-invalid
slot-invalid
deprecated-token
```

## Inline styles

Product code should generally reject:

```tsx
<div style={{ padding: 17 }} />
```

Exceptions may exist for genuinely dynamic non-design values, but they should require an explicit escape hatch.

## Escape hatches

Escape hatches must be:
- explicit;
- searchable;
- reviewable;
- rare;
- optionally accompanied by a reason.

Example concept:

```ts
unsafeRawStyle({
  reason: "Canvas transform generated from pointer coordinates",
  transform: ...
})
```

Avoid generic `any`-style bypasses.

## Repair-oriented compiler messages

Every common failure should ideally include:
1. what was invalid;
2. why it was invalid;
3. allowed alternatives;
4. closest valid values;
5. an autofix hint when safe.

## Agent contract

An agent generating UI should be able to receive only:
- component catalog
- recipes
- layout patterns
- semantic tokens
- allowed variants
- conditions
- constraints

and produce high-quality pages without needing unrestricted CSS knowledge.

That is the architectural success criterion.
