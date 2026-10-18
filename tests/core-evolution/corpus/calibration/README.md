# Consumer calibration records

These records calibrate the CE-00.2 declaration classifier against the baseline
reported by a private consumer project. Every record field is closed: an enum,
an integer, a fixed-length digest, an ordinal id, a pinned commit or a CSS
string that passes the token allow-list in `tools/coverage/publication.mjs`. The
records hold no free text. This page is the authored explanation; records refer
to it only by the fixed ids below.

| File                                 | Content                                                        |
| ------------------------------------ | -------------------------------------------------------------- |
| `baseline.v1.json`                   | Reported baseline, recovered classifier, inputs, limits, gates |
| `w-util-343.declarations.v1.json`    | Redacted declarations of the utilities input                   |
| `w-mockup-1559.declarations.v1.json` | Redacted declarations of the mockup input                      |
| `approved-identifiers.v1.json`       | Consumer identifiers that may be published, with a reason enum |
| `publication-review.v1.json`         | Digests pinning the reviewed state of the calibration records  |

## Reported baseline

Section 6 of the consumer integration note reports two measurements:

- 343 declarations = 212 expressible + 37 composite rewrites + 94 gaps (47
  absent properties + 47 out-of-domain values);
- 1,559 declarations = 1,111 + 124 + 324 (112 + 212).

The table is identical in the three note revisions recorded in `noteBlobs`:

- `introduced`: the commit that added the table;
- `intermediate`: a later revision;
- `inspected-by-research`: the revision that the CE research cited as [W1].

The table had not been rerun before CE-00.2.

## Original classifier (`recoveredFrom: consumer-agent-session-transcript`)

The note says a script imported the compiler's policy module. That script was
written to a session scratch directory during the consumer integration work. It
was never committed to the consumer repository or any other repository: the
consumer Git history (all branches, pull refs and tags; 629 commits, 4,753
blobs) contains no classifier. CE-00.2 recovered it from the agent session
transcript on the maintainer's machine.

`publicationDecision: consumer-material-digest-only`: the script was written
during the consumer's own work session, so it is treated as consumer material.
It is identified by digest only, and `tools/coverage/` is the parser-based
replacement that this repository runs.

`algorithm: CE-ALG-R0` describes the recovered script:

1. Import `propertyKind` and `structuralAllowed` from the Alpha 1 policy module
   given as an argument.
2. Remove `/* */` comments and `@keyframes` blocks with regular expressions.
3. Match every `name: value` followed by `;` or `}` with
   `([a-z-]+)\s*:\s*([^;{}]+)[;}]`.
4. Skip names starting with `--` (custom properties). A second skip for names
   starting with `webkit` never matches, because vendor names start with `-`.
5. Remove `!important`, trim the value and convert the name with `-([a-z])` to
   camelCase, so `-webkit-user-select` becomes `WebkitUserSelect`.
6. Tally category, composite-form and unsupported kinds by property. For
   structural kinds, tally `structuralOk` when `structuralAllowed(name, value)`
   or `structuralAllowed(name, Number(value))` holds, otherwise
   `structuralForbidden`.
7. For the utilities measurement, first cut the `@layer utilities{...}` block
   out of the renderer stylesheet by brace matching.

The run recorded with `inputId: null` and `reported: false` is a first run over
the whole renderer stylesheet before the utilities block was cut out. It was
never reported.

## Reconstructed classifier

`tools/coverage/cli.mjs` uses postcss 8.5.28. Its resolution
(`yarn-lock-via-vite-8.3.1`) is the repository lockfile, through vite 8.3.1. It
loads the same Alpha 1 policy module from its digested bytes
(`policyLoading: digest-pinned-bytes`). It differs from the original in these
ways:

- `CE-DIFF-01`: declarations come from a CSS parser instead of a regular
  expression. On both inputs the two extractions yield identical (property,
  value) multisets (`extractionParity: identical-multisets`).
- `CE-DIFF-02`: excluded declarations (custom properties, `@keyframes` frames,
  layers outside the measured block) stay in the set with a reason instead of
  disappearing.
- `CE-DIFF-03`: each declaration is also bound to its CE-00.1 registry entry and
  proof fixture, annotated with boundary flags and, for composites, with the
  longhands a rewrite needs.
- `CE-DIFF-04`: declarations are identified by ordinal within their input only.
  Source positions stay in a private position map outside the repository; only
  its SHA-256 is published.

## Inputs

### W-UTIL-343

- `role: replacement-candidate`.
- `recovery: rebuild-in-consumer-worktree`: a build output left in the consumer
  integration worktree, ignored by Git and never committed. It was rebuilt at
  `rebuiltAt`, after the measurement, so it stands in for the measured file.
- `byteIdentity: unproven`: the original session recorded no digest of the
  measured file. Only its category counts and block span reconcile.
