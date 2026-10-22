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

An optional `enhancements` list (CE-01.1) names emitted features the
design-system author declares as optional progressive enhancements, each with a
fallback policy. Every other emitted feature is required by the application's
browser targets. Only the definition can declare a policy; page source cannot.

```js
enhancements: [
  { feature: 'value:text-wrap/pretty', fallback: { kind: 'degrade' } },
  { feature: 'selector::has', fallback: { kind: 'degrade', note: 'static layout' } },
],
```

- `feature` is a feature key of emitted CSS, such as `property:<name>`,
  `value:<property>/<keyword>`, `function:<name>`, `selector::<pseudo>`,
  `at-rule:<name>[/<kind>]` or `media:<feature>`. An unknown key is
  `PMS_INVALID_ENHANCEMENT_POLICY`.
- `fallback.kind: 'degrade'` accepts that an engine ignores the construct. The
  outcome stays as computed and is reported as degraded
  (`PMS_TARGET_ENHANCEMENT_DEGRADED`, a warning), never as equivalent.
- `fallback.kind: 'alternative-value'` is reserved: its CSS emission belongs to
  CE-07.3 (#62), and it is refused until then (`context.deferredTo:
  "CE-07.3"`).
- A policy for a feature native on every announced profile has no effect and
  produces `PMS_TARGET_ENHANCEMENT_INEFFECTIVE` (info).

Declared enhancements enter the registry digest; a definition without the
field keeps the digest it had before. Declaring an enhancement changes what the
system promises, so it is a design-system decision, not a repair for page code.

An optional `propertyDomains` object (CE-02.1, CE-02.2) sets, per property,
the domain this design system admits, chosen from the compiler's standard
domain for that property:

```js
propertyDomains: {
  width: { tokens: ['sizes'], values: ['auto', 'min-content', '46ch'] }, // approve: mixed
  display: { values: ['flex', 'inline-flex', 'grid', 'none'] },          // narrow
  opacity: { values: [0, 0.33, 1] },                                    // finite numbers
},
```

- A key is a property authoring key the compiler admits (not a composite form
  or a platform extension). An entry holds at least one of `values` and
  `tokens`, and nothing else. CE-02.1's `range` member was removed by CE-02.2:
  every domain is finite (`property-domains.range-removed`).
- A token category must be a standard category of the property with at least
  one declared token.
- A value is in the standard domain (CE-02.2) when it is one of:
  - a reviewed standard value of the property, exactly as the compiler lists
    it (`flex`, `repeat(3, minmax(0, 1fr))`);
  - a keyword alternative of the property's grammar (`auto`, `min-content`);
  - a numeric literal satisfying a numeric alternative of the grammar
    (`<length-percentage [0,∞]>`, `<number [0,1]>`, `<time>`): its units, its
    bounds (`paddingTop: '-4px'` is refused, `marginTop: '-4px'` admitted), at
    most 4 fraction digits and a magnitude of at most 1e6;
  - `inherit`, `initial`, `unset` or `revert` (`revert-layer` is refused).
- A numeric literal is written in its one canonical spelling: a number stays a
  number on a number grammar (`0.5`, not `'0.5'`); a dimension is
  `<number><unit>` with no `+`, exponent, redundant zero or upper-case unit
  (`'18px'`, not `'18.0px'`); the zero of a length is `'0'` (numeric `0` is
  the same value). A non-canonical value is refused with its canonical
  spelling in `context.canonical`; it is never rewritten silently. A number is
  never given a unit: `width: 18` is refused.
- Grammar the compiler does not interpret (a property reference, a
  multiplier, a function, another data type) admits only the reviewed values:
  anything else is refused as `property-domains.grammar-unsupported`, a
  compiler gap, not an authoring error.
- Without an override, `opacity` admits the multiples of 0.05 from 0 to 1,
  and `flex`, `flexGrow` and `flexShrink` the integers 0 to 12 (CE-02.2;
  Alpha 1 accepted any number in a continuous range).
- The entry is the whole domain of the property, for every role (recipes and
  pages alike): a member it does not restate is no longer admitted, whatever
  the compiler default held.
- A domain that removes a value or token category a pattern emits is refused,
  so the manifest never offers an unusable pattern selection.
- Any invalid entry is `PMS_INVALID_PROPERTY_DOMAIN` (phase `registry`, one
  rule per class, `property-domains.*`), and the whole definition is refused.
- Declared domains enter the registry digest; a definition without the field
  keeps its digest. Changing a domain is a design-system decision, never a
  repair for page code.

A token's numeric value must also be a value of the property it is used on
(CE-02.2). Where a property's token categories can carry a number (spacing,
sizes, radii, font sizes and weights, line heights, letter spacings,
durations), each whitespace-separated component of the token's value, in the
base and in every theme, must satisfy the property's constraint: a `-4px`
spacing token is a valid margin or offset and is refused on a padding or a
gap; `padding` takes 1 to 4 components, `paddingInline` 1 or 2, a longhand 1.
A refusal is `PMS_FORBIDDEN_VALUE` / `category-strict` with
`context.reason: 'token-value-out-of-domain'` (or `non-finite` for `NaN` and
`Infinity`), naming the token, the theme and the constraint. Values that are
not plain numbers (`calc()`, colors, mixed lists) are not checked yet
(typed category grammar is CE-03).

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
