# Compiler engine source map

## Baseline and method

This map records upstream source provenance and implementation disposition for the compiler modules shipped in Alpha 1. It is not a qualification or benchmark archive. The source paths identify upstream modules used to derive the retained implementations; the Alpha 1 source snapshot is the implementation authority.

The four current callers of the plugin entry only call `processStylexRules` or its shared ordering primitives. They do not call the StyleX Babel visitor. The evaluator is always invoked with `disableImports: true`; PandamStyle resolves design-system imports and forwarding separately by Babel binding identity. These facts narrow the required behavior and are checked against the frozen semantic oracle, not treated as permission to broaden evaluation.

## Required behavior and source-module decisions

Each source row identifies an upstream module and its retained PandamStyle
target. Owned PandamStyle tests define supported behavior; upstream tests may
provide additional source-level context.

| Donor source module | Current caller / responsibility | Required behavior and owned target | Decision | Existing protection / provenance |
| --- | --- | --- | --- | --- |
| `packages/@stylexjs/babel-plugin/src/utils/evaluate-path.js` | `frontend/babel/evaluate.js`; safe static expression folding | Keep literals, immutable local aliases, object/array spreads, computed keys, TS wrappers, recursion detection, and fail-closed deopt in `frontend/babel/static-evaluator.js`. Drop donor import resolution because caller disables it. | REFACTOR | semantic oracle evaluation and forwarding cases; donor `@stylexjs/babel-plugin` 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/utils/evaluation-errors.js` | evaluator; stable deopt reasons | Keep only reasons used by the owned static evaluator in `frontend/babel/static-evaluation-errors.js`. | MOVE | semantic oracle non-static cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/utils/state-manager.js` | `frontend/babel/plugin.js` and evaluator type/context; generic StyleX plugin pass state | Replace with a per-plugin-pass PandamStyle evaluation context in `frontend/babel/pass-state.js`; no import resolver, StyleX visitor maps, global cache, or donor abstraction. | REWRITE | project-isolation, static-evaluation, and forwarding oracle cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/index.js` | `compile-file.js`, `project/session/fresh.js`, `project/session/index.js`, and `project/css-state/index.js`; currently exposes both a general Babel plugin and CSS aggregation helpers | Only the documented CSS ordering helpers are required: `processStylexRules`, comparator, entry transform, layer header/name, logical-float preamble, constant split, specificity and ancestor selector helpers, and declared-property ordering. Extract/refactor into `engine/ordering/`; the general StyleX visitor, imports, and transforms are unused. | REFACTOR | owned incremental CSS/oracle cases; upstream processStylexRules suite as secondary evidence; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/stylex-create.js` | `engine/lowering/styles.js`; atomic style lowering | Preserve PandamStyle-observed atomic declarations, hashes, normalization, property expansion, conditions, and rule shape under `engine/atomic/`. | REFACTOR | semantic oracle, browser computed styles, SSR, incremental CSS; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/preprocess-rules/PreRule.js` | stylex-create preprocessing intermediate form | Keep only the intermediate representation required by atomic preprocessing under `engine/atomic/`. | REFACTOR | shorthand/longhand, condition, and normalization oracle cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/preprocess-rules/application-order.js` | stylex-create; declaration ordering | Preserve supported application ordering under `engine/atomic/`. | REFACTOR | cascade and conflict oracle cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/preprocess-rules/basic-validation.js` | stylex-create; key/value validation | Retain validation exercised by the PandamStyle-supported value profile under `engine/atomic/`. | REFACTOR | semantic oracle policy/value cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/preprocess-rules/flatten-raw-style-obj.js` | stylex-create; flatten nested raw styles | Preserve supported nesting and condition expansion under `engine/atomic/`. | REFACTOR | semantic oracle condition/nesting cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/preprocess-rules/index.js` | stylex-create; preprocessing sequence | Keep the required sequence in one owned atomic pipeline under `engine/atomic/`. | REFACTOR | atomic and conflict oracle cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/preprocess-rules/legacy-expand-shorthands.js` | stylex-create and ordering preamble; legacy shorthand and logical-float names | Preserve only supported shorthand expansion and logical-float identifiers under `engine/atomic/` and `engine/ordering/`. | REFACTOR | shorthand, direction, and CSS output oracle cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/preprocess-rules/property-specificity.js` | stylex-create; atomic property conflict ordering | Preserve supported property specificity under `engine/atomic/`. | REFACTOR | shorthand/longhand conflict oracle cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/hash.js` | atomic, token, and theme lowering; stable class/variable identity | Preserve exact observed digest inputs and results in owned `engine/atomic/` and `engine/lowering/` helpers. | REFACTOR | hash determinism and SSR oracle cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/messages.js` | atomic validation/lowering diagnostics | Retain only messages used by the supported atomic profile under `engine/atomic/`. | REFACTOR | negative semantic-oracle cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/physical-rtl/generate-ltr.js` | atomic rule generation | Preserve supported LTR declarations under `engine/atomic/direction/`. | REFACTOR | browser direction cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/physical-rtl/generate-rtl.js` | atomic rule generation | Preserve supported RTL declarations under `engine/atomic/direction/`. | REFACTOR | browser direction cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/utils/convert-to-className.js` | atomic class generation | Preserve stable class-name construction under `engine/atomic/`. | MOVE | generated CSS, hash determinism, SSR cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/utils/dashify.js` | atomic CSS property serialization | Preserve property-name conversion under `engine/atomic/`. | MOVE | browser computed-style and output oracle cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/utils/generate-css-rule.js` | atomic CSS rule generation | Preserve selectors, at-rule wrapping, LTR/RTL pair shape, and priority inputs under `engine/atomic/`. | REFACTOR | browser, ordering, and incremental CSS cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/utils/normalize-value.js` | atomic value serialization | Preserve supported CSS value normalization under `engine/atomic/`. | REFACTOR | value-normalization and browser oracle cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/utils/normalizers/convert-camel-case-values.js` | value normalization | Preserve supported value conversions under `engine/atomic/normalizers/`. | MOVE | value-normalization oracle cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/utils/normalizers/detect-unclosed-fns.js` | value normalization parser | Preserve malformed-function rejection under `engine/atomic/normalizers/`. | MOVE | negative value oracle cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/utils/normalizers/detect-unclosed-strings.js` | value normalization parser | Preserve malformed-string rejection under `engine/atomic/normalizers/`. | MOVE | negative value oracle cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/utils/normalizers/font-size-px-to-rem.js` | optional font normalization | Keep only if the frozen supported configuration exercises it; otherwise remove from the absorbed closure. | REFACTOR | current compiler defaults disable this behavior; upstream normalization test is secondary; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/utils/normalizers/leading-zero.js` | value normalization | Preserve supported numeric serialization under `engine/atomic/normalizers/`. | MOVE | value-normalization oracle cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/utils/normalizers/quotes.js` | value normalization | Preserve supported string quoting under `engine/atomic/normalizers/`. | MOVE | value-normalization oracle cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/utils/normalizers/timings.js` | value normalization | Preserve supported timing serialization under `engine/atomic/normalizers/`. | MOVE | value-normalization oracle cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/utils/normalizers/whitespace.js` | value normalization | Preserve supported whitespace normalization under `engine/atomic/normalizers/`. | MOVE | value-normalization oracle cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/utils/normalizers/zero-dimensions.js` | value normalization | Preserve supported zero-dimension normalization under `engine/atomic/normalizers/`. | MOVE | value-normalization oracle cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/utils/object-utils.js` | atomic and variable object traversal | Retain only object helpers used by supported lowering under `engine/atomic/` and `engine/lowering/`. | REFACTOR | token/theme and atomic oracle cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/utils/rule-utils.js` | rule generation/preprocessing | Retain the required rule operations under `engine/atomic/`. | REFACTOR | deduplication and ordering oracle cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/utils/split-css-value.js` | value normalization | Preserve supported CSS value splitting under `engine/atomic/`. | MOVE | value-normalization oracle cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/utils/transform-value.js` | value normalization | Preserve supported CSS value transformations under `engine/atomic/`. | REFACTOR | value-normalization and browser cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/stylex-define-vars.js` | `engine/lowering/styles.js`; stable token variable definitions | Preserve variable naming, group identity, values, and token aliases under `design-system/tokens/` and `engine/lowering/`. | REFACTOR | semantic oracle, token rename/repair, incremental invalidation, SSR; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/stylex-vars-utils.js` | define-vars/create-theme shared behavior | Preserve variable group projection needed by base and alternate themes in `design-system/tokens/` and `design-system/themes/`. | REFACTOR | token/theme and browser/SSR oracle cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/types/index.js` | runtime CSS type predicates used by token/theme lowering | Retain only supported runtime predicates under `design-system/tokens/`. | REFACTOR | token/theme value cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/stylex-create-theme.js` | `engine/lowering/styles.js`; base/alternate theme projection | Preserve shared variable-group identity and overrides under `design-system/themes/` and `engine/lowering/`. | REFACTOR | browser, SSR/hydration, and theme oracle cases; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/shared/src/utils/property-priorities.js` | imported by donor `generate-css-rule.js`; atomic declaration and selector priorities | Preserve only the observed priority contract in `engine/ordering/property-priorities.js`; remove the package dependency. | REFACTOR | atomic conflict/order and browser cases; donor `@stylexjs/shared` 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/utils/default-options.js` | engine lowering and generic `StateManager` defaults | Replace with a small explicit PandamStyle-supported defaults object in `engine/ordering/defaults.js`; no generic donor options object is retained. | REWRITE | engine defaults and oracle coverage; donor plugin 0.19.1, MIT |
| `packages/@stylexjs/babel-plugin/src/shared/common-types.js` | imported as Flow types by donor engine helpers | No runtime behavior; replace any required internal type shape with PandamStyle-owned local types. | REWRITE | compiler build plus owned engine tests; donor plugin 0.19.1, MIT |

