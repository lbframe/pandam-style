# Core evolution coverage matrix

Status: planned work, grounded in the [2026-10-18 research snapshot](../research/core-evolution-upstreams.md).
Baseline: PandamStyle `415e05539fcb5d36a78226112b5cf488b200b1aa`, Alpha 1.
Execution details and dependencies: [implementation plan](core-evolution-plan.md).
No row below claims a newly implemented or qualified feature.

## Meaning of coverage

Compare **application styling capabilities** against the union of StyleX
0.19.1 and PandaCSS 2.2.0, preserving PandamStyle's product contract. API names,
JSX convenience syntax, GUIs and implementation languages are not the parity
target. Equivalent static output and composition behavior are the target.

The [machine inventory](../research/core-evolution-inventory.json) enumerates
the union of pinned CSS property compatibility keys, upstream typed property
names, base utility keys and current policy names. A type occurrence means
`type-surface-evidence`, not `compiler-tested`, `browser-supported` or
`PandamStyle-qualified`. Legacy, vendor, experimental and pseudo-property
entries remain distinguishable. This research inventory is not the proposed
production property catalog.

During CE-00 each inventory entry receives a disposition: canonical property,
normalized alias, system resource, scoped platform extension, deprecated,
experimental, non-CSS syntax, or incompatible runtime requirement. Every
canonical supported property then receives finite keywords, applicable token
categories, reset/conflict semantics, target requirements and proof fixtures.
An upstream key that is absent from the type surface is not automatically
unsupported by its compiler. New upstream releases require a delta review.

All rows are mandatory disposition and qualification work. A missing stable
capability needed by the accepted static project profiles blocks completion.
An architectural exclusion stays visible and is excluded from any claim of
unqualified upstream feature equivalence.

## Capability families

`Partial` means some related code exists, with the limitations recorded in the
research. `Absent` means no supported public contract was found for that
capability, even if inherited internal primitives mention it. `Existing` still
requires non-regression and browser/host evidence for the expanded language.