- Evidence:
  - `EV-UNCHANGED-SOURCES`: between the commit of the measured sources and the
    commit of the rebuild, no renderer component, Panda configuration or token
    file changed; only build guards, a Vite plugin entry, scripts, tests and
    documentation did.
  - `EV-SPAN-MATCH`: the utilities block span equals the span the original
    session printed when it cut the block out.
  - `EV-BUCKETS-MATCH`: all five recorded bucket counts are reproduced exactly.

### W-MOCKUP-1559

- `role: recovered-exact`.
- `recovery: designer-package-in-session-scratch`: the designer package that the
  original session read as data, still present in that session's scratch
  directory. It is not part of the consumer repository; the integration note
  names it.
- `byteIdentity: proven-by-manifest`.
- Evidence: `EV-MANIFEST-DIGEST`, the stylesheet digest equals its entry in the
  package's SHA-256 manifest.

## Publication policy (`publicationPolicy: CE-PUB-01`)

The published records hold only:

- extracted CSS declarations: property, value, and condition and state context;
- Alpha 1 categories;
- ordinal ids;
- pinned consumer commits;
- input digests and counts.

Consumer source, selectors, file paths, source positions, unapproved
identifiers, the original script and private values are not published.

Redaction placeholders use HMAC-SHA256 with a private key kept outside the
repository, so removed values cannot be recovered by hashing guesses. Each set
publishes only the key fingerprint. The maintainer holds the private key and the
per-input position maps with the private inputs.

## Extraction rules (declaration-set headers)

- `CE-DEN-01`: the Alpha 1 baseline denominator is every declaration except
  custom properties and declarations inside `@keyframes`.
- `CE-DEN-02`: the same, restricted to `@layer utilities`. Declarations outside
  the denominator stay in the set with their reason.
- `CE-SEL-01`: selectors are not published. Only allow-listed pseudo-classes,
  pseudo-elements and state attribute names are kept, and declarations are
  identified by ordinal only.
- `CE-RED-01`: these are replaced by a placeholder carrying a keyed HMAC-SHA256
  digest of the removed text:
  - every value and condition token that is not CSS vocabulary, a number with a
    CSS unit, a hex color, an approved identifier or punctuation;
  - `url()`, quoted strings, e-mail addresses, URIs, opaque tokens and non-ASCII
    text;
  - unapproved custom-property and layer names, non-registry property names,
    unknown at-rules and unclean query parameters.

`baselineLayer` is `utilities` for W-UTIL-343 and `null` for W-MOCKUP-1559. The
calibration record fixes it per input.

## Calibration limits

- `CAL-01` **Numeric coercion.** The original retried each structural value as a
  JavaScript number. These declarations count as expressible only because a
  JavaScript number could be authored. The note's prose says string values such
  as `"0.6"` are refused; its counts include the coercion.
- `CAL-02` **Category-bound values are not checked.** A category-bound property
  counts as expressible whatever its value. Raw values become expressible only
  through a token of that category; keywords, multi-value, negative or invalid
  values are not examined. Value grammar is not validated at all.
- `CAL-03` **Conditions are not checked.** Declarations under media queries,
  pseudo-classes or state attributes are classified on property and value only.
  Alpha 1 needs each condition declared in the design system.
- `CAL-04` **Pseudo-elements are not checked.** Declarations on `::before`,
  `::after` or `::placeholder` are counted on property and value, although Alpha
  1 has no pseudo-element authoring.
- `CAL-05` **Only five composite forms.** Only `background`, `border`, `font`,
  `animation` and `transition` count as composite rewrites.
  - A `background` whose value is one color rewrites to `background-color`, the
    other background longhands falling back to their initial values. A color is
    a CSS Color 4 named or system color, `transparent`, `currentcolor`, hex
    notation, a color function, or a custom property whose every declaration in
    the same stylesheet is such a color.
  - Every other composite needs a full longhand reset that Alpha 1 does not
    admit. That includes `background: none` (`background-image` becomes `none`
    and `background-color` becomes `transparent`) and a reference to an
    undefined custom property.
  - Other shorthands (`border-top`, `outline`, `text-decoration`, `list-style`,
    `place-items`, `flex`, `inset`, `grid-column`) count as gaps, not rewrites.
  - The five reported buckets do not depend on this accounting.
- `CAL-06` **Font-face descriptors counted as declarations.** `@font-face`
  descriptors are counted like properties: `font-family` and `font-weight` as
  expressible, `src` and `font-display` as gaps. `font-display` has no CE-00.1
  registry entry.
- `CAL-07` **Vendor-prefixed names counted as absent properties.** The CE-00.1
  registry disposes of them separately.