## Transitive media-query parser closure

The donor ordering and nested-condition helpers imported the bare workspace
specifier `style-value-parser`. Its package entry's CommonJS shape made the
pre-edit compiler Rollup graph watch 19 parser-package files. The required
media-query behavior uses only this eight-file source closure; the owned engine
imports these modules directly, so neither the package entry nor its unused
property-parser exports remain in the production graph.

| Donor source module | Required behavior | PandamStyle target | Decision | Existing protection / provenance |
| --- | --- | --- | --- | --- |
| `packages/style-value-parser/src/at-queries/media-query.js` | Parse and normalize supported media conditions for CSS ordering. | `packages/compiler/src/engine/ordering/media-query/media-query.js` | REFACTOR | CSS ordering and condition cases; StyleX 0.19.1, MIT |
| `packages/style-value-parser/src/at-queries/media-query-transform.js` | Preserve last-media-query-wins projection for nested responsive declarations. | `packages/compiler/src/engine/ordering/media-query/media-query-transform.js` | REFACTOR | Responsive-condition and semantic-oracle cases; StyleX 0.19.1, MIT |
| `packages/style-value-parser/src/at-queries/messages.js` | Stable parser errors used by media-query parsing. | `packages/compiler/src/engine/ordering/media-query/messages.js` | MOVE | Existing media-query negative cases; StyleX 0.19.1, MIT |
| `packages/style-value-parser/src/css-types/calc.js` | Parse CSS `calc()` expressions in media conditions. | `packages/compiler/src/engine/ordering/media-query/css-types/calc.js` | REFACTOR | Media-query ordering cases; StyleX 0.19.1, MIT |
| `packages/style-value-parser/src/css-types/calc-constant.js` | Parse constants used by media-condition calculations. | `packages/compiler/src/engine/ordering/media-query/css-types/calc-constant.js` | MOVE | Media-query ordering cases; StyleX 0.19.1, MIT |
| `packages/style-value-parser/src/css-types/common-types.js` | Shared percentage and number parsing required by `calc()`. | `packages/compiler/src/engine/ordering/media-query/css-types/common-types.js` | REFACTOR | Media-query ordering cases; StyleX 0.19.1, MIT |
| `packages/style-value-parser/src/token-parser.js` | Token cursor used by media and calc parsing. | `packages/compiler/src/engine/ordering/media-query/token-parser.js` | REFACTOR | Media-query ordering cases; StyleX 0.19.1, MIT |
| `packages/style-value-parser/src/token-types.js` | Token list and tokenizer adaptation used by the parser. | `packages/compiler/src/engine/ordering/media-query/token-types.js` | REFACTOR | Media-query ordering cases; StyleX 0.19.1, MIT |