| ID | Capability and relevant upstream mechanism | Alpha 1 source status | Required PandamStyle outcome | Work |
| --- | --- | --- | --- | --- |
| CAP-01 | Broad CSS properties: StyleX property types; Panda native properties/utilities | Partial, 102 admitted names | Versioned recognized catalog; project-authorized finite values; per-property disposition | CE-00/02 |
| CAP-02 | Keyword domains and CSS-wide reset values | Small hardcoded sets | Applicable finite keywords and explicit `inherit`/`initial`/`unset`/`revert`/`revert-layer` semantics | CE-02/07 |
| CAP-03 | Dimension values and modern units | Literal width/height subsets | Size tokens, intrinsic/percentage keywords, physical/logical min/max, unit-aware validation | CE-03/04 |
| CAP-04 | Flexbox, wrapping, alignment and ordering | Partial; numeric flex ranges | Finite wrap/alignment/order; token basis; deterministic normalization of `none` and approved flex tuples | CE-02/04 |
| CAP-05 | Grid tracks, placement and areas | Equal columns 1–6 only | Authored track/area/placement domains, rows, auto tracks/flow, span and subgrid profiles | CE-04 |
| CAP-06 | Positioning, inset and stacking | Relative/absolute; spacing-bound sides | Static/fixed/sticky; logical insets, signed offsets, z-index tokens and isolation | CE-03/04 |
| CAP-07 | Scrolling, clipping and overflow | `overflow: hidden`, one clip path | Axes, overscroll, snap, gutter, scroll margin/padding, clipping/containment and approved resize | CE-04/05 |
| CAP-08 | Margin, padding and gaps | Mostly category-bound | Complete physical/logical families; auto/negative applicability; no invalid negative padding | CE-02/04 |
| CAP-09 | Borders and outlines | Colors/radii; one width/style | All physical/logical sides, width/style/color, outline offset, collapsed tables and border image resources | CE-03/05 |
| CAP-10 | Focus, forced colors and control states | Conditions and color primitives | Focus-visible rings, system colors, appearance/accent, state selectors, reduced-motion/contrast modes | CE-05/07 |
| CAP-11 | Interaction and cursor | Pointer-events none, user-select none | Finite cursor/select/touch/action/caret/resize domains and browser-scoped extensions | CE-05 |
| CAP-12 | Typography and text flow | Font tokens; narrow alignment/white-space | Complete text alignment, whitespace, wrapping, breaking, ellipsis, indentation, hyphenation and vertical alignment | CE-06 |
| CAP-13 | Advanced typography, lists and writing systems | Partial | Font features/variations, text-decoration longhands, line clamp policy, list/counter resources, RTL and vertical writing | CE-06/09 |
| CAP-14 | Backgrounds, gradients and masks | Background color; one clip value | Approved layered backgrounds, positions/sizes/repeat, gradient and mask resources, blend behavior | CE-03/05/09 |
| CAP-15 | Shadows, filters and opacity | Shadow tokens; grayscale; numeric opacity | Validated multi-shadow/filter/opacity tokens, backdrop filters and target fallbacks | CE-03/05 |
| CAP-16 | Media, object sizing and aspect ratios | Absent | Object fit/position, ratios and sizes; responsive image/media layouts without inline CSS | CE-03/04/05 |
| CAP-17 | SVG styling | Fill/stroke colors | Finite SVG paint/geometry/text presentation properties; dash, width and vector-effect semantics | CE-05/06 |
| CAP-18 | Motion primitives and transforms | Duration/easing tokens; one transform | Transform functions/origins/individual transforms, all animation/transition longhands and approved property lists | CE-03/08 |
| CAP-19 | Named keyframes: both upstreams | Names only; no authored keyframe registry | Validated system-owned frame resources, generated names and typed references; deduplication and cleanup | CE-08 |
| CAP-20 | Base tokens and semantic aliases | Existing scalar/ref categories | Category grammar, compositional references, clear missing/category/cycle failures | CE-03 |
| CAP-21 | Conditional semantic tokens | Absent public shape | Finite registered conditions resolved across themes with explicit base/precedence | CE-03/07 |
| CAP-22 | Theme inheritance and scope | Existing | Nested subtree overrides and resets; inherited aliases; stable CSS identities after extension | CE-03/07 |
| CAP-23 | Pseudo classes/elements and attributes | Partial named conditions | Finite named pseudo/ARIA/data/state conditions; placeholder/file/backdrop/selection/content | CE-07 |
| CAP-24 | Combined selectors and contextual state | Raw-condition path needs audit | Owned selector grammar, typed markers/relations, group/peer equivalence, selector-specific targets | CE-07 |
| CAP-25 | Responsive and environmental conditions | One-level maps/blocks | Recursive named media/supports/container combinations, order/intersections, print and input capability queries | CE-07 |
| CAP-26 | Container rules and units | Raw definitions possible; no full profile | Named containers, size/style/scroll-state capability distinctions and target-bound token units | CE-04/07/11 |
| CAP-27 | Fallback declarations: both upstreams | No public ordered fallback API | System-owned ordered alternatives, no arbitrary consumer arrays; tested cascade and computed values | CE-02/07 |
| CAP-28 | Cascade and composition | Owned atomic conflict rules | Chosen deterministic merge/reset semantics for shorthand, logical/physical, conditions and layers | CE-02/07 |
| CAP-29 | Global CSS and reset: Panda | No owned public resource contract | Scoped, explicit author resources, reset/preflight policy and external CSS layer interoperability | CE-09 |
| CAP-30 | Fonts, images and asset URLs | Token strings; no owned resource pipeline | Self-hosted font-face and asset references, bundler URL resolution, hashes, base paths and CSP facts | CE-09/13 |
| CAP-31 | Recipes, slots, defaults and compounds: Panda | Existing | Expanded property domain available everywhere; conflict/default/slot stability and finite class selection | CE-10 |
| CAP-32 | Responsive recipe axes | No consumer selector contract | Precompiled finite condition selections; explicit compound interaction and bounded compilation | CE-10 |
| CAP-33 | Pattern coverage: Panda's twenty base patterns | Five patterns | Equivalent layout capabilities through canonical patterns/resources; finite parameter schemas | CE-10 |
| CAP-34 | Text/layer/animation styles: Panda | Recipes can carry subsets | Reusable approved declaration bundles integrated with one validation and cascade path | CE-03/10 |
| CAP-35 | Shareable design-system packages | Generated instance; cross-system refs rejected | Versioned definition composition/imports under one authority; exact package/provenance contract | CE-10/12/13 |
| CAP-36 | Static extraction and runtime selection | Existing | No CSS compilation/injection or free CSS value transport at application execution | CE-12/13 |
| CAP-37 | CSS custom-property registration | Internal primitive, no complete author contract | Approved typed variables with defaults/inheritance, conditional declarations and old-engine behavior | CE-03/11 |
| CAP-38 | Anchor positioning and position-try: both upstreams | No public resource contract | Owned anchors/position-try definitions, target gating and approved alternate layouts | CE-11 |
| CAP-39 | View-transition styling: both upstreams | No public resource contract | Finite named transition resources and pseudo-elements; separate native API availability facts | CE-11 |
| CAP-40 | Scroll-driven motion, starting-style and modern scopes | Inherited internals are insufficient | Catalog and rule resource support with native/fallback/unqualified statuses by target | CE-07/08/11 |
| CAP-41 | Browser transformations and prefixing | No shared qualified target contract | One compiler-owned target transform before final CSS identity; no host-dependent semantics | CE-01/12/13 |
| CAP-42 | Framework and bundler breadth | Vite, Next webpack/Turbopack, Rsbuild | Requalify existing modes; qualify explicit frontend/SSR adapters for accepted additional source formats | CE-00/13 |
| CAP-43 | Vitest and component tests | Consumer declares Vitest 4.1.11 | Exact Vitest 4.1.11 + Vite 8.3.1 qualification, extraction, watch and isolation | CE-13 |
| CAP-44 | SSR, hydration, lazy routes and HMR | Existing integration infrastructure | Consistent CSS/module identity, complete first paint, no stale rules or hydration mismatch | CE-12/13 |
| CAP-45 | Declaration coverage and migration fidelity | Reported consumer baseline | Exhaustive classification, no unexpressible in-profile declarations, behavior/render proofs | CE-00/14 |
| CAP-46 | Generated type/manifest/diagnostic fidelity | Existing generated projections | Complete mixed domains/resources/target facts from canonical snapshot; no permissive type escape | CE-12 |
| CAP-47 | Performance and output size | Existing tooling, no new measurements | Frozen budgets; expansion, compile/incremental, runtime and CSS-size evidence on varied projects | CE-00/12/14 |
| CAP-48 | Production packages and version migration | Alpha 1 package/release machinery | Exact consistent versions, reviewed archives, changes/migration notes and published evidence | CE-15 |

