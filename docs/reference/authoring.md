# Consumer authoring reference

Consumer code imports the generated module configured by the host. Its value
exports are `create`, `token`, `props`, `recipes`, `patterns`, `themes`, and
`manifest`. `create`, `token`, and `patterns.*` are compile-time only; if one
reaches runtime, the host compiler did not transform the source.

## Styles and tokens

```js
import { create, token, props } from '../.pandamstyle/design.pandamstyle.js';

const styles = create({
  shell: {
    display: 'flex',
    gap: token('spacing.md'),
    color: token('colors.text.primary'),
    padding: { base: token('spacing.sm'), wide: token('spacing.md') },
  },
});

export const shellProps = props(styles.shell);
```

Use existing public tokens for semantic values. Properties are restricted to
the compiler's supported property/category policy. Token-valued properties
require the matching category; non-token structural values use finite allowed
domains (for example `display: 'flex'`). Unsupported properties, CSS
composite forms, forbidden raw values, private consumer tokens and dynamic
values fail compilation. The full allowlist is defined in compiler source and
the design-system manifest; do not assume all CSS is supported.

Responsive declaration objects use `base` plus declared `conditions`. Selector
conditions can be expressed through the compiler's named conditional keys used
in existing source (for example `_hover` when `hover` is declared). Confirm the
project's exact condition syntax before adding one. Values and maps must be
static or immutable local constants the compiler can resolve.

## `props()` composition

`props(...inputs)` accepts generated `StyleRef` and `ThemeRef` values, nested
arrays, and `null`/`undefined`/`false` omissions. It returns `{ className }` or
`{}`. It rejects raw CSS objects, unknown references, cyclic input arrays and
references from different design systems. Later references win conflicting
properties. A slot recipe returns a map, so pass its named member rather than
the whole map.

## Recipes, slots and compounds

Declare recipes in the system definition and select from the generated
`recipes` namespace:

```js
const button = recipes.button({ tone: 'primary', size: 'md' });
const buttonProps = props(button);
```

Recipe definition fields:

- `base`: shared style declarations.
- `variants`: finite axis names, each with finite string-keyed branches.
- `defaultVariants`: optional default string or boolean values inside those
  domains.
- `slots`: optional nonempty ordered list of unique, safe slot names.
- `compoundVariants`: optional ordered array of predicates and `css` output.

For a slot recipe, `base`, every variant branch and each compound's `css` map
contains slot names whose values are declaration objects. Missing slots mean
empty styles. Unknown slot names fail. Usage returns a typed map:

```js
const card = recipes.card({ size: 'md' });
const cardRoot = props(card.root, themes.light);
const cardLabel = props(card.label);
```

A compound looks like:

```js
compoundVariants: [
  {
    tone: 'quiet',
    size: ['sm', 'md'],
    css: { root: { opacity: 0.8 } },
  },
]
```

The selected recipe must match every predicate axis. Values in one array are
alternatives; axes are combined with AND. Absent selection values use declared
defaults. Boolean `false` is a value. Compound output applies after base and
variant branches in declared order; later declarations win conflicts.
Duplicate equivalent predicates are rejected. Use only axes and values already
declared in the recipe.

## Layout patterns

There are exactly five generated pattern functions:

| Pattern | Parameters |
| --- | --- |
| `patterns.stack` | `gap` spacing token; `align`: `start`, `end`, `center`, `stretch`, `baseline`; `justify`: `start`, `end`, `center`, `between`, `around` |
| `patterns.inline` | Same parameter domains as `stack` |
| `patterns.center` | Optional static boolean `inline` |
| `patterns.grid` | `columns`: integer 1 through 6; `gap` spacing token; `align` as above |
| `patterns.box` | `padding`, `paddingInline`, `paddingBlock`: spacing tokens |

All parameters except `center.inline` may use a map over `base` (or `default`)
and registered conditions. Maps must be nonempty and static; both `base` and
`default` cannot occur in one map. Pattern functions accept no freeform CSS
parameters. A spacing value must be a reference such as
`token('spacing.md')`:

```js
const columns = patterns.grid({
  columns: { base: 1, wide: 3 },
  gap: token('spacing.md'),
});
const layoutProps = props(columns, themes.light);
```

For a system-owned recipe definition, `patternStyles()` is available from
`@pandamstyle/compiler/config` and returns constrained declaration data that
the system compiler validates. It is not a consumer runtime escape hatch:

```js
import { patternStyles, token } from '@pandamstyle/compiler/config';

const recipes = {
  card: {
    base: patternStyles('stack', { gap: token('spacing.sm') }),
  },
};
```

Use the generated `patterns.*` API in consumer modules. Use `patternStyles()`
only while defining system-owned recipe styles.

## Themes and generated types

Compose a named theme reference alongside styles, recipes or patterns:

```js
const themedPanel = props(themes.dark, styles.panel, patterns.box({
  padding: token('spacing.md'),
}));
```

Generated types derive the available public token paths, theme names and
parents, recipe axes/values/defaults/slots/compound predicates, and finite
pattern parameters/condition names from the current definition. Import types
from the generated module where exposed; do not recreate a parallel vocabulary
type or use a cast to bypass it. See
[compiler and host API reference](compiler-api.md) for generated artifacts and
build boundaries.
