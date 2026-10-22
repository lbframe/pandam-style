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

An optional `propertyDomains` object (CE-02.1) sets, per property, the
domain this design system admits, chosen from the compiler's standard domain
for that property:

```js
propertyDomains: {
  width: { tokens: ['sizes'], values: ['auto', 'min-content'] }, // approve: mixed
  display: { values: ['flex', 'inline-flex', 'grid', 'none'] }, // narrow
  opacity: { values: [0, 1] },                                  // finite numbers
},
```

- A key is a property authoring key the compiler admits (not a composite form
  or a platform extension). An entry holds at least one of `values`, `tokens`
  and `range`, and nothing else except optional descriptive `meta` (see
  Validation boundary), which is never part of the domain.
- Every member must belong to the property's standard domain: standard
  keywords and literals, standard token categories with at least one declared
  token, and, on the four legacy rows (`opacity`, `flex`, `flexGrow`,
  `flexShrink`), finite numbers or a `range` (`{ min, max }`, or `{ min }` for
  no upper bound) within the standard range. Arbitrary strings, numbers,
  functions and patterns are refused.
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

**Metadata (AG-03.1).** An optional `meta` object describes an entity for agents. It is
untrusted descriptive data: it never grants a property, value, token, recipe
selection, visibility or capability, and the compiler interprets none of its
text. Policy, generated types, the manifest, CSS and the design module are
identical with or without it, and the registry digest does not change.

`meta` is accepted on the definition itself, on a token leaf (beside `value` or
`ref`), on a theme, on a condition in object form, on a recipe and on a
`propertyDomains` entry. Recipe children and compiler patterns are described
from their parent:

```js
recipes: {
  button: {
    variants: { tone: { neutral: {}, danger: {} } },
    meta: {
      description: 'The only clickable action surface.',
      examples: [{ select: { tone: 'danger' } }],
      variants: { tone: { values: { danger: { usage: ['Destructive actions.'] } } } },
    },
  },
},
meta: { patterns: { stack: { usage: ['Vertical rhythm between sections.'] } } },
```

Slots use `meta.slots.<slot>`; a variant axis uses
`meta.variants.<axis>.meta`. A `meta` key in a token group or as a category
name, or on a theme override leaf, is an error.

Each `meta` is closed; nothing has a default and absent fields stay absent.
Fields, by kind: `description` (one line, at most 512 bytes), `usage` and
`restrictions` (1–8 lines of at most 256 bytes), `terms` and `semanticRole`
(lowercase kebab identifiers), `relations` (`related`, `pairs-with`,
`alternative`, or `implemented-by` an application component
`{ component: { module, export } }`, which is declared and never checked),
`examples` (structured data compiled by the unchanged policy, with
`{ token: '<path>' }` for token references) and `deprecated`
(`{ reason?, replacement? }`, descriptive only; a replacement has the same kind
and, for tokens, the same category, and replacements are acyclic). References
use addresses such as `{ token }`, `{ recipe, slot }` or
`{ recipe, variant, value }`. Text must be NFC, single-line, without control,
bidirectional or invisible characters, and without surrounding space; the
compiler rejects it rather than rewrite it. One entity's own `meta` is at most
4,096 bytes and all metadata at most 1 MiB, in canonical JSON.

Metadata of a consumer-visible entity may not reference, exemplify or name
(in any text, term or literal, whatever its case or punctuation) a private
token or private recipe. Invalid metadata fails the build with
`PMS_INVALID_METADATA` and a `metadata.*` rule. Its diagnostics show a private
entity only as `{ kind, visibility: 'private', ordinal }`: the rank among the
private entities of that kind that declare `meta`, ordered by address.

The definition must be plain data: plain objects, arrays, primitives and
`token()` marks. An accessor, function, class instance or other non-plain
object is `PMS_INVALID_DEFINITION`, rule `definition.shape`.