## Explicit architecture dispositions

| Upstream mechanism | PandamStyle disposition | Required evidence or consequence |
| --- | --- | --- |
| Unbounded runtime CSS values, inline custom properties, arbitrary style objects | Excluded by the existing product contract | Show available finite/CSS-native alternatives per task. If behavior requires unrestricted values, record a real limitation; never count an approximate bucketed rendering as equivalent. |
| Arbitrary consumer selectors, tokens or policy overrides | Replaced with declared project vocabulary | Unauthorized values and selectors fail compiler validation in every authoring context. Authorized design-system changes are separately reviewed. |
| Runtime style injection, including development helpers | Excluded | Qualify stylesheet links/assets and HMR under restrictive CSP. AG-13 owns removal of inherited display surfaces. |
| UI factories, prop aliases and framework wrappers | Retain only where an agent workflow needs them | CSS output/composition equivalence can meet parity without cloning all upstream syntaxes. No human-only authoring surface is introduced. |
| Unimplemented browser features | Native feature, verified build fallback, or explicit incompatibility | An unsupported experimental capability is not a general browser support claim. A required stable capability without an equivalent remains a release blocker for that profile. |
| Runtime DOM/application behavior such as opening a dialog or starting a native view transition | Application/framework responsibility | Qualify the styling contract, attributes, native API dependency and resulting behavior together. CSS alone does not implement interaction logic. |
| IE/obsolete engines, vendor properties and desktop extensions | Explicit profile disposition | Modern CSS variables cannot be made universally available by adding a property to a catalog. Electron-specific extensions require exact Chromium/Electron evidence. |