- `CAL-08` **`!important` ignored.** The original removed `!important` before
  classifying; Alpha 1 has no `!important` authoring.
- `CAL-09` **Reported denominator is not the full stylesheet.** The reported
  totals exclude custom properties, `@keyframes` frames and, for the utilities
  input, the reset, base and tokens layers. The sets keep those declarations
  with their reason; the full denominators are the set totals.
- `CAL-10` **Different kinds of denominator.** The utilities block lists each
  atomic declaration once, however many components use it. The mockup lists
  every authored declaration, repeated ones included. The two totals are not
  comparable rates.
- `CAL-11` **Utilities input is a replacement candidate.** It was rebuilt from
  unchanged sources. Its block span and all bucket counts reconcile with the
  original run, but its bytes cannot be proven identical to the measured file.
  Exact-input recovery is claimed for the mockup only.
- `CAL-12` **Policy-level evidence only.** Expressible means the Alpha 1 policy
  module admits the property and value. It is not compiler acceptance (E2),
  emitted CSS (E3) or rendered behavior (E4). A declaration counted expressible
  can still fail to reproduce its rendering.
- `CAL-13` **Invalid values are counted.** The original never validates value
  grammar. W-UTIL-343 contains `direction: incoming` and `direction: outgoing`,
  which are invalid CSS (scope finding SF-03). They count as absent-property
  gaps and imply neither validity nor fidelity.

## Separate gates

- `GATE-01`: the consumer's badge comparison script (the recorded blob) compares
  computed badge styles and border boxes under CSP in Chromium. It is not this
  classifier, is not used here and stays a separate rendering check.
- `GATE-02`: rendered and behavioral fidelity is
  `CE-FX-CAP-45-render-behavior-fidelity` (E4), owned by CE-14. Calibration
  closes no rendering, state, accessibility or CSP claim.
- `GATE-03`: the zero-unexpressible full-denominator proof is
  `CE-FX-CAP-45-full-denominator-zero-unexpressible`, owned by CE-14 against the
  canonical catalog, not the Alpha 1 policy.

## Approved identifiers

A consumer-controlled identifier (a custom-property, animation, font family or
layer name, or another non-CSS word) may appear in a published declaration only
when `approved-identifiers.v1.json` lists it. Each entry carries a `kind` and a
`reason` from these enums:

| `reason`                     | Meaning                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `platform-defined`           | Defined by a library or platform (PandaCSS preset variables, keyframes, layers)                     |
| `css-generic-token-name`     | Generic design-token word (color, font, easing, surface) with no product, customer or internal name |
| `public-font-family`         | Public web or platform font family name                                                             |
| `generic-animation-name`     | Generic animation name, approved in the CE-00.2 review                                              |
| `invalid-value-generic-word` | Generic word emitted as an invalid CSS value (SF-03), kept as measured data                         |

Extraction replaces every other consumer identifier with a placeholder, and the
corpus validator rejects any that remains.

## Publication review

`publication-review.v1.json` holds the digest of every string leaf, with its
JSON path, of these records:

- `baseline.v1.json`;
- `approved-identifiers.v1.json`;
- `../scope-findings.v1.json`.

Any change fails validation until it is reviewed and the pin is updated in the
same reviewable diff.

## Scope findings

`../scope-findings.v1.json` records these handoffs by id:

- `SF-01` **font-display has no registry entry.** W-MOCKUP-1559 has one
  `@font-face` `font-display` declaration, whose registry accounting is null
  with reason `font-face-descriptor-not-in-inventory`. The registry carries
  `src` and `unicode-range` but no other font-face descriptor. CE-09.1 (#65)
  defines the font-face resource schema. It decides, through a reviewed CE-00.1
  scope change, whether font-face descriptors (`font-display` and the descriptor
  forms of `font-family`, `font-weight` and `font-style`) join the registry as
  system-resource entries.
- `SF-02` **Alpha 1 emits a raw selector key.** CE-NEG-UNKNOWN-SELECTOR-03
  compiles without diagnostics under the built Alpha 1 compiler, and the emitted
  stylesheet contains `[dir=rtl] &` verbatim. CE-07.1 (#54) closes raw-selector
  authority gaps: a consumer key that is not a declared condition must be
  rejected. Until then the rtl profile has no negative fixture that Alpha 1
  actually rejects; the rejection stays intended and is not counted as met.
- `SF-03` **Invalid CSS values in measured consumer data.** W-UTIL-343 contains
  `direction: incoming` and `direction: outgoing`, which are not valid direction
  values (a variant property emitted as CSS). The Alpha 1 measurement counts
  them as absent-property gaps because it never checks value grammar (CAL-02).
  They are kept as measured data, imply neither validity nor fidelity and need
  no vocabulary. The CE-14 migration (#82) accounts for them as consumer
  defects, not as required coverage.
