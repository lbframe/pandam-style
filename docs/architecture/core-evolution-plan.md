# Core evolution implementation plan

Status: implementation plan prepared from source and upstream research; not
implemented, independently accepted or release-qualified. All work packages
below remain open. Planning base: `415e05539fcb5d36a78226112b5cf488b200b1aa`.

## Objective and inputs

Give AI/LLM agents enough approved styling vocabulary to implement complete
web applications, desktop web renderers, public sites, content, forms, data
interfaces and reusable component packages. Cover the static styling
capabilities represented by current StyleX and PandaCSS while preserving
PandamStyle's compiler-enforced design-system authority and finite runtime.

Inputs:

- [Product contract](../PRODUCT.md), [architecture](../ARCHITECTURE.md) and
  [constraints](../CONSTRAINTS.md).
- [Research](../research/core-evolution-upstreams.md): StyleX **0.19.1**,
  PandaCSS **2.2.0**, MDN BCD **8.1.6**, resolved on 2026-10-18.
- [Evidence lock](../research/core-evolution-evidence.json) and
  [property/utility inventory](../research/core-evolution-inventory.json).
- [Coverage matrix](core-evolution-coverage.md): CAP-01 through CAP-48 and
  original Alpha 2 request traceability.
- [Agentic optimization plan](agentic-optimizations-plan.md): related agent
  operations and evaluation work, with separate ownership below.

This plan specifies proposed shapes and modules. Existing public reference
pages remain the authority for shipped APIs until implementation changes them.
No new command, definition field or generated export in this plan may be used
as though Alpha 1 already supports it.

## Completion contract

1. Every property and capability in the pinned comparator inventory has a
   reviewed disposition. Stable, in-profile styling capabilities have working
   implementations, validated domains and executable proof.
2. Every admitted value is a finite keyword, approved token/resource reference
   or finite project-declared selection. Consumer source cannot create a new
   value domain, selector, token, asset or authority claim.
3. Each admitted declaration behaves consistently in direct styles, named
   conditions, recipes, slots, compounds, patterns, themes and global resources
   wherever it is semantically applicable. Context restrictions are explicit.
4. Complete interfaces preserve their layout, state, text flow, keyboard focus,
   responsive behavior and CSP. Successful compilation is necessary and
   insufficient as application evidence.
5. Browser support is established for the emitted CSS and exact target/profile,
   including transformation and fallback behavior. Unsupported/unknown features
   do not receive a passing support label.
6. Generated modules, declarations, manifests, CSS, source maps, diagnostics,
   hashes and incremental publication agree on one canonical revision.
7. Accepted project corpora have **zero unexpressible in-profile declarations**
   after approved tokenization and semantics-preserving normalization. No
   workaround allowance or reduced denominator conceals a product gap.
8. All supported host modes and final package archives pass their qualification;
   migration notes describe every changed shape or behavior.

