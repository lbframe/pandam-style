# Design-system reference

This page describes the author definition consumed by the compiler. Host
integration options are in [agent-install](../agent-install.md); consumer
composition is in [authoring](authoring.md).

## Definition shape

The definition is a JavaScript module exporting an object with a stable
project-specific `systemId` string. It may contain `tokens`, `themes`, `conditions`, and
`recipes`. The host's `definition` option points to that module. Keep this file
as source of truth; the generated design-system module is compiler output and
MUST NOT be edited.

```js
import { token } from '@pandamstyle/compiler/config';

export default {
  systemId: 'acme-ui@1',
  tokens: {
    spacing: {
      sm: { value: '8px', visibility: 'public' },
      md: { value: '16px', visibility: 'public' },
    },
    colors: {
      ink: { value: '#172033', visibility: 'private' },
      text: { primary: { ref: 'colors.ink', visibility: 'public' } },
    },
  },
  conditions: {
    wide: '@media (min-width: 48rem)',
    hover: ':is(:hover, [data-hover])',
  },
  themes: {
    light: { tokens: {} },
    dark: {
      tokens: {
        colors: { text: { primary: { ref: 'colors.ink' } } },
      },
    },
  },
  recipes: {},
};
```

Token categories are path segments used by the compiler's property policy
(common categories include `colors`, `spacing`, `radii`, `fontFamilies`,
`fontSizes`, `fontWeights`, `lineHeights`, `letterSpacings`, `shadows`,
`durations` and `easings`). The actual paths in this project definition are
authoritative. A token leaf has a concrete `value` or a `ref` to another token.
Visibility defaults to public; set `visibility: 'private'` for implementation
values that consumers must not select. Private tokens can support system-owned
recipe styles but consumer styles cannot reference them.

Reference paths are dot-separated strings such as `spacing.md` and
`colors.text.primary`. A reference must resolve, stay in the expected category,
and avoid cycles. Do not infer a token from a raw CSS value.

## Conditions

`conditions` maps a finite name to selector or at-rule text. Consumers use the
name in responsive style maps or state keys. Inspect whether a condition is a
media query or selector before using it. `base` is the default responsive key;
other keys must be declared. Unknown names fail compilation.

## Themes

`themes` contains named token overrides. A theme may use `extends` to inherit
from `base` (the implicit parent) or another declared theme. `base` itself is
reserved. Overrides must refer to known token paths and compatible categories;
reference targets and inheritance must be acyclic. The generated `themes` map
provides references for composition at use sites. Theme switching does not
authorize new arbitrary values in page styles.

## Recipe definitions

Recipes are declared under `recipes`. The exact fields and slot/compound syntax
are in [authoring reference](authoring.md). Recipe declarations are system
owned, may use private tokens, and must describe finite axes, values, defaults,
slots and compounds. The generated consumer API is `recipes.<id>()`; there is
no separate generated `slotRecipes` namespace.

## Validation boundary

The compiler validates definitions as part of the host build and reports
structured `PMS_*` diagnostics. Changing a definition invalidates generated
styles, manifest and types as one design-system input. If a system change is
not explicitly authorized, report missing vocabulary instead of amending the
definition as a side effect of component work.
