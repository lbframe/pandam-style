# Derived-source provenance

## Provenance basis

The donor package manifests identify StyleX source release `0.19.1`, repository `facebook/stylex`, under the MIT license. The upstream revision and retained file mapping are recorded in the package [attribution file](../../ATTRIBUTIONS.md). A Panda CSS checkout was consulted for design comparison only and is not part of the absorbed engine.

Copied or refactored source retains its existing MIT attribution header. New wrappers and extracted code identify the exact donor path in source comments. Durable attribution and license records are maintained in the package [`ATTRIBUTIONS.md`](../../ATTRIBUTIONS.md) and [`LICENSES/`](../../LICENSES/). This map documents source lineage for the retained compiler helpers.

## Subsystem mapping

| Donor origin | Retained behavior | PandamStyle target | Decision | License / notes |
| --- | --- | --- | --- | --- |
| `@stylexjs/babel-plugin@0.19.1/src/utils/evaluate-path.js` | Static literals, binding lookup, immutable aliases, spreads, computed keys, recursion/deopt, and the safe built-in allowlist | `packages/compiler/src/frontend/babel/static-evaluator.js` | REFACTOR | MIT header retained; imported-file evaluation and donor theme proxies removed because PandamStyle resolves helper forwarding and refuses arbitrary source imports itself |
| `@stylexjs/babel-plugin@0.19.1/src/utils/evaluation-errors.js` | Stable internal deopt reasons that remain in use | `packages/compiler/src/frontend/babel/static-evaluation-errors.js` | MOVE | MIT header retained; no public error API |
| `@stylexjs/babel-plugin@0.19.1/src/utils/state-manager.js` | Per-pass filename/file context needed by static evaluation and diagnostics | `packages/compiler/src/frontend/babel/pass-state.js` | REWRITE | Small frozen context created per Babel pass; no generic StyleX visitor state, resolver, module cache, or process-global authority |
| `@stylexjs/babel-plugin@0.19.1/src/index.js` | CSS rule ordering, media width ordering, layer rendering, LTR/RTL wrapping, specificity and logical-float preamble | `packages/compiler/src/engine/ordering/rules.js` | REFACTOR | MIT attribution identifies the source file; only named serialization/order functions were extracted, not the general Babel visitor |
| `@stylexjs/babel-plugin@0.19.1/src/shared/stylex-create.js` | Atomic declaration lowering, class generation, and deduplication | `packages/compiler/src/engine/atomic/create-set.js`, `packages/compiler/src/engine/atomic/preprocess-rules/`, `packages/compiler/src/engine/atomic/utils/`, `packages/compiler/src/engine/atomic/direction/` | REFACTOR | MIT headers retained on selected source modules; only the statically reachable supported lowering closure was copied |
| `@stylexjs/babel-plugin@0.19.1/src/shared/hash.js` | Stable atom, token, and theme identifiers | `packages/compiler/src/engine/atomic/hash.js` | REFACTOR | MIT header retained; shared owned helper |
| `@stylexjs/babel-plugin@0.19.1/src/shared/messages.js` | Required atom validation messages | `packages/compiler/src/engine/atomic/messages.js` | REFACTOR | MIT header retained; unused generic visitor messages were not migrated |
| `@stylexjs/shared@0.19.1/src/utils/property-priorities.js` | Atomic property, pseudo, at-rule, and shorthand priorities | `packages/compiler/src/engine/ordering/property-priorities.js` | REFACTOR | MIT header retained; the aggregator package dependency is removed |
| `@stylexjs/babel-plugin@0.19.1/src/shared/stylex-define-vars.js` | Stable custom property names, typed values, and variable groups | `packages/compiler/src/design-system/tokens/lowering.js` | REFACTOR | MIT header retained; internal function renamed and kept outside the public API |
| `@stylexjs/babel-plugin@0.19.1/src/shared/stylex-vars-utils.js` | Variable condition collection, defaults, and at-rule projection | `packages/compiler/src/design-system/tokens/vars-utils.js` | REFACTOR | MIT header retained; shared only by owned token/theme lowering |
| `@stylexjs/babel-plugin@0.19.1/src/shared/types/index.js` | Runtime CSS-type predicates required for token/theme lowering | `packages/compiler/src/design-system/tokens/types.js` | REFACTOR | MIT header retained; unused type exports are not part of a public PandamStyle API |
| `@stylexjs/babel-plugin@0.19.1/src/shared/stylex-create-theme.js` | Projection of supported alternate-theme values onto the base variable group | `packages/compiler/src/design-system/themes/lowering.js` | REFACTOR | MIT header retained; advanced/nested themes remain deferred |
| `@stylexjs/babel-plugin@0.19.1/src/shared/utils/default-options.js` | Defaults actually observed by the owned compiler | `packages/compiler/src/engine/ordering/defaults.js` | REWRITE | Small PandamStyle-supported subset only; no generic donor options object or public tuning surface |
| `@stylexjs/babel-plugin@0.19.1/src/shared/common-types.js` | Input/output type shapes needed by copied helpers | `packages/compiler/src/engine/types.js` | REWRITE | Local Flow types; no donor package import or copied `common-types.js` module |