Complete coverage means auditable capability coverage under these constraints.
It does not mean universal browser support or equivalence to an unrestricted
runtime styling channel. The [architecture dispositions](core-evolution-coverage.md#explicit-architecture-dispositions)
remain visible; required behavior incompatible with them must be reported as a
product limitation, not approximated and labeled complete.

## Architecture decisions to implement

### One declarative property catalog

Replace the mutually exclusive property/category/set/range model with a
canonical descriptor for each recognized property. Generate policy queries,
manifest domains, declarations and diagnostics from this descriptor and the
validated project definition. Do not maintain another handwritten allowlist in
types, recipes, hosts, the future agent SDK or migration tooling.

A descriptor records CSS name/aliases, grammar, permitted finite keywords,
token categories, resource kind, unit/range constraints, applicable contexts,
inheritance/reset behavior, logical/physical conflict family, shorthand
expansion, browser feature dependencies and serialization rules. Recognition
by the standards catalog does not grant consumer access to arbitrary values.

Proposed design-system `propertyDomains` may narrow standard domains or add
approved finite values for recognized properties. Its exact schema is frozen
in CE-02. It is declarative data validated by the compiler, not a consumer
extension callback or a generic string/number escape. Platform-specific
properties have a namespace/profile and remain distinguishable from standards.

### Typed tokens and resources

Retain existing token paths, visibility and same-category alias guarantees.
Add mixed domains such as size-token **or** `auto`/`min-content` where valid.
Use property-specific grammar checks: a negative length can be valid for an
offset and invalid for padding or width even if both reference a dimension.

Separate scalar tokens, approved composite values, named declaration bundles
and rule resources. Track dependencies between colors, gradients, shadows,
assets, keyframes, anchors and themes without string substitution that bypasses
category checks. Rule references must resolve to emitted rules, not dangling
strings such as the current hardcoded animation names.

### Conditions, conflict semantics and browser output

Use a parsed, canonical condition representation for finite registered names.
Recursion, selector lists, media/supports/container nesting and named
relationships must share validation and deterministic ordering. Distinguish
CSS declaration removal/tombstones from emitting reset keywords.

Preserve the existing `property-specificity` merge model unless an explicit,
versioned migration changes it. Specify physical/logical precedence, direction,
shorthand reset effects, conditions, `!important`, layers and global resources
as one contract. `all`, if admitted, requires complete reset/conflict handling;
it cannot silently become an ordinary atomic key.

Resolve browser targets once in the compiler. Perform any required CSS
transformation against the canonical complete candidate, before final CSS
identity, source-map and publication digests. Host optimizers must not change
semantic assumptions behind those identities. A minification stage needs a
documented identity relationship to the canonical candidate.

### Runtime and agent boundaries

Application execution retains authenticated class/reference composition and
finite selections. All keyframes, fallbacks, assets, global rules and condition
branches are static resources. Neither runtime `style` attributes nor stylesheet
injection are added as an answer to missing coverage.

The compiler's existing Project Service owns validation and publication.
Core evolution supplies canonical capability/target facts and bounded
diagnostics through its current snapshot/public interfaces. AG-01/02/04/05
own the future agent operation registry, SDK/CLI/MCP and contextual search.
Do not implement competing sessions or transports in this work.

## Work packages

Each work package produces source changes, contract updates, fixtures,
requirement-to-proof links, exact commands/results and an independent review
before acceptance. Revisions after review require fresh affected checks and
review. Tests below are implementation deliverables; none were executed to
produce this planning document.

### CE-00 — Freeze scope, baseline and proof corpus

Dependencies: none. This is the first implementation entry point.

- Expand the research inventory into a versioned property/capability registry
  with the dispositions in the coverage matrix. Inspect extraction and emitted
  CSS as well as type declarations; missing type keys are not automatic gaps.
- Pin original package tarballs, repository commit, lockfiles, source corpora,
  browser engines, fonts, assets and host versions. Preserve an executable
  Alpha 1 baseline for AG-00 even if core evolution lands first. AG evaluation
  must still run against that unchanged artifact; compare epochs explicitly.
- Recover the declaration classifier described by the integration note, or
  reconstruct a parser-based classifier and calibrate it against the original
  343/1,559 inputs. Keep the existing visual/CSP badge comparison separate.
  If generated inputs cannot be recovered, report the baseline as unavailable
  and freeze replacement inputs; do not relabel new counts as a reproduced run.
- Include application shells, forms, notices/empty states, dense data grids,
  content/marketing, RTL/vertical text, SVG/media, SSR and component libraries.
  Cover pointer, touch, keyboard, error/loading/disabled and high-contrast states.
- Define success per fixture: accepted vocabulary, expected CSS, computed
  geometry, text wrapping, state behavior, accessibility and CSP expectations.
  Preserve negative fixtures for wrong categories, private resources, unknown
  selectors, raw styles, runtime values and mixed design systems.
- Freeze non-regression budgets before product changes: full/incremental time,
  memory, CSS/module bytes, rule/variant growth and runtime selection cost.
  Record hardware, repetitions and threshold rationale. Reuse existing tooling
  where its measurements fit; do not invent success numbers in the plan.
- Reproduce and diagnose the inherited spelling, semantic-oracle and package/
  Next qualification failures. Keep their repairs traceable; never modify
  expected output solely to turn a red baseline green.

Exit: complete inventory dispositions and fixture IDs, retained original
baseline, calibrated measurement method, frozen budgets and named CI blockers.

### CE-01 — Browser and platform capability contract

Dependencies: CE-00 scope.

- Define project targets and named profiles, including modern evergreen web,
  mobile Safari/iOS and embedded Chromium/WebView where announced. Record exact
  resolved versions, Browserslist/data versions and configuration provenance.
  IE and obsolete engines require an explicit incompatibility disposition;
  no broad promise follows from accepting old target syntax.
- Freeze the default profile using the accepted project corpus and measured
  feature floor. Do not copy either upstream's headline browser numbers.
- Add per-feature states: native, transformed with proof, equivalent fallback,
  incompatible, unknown. Separate compiler recognition and browser evidence.
- Track property values, units, selectors, rule resources and combinations:
  layers, `:has`, container query kinds/units, `@property`, intrinsic sizes,
  `text-wrap` keywords, colors, masks, anchors, scopes and transition APIs.
- Evaluate a compiler-owned transformation dependency against required
  semantics and license/dependency cost. Include layer lowering, prefixing,
  logical properties, modern color functions and source maps. Reject purported
  polyfills that lose cascade, inheritance or computed-value behavior.
- Decide structured warning/error policy: an unavailable required capability
  without an approved equivalent fails the target profile. Optional progressive
  enhancement must be declared by the system author with a fallback policy.

Exit: versioned target schema and deterministic resolution, feature records,
transformation decision and executable target-specific acceptance cases.

### CE-02 — Canonical domains, grammar and normalization

Dependencies: CE-00, CE-01 contracts.

- Implement the declarative property descriptors and proposed system-domain
  extension schema. Admit finite standard keyword domains and public approved
  token/resource unions, without broad consumer `string`/`number` branches.
- Validate values against property grammar and numeric/unit applicability.
  Normalize canonical spelling and numeric zero without treating every CSS
  numeric string as a token reference or every number as a pixel length.
- Replace continuous/infinite opacity/flex ranges with explicit approved
  domains in the new contract; include their Alpha 1 source migration.
- Define finite CSS-wide keywords, null/removal, unknown properties, vendor
  extensions, custom-property ownership and malformed definition diagnostics.
- Normalize approved shorthands and bundles to validated longhands/IR while
  preserving all reset semantics. A refused free composite can still have a
  finite resource equivalent. Cover `flex: none`, approved flex tuples,
  border/background/font/animation/transition and side/logical variants.
- Register property conflict families, aliases and direction behavior once;
  preserve source locations through expansion and report all relevant errors.
- Qualify escapes, comments, CSS token boundaries, unsafe serialization,
  accidental `!important`, malicious-looking resource text and non-finite values.
  Build configuration authority does not excuse malformed CSS output.

Primary paths: `design-system/policy/`, `registry/`, `engine/lowering/`,
`engine/atomic/`, `protocol/diagnostics*` under compiler source.

Exit: descriptor-driven validation; cross-context positive/negative tests;
deterministic normalization and no raw consumer value channel.

### CE-03 — Tokens, semantic values, themes and resource graphs

Dependencies: CE-02; conditional representation coordinated with CE-07.

- Bind `sizes`, `zIndices`, `opacities`, `borderWidths`, ratios, transforms,
  filters, gradients, assets and remaining required categories. Retain current
  category names such as `fontFamilies`; do not rename them to match Panda.
- Support dimension tokens in px/rem/em/ch, percentages and approved modern
  viewport/container units. System definitions may contain validated
  `calc`/`min`/`max`/`clamp`/`minmax`/`repeat` compositions; consumer agents
  select their finite references. Validate nested references and dependencies.
- Add structured composite resources where needed for shadows, gradients,
  border/font/animation bundles and declaration sets. Scalars remain backward
  compatible where their existing meaning can be preserved.
- Define conditional semantic token values with base, named conditions,
  inheritance, theme overrides and compatible alias resolution. Reject cycles
  through themes, resources or conditional branches; preserve private visibility.
- Handle explicit defaults, `currentColor`, transparent/system colors and
  inherited variables with grammar-aware checks. A color accepted as text
  remains subject to target support for its actual color syntax.
- Qualify nested themes, theme reset, alias remaps and unused-token elimination;
  verify that pruning cannot remove resources selected by finite runtime axes.

Primary paths: `design-system/registry/`, `tokens/`, `themes/`, snapshot and
token/theme lowering. New resource modules use the same authority.

Exit: base/conditional/theme values valid in every applicable context; stable
resource identities, exact dependency invalidation and preserved visibility.

### CE-04 — Layout, dimensions, flex, grid and scrolling

Dependencies: CE-02/03; target facts from CE-01.

- Cover display modes, intrinsic sizing, physical/logical width/height and
  min/max, box sizing, aspect ratio, visibility, positioning and containment.
- Complete flex direction/wrap/grow/shrink/basis/order and per-property alignment
  keywords, including start/end and distributed spacing. Preserve distinctions
  between `auto`, zero basis and shorthand reset defaults.
- Add grid template columns/rows/areas, auto tracks/flow, gap and line/area/span
  placement. Expose approved track/placement resources and finite parameters;
  include `232px minmax(0, 1fr)`, equal tracks, auto-fit/fill and subgrid targets.
- Complete physical/logical margin/padding/inset families, auto keywords and
  allowed signed offsets. Validate block/inline behavior in horizontal/vertical
  writing and RTL, rather than equating start/end to left/right.
- Add overflow axes, clipping, overscroll, scroll snap, gutters, scroll margin/
  padding and scroll behavior. Test sticky/fixed containing blocks, keyboard
  scrolling, mixed-axis computed overflow and narrow viewports.
- Include tables, multi-column content, replaced elements and container layouts
  in the canonical property catalog, not only flex/grid demonstrations.

Exit: CAP-03 through CAP-08 and CAP-16 layout fixtures, all original size/grid
cases, target-specific geometry assertions and preserved conflict semantics.

### CE-05 — Surfaces, focus, controls, media and SVG paint

Dependencies: CE-02/03; CE-07 conditions for state qualification.

- Complete border sides and logical sides: width/style/color, radii, outline
  width/style/color/offset, border collapse/spacing and approved border images.
- Add backgrounds, gradient/image layers, clips/origins, sizes/repeat/positions,
  masks, blending, shadows, opacity, filters and backdrop filters.
- Complete cursor, user select, pointer events, touch action, resize, appearance,
  accent/caret and applicable form-control properties. Include platform-scoped
  `WebkitAppRegion` drag/no-drag when qualifying Electron; do not treat it as
  portable browser CSS.
- Implement object-fit/position, shape/clip resources, SVG paint, stroke width,
  dashes, line caps/joins, vector effects and presentation-property constraints.
- Provide system-owned focus-visible treatments that survive forced colors,
  keyboard navigation, disabled/read-only states and browser-native controls.

Exit: focus accessibility, disabled selection, scroll/media/paint and SVG cases
verified across targets; fallback behavior never silently removes focus cues.

### CE-06 — Typography, content and writing systems

Dependencies: CE-02/03.

- Cover text alignment, vertical alignment, whitespace including pre/pre-wrap/
  pre-line, wrap modes, word/overflow breaking, ellipsis and indentation.
- Add font stretch/style/variant/features/variations, synthesis and kerning,
  text decoration/emphasis, underline details, text transform and text rendering.
- Define line-clamp with its required display/orientation/overflow bundle and
  target behavior. Do not accept a typed property while omitting its prerequisites.
- Add lists, counters/quotes, pseudo content, ruby and vertical writing where
  present in the recognized stable catalog. System-authored content/attribute
  functions must have finite approved sources and safe serialization.
- Distinguish support for the `text-wrap` property, `balance`, `pretty` and
  longhands. Record unsupported target variants and approved equivalents.
- Test Latin/CJK/RTL, long unbroken strings, code/preformatted content, tables,
  icons alongside text and font loading. Avoid text-overflow claims based only
  on stylesheet serialization.

Exit: computed wrapping/line-box and content fixtures with pinned fonts;
writing-mode/direction correctness and explicit keyword-level target results.

### CE-07 — Conditions, selectors, fallbacks and cascade

Dependencies: CE-01/02; coordinate CE-03 conditional tokens.

- Parse condition definitions and recursive use sites into canonical finite
  trees. Support nested named media/supports/container conditions and pseudo,
  ARIA/data, structural, print, reduced-motion/contrast/color/input conditions.
- Qualify selectors for placeholder, selection, file controls, backdrop,
  before/after, focus-visible, group/peer and ancestor/sibling relationships.
  Provide registered marker/resource identities where selectors require them.
- Close the current raw condition-block ambiguity: consumer use sites must
  resolve authorized names/resources. Internal normalized selectors carry
  compiler provenance; a colon/@/attribute prefix is not sufficient authority.
- Define intersection/overlap ordering, duplicate conditions, aliasing, base
  requirements, nesting limits, selector-list validity and unsupported subtrees.
- Add system-owned ordered fallback values; validate each alternative against
  grammar/categories and targets. Do not confuse parse-time fallback with an
  invalid custom-property value at computed-value time.
- Complete conflict/reset behavior across shorthand/longhand, logical/physical,
  pseudo conditions, source composition, globals and native/lowered layers.
  Decide explicit `!important` policy, including its reversed layer precedence;
  refusing arbitrary suffix strings must not leave required system rules unclear.
- Apply the same representation to conditional tokens and stylesheet resources.

Exit: selector authority and negative bypass cases; deterministic CSS and
computed cascade proof for overlapping conditions and composed references.

### CE-08 — Animation, transforms and transitions

Dependencies: CE-02/03/07.

- Add a system-owned keyframe registry with finite frame offsets, validated
  declarations, reference resolution, deterministic names and deduplication.
- Make animation-name references require actual resources. Migrate or diagnose
  hardcoded `spin`/`pulse`; never emit a dangling name as successful behavior.
- Complete animation/transition longhands and finite approved property lists,
  iteration/fill/play/direction, transform lists/origins and individual transforms.
- Define approved transform/filter composition and reset behavior, including
  `transform: none` under disabled/reduced-motion conditions.
- Test keyframe/theme dependencies, unused removal, HMR replacement and ordering.
  Respect declared reduced motion and record whether native typed-variable
  interpolation is necessary; a default-value fallback cannot emulate it.

Exit: state and motion fixtures, reduced-motion behavior and no runtime CSS
mutation; CE-11 provides the modern timeline/transition rule resources.

### CE-09 — Global rules, fonts and asset pipeline

Dependencies: CE-02/03/07; host contract coordinated with CE-13.

- Define explicit system-owned reset/preflight, global selectors, scoped
  declaration resources, font-face, counters and allowed non-atomic at-rules.
  No consumer free stylesheet string is introduced.
- Specify global selector scope, ownership, third-party CSS layers and the
  relationship of resets to component references and `revert-layer`.
- Resolve local fonts/images and approved URLs at build time with bundler asset
  mapping, base paths, hashes, source maps, escaping and self-hosted outputs.
  A Vite import value is not assumed to be an extractable CSS URL.
- Define URL policy per resource and project target, including SVG/data URLs
  only when explicitly approved. Style CSP and image/font/network CSP are
  separate facts; `style-src 'self'` does not authorize all asset protocols.
- Qualify `next/font`/external CSS-variable references through explicit typed
  external resources. Fail missing or incompatible imports instead of silently
  accepting unknown `var(--anything)` strings in consumer source.
- Include global rule/resource edits in incremental invalidation and stale
  output cleanup, with no parallel CSS writer outside the Project Service.

Exit: font/image loading and relative/base-path fixtures, global cascade proofs
and exact emitted-resource identities for dev, SSR and production.

### CE-10 — Recipes, patterns and shared definitions

Dependencies: CE-03/04/05/06/07; motion resources as needed.

- Make expanded domains available to existing recipes, slots and compounds;
  preserve defaults, boolean false, ordering, visibility and collision rules.
- Add precompiled responsive variant selections using finite registered axes
  and conditions. Define compound interaction explicitly. The upstream Panda
  compound/responsive restriction is a minimum limitation to disclose, not a
  reason to silently produce wrong CSS. If the accepted corpus needs the
  combination, implement and prove its finite condition-state semantics.
- Provide equivalent capabilities for the twenty Panda base patterns, using
  canonical parameter schemas rather than duplicating aliases/wrappers.
  Include wrap, spacer, grid item, container, aspect ratio, divider, overlay,
  float, bleed, visually hidden and named query-container patterns.
- Add approved text/layer/animation declaration bundles where they improve
  finite composition. Their expansion uses the normal catalog and diagnostics.
- Define shareable design-system packages: authorized definition imports,
  namespaces, collision/override rules, version identity and CSS/resource
  ownership. Runtime references from unrelated systems remain incompatible.
- Budget finite expansion and provide an actionable compile-time failure for
  excessive state spaces; never truncate variants silently.

Exit: representative primitive libraries and layout patterns migrate without
raw channels; responsive/compound behavior and package composition are proven.

### CE-11 — Modern CSS capabilities and progressive enhancement

Dependencies: CE-01/03/07/08/09.

- Add owned typed custom properties with syntax/inheritance/default semantics.
  Define old-engine behavior separately from native registration/interpolation.
- Add named anchors, position-try resources, area/anchor properties and finite
  fallback layouts. Keep positioning JavaScript/native API requirements separate
  from CSS rule support.
- Add named view-transition styles and pseudo-element resources, including
  keyframe references. Track same-document, cross-document and class styling
  capabilities separately; invoking a transition is application behavior.
- Cover `@starting-style`, supported scope rules, scroll/view timelines,
  timeline/range names, container query kinds and modern units in the catalog.
  Required unsupported browser behavior needs an approved equivalent; optional
  enhancement may be native-only with explicit targets.
- Verify color-mix/light-dark, modern colors, intrinsic interpolation and other
  inventory features individually. Inspect the complete cascade when lowering;
  avoid the documented per-module color-scheme transformation hazard.
- Freeze experimental/vendor dispositions and browser bug notes in capability
  records. A new upstream release triggers a delta decision, not automatic
  adoption or an implied browser guarantee.

Exit: each modern capability is native/verified-equivalent/incompatible per
target; required in-profile capabilities have executable proof and no unknowns.

### CE-12 — Generated surfaces, identities and incremental correctness

Dependencies: CE-02 baseline contract; integrate continuously with CE-03–11.

- Project all property unions, public/private resources, conditional shapes,
  finite recipe/pattern selections and target facts from the canonical snapshot.
- Update generated JavaScript, `.d.ts`, manifests, diagnostics and public SDK
  declarations together. Types must reject forbidden values; compiler rejection
  remains authoritative over casts and typecheck success.
- Include policy/domain/target/transform/resource inputs in semantic hashes,
  caches, dependency graphs, accepted snapshots and artifact-set identity.
  Invalidate changes to resource references, conditions, fonts/assets and themes.
- Prove clean/full output equals incremental output for definition/source edits,
  additions, deletion, rename, target changes and failed revisions. Prevent stale
  rules, ghost resources, namespace collisions and cross-project cache leakage.
- Transform final CSS before sealing artifact digests; preserve traceable source
  maps and host final-asset identity. Stable semantic IDs must not depend on
  local checkout paths or request ordering.
- Evaluate selective token/keyframe/variant emission without dropping finite
  runtime branches or external package resources. Measure rather than assume
  output size and extraction performance improve.
- Expose facts through existing compiler boundaries for future AG tooling.
  Version schema/ABI only according to actual structural or behavioral changes.

Exit: deterministic full/incremental artifact equivalence, sound declarations,
accurate diagnostics and resource-aware revision/publication tests.

### CE-13 — Hosts, source formats, SSR, test runners and CSP

Dependencies: CE-12 plus the capability/resource slices being qualified.

- Requalify Vite 8.3.1 dev/build, Rsbuild/Rspack dev/build, direct Next webpack
  dev/build, Turbopack semantic development and strict production individually.
  Pin their exact Node/OS/package combinations; do not widen support from peers.
- Qualify Vitest **4.1.11** on Vite **8.3.1**, the exact versions declared by
  the inspected consumer manifest: one-shot/watch,
  JSX transforms, generated import resolution, CSS availability, definition
  reload, test isolation and React Testing Library component behavior.
- Establish a source-format matrix against upstream coverage: JS/TS/JSX/TSX,
  Vue/Svelte/Astro source and SSR/reusable packages. Implement required bounded
  frontend/host adapters to the same compiler service; source maps, roots,
  template extraction and lifecycle must be explicit. Unsupported formats are
  recorded before accepting projects that require them. Framework wrappers
  are not a substitute for actual source extraction.
- Qualify SSR/RSC/hydration, lazy routes, code splitting, public base paths,
  external definitions, static site output and multiple compiler environments.
  Serve complete first-paint styles and eliminate stale/deleted resources.
- Exercise production and development CSS delivery under `style-src 'self'`,
  with style-src-attr/style-src-elem behavior where applicable. Detect violations
  and any CSSOM/inline-style writes; do not silently relax CSP or add a nonce
  requirement to make a fixture pass.
- Test actual Electron/Chromium and mobile WebKit profiles where announced.
  Playwright's WebKit is useful coverage but not proof of every Safari/iOS
  version. Retain evidence for actual claimed engines or mark them unqualified.
- Keep application style delivery separate from AG-13 overlay removal while
  ensuring inherited development clients cannot invalidate the CSP claim.
  A violating development display path blocks that host's CSP gate until its
  removal/replacement is delivered and linked to AG-13; its ownership is not
  permission to ignore the failure. Other CE work can proceed independently.

Exit: exact host/source-format/browser matrix, per-mode lifecycle and CSP proof,
and no duplicate compiler owner or host-specific policy implementation.

### CE-14 — Project migrations and result qualification

Dependencies: CE-00 corpus and completed required capability slices, CE-13.

- Rerun the calibrated classifier against final archives and pinned project
  inputs. Report direct expressions, tokenization, semantic rewrites, missing
  vocabulary, unsupported compiler capability and target/runtime limitations.
  Every original declaration is accounted for; composites remain in the total.
- A potential token binding is not a successful migrated declaration. Validate
  the actual authorized definition, generated code and emitted CSS. Missing
  project vocabulary and missing compiler support remain distinct failures.
- Run component/application comparisons in all required states/viewport/target
  combinations. Include layout/text, computed properties, screenshots, keyboard
  focus, forced colors, reduced motion, SSR and CSS/asset load behavior.
- Remove obsolete padding/attribute-CSS workarounds and expected-difference
  allowances after equivalent support lands. No visible redesign or global
  escape is introduced to make migration counts pass.
- Execute independent agent migrations from published documentation and exact
  packages. Core-specific migration fidelity is separate from AG-00/12's full
  LLM task-efficiency evaluation; reuse inputs without relabeling the results.
- Compare frozen performance/output budgets, resource growth and failure paths;
  report all skipped or unavailable evidence. Required gaps block completion.

Exit: zero unexpressible in-profile declarations, preserved application behavior,
all CAP/request proofs linked and budgets satisfied on varied projects.

### CE-15 — Compatibility, review and publication

Dependencies: completed required CE-00–14 work and independent final review.

- Produce migration notes for property-domain format, numeric literal policy,
  tokens/resources, generated imports, condition syntax, cascade/reset behavior,
  target defaults, declaration/manifest changes and any ABI/protocol changes.
- Keep a before/after fixture for the already migrated Alpha 1 component.
  Regenerate compiler-owned output; never require manual edits to generated files.
- Qualify clean installs, exports, dependencies, licenses, source maps and static
  assets using the exact tarballs intended for publication. Supported modes
  must use those archives, not source/workspace substitutions.
- The initial requested Alpha 2 release uses exact **0.1.0-alpha.2** for all
  released `@pandamstyle/*` packages together, including exact internal pins.
  If the channel/version is already occupied, resolve a new release identity
  explicitly; never overwrite a published artifact or mix Alpha 1/2 packages.
- An intermediate Alpha 2 may ship a fully qualified compatibility slice only
  if its scope and remaining CE work are explicit. It does not close this plan
  or assert complete upstream parity. Full core evolution closes only when the
  completion contract and all accepted capability/profile gates pass.
- Publish changelog, release scope, support matrix, migration, known architectural
  limitations and revision-bound proof links. Verify published archive hashes
  and installation against the reviewed candidate.
- Keep core evolution distinct from AG delivery: no claim that agent operation
  transports or human-surface removal are complete because CSS coverage shipped.

Exit: reviewed/published package identity and evidence agree; all claims are
bounded by demonstrated scope, with no unresolved required gate.

## Execution order and ownership

| Phase | Work | Dependency and acceptance |
| --- | --- | --- |
| Baseline | CE-00 | Scope, original artifacts, corpus and budgets frozen first |
| Contracts | CE-01 → CE-02 | Targets and property/resource authority fixed before feature expansion |
| Vocabulary | CE-03; CE-07 condition contract | Token/resource and condition representations fixed together |
| Capabilities | CE-04/05/06; CE-08/09 after their prerequisites | Independent families can progress against the same descriptor contract |
| Composition | CE-10 | Expanded domains and conditions available |
| Modern features | CE-11 | Resource/cascade/target prerequisites satisfied |
| Projections and host slices | CE-12/13 throughout | Required affected host and incremental tests per feature slice |
| Convergence | CE-14 → CE-15 | Project behavior, archives, review and release evidence close the plan |

Primary change areas:

| Area | Responsibility |
| --- | --- |
| `packages/compiler/src/design-system/` | Catalog, domains, tokens, themes, recipes, patterns and resource graphs |
| `packages/compiler/src/engine/` | Validated IR lowering, conflicts, rule ordering and target transforms |
| `packages/compiler/src/frontend/`, `semantics/` | Source extraction, compiler provenance and diagnostics |
| `packages/compiler/src/artifacts/`, `project/`, `api/` | Generated surfaces, identity, invalidation and publication |
| `packages/core/` | Finite reference/recipe selection; no CSS-value interpreter |
| `packages/{vite,next,rsbuild}/` | Host lifecycle, source/asset routing and CSS delivery |
| Proposed `tests/core-evolution/`, `tools/coverage/` | Capability/corpus classification and qualification evidence |
| `docs/reference/`, `docs/agent-*`, AgentDoc catalog | Shipped contracts, migration, evidence and agent routing |

New directories/fields are proposals to freeze in their work package, not
already supported public APIs. Prefer existing modules when they own the same
responsibility; do not create a parallel engine or proof oracle.

## Relationship to agentic optimizations

- CE owns CSS capability breadth, definitions, lowering, emitted target facts,
  generated domains and project migration fidelity.
- AG-00/12 own the full multi-model task baseline and efficiency qualification.
  Preserve original artifacts before CE behavior changes; later AG results must
  name the original and evolved epochs explicitly.
- AG-01/02 own operation envelopes, capabilities, owner access and SDK/CLI/MCP.
  CE exposes canonical facts through the compiler, not a competing agent service.
- AG-03/04/05 enrich metadata, search and task context. Coordinate snapshot and
  schema changes rather than forking the vocabulary or shipping duplicate facts.
- AG-06/07/08 own agent repair/extension operations and isolated candidates.
  CE validation remains usable by those operations and never grants callers
  design-system author permissions through input fields.
- AG-13 owns the exhaustive human-surface removal gate. CE introduces only
  agent-useful APIs and participates in CSP/packaging checks; it does not mark
  existing removals complete without their own proof.

Neither initiative's issue completion substitutes for the other's acceptance
criteria. Preserve the accepted AG plan/review unchanged while implementing CE.

## Open decisions and blockers to close before implementation

| Decision or blocker | Owner | Required resolution |
| --- | --- | --- |
| Exhaustive property/alias/vendor/experimental dispositions | CE-00/02 | Reviewed machine inventory and stable catalog scope |
| Default browser floors, mobile/embedded profiles | CE-01 | Pinned targets from the corpus and compatibility evidence |
| Exact domain/resource/conditional-token schemas | CE-02/03/07 | Contract fixtures and migration examples |
| CSS transformation engine and identity stage | CE-01/12 | Semantic/target proof and dependency decision |
| Responsive compound semantics and expansion limits | CE-10 | Accepted finite model and measured budgets |
| Vitest 4.1.11 + Vite 8.3.1 and additional host/source combinations | CE-13 | Registry/lockfile identity and executable qualification matrix |
| Missing original declaration-classifier artifact | CE-00 | Recover or calibrate a replacement with disclosed provenance |
| Inherited red CI gates | CE-00 | Reproduce, attribute and repair with separate evidence |
| Independent review of this plan | Planning acceptance | Fresh reviewer, pinned candidate and corrections before execution acceptance |

These are named implementation decisions, not claims that the corresponding
APIs already exist or that compatibility has been measured. This documentation
delivery runs only documentation/catalog checks; product tests, browser runs,
benchmarks, migrations and publication remain future work.
