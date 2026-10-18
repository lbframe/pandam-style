# Core evolution: upstream research and present implementation

Status: research snapshot and implementation input. No product capability is
qualified by this document. Research date: 2026-10-18. PandamStyle source base:
`415e05539fcb5d36a78226112b5cf488b200b1aa` (`0.1.0-alpha.1`).

Read [the coverage matrix](../architecture/core-evolution-coverage.md) for scope
and [the implementation plan](../architecture/core-evolution-plan.md) for work
packages. The audience of the resulting product is exclusively AI/LLM agents.

## Release identity and method

| Project | Latest stable package inspected | Published UTC | Source revision |
| --- | --- | --- | --- |
| StyleX | `@stylexjs/stylex`, `babel-plugin`, `unplugin` **0.19.1** | 2026-09-15 | `1fcb9a51cbecad2c82255e0f4b45cc072fa1a95a` |
| PandaCSS | `@pandacss/dev`, `compiler`, `preset-base`, `types` **2.2.0** | 2026-10-09 | `d149285ee26cd40488909cbf4aa4143980e2e05c` |
| MDN compatibility data | `@mdn/browser-compat-data` **8.1.6** | 2026-10-15 | `3e5665883c3dcaa610e2ed2478e24ade34d57ff4` |

The npm `latest` tags were resolved directly, not inferred from search snippets,
an old clone, GitHub's latest-release widget, or an internal package name.
[The evidence lock](core-evolution-evidence.json) records exact publication
times, registry metadata endpoints, tarball SHA-512 integrity and source pins.
Each listed tarball was downloaded outside this repository and its integrity
verified. No upstream package was installed into PandamStyle or executed.
Tagged source archives and official documentation were inspected separately;
source inspection is not a build or browser qualification.

Panda's `@pandacss/core@latest` still resolves to **1.12.1**. That package is a
v1 internal, folded into `@pandacss/compiler` in v2. Basing a current comparison
on it would miss the Rust/Oxc engine, new helpers and compatibility options.
The v2 migration also removes the old root `lightningcss` and `browserslist`
configuration options. Do not reuse a v1 integration description. [P1]

The checked release is a fixed comparator, not a permanently current release.
Refresh npm identities and review the release delta before implementation
qualification and again before publication; retain the original snapshot.

## How StyleX provides breadth

StyleX accepts a broad CSS property/value vocabulary in statically evaluated
objects, lowers declarations into atomic rules, and merges compiled references
with deterministic conflict resolution. Variables, themes and constants can
cross authorized StyleX module boundaries. Its Babel compiler performs static
evaluation; it is not a general JavaScript execution engine. [S1, S2]

Its typed CSS surface is broad, but types are not a project-specific finite
design policy. Property validation defaults to `silent` in the inspected Babel
options. Project rules can be added through types and linting. This differs
from PandamStyle's compiler-enforced project vocabulary. [S3, S4]

| Capability | Mechanism in 0.19.1 | Boundary or limitation |
| --- | --- | --- |
| Layout, typography, borders, effects, SVG | CSS property objects, strings/numbers, atomic lowering | Availability of a typed property does not prove its browser support. |
| Conditional styling | Property conditions, pseudo-elements, media/other at-rules and nested conditions | Values must remain statically analyzable. |
| Contextual states | `when.*` with default/custom markers; ancestor, descendant and sibling relationships | Lookahead relationships use `:has()`; selectors have explicit priority rules. [S5] |
| Tokens and themes | `defineVars`, typed variables, conditional values and `createTheme` | Variables/themes follow compiler module-resolution contracts. [S6] |
| Variants and reusable components | JavaScript selection/composition of compiled style references | The documented model does not supply Panda's config recipe/slot/pattern registry. [S7] |
| Animation | `keyframes` plus CSS animation/transition properties | Keyframes must compile; a name alone does not define animation behavior. [S8] |
| Value fallbacks | `firstThatWorks` emits ordered alternatives | Alternatives address declaration support, not every semantic or platform gap. [S9] |
| Anchor positioning | `positionTry` creates named `@position-try` rules | Descriptor allowlist and declaration-location constraints apply. [S10] |
| View transitions | `viewTransitionClass` emits the named transition pseudo-element styles | Its styles do not support media queries in this release; application/native API support is separate. [S11] |
| Dynamic values | Function styles assign CSS custom-property values at execution time | Requires runtime value transport, normally through inline style properties. This conflicts with PandamStyle's static finite contract. [S1] |
| CSS delivery | Static extraction; optional runtime injection in compiler/integrations | Babel's `runtimeInjection` defaults off; enabling it changes the CSP behavior. [S3] |