The compiler's pre-edit Rollup graph also reached `style-value-parser@0.19.1`
through the donor ordering helpers. Its old package entry exposed unrelated
property parsers as well as media-query utilities. The exact eight-file
media-query source closure required by PandamStyle now lives under
`packages/compiler/src/engine/ordering/media-query/`; the eleven other files
pulled in by the old package entry were not copied. Their individual origin,
target, and disposition are recorded in
[`phase-4-engine-absorption-map.md`](phase-4-engine-absorption-map.md).

The selected helper modules below remain in the same PandamStyle-owned domains as the atomic kernel. Each file retains its MIT header and source mapping in `phase-4-engine-absorption-map.md`:

```text
shared/preprocess-rules/PreRule.js                         -> engine/atomic/preprocess-rules/PreRule.js
shared/preprocess-rules/application-order.js               -> engine/atomic/preprocess-rules/application-order.js
shared/preprocess-rules/basic-validation.js                -> engine/atomic/preprocess-rules/basic-validation.js
shared/preprocess-rules/flatten-raw-style-obj.js            -> engine/atomic/preprocess-rules/flatten-raw-style-obj.js
shared/preprocess-rules/index.js                           -> engine/atomic/preprocess-rules/index.js
shared/preprocess-rules/legacy-expand-shorthands.js        -> engine/atomic/preprocess-rules/legacy-expand-shorthands.js
shared/preprocess-rules/property-specificity.js             -> engine/atomic/preprocess-rules/property-specificity.js
shared/physical-rtl/generate-ltr.js                        -> engine/atomic/direction/generate-ltr.js
shared/physical-rtl/generate-rtl.js                        -> engine/atomic/direction/generate-rtl.js
shared/utils/convert-to-className.js                       -> engine/atomic/utils/convert-to-className.js
shared/utils/dashify.js                                    -> engine/atomic/utils/dashify.js
shared/utils/generate-css-rule.js                          -> engine/atomic/utils/generate-css-rule.js
shared/utils/normalize-value.js                            -> engine/atomic/utils/normalize-value.js
shared/utils/normalizers/convert-camel-case-values.js      -> engine/atomic/utils/normalizers/convert-camel-case-values.js
shared/utils/normalizers/detect-unclosed-fns.js            -> engine/atomic/utils/normalizers/detect-unclosed-fns.js
shared/utils/normalizers/detect-unclosed-strings.js        -> engine/atomic/utils/normalizers/detect-unclosed-strings.js
shared/utils/normalizers/font-size-px-to-rem.js            -> engine/atomic/utils/normalizers/font-size-px-to-rem.js
shared/utils/normalizers/leading-zero.js                   -> engine/atomic/utils/normalizers/leading-zero.js
shared/utils/normalizers/quotes.js                         -> engine/atomic/utils/normalizers/quotes.js
shared/utils/normalizers/timings.js                        -> engine/atomic/utils/normalizers/timings.js
shared/utils/normalizers/whitespace.js                     -> engine/atomic/utils/normalizers/whitespace.js
shared/utils/normalizers/zero-dimensions.js                -> engine/atomic/utils/normalizers/zero-dimensions.js
shared/utils/object-utils.js                               -> engine/atomic/utils/object-utils.js
shared/utils/rule-utils.js                                 -> engine/atomic/utils/rule-utils.js
shared/utils/split-css-value.js                            -> engine/atomic/utils/split-css-value.js
shared/utils/transform-value.js                            -> engine/atomic/utils/transform-value.js
```

`font-size-px-to-rem.js` is retained only because the engine preserves the existing `enableFontSizePxToRem` internal option, whose default remains false. It is not enabled as a new PandamStyle feature.

## Vite qualification seam

The public Vite integration is maintained in `packages/vite`; the compiler
package does not export a private adapter seam.
