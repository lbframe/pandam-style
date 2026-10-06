# Agent contract: build with PandamStyle

## Objective

Build or change an interface using the project's PandamStyle design system.
This is the primary product workflow. The page-generation LLM performs
composition, not micro-design: choose the project's vocabulary, compose it, and
let the compiler enforce its constraints.

## Prerequisites

The project MUST have a qualified host configuration and an authoritative
design-system definition/generated module. If it does not, stop and route to
[agent-install](agent-install.md). The agent MUST inspect the existing
component and design-system vocabulary before adding styles.

## Required sequence

1. Locate the generated design-system module and read the system definition,
   existing component recipes and nearby usage. Read only relevant pages from
   the [reference index](reference/README.md).
2. Reuse semantic tokens, themes, recipes, recipe slots and patterns before
   adding new vocabulary. Follow the existing component and accessibility
   conventions.
3. Select the smallest suitable PandamStyle primitive using the decision rules
   below.
4. Make a bounded source change. Keep values static and inside declared finite
   domains. Do not hand-edit generated output.
5. Run the project's supported dev/build compiler path. Read every diagnostic,
   repair the narrow cause, and compile again. See
   [agent-repair](agent-repair.md).
6. Report changed files, reused system vocabulary, checks, and any unresolved
   design-system gap.

## Choose a primitive

| Use | When |
| --- | --- |
| Semantic token | A design value already exists in the system, such as spacing, color, radius or typography. Reference it with `token('category.name')`; do not copy its raw value. |
| Direct allowed style primitive | A one-off declaration has no existing semantic token or repeated component behavior and its property/value is inside the compiler's finite policy. |
| Recipe | A reusable component has shared base styles and finite named variants such as tone or size. Select an existing recipe instead of duplicating branches. |
| Slot recipe | A reusable component has named independently styled parts (for example root and label). Select `recipes.<id>(selection).root` and `.label` separately. |
| Pattern | The intent is a supported layout primitive: stack, inline, center, grid or box. Use its bounded parameters; do not restate the same layout with arbitrary CSS. |
| Theme | A page or subtree needs a declared semantic token mapping. Compose `themes.<name>` with styles using `props`; do not create per-component color overrides to simulate a theme. |

If the design system lacks a required concept, report the exact missing
vocabulary and propose a bounded design-system change. Do not invent a token,
variant, condition, recipe, theme, or CSS property and treat it as already
approved.

## Allowed actions

Change only the requested application source and, when explicitly authorized,
the design-system definition needed to add vocabulary. Prefer existing tokens,
recipes, slot recipes, patterns and themes. Keep composition inside declared
finite domains and the project's established component/accessibility patterns.

## Composition contract

Consumer source imports the generated module configured by the host, for
example:

```js
import {
  create,
  token,
  props,
  recipes,
  patterns,
  themes,
} from '../.pandamstyle/design.pandamstyle.js';

const styles = create({
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: token('spacing.md'),
    color: token('colors.text.primary'),
  },
});

const layout = patterns.stack({ gap: token('spacing.md') });
const panelProps = props(themes.light, styles.panel, layout);
```

Resolve the correct relative path from the file being edited. `create`,
`token`, and pattern calls are compiler inputs, not runtime CSS functions. If
they survive to execution, compilation did not transform that source.

For a recipe, select finite values and let defaults apply only where the
definition supplies defaults:

```js
const buttonProps = props(recipes.button({ tone: 'primary', size: 'md' }));
```

For a slot recipe, select and compose individual slots:

```jsx
const card = recipes.card({ size: 'md' });

return (
  <section {...props(card.root, themes.light)}>
    <h2 {...props(card.label)}>Account</h2>
  </section>
);
```

`props()` accepts compiled style/theme references, nested arrays of references,
and conditional omissions (`null`, `undefined`, or `false`). It returns a
`className` object or an empty object. It does not accept a raw style object or
a whole slot map. Later composed references win conflicts, so preserve
intentional ordering and prefer one authoritative recipe when possible.

## Responsive behavior and finite selection

Responsive style values and pattern parameters use `base` and names declared in
the design system's `conditions`. Use those names exactly. A named condition
may represent a selector or media condition; inspect its definition before
using it. Do not assume a breakpoint or selector exists because another CSS
system uses the same name.

Recipe axes and values are finite. Boolean values are real selections (`false`
is not absence). Compound recipe variants match every named axis; arrays are OR
within one axis, and separate axes are ANDed. Composition order is recipe base,
variant branches in declared axis order, then matching compounds in definition
order. Do not use runtime-generated variant keys.

Generated declarations expose the finite recipe, slot, theme and pattern types.
Use them as the authority for source typing. Do not cast away a rejected
selection or edit generated declarations.

## Forbidden patterns

- Arbitrary color, spacing, breakpoint or other micro-design values where a
  system token exists.
- Dynamic style objects, template-built token paths, runtime recipe selection
  domains, or computed slot names.
- Raw CSS objects passed to `props`, `style` props used to bypass PandamStyle,
  or edits to generated files.
- Unsupported pattern names/parameters, undeclared conditions, unknown recipe
  axes/values, unknown theme names, or private tokens in consumer styles.
- Changing visual/product behavior during a requested implementation unless
  the user asked for that change.

Alpha 1 advertises `rawDynamicStyles: false`; there is no raw-style escape hatch.
If the requested design cannot be expressed with the current vocabulary, stop
and state what the system must add or what existing project styling should own.

## Expected checks and completion

Compile with the project's host command after each meaningful change. A
successful typecheck alone is insufficient when the host compiler did not run.
Use diagnostics to repair local constraints, then verify the relevant build or
dev path again. Completion requires the interface to compile, existing visual
behavior outside the requested change to remain intact, and a concise report of
vocabulary used, files changed, checks, and limitations.

For every meaningful change, keep this loop visible in the work record:

```text
intent → PandamStyle vocabulary → host compile → diagnostic (if any) → minimal repair → compile again
```