Do not infer global stylesheets, reset ownership or `@font-face` support from
the atomic `create()` API. These need separate authored CSS/integration paths;
PandamStyle's corresponding design-system resources are specified explicitly
in CE-09 rather than attributed to an unverified StyleX API.

## How PandaCSS provides breadth

Panda 2.2.0 uses Rust/Oxc for extraction and compilation, exposed through native
bindings and a WASM build. It generates project-specific styling helpers and
extracts their uses to static CSS. The public toolchain is ESM and requires
Node 22 or newer. These are toolchain requirements, separate from the CSS
browser requirements. [P1]

| Capability | Mechanism in 2.2.0 | Boundary or limitation |
| --- | --- | --- |
| CSS property breadth | Native properties plus configurable utilities, aliases and transforms | Broad input acceptance does not enforce PandamStyle's closed consumer policy. [P2] |
| Token categories | Colors, sizes, spacing, fonts, borders/widths, shadows, gradients, durations, easings, animations, opacity, z-index, ratios, assets and other domains | Composite values and token references are transformed by category. [P3] |
| Semantic tokens and themes | Conditional semantic values, reference resolution and named theme CSS | A theme must have its CSS generated and loaded; JavaScript selection alone does not ship it. [P4] |
| States and responsiveness | Built-in/custom conditions, selectors, attributes, group/peer states, media and container queries | Arbitrary selectors remain available; static extraction cannot infer unrestricted runtime expressions. [P5] |
| Recipes | Config recipes, atomic `cva`, slot `sva`, defaults and compounds | Atomic recipes emit all variants; config recipes can emit usage-selected variants. [P6] |
| Responsive variants | Conditional variant values for config/slot recipes | Not available for atomic recipes, or recipes with compound variants; the latter combination throws. [P7] |
| Patterns | Twenty base patterns, including layout, grid items, ratios, wrap, container, float, bleed and visually hidden | Pattern definitions can restrict props; helpers/JSX forms are alternative syntax. [P8] |
| Global resources | Reset/preflight, `globalCss`, global variables, font-face configuration and layer ordering | These affect cascade and require explicit configuration. [P9] |
| Motion and modern rules | Keyframes, ordered fallbacks, `positionTry`, `viewTransition`, plus native properties | Generated helpers have compiler/codegen support; this is not a claim of browser availability. [P10] |
| Dynamic selection | Finite extracted branches, recipes and `staticCss` pre-generation | Unknown runtime values need pre-generated choices or an inline custom-property/value path. A returned class string can lack emitted CSS if extraction missed it. [P11] |
| Strictness | `strictTokens`, `strictPropertyValues` and generated types | Both options are optional and affect generated typing; their existence does not establish PandamStyle-equivalent compiler authority. [P12] |
| Distribution | Design-system build information, generated helpers and package workflows | Publishing a library has its own extraction, theme and runtime boundary. [P13] |

The source snapshot contains 522 property keys in StyleX's `CSSProperties` and
863 unique optional keys found in Panda's bundled CSS type declarations plus
its explicit modern-property extension. These include vendor, legacy and
nonstandard entries. They are inventory inputs, **not comparable support
scores** and not counts of browser-qualified features. The machine inventory
preserves the extraction method and distinguishes the evidence classes.

## Browser limits

Neither project makes a new CSS feature work in every browser merely by
extracting it. Track four separate questions: accepted authoring syntax,
emitted CSS, configured build transformations, and observed browser behavior.

### StyleX

The inspected unplugin applies Lightning CSS with project Browserslist targets
and supports explicit target/options overrides. Other integration paths must
be checked separately; Babel compilation alone does not establish the same
postprocessing. Its README documents a `light-dark()` lowering hazard when
`color-scheme` is absent from the same transformation unit. Narrowing targets
or excluding that transformation leaves native browser requirements; neither
option creates universal dark-theme support. [S12]

There is no single browser minimum established here for every StyleX feature.
Its marker lookahead, variables, layers when enabled, and modern APIs have
different requirements. The release documentation's generic warning about
`:has()` must be interpreted against pinned compatibility data, not treated
as a current statement that no major engine supports it.