The remaining 11 files observed through the old package entry were not required
by the engine callers and were not copied:

```text
packages/style-value-parser/src/index.js
packages/style-value-parser/src/properties.js
packages/style-value-parser/src/properties/transform.js
packages/style-value-parser/src/properties/box-shadow.js
packages/style-value-parser/src/properties/border-radius.js
packages/style-value-parser/src/css-types/transform-function.js
packages/style-value-parser/src/css-types/length.js
packages/style-value-parser/src/css-types/color.js
packages/style-value-parser/src/css-types/length-percentage.js
packages/style-value-parser/src/css-types/angle.js
packages/style-value-parser/src/css-types/alpha-value.js
```

The `font-size-px-to-rem` module is reachable but the current PandamStyle-owned options disable it. Its final disposition is conditional on frozen oracle/config evidence; it is not retained merely because a donor default object names it.

## Reachable but not required modules

The following paths are in the conservative AST closure but have no required PandamStyle caller after the decisions above. They are deliberately not copied. The package metadata row is listed separately because it is resolution metadata rather than source code.

```text
packages/@stylexjs/atoms/src/babel-transform.js
packages/@stylexjs/babel-plugin/src/shared/index.js
packages/@stylexjs/babel-plugin/src/shared/stylex-consts-utils.js
packages/@stylexjs/babel-plugin/src/shared/stylex-create-theme-nested.js
packages/@stylexjs/babel-plugin/src/shared/stylex-defaultMarker.js
packages/@stylexjs/babel-plugin/src/shared/stylex-define-consts-nested.js
packages/@stylexjs/babel-plugin/src/shared/stylex-define-consts.js
packages/@stylexjs/babel-plugin/src/shared/stylex-define-vars-nested.js
packages/@stylexjs/babel-plugin/src/shared/stylex-first-that-works.js
packages/@stylexjs/babel-plugin/src/shared/stylex-keyframes.js
packages/@stylexjs/babel-plugin/src/shared/stylex-nested-utils.js
packages/@stylexjs/babel-plugin/src/shared/stylex-position-try.js
packages/@stylexjs/babel-plugin/src/shared/stylex-view-transition-class.js
packages/@stylexjs/babel-plugin/src/shared/when/when.js
packages/@stylexjs/babel-plugin/src/utils/add-sourcemap-data.js
packages/@stylexjs/babel-plugin/src/utils/ast-helpers.js
packages/@stylexjs/babel-plugin/src/utils/dev-classname.js
packages/@stylexjs/babel-plugin/src/utils/js-to-ast.js
packages/@stylexjs/babel-plugin/src/utils/validate.js
packages/@stylexjs/babel-plugin/src/visitors/imports.js
packages/@stylexjs/babel-plugin/src/visitors/parse-stylex-create-arg.js
packages/@stylexjs/babel-plugin/src/visitors/stylex-create-theme-nested.js
packages/@stylexjs/babel-plugin/src/visitors/stylex-create-theme.js
packages/@stylexjs/babel-plugin/src/visitors/stylex-create.js
packages/@stylexjs/babel-plugin/src/visitors/stylex-default-marker.js
packages/@stylexjs/babel-plugin/src/visitors/stylex-define-consts-nested.js
packages/@stylexjs/babel-plugin/src/visitors/stylex-define-consts.js
packages/@stylexjs/babel-plugin/src/visitors/stylex-define-marker.js
packages/@stylexjs/babel-plugin/src/visitors/stylex-define-vars-nested.js
packages/@stylexjs/babel-plugin/src/visitors/stylex-define-vars.js
packages/@stylexjs/babel-plugin/src/visitors/stylex-keyframes.js
packages/@stylexjs/babel-plugin/src/visitors/stylex-merge.js
packages/@stylexjs/babel-plugin/src/visitors/stylex-position-try.js
packages/@stylexjs/babel-plugin/src/visitors/stylex-props.js
packages/@stylexjs/babel-plugin/src/visitors/stylex-view-transition-class.js
packages/@stylexjs/babel-plugin/src/visitors/visitor-utils.js
packages/@stylexjs/shared/src/index.js
packages/@stylexjs/stylex/src/stylex.js
packages/@stylexjs/stylex/src/types/StyleXCSSTypes.js
packages/@stylexjs/stylex/src/types/StyleXOpaqueTypes.js
packages/@stylexjs/stylex/src/types/StyleXTypes.js
packages/@stylexjs/stylex/src/types/StyleXUtils.js
packages/@stylexjs/stylex/src/types/VarTypes.js
```