## Initial request traceability

These are minimum acceptance cases inside the wider scope, not a complete
property catalog. Preserve already admitted values unless an explicit migration
changes them.

| Request | Work and required acceptance case |
| --- | --- |
| Cursor pointer/default/not-allowed/text | CE-05 finite cursor values in ordinary, conditional and recipe styles |
| Overflow and X/Y auto/hidden/visible | CE-04 actual scrolling and clipping, including computed-axis interactions |
| Position fixed/sticky; display inline-grid | CE-04 containing blocks, scroll behavior and inline grid geometry |
| Align items/self/content, justify items/self, place items: start/end/center/stretch | CE-04 valid per-property domains; flex/grid and writing direction fixtures |
| Text align center/right/end; whitespace pre-wrap/pre-line | CE-06 content and line-layout assertions, including `pre` from the measured source |
| Border dashed/none; user-select text; disabled transform none | CE-05/08 state behavior and conflict/reset checks |
| Flex none / longhands / approved 1 1 0% equivalent | CE-04 shorthand reset semantics and size constraints; no raw composite bypass |
| flexWrap, overflowWrap, wordBreak, ellipsis, verticalAlign, objectFit, aspectRatio, textWrap | CE-04/05/06; individual keyword targets and equivalent fallback behavior |
| Sizes: 12–18px icons, 220px QR, 46ch/62ch widths | CE-03/04 tokens and all min/max bindings; include 6px dot and 420px width from consumer evidence |
| zIndices and opacities; conditional opacity variants | CE-03/10 typed tokens, integer/number validity, finite runtime selections and states |
| Border Top/Right/Bottom/Left Width/Style/Color | CE-05 full side and logical families; preserve existing color support |
| outlineWidth/Style/Color/Offset | CE-05 focus-visible, keyboard and forced-colors proof |
| Grid columns/rows 232px minmax(0,1fr), gridColumn | CE-04 system-owned track and placement references; narrow viewport/overflow proof |
| Vitest 4.1 + Vite 8.3.1 | CE-13 exact Vitest 4.1.11, React Testing Library path, watch and one-shot execution |
| Static CSS, CSP style-src self, exact Alpha 2 versions and migration | CE-13/15 delivered package/install/CSP tests and format-change notes |
| Rerun declaration measurement | CE-00/14 recover/calibrate classifier, pin inputs, report all categories and full denominator |

## Required proof record

Each capability/property/profile record contains its stable ID, source pins,
author and consumer domains, implementation paths, lowering and conflict
semantics, target results, fixture IDs, expected diagnostics, commands, raw
artifacts, revision/package digests and outstanding gaps. Distinguish:

1. inspected source or upstream documentation;
2. accepted syntax and compiler diagnostics;
3. emitted and transformed CSS;
4. computed layout/visual/state behavior in exact browser engines;
5. qualified host and clean package installation.

No aggregate percentage may merge these evidence classes. No skipped,
quarantined, unexecuted or expected-failing test supplies a passing proof.