### PandaCSS

The FAQ lists Chrome/Edge 99+, Firefox 97+, Safari/iOS 15.4+, Android 115+ and
Opera 73+, reflecting variables, cascade layers and modern selectors. This
list is a published baseline, not evidence that every utility works at those
versions. In particular, transform/filter utilities can depend on `@property`;
`optimize.propertyFallback` seeds initial values for engines that ignore those
registrations. It does not emulate typed-variable interpolation. [P14, P15]

Panda v2 provides an emit-time layer polyfill (`polyfill: true` / `--polyfill`).
The FAQ recommends PostCSS Autoprefixer when additional vendor prefixing is
needed. Removing `@layer` alone is not an equivalent cascade transformation,
and a layer polyfill does not polyfill grid, `:has()`, anchor positioning or
view transitions. [P14, P16]

### Selected native feature thresholds

These values come from pinned MDN BCD 8.1.6. They report selected native
features, not entire library support. Subfeatures, partial support and bugs
still require review and execution. Desktop Safari values do not substitute
for iOS or embedded WebView evidence. [B1]

| Native feature | Chrome / Edge | Firefox | Safari |
| --- | --- | --- | --- |
| Custom properties | 49 / 15 | 31 | 9.1 |
| `:is()` and `:where()` (unprefixed) | 88 | 78 | 14 |
| Cascade layers | 99 | 97 | 15.4 |
| `aspect-ratio` | 88 | 89 | 15 |
| Size container queries | 105 | 110 | 16 |
| `:has()` | 105 | 121 | 15.4 |
| `subgrid` | 117 | 71 | 16 |
| `@property` | 85 | 128 | 16.4 |
| `color-mix()` | 111 | 113 | 16.2 |
| `light-dark()` | 123 | 120 | 17.5 |
| `text-wrap` property | 114 | 121 | 17.4 |
| `@starting-style` | 117 | 129 | 17.5 |
| `@position-try` / `anchor-name` | 125 | 147 | 26 |
| `view-transition-class` | 125 | 144 | 18.2 |
| `animation-timeline` | 115 | Preview, not a stable support claim | 26 |

`text-wrap: balance` and `pretty` have their own entries; the property row
does not qualify every keyword. Same-document transitions, cross-document
transitions and transition-class styling are also separate capabilities.
For example, BCD records a partial Safari interval for `@scope`; collapsing
its support history to a single number would hide the input/textarea issue.
The evidence lock retains the selected support statements, including notes.

PandamStyle currently has no documented, executed cross-browser qualification
matrix covering this scope. An existing Chromium pilot or a dependency's
browser claim cannot supply one. CE-01 and CE-13 establish targets and proofs.

## PandamStyle: observed source facts

The current policy contains **102 distinct admitted property names**: 69
category-bound, 29 structural sets and four numeric ranges. Five composite
forms (`background`, `border`, `font`, `animation`, `transition`) are explicitly
rejected. This count describes source declarations, not tested coverage.

- Tokens already allow arbitrary category path names in the definition, with
  scalar values/references, visibility, reference-cycle detection and theme
  inheritance. The missing piece for categories such as `sizes` is chiefly
  property binding, grammar and projection support, not an absent token API.
- The policy's exclusive category/set/range classification cannot directly
  describe a size token **or** a structural keyword for the same property.
- `opacity`, `flex`, `flexGrow`, `flexShrink` accept JavaScript numbers through
  ranges; numeric CSS strings do not follow that path. Opacity is not missing
  altogether. Conditional finite selection is distinct from runtime values.
- Border side colors and `outlineColor` already exist. Side widths/styles,
  outline width/style/offset, size token bindings and z-index do not.
- Named conditions, property condition maps and one-level condition blocks
  exist. Recursive condition composition and selector authority need work:
  `compileStyles()` also handles raw `:`, `@` and `[` blocks. That branch must
  be reconciled with the documented named-only consumer contract.
- Five patterns, recipes, slots, compounds, themes, generated declarations,
  finite runtime selectors and revision-bound publication already exist.
- `animationName` admits the strings `spin` and `pulse`, but the public
  definition has no keyframe registry. Reserved upstream helper names and
  inherited engine messages do not implement those APIs.
- The application runtime composes authenticated references and returns class
  names; it does not accept arbitrary CSS objects or an inline value channel.