`packages/@stylexjs/babel-plugin/src/shared/utils/file-based-identifier.js` and `packages/@stylexjs/babel-plugin/src/shared/utils/default-options.js` are also excluded as donor source modules: the former only supports donor import/theme evaluation (disabled by PandamStyle), and the latter is replaced as described above. The shared package aggregator and StyleX runtime/types are not pulled into the built compiler; they appear in the AST closure through donor type/package resolution. `packages/@stylexjs/stylex/package.json` is not a source module and is excluded from the source count.

## Vite seam and proof boundary

Row 14, `packages/@stylexjs/babel-plugin/pandamstyle/vite.js`, is a qualification seam and is excluded from this engine source closure. It has been relocated to `tools/pilot/vite-seam.js` and remains outside compiler Rollup inputs and npm exports. The required `donor-closure` verifier scans source imports and built/packed application graphs structurally, while allowing historical docs, license text, test fixture text, and forbidden-import string matchers.

## Provenance

The donor package manifests identify the source as Facebook StyleX `0.19.1`,
MIT licensed, repository `facebook/stylex`; the recorded upstream revision is
listed in `ATTRIBUTIONS.md`. Moved or refactored files retain their required
MIT headers and are mapped to owned targets in
`phase-4-derived-source-provenance.md`. License and source records are retained
in `ATTRIBUTIONS.md` and `LICENSES/`.