- The owned engine retains atomic ordering and logical/physical lowering
  primitives. Its provenance from StyleX 0.19.1 does not mean all StyleX
  authoring APIs, property policy or compatibility processing were retained.

Local source anchors: [property policy](../../packages/compiler/src/design-system/policy/properties.js),
[registry](../../packages/compiler/src/design-system/registry/index.js),
[lowering](../../packages/compiler/src/engine/lowering/styles.js),
[generated types](../../packages/compiler/src/artifacts/types/design-declarations.js),
[consumer boundary](../../packages/compiler/src/frontend/babel/plugin.js),
[patterns](../../packages/compiler/src/design-system/patterns/compile.js),
[runtime composition](../../packages/core/src/props.js),
[engine provenance](../architecture/phase-4-derived-source-provenance.md).

## Consumer evidence and measurement caveat

Wacando's integration note, section 6, reports 343 declarations split into
212 expressible, 37 composite rewrites and 94 unexpressible; its redesign
reports 1,559 split into 1,111, 124 and 324 respectively. These are reported
baseline results, not measurements rerun for this research. [W1]

The note describes a script importing the policy. The versioned
`apps/desktop/scripts/pandamstyle-compare.mjs` inspected here instead compares
computed badge styles and border boxes in Chromium under CSP. It contains a
known padding workaround allowance; it is **not** the declaration-classifier
script. CE-00 must recover the actual classifier or explicitly reconstruct
and calibrate it. CE-14 must preserve both declaration and rendered-behavior
checks and remove workaround allowances once equivalent sizing is supported.

The compatibility corpus also needs public sites, forms, data grids,
responsive dashboards, content typography, SVG/media, RTL/vertical writing,
SSR and reusable packages. Coverage and release criteria are defined for that
whole corpus in the plan.

The inspected desktop manifest declares exact Vite `8.3.1`, Vitest `4.1.11`,
Electron `44.7.2` and React Testing Library `16.3.3`. These identify qualification
inputs, not a newly executed upstream support guarantee. Its blob identity is
recorded in the evidence lock.

## Source index

Links below identify release-pinned primary source unless marked live.

- [S1](https://github.com/facebook/stylex/blob/1fcb9a51cbecad2c82255e0f4b45cc072fa1a95a/packages/docs/content/docs/learn/styling-ui/defining-styles.mdx): style creation, conditions, static restrictions and dynamic values.
- [S2](https://github.com/facebook/stylex/blob/1fcb9a51cbecad2c82255e0f4b45cc072fa1a95a/packages/docs/content/docs/learn/thinking-in-stylex.mdx): composition and conflict model.
- [S3](https://github.com/facebook/stylex/blob/1fcb9a51cbecad2c82255e0f4b45cc072fa1a95a/packages/docs/content/docs/api/configuration/babel-plugin.mdx): compiler options and extraction.
- [S4](https://github.com/facebook/stylex/blob/1fcb9a51cbecad2c82255e0f4b45cc072fa1a95a/packages/@stylexjs/babel-plugin/src/shared/utils/default-options.js): actual defaults.
- [S5](https://github.com/facebook/stylex/blob/1fcb9a51cbecad2c82255e0f4b45cc072fa1a95a/packages/docs/content/docs/api/javascript/when.mdx): marker/relationship selectors.
- [S6](https://github.com/facebook/stylex/tree/1fcb9a51cbecad2c82255e0f4b45cc072fa1a95a/packages/docs/content/docs/learn/theming): variable/theme contracts.
- [S7](https://github.com/facebook/stylex/tree/1fcb9a51cbecad2c82255e0f4b45cc072fa1a95a/packages/docs/content/docs/learn/recipes): composition recipes.
- [S8](https://github.com/facebook/stylex/blob/1fcb9a51cbecad2c82255e0f4b45cc072fa1a95a/packages/docs/content/docs/api/javascript/keyframes.mdx): animation rule creation.
- [S9](https://github.com/facebook/stylex/blob/1fcb9a51cbecad2c82255e0f4b45cc072fa1a95a/packages/docs/content/docs/api/javascript/firstThatWorks.mdx): ordered fallbacks.
- [S10](https://github.com/facebook/stylex/blob/1fcb9a51cbecad2c82255e0f4b45cc072fa1a95a/packages/docs/content/docs/api/javascript/positionTry.mdx): anchor fallback descriptors.
- [S11](https://github.com/facebook/stylex/blob/1fcb9a51cbecad2c82255e0f4b45cc072fa1a95a/packages/docs/content/docs/api/javascript/viewTransitionClass.mdx): transition pseudo-element API limits.
- [S12](https://github.com/facebook/stylex/blob/1fcb9a51cbecad2c82255e0f4b45cc072fa1a95a/packages/@stylexjs/unplugin/README.md#browserslist--css-lowering): target processing and light/dark hazard.
- [P1](https://github.com/chakra-ui/panda/blob/d149285ee26cd40488909cbf4aa4143980e2e05c/website/content/docs/get-started/upgrading-to-v2.mdx): v2 architecture, packages and migration.
- [P2](https://github.com/chakra-ui/panda/tree/d149285ee26cd40488909cbf4aa4143980e2e05c/packages/preset-base/src/utilities): utility/property implementation.
- [P3](https://github.com/chakra-ui/panda/blob/d149285ee26cd40488909cbf4aa4143980e2e05c/website/content/docs/theming/token-categories.mdx): category/value mapping.
- [P4](https://github.com/chakra-ui/panda/tree/d149285ee26cd40488909cbf4aa4143980e2e05c/website/content/docs/theming): tokens, themes and resources.
- [P5](https://github.com/chakra-ui/panda/blob/d149285ee26cd40488909cbf4aa4143980e2e05c/website/content/docs/styling/conditional-styles.mdx): conditional selectors and at-rules.
- [P6](https://github.com/chakra-ui/panda/tree/d149285ee26cd40488909cbf4aa4143980e2e05c/website/content/docs/recipes): recipe/slot variants.
- [P7](https://github.com/chakra-ui/panda/blob/d149285ee26cd40488909cbf4aa4143980e2e05c/website/content/docs/recipes/responsive-variants.mdx): responsive/compound restriction.
- [P8](https://github.com/chakra-ui/panda/blob/d149285ee26cd40488909cbf4aa4143980e2e05c/packages/preset-base/src/patterns.ts): twenty pattern definitions.
- [P9](https://github.com/chakra-ui/panda/blob/d149285ee26cd40488909cbf4aa4143980e2e05c/website/content/docs/styling/global-styles.mdx): reset, globals and variable defaults.
- [P10](https://github.com/chakra-ui/panda/tree/d149285ee26cd40488909cbf4aa4143980e2e05c/crates/pandacss_codegen/src/artifacts): keyframes, position-try, transition and fallback helpers.
- [P11](https://github.com/chakra-ui/panda/blob/d149285ee26cd40488909cbf4aa4143980e2e05c/website/content/docs/styling/dynamic-styling.mdx): extraction and runtime boundaries.
- [P12](https://github.com/chakra-ui/panda/blob/d149285ee26cd40488909cbf4aa4143980e2e05c/packages/types/src/config.ts): strictness and optimization option semantics.
- [P13](https://github.com/chakra-ui/panda/tree/d149285ee26cd40488909cbf4aa4143980e2e05c/website/content/docs/design-systems): package/distribution workflows.
- [P14](https://github.com/chakra-ui/panda/blob/d149285ee26cd40488909cbf4aa4143980e2e05c/website/content/docs/get-started/faq.mdx): published browser baseline and prefix guidance.
- [P15](https://github.com/chakra-ui/panda/blob/d149285ee26cd40488909cbf4aa4143980e2e05c/packages/preset-base/src/utilities/transforms.ts): composed transform variables.
- [P16](https://github.com/chakra-ui/panda/blob/d149285ee26cd40488909cbf4aa4143980e2e05c/crates/pandacss_stylesheet/src/polyfill.rs): emit-time cascade layer transformation.
- [B1](https://github.com/mdn/browser-compat-data/tree/3e5665883c3dcaa610e2ed2478e24ade34d57ff4/css): browser feature data; per-feature keys/statements are retained in the evidence lock.
- [W1](https://github.com/lbframe/wacando/blob/main/docs/PANDAMSTYLE_INTEGRATION.md#6-vocabulaire-alpha-1--ce-qui-ne-passe-pas): live integration note, inspected blob `4ed2e94b3f11c770db257f89ec52bc0d6610700e`; comparison script blob `8a97a049f1a9a3117342532c66ca407d1a6ecfbd`.
