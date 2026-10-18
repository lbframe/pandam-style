# Core evolution registry v1: CE-00.1 scope contract

Status: scope contract for
[CE-00.1](https://github.com/lbframe/pandam-style/issues/40), not a
qualification. No product behavior changed. Every fixture and proof record named
here is **planned**; none was executed by this task. Baseline:
`415e05539fcb5d36a78226112b5cf488b200b1aa`. Comparator: StyleX **0.19.1**,
PandaCSS **2.2.0**, MDN BCD **8.1.6**.

This document explains the machine records. The records are authoritative:

| Record                                                                                         | Role                                                                                       |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [`core-evolution-registry.v1.json`](core-evolution-registry.v1.json)                           | Generated registry: 1,108 entries, CAP-01–CAP-48, limitations and request traceability     |
| [`core-evolution-upstream-observations.v1.json`](core-evolution-upstream-observations.v1.json) | Generated, timestamped refresh of npm identities, tarball/source digests and probe digests |
| [Profiles](../../tests/core-evolution/profiles.v1.json)                                        | The nine accepted project profiles (authored)                                              |
| [Capability dispositions](../../tests/core-evolution/capabilities.v1.json)                     | CAP dispositions, owners, proof records, limitations, request cases (authored)             |
| [Scope decisions](../../tests/core-evolution/scope-decisions.v1.json)                          | Source-format and browser-profile decisions for later lots (authored)                      |
| [Classification rules](../../tests/core-evolution/classification-rules.v1.json)                | Deterministic disposition procedure, curated records and families (authored)               |
| [Schemas and tools](../../tests/core-evolution/README.md)                                      | JSON Schemas, validator and regeneration pipeline                                          |

The earlier research files stay byte-identical. The registry cites them, the
reviewed plan, coverage matrix and review by SHA-256 in `inputs`.

## What a count means

Counts are tracking denominators. They are **not** support scores. No percentage
is derived from type occurrence, registry or profile counts, and the validator
rejects any such field. A required entry stays open work until its proof record
closes with its evidence classes:

- E1: inspected source;
- E2: accepted syntax and diagnostics;
- E3: emitted and transformed CSS;
- E4: computed behavior in exact engines;
- E5: qualified host and clean package installation.

## Method

1. **Reconciliation with pinned sources.** The four key surfaces are re-derived
   from the pinned sources. StyleX `CSSProperties` comes from a Flow AST, Panda
   csstype and `ModernCssProperties` from TypeScript ASTs, Panda preset-base
   utility object keys from source, and BCD `css.properties` from the published
   `data.json`. The Alpha 1 policy tables are parsed from `properties.js`. The
   result: 522, 863, 372 and 652 keys and 102 admitted names, whose union is
   exactly the 1,108 inventory names. All source flags, BCD statuses and Alpha 1
   domain kinds match the inventory row for row. Any mismatch fails the build.
2. **Upstream extraction and emission, not only types.** Each entry was compiled
   with the published StyleX 0.19.1 Babel plugin and with the Panda 2.2.0 native
   compiler plus preset-base. Each run used one declaration and a CSS-wide
   keyword value. The CSS it actually emitted was recorded. This evidence class
   E1 describes property handling, not value domains, cascade or browser
   behavior. Both probes are byte-deterministic across runs.
3. **Classification.** A documented, ordered procedure assigns exactly one
   disposition: curated records first, then obsolete-engine prefixes, BCD
   status, BCD prefix/alternative-name statements, vendor-base derivation. An
   unclassified name or an entry without a family fails the build. A BCD prefix
   or alternative name becomes a normalized alias only when its relating
   statements carry no caveat, or when a curated audit finds a behavior caveat
   with the same grammar (see [Alias audit](#alias-audit)).
4. **Requirement.** Families name the profiles that require their stable
   canonical properties. Overlay rules add the `rtl` and `svg-media` overlays to
   direction-sensitive or media-related entries. Alpha 1 status then separates
   `required-gap` from `required-requalification-and-expansion`. Entries whose
   capability is carried by a resource or pattern record point at that CAP.
5. **Target facts.** BCD 8.1.6 base support for Chrome, Edge, Firefox, Safari,
   iOS Safari and Android WebView is recorded per entry. A required entry
   without an unprefixed release in Chrome, Firefox or Safari is routed to
   D-BP-06, or to D-BP-07 when only a prefixed form ships. Required platform
   extensions are routed to D-BP-03. These are inputs to CE-01, not support
   claims.
6. **Re-derivation.** Entry fields `sources`, `bcd`, `bcdRelations`, `alpha1`
   and `upstream` are recorded facts. Every other entry field, the counts and
   the capability, limitation and request sections are derived from those facts
   and the authored inputs by `tests/core-evolution/tools/derive-registry.mjs`.
   The validator runs the same derivation offline and requires the committed
   registry to be identical, so scope, ownership and proof obligations cannot
   drift from the authored rules.

## Inventory dispositions

| Disposition                        | Entries  |
| ---------------------------------- | -------- |
| `canonical-property`               | 471      |
| `deprecated-or-experimental`       | 375      |
| `incompatible-runtime-requirement` | 2        |
| `non-css-syntax`                   | 24       |
| `normalized-alias`                 | 173      |
| `scoped-platform-extension`        | 7        |
| `system-resource`                  | 56       |
| **Total**                          | **1108** |

| Subkind of `deprecated-or-experimental` | Entries |
| --------------------------------------- | ------- |
| `abandoned-draft`                       | 5       |
| `deprecated`                            | 52      |
| `divergent-legacy-variant`              | 14      |
| `experimental`                          | 134     |
| `nonstandard`                           | 52      |
| `obsolete-engine-prefix`                | 101     |
| `unimplemented-specification`           | 17      |

| Owner lot | Entries |
| --------- | ------- |
| CE-01     | 101     |
| CE-02     | 325     |
| CE-03     | 38      |
| CE-04     | 152     |
| CE-05     | 178     |
| CE-06     | 104     |
| CE-07     | 2       |
| CE-08     | 41      |
| CE-09     | 2       |
| CE-10     | 8       |
| CE-11     | 157     |

| Requirement status                       | Entries |
| ---------------------------------------- | ------- |
| `carried-by-capability`                  | 79      |
| `disposition-only`                       | 565     |
| `required-gap`                           | 362     |
| `required-requalification-and-expansion` | 102     |

Every one of the 102 Alpha 1 admitted names is a required canonical property, so
existing behavior stays in the denominator. The 11 canonical properties no
profile requires (`all`, `math-*`, the motion-path `offset*` family, `speak`)
still carry a disposition fixture: admission with full proof, or a structured
diagnostic.

## Alias audit

Every automatic alias rests on BCD 8.1.6 prefix or alternative-name statements,
now recorded per entry in `bcdRelations` with their notes,
partial-implementation and flag caveats. All 180 automatic aliases were audited
against those statements; 28 carry caveats, none carries flags, and each of the
28 has a curated `aliasAudit` verdict in the classification rules. The build
fails on a missing or stale verdict, and a behavior-only verdict on notes that
mention syntax or values needs an explicit reviewed reason.

**Grammar-divergent (14), reclassified from `normalized-alias` to
`deprecated-or-experimental/divergent-legacy-variant`:** `-moz-background-clip`
→ `background-clip`, `-moz-background-origin` → `background-origin`,
`-moz-border-image` → `border-image`, `-moz-column-rule` → `column-rule`,
`-moz-font-feature-settings` → `font-feature-settings`,
`-webkit-background-clip` → `background-clip`, `-webkit-background-origin` →
`background-origin`, `-webkit-background-size` → `background-size`,
`-webkit-initial-letter` → `initial-letter`, `-webkit-mask` → `mask`,
`-webkit-mask-image` → `mask-image`, `-webkit-perspective` → `perspective`,
`-webkit-ruby-position` → `ruby-position`, `-webkit-scroll-snap-type` →
`scroll-snap-type`. They are diagnosed toward their target instead of
normalized. 12 still ship in some engine; for those, any prefixed emission is a
D-BP-07 transformation decision with emitted-CSS proof (E3) restricted to the
shared value subset. `-moz-background-clip` and `-moz-background-origin` no
longer ship.

**Behavior caveat only (14), kept as aliases with the audit recorded:**
`-moz-box-sizing`, `-moz-column-count`, `-moz-column-width`, `-moz-columns`,
`-webkit-animation`, `-webkit-box-decoration-break`,
`-webkit-font-feature-settings`, `-webkit-print-color-adjust`,
`-webkit-transform`, `scroll-snap-margin`, `scroll-snap-margin-bottom`,
`scroll-snap-margin-left`, `scroll-snap-margin-right`, `scroll-snap-margin-top`.
Their notes describe engine bugs or partial behavior with the same grammar, such
as old Firefox `getComputedStyle` sizing, `display: table-caption` columns,
inline-only `box-decoration-break` and Safari's fragment-scroll margin.

The remaining 152 automatic aliases have BCD statements without notes, partial
implementation or flags. That some prefixed forms were later removed from
engines is recorded as `prefixedFormShips: false`; removal does not change
grammar equivalence.

## Upstream emission findings

These are comparator observations (E1), recorded per entry under `upstream`:

- **StyleX 0.19.1** emits 1,069 entries verbatim and silently drops 14
  shorthands under its default `propertyValidationMode: silent`. The dropped
  shorthands are `all`, `animation`, `background`, `border` and the side/axis
  border shorthands; `throw` mode reports the reason, which is recorded. It
  renames 25 keys. Its `start`/`end` keys become `inset-inline-start`/`-end`,
  and 23 logical block/inline properties become physical ones, for example
  `block-size` to `height` and `margin-block-start` to `margin-top`. That
  changes vertical-writing results, so CE-04/CE-06 must not copy it. Keys
  without a specification pass through verbatim, for example its own type key
  `overflow-block-x`.
- **Panda 2.2.0** emits 1,007 entries verbatim, including keys it has no type or
  utility for, so a missing type key is not a compilation gap. It composes 55
  utilities through CSS variables (filters, transforms, gradients, focus rings)
  and emits 12 selector helpers (`spaceX`, `divideX`, scrollbar pseudo-elements,
  `debug`) and 2 media-query helpers (`hideFrom`, `hideBelow`). For 23 entries
  it emits a `-webkit-` property besides or instead of the requested one,
  including `appearance`, `backdrop-filter`, `background-clip`, `mask-*`,
  `user-select` and the `line-clamp` bundle. It maps its `x`/`y` utilities to
  translate variables, although `x`/`y` are BCD SVG geometry properties. It
  emits the nonexistent property `animation-state`.
- 59 canonical properties have an upstream divergence recorded in
  `upstreamDivergence`.

## Profiles

The accepted profiles are `web`, `desktop-renderer`, `content`, `forms`, `data`
(application), `rtl`, `svg-media` (overlays), `ssr` (delivery) and
`reusable-package` (distribution). Delivery and distribution profiles inherit
the property requirements of the application profiles they deliver. Together the
profiles require all 48 capability families. Corpus evidence from CE-00.2 may
add requirements; removing one needs an explicit reviewed decision.

| Profile            | Kind         | Required entries | Of which Alpha 1 gaps | Required capability families |
| ------------------ | ------------ | ---------------- | --------------------- | ---------------------------- |
| `web`              | application  | 338              | 236                   | 44                           |
| `desktop-renderer` | application  | 316              | 214                   | 43                           |
| `content`          | application  | 406              | 305                   | 39                           |
| `forms`            | application  | 295              | 193                   | 38                           |
| `data`             | application  | 303              | 202                   | 34                           |
| `rtl`              | overlay      | 116              | 87                    | 14                           |
| `svg-media`        | overlay      | 83               | 71                    | 9                            |
| `ssr`              | delivery     | 0                | 0                     | 10                           |
| `reusable-package` | distribution | 0                | 0                     | 14                           |

## Capability families

Each CAP has one disposition, a primary and closing lot within its coverage Work
lots, and a planned proof record `tests/core-evolution/proofs/CAP-xx.json` with
evidence classes and fixture sets. Stable in-profile gaps remain
`required-implementation`. Existing families remain `existing-requalification`.
Neither is closed by this task. "Mapped entries" counts registry entries whose
capability is that CAP; CAP-01 maps the whole inventory.

| CAP    | Disposition              | Primary / closing lot | Proof record                       | Mapped / required entries | Profiles | Limitations    | Request cases          |
| ------ | ------------------------ | --------------------- | ---------------------------------- | ------------------------- | -------- | -------------- | ---------------------- |
| CAP-01 | required-implementation  | CE-02 / CE-02         | `CE-PROOF-CAP-01` (E1, E2, E3, E4) | 1108 / 464                | 7        | —              | —                      |
| CAP-02 | required-implementation  | CE-02 / CE-07         | `CE-PROOF-CAP-02` (E2, E3, E4)     | 0 / 0                     | 6        | —              | —                      |
| CAP-03 | required-implementation  | CE-03 / CE-04         | `CE-PROOF-CAP-03` (E2, E3, E4)     | 27 / 13                   | 5        | —              | REQ-09                 |
| CAP-04 | required-implementation  | CE-04 / CE-04         | `CE-PROOF-CAP-04` (E2, E3, E4)     | 36 / 17                   | 6        | —              | REQ-04, REQ-07, REQ-08 |
| CAP-05 | required-implementation  | CE-04 / CE-04         | `CE-PROOF-CAP-05` (E2, E3, E4)     | 58 / 15                   | 6        | —              | REQ-03, REQ-13         |
| CAP-06 | required-implementation  | CE-04 / CE-04         | `CE-PROOF-CAP-06` (E2, E3, E4)     | 22 / 14                   | 6        | —              | REQ-03, REQ-10         |
| CAP-07 | required-implementation  | CE-04 / CE-05         | `CE-PROOF-CAP-07` (E2, E3, E4)     | 79 / 49                   | 6        | —              | REQ-02                 |
| CAP-08 | required-implementation  | CE-04 / CE-04         | `CE-PROOF-CAP-08` (E2, E3, E4)     | 37 / 26                   | 6        | —              | —                      |
| CAP-09 | required-implementation  | CE-05 / CE-05         | `CE-PROOF-CAP-09` (E2, E3, E4)     | 133 / 69                  | 6        | —              | REQ-06, REQ-11, REQ-12 |
| CAP-10 | required-implementation  | CE-05 / CE-07         | `CE-PROOF-CAP-10` (E2, E3, E4)     | 29 / 8                    | 5        | —              | REQ-12                 |
| CAP-11 | required-implementation  | CE-05 / CE-05         | `CE-PROOF-CAP-11` (E2, E3, E4)     | 24 / 7                    | 4        | LIM-07         | REQ-01, REQ-06         |
| CAP-12 | required-implementation  | CE-06 / CE-06         | `CE-PROOF-CAP-12` (E2, E3, E4)     | 71 / 42                   | 6        | —              | REQ-05, REQ-08         |
| CAP-13 | required-implementation  | CE-06 / CE-09         | `CE-PROOF-CAP-13` (E2, E3, E4)     | 120 / 57                  | 2        | —              | —                      |
| CAP-14 | required-implementation  | CE-03 / CE-09         | `CE-PROOF-CAP-14` (E2, E3, E4)     | 77 / 29                   | 5        | —              | —                      |
| CAP-15 | required-implementation  | CE-03 / CE-05         | `CE-PROOF-CAP-15` (E2, E3, E4)     | 31 / 4                    | 6        | —              | REQ-10                 |
| CAP-16 | required-implementation  | CE-05 / CE-05         | `CE-PROOF-CAP-16` (E2, E3, E4)     | 15 / 8                    | 4        | —              | REQ-08                 |
| CAP-17 | required-implementation  | CE-05 / CE-06         | `CE-PROOF-CAP-17` (E2, E3, E4)     | 43 / 38                   | 6        | —              | —                      |
| CAP-18 | required-implementation  | CE-03 / CE-08         | `CE-PROOF-CAP-18` (E2, E3, E4)     | 112 / 26                  | 5        | —              | REQ-06                 |
| CAP-19 | required-implementation  | CE-08 / CE-08         | `CE-PROOF-CAP-19` (E2, E3, E4)     | 4 / 1                     | 4        | —              | —                      |
| CAP-20 | existing-requalification | CE-03 / CE-03         | `CE-PROOF-CAP-20` (E2, E3)         | 0 / 0                     | 6        | —              | —                      |
| CAP-21 | required-implementation  | CE-03 / CE-07         | `CE-PROOF-CAP-21` (E2, E3, E4)     | 0 / 0                     | 5        | —              | —                      |
| CAP-22 | existing-requalification | CE-03 / CE-07         | `CE-PROOF-CAP-22` (E2, E3, E4)     | 1 / 0                     | 6        | —              | —                      |
| CAP-23 | required-implementation  | CE-07 / CE-07         | `CE-PROOF-CAP-23` (E2, E3, E4)     | 0 / 0                     | 5        | —              | —                      |
| CAP-24 | required-implementation  | CE-07 / CE-07         | `CE-PROOF-CAP-24` (E2, E3, E4)     | 0 / 0                     | 5        | LIM-03         | —                      |
| CAP-25 | required-implementation  | CE-07 / CE-07         | `CE-PROOF-CAP-25` (E2, E3, E4)     | 2 / 0                     | 6        | —              | —                      |
| CAP-26 | required-implementation  | CE-04 / CE-11         | `CE-PROOF-CAP-26` (E2, E3, E4)     | 3 / 3                     | 4        | —              | —                      |
| CAP-27 | required-implementation  | CE-02 / CE-07         | `CE-PROOF-CAP-27` (E2, E3, E4)     | 0 / 0                     | 5        | —              | —                      |
| CAP-28 | required-implementation  | CE-02 / CE-07         | `CE-PROOF-CAP-28` (E2, E3, E4)     | 3 / 0                     | 6        | —              | REQ-07                 |
| CAP-29 | required-implementation  | CE-09 / CE-09         | `CE-PROOF-CAP-29` (E2, E3, E4)     | 0 / 0                     | 5        | —              | —                      |
| CAP-30 | required-implementation  | CE-09 / CE-13         | `CE-PROOF-CAP-30` (E2, E3, E4, E5) | 2 / 0                     | 7        | —              | —                      |
| CAP-31 | existing-requalification | CE-10 / CE-10         | `CE-PROOF-CAP-31` (E2, E3, E4)     | 0 / 0                     | 6        | —              | REQ-10                 |
| CAP-32 | required-implementation  | CE-10 / CE-10         | `CE-PROOF-CAP-32` (E2, E3, E4)     | 0 / 0                     | 5        | LIM-08         | —                      |
| CAP-33 | required-implementation  | CE-10 / CE-10         | `CE-PROOF-CAP-33` (E2, E3, E4)     | 6 / 0                     | 6        | —              | —                      |
| CAP-34 | required-implementation  | CE-03 / CE-10         | `CE-PROOF-CAP-34` (E2, E3)         | 2 / 0                     | 6        | —              | —                      |
| CAP-35 | required-implementation  | CE-10 / CE-13         | `CE-PROOF-CAP-35` (E2, E3, E5)     | 0 / 0                     | 1        | —              | —                      |
| CAP-36 | existing-requalification | CE-12 / CE-13         | `CE-PROOF-CAP-36` (E2, E3, E4, E5) | 0 / 0                     | 7        | LIM-01, LIM-02 | REQ-15                 |
| CAP-37 | required-implementation  | CE-03 / CE-11         | `CE-PROOF-CAP-37` (E2, E3, E4)     | 1 / 1                     | 4        | LIM-01         | —                      |
| CAP-38 | required-implementation  | CE-11 / CE-11         | `CE-PROOF-CAP-38` (E2, E3, E4)     | 10 / 8                    | 2        | LIM-06         | —                      |
| CAP-39 | required-implementation  | CE-11 / CE-11         | `CE-PROOF-CAP-39` (E2, E3, E4)     | 4 / 2                     | 2        | LIM-04, LIM-06 | —                      |
| CAP-40 | required-implementation  | CE-07 / CE-11         | `CE-PROOF-CAP-40` (E2, E3, E4)     | 23 / 12                   | 2        | LIM-04, LIM-06 | —                      |
| CAP-41 | required-implementation  | CE-01 / CE-13         | `CE-PROOF-CAP-41` (E1, E3, E4, E5) | 0 / 0                     | 6        | LIM-05         | —                      |
| CAP-42 | existing-requalification | CE-00 / CE-13         | `CE-PROOF-CAP-42` (E1, E5)         | 0 / 0                     | 7        | —              | —                      |
| CAP-43 | required-implementation  | CE-13 / CE-13         | `CE-PROOF-CAP-43` (E5)             | 0 / 0                     | 1        | —              | REQ-14                 |
| CAP-44 | existing-requalification | CE-12 / CE-13         | `CE-PROOF-CAP-44` (E3, E4, E5)     | 0 / 0                     | 1        | —              | —                      |
| CAP-45 | required-implementation  | CE-00 / CE-14         | `CE-PROOF-CAP-45` (E1, E2, E3, E4) | 0 / 0                     | 8        | LIM-01         | REQ-16                 |
| CAP-46 | existing-requalification | CE-12 / CE-12         | `CE-PROOF-CAP-46` (E2, E3)         | 0 / 0                     | 7        | —              | —                      |
| CAP-47 | existing-requalification | CE-00 / CE-14         | `CE-PROOF-CAP-47` (E1, E3, E5)     | 0 / 0                     | 6        | —              | —                      |
| CAP-48 | existing-requalification | CE-15 / CE-15         | `CE-PROOF-CAP-48` (E5)             | 0 / 0                     | 7        | —              | REQ-15                 |

## Visible limitations

| ID     | Kind                          | Limitation                                                                                                                                          |
| ------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| LIM-01 | architectural exclusion       | Unbounded runtime CSS values (StyleX function styles, Panda runtime values) need an inline value channel; never approximated and labeled equivalent |
| LIM-02 | architectural exclusion       | Runtime style injection, including development helpers                                                                                              |
| LIM-03 | architectural exclusion       | Arbitrary consumer selectors, tokens or policy overrides; replaced by declared vocabulary                                                           |
| LIM-04 | application responsibility    | Runtime DOM and native API behavior (dialogs, native view transitions)                                                                              |
| LIM-05 | unsupported platform          | Internet Explorer, legacy EdgeHTML, Presto and KHTML; 101 obsolete-engine-prefix entries stay in the denominator                                    |
| LIM-06 | target limited                | Unshipped or partially shipped features; required in-profile capabilities without an equivalent block their profile                                 |
| LIM-07 | unsupported platform          | Platform-scoped desktop/vendor extensions outside their exact engine                                                                                |
| LIM-08 | upstream limitation disclosed | Panda responsive variants with compound variants; PandamStyle must define its own semantics if needed                                               |
| LIM-09 | architectural exclusion       | Script-binding properties `behavior` and `-moz-binding`                                                                                             |

## Decisions handed to later lots

D-SF-01..D-SF-10 close in CE-13. D-BP-01..D-BP-11 and D-BP-13 close in CE-01.
D-BP-12, the SSR first-paint and hydration binding, closes in CE-13. The
validator enforces these closing lots. Each records Alpha 1 facts, upstream
evidence and affected profiles and capabilities. Notable inputs:

- the Alpha 1 hosts disagree on `.mts`/`.cts`;
- the Vite adapter rejects `.vue`;
- Panda 2.2.0 extracts Vue, Svelte, Astro and MDX, while StyleX's unplugin
  handles JS-like and Svelte ids.

| Decision | Closing lot | Issues   | Question                                                                                                                                                                                                              |
| -------- | ----------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-SF-01  | CE-13       | #80      | Which JavaScript/TypeScript module extensions are accepted source formats, and do all hosts agree?                                                                                                                    |
| D-SF-02  | CE-13       | #80      | Is Vue single-file-component source accepted, with a dedicated source identity adapter, or recorded as unsupported?                                                                                                   |
| D-SF-03  | CE-13       | #80      | Is Svelte component source accepted?                                                                                                                                                                                  |
| D-SF-04  | CE-13       | #80      | Is Astro component source accepted?                                                                                                                                                                                   |
| D-SF-05  | CE-13       | #80      | Is MDX content source accepted?                                                                                                                                                                                       |
| D-SF-06  | CE-13       | #80      | Which JSX runtimes are accepted (React only, or also Solid, Preact or Vue JSX), given that Alpha 1 lowers JSX with the React automatic runtime?                                                                       |
| D-SF-07  | CE-13       | #80      | Are static HTML/markup templates an accepted source, or is content authored only through accepted component formats?                                                                                                  |
| D-SF-08  | CE-13       | #78      | How is one source identity kept across client, SSR and RSC compiler environments and lazy chunks?                                                                                                                     |
| D-SF-09  | CE-13       | #80, #70 | Do reusable packages ship prebuilt PandamStyle artifacts or source to extract, and how are node_modules sources and external definitions admitted?                                                                    |
| D-SF-10  | CE-13       | #79      | Which Vitest 4.1.11 on Vite 8.3.1 transform, watch and isolation paths are accepted for component tests?                                                                                                              |
| D-BP-01  | CE-01       | #44      | What exact default evergreen target floor (Chrome, Edge, Firefox, Safari) does the web/content/forms/data profile use, and from which Browserslist/data versions?                                                     |
| D-BP-02  | CE-01       | #44, #81 | Which iOS Safari/WebKit versions are announced, and which real devices or engines prove them? Desktop Safari data and Playwright WebKit do not substitute.                                                            |
| D-BP-03  | CE-01       | #44, #81 | Which exact Electron/Chromium versions does the desktop-renderer profile target, and which platform extensions does it admit?                                                                                         |
| D-BP-04  | CE-01       | #44      | Is Android WebView an announced target, and with which minimum version?                                                                                                                                               |
| D-BP-05  | CE-01       | #44      | Record the explicit incompatibility of Internet Explorer, legacy EdgeHTML, Presto Opera and KHTML engines and their prefixed property entries.                                                                        |
| D-BP-06  | CE-01       | #44      | For each required property whose BCD 8.1.6 base support lacks an unprefixed release in Chrome, Firefox or Safari, decide native, transformed-with-proof, equivalent fallback or incompatible per target.              |
| D-BP-07  | CE-01       | #45      | Which prefixed-only or prefix-dependent features (for example line-clamp, masks, backdrop-filter, text-size-adjust) does the compiler-owned transformation emit, and how is that emission bound to artifact identity? |
| D-BP-08  | CE-01       | #44      | Which value keywords and functions need their own target records (text-wrap balance/pretty, multi-keyword display, light-dark(), color-mix(), modern color spaces, intrinsic sizes)?                                  |
| D-BP-09  | CE-01       | #45      | Which CSS transformation engine, Browserslist data pin and identity stage does the compiler own?                                                                                                                      |
| D-BP-10  | CE-01       | #44, #45 | What is the cascade-layer target policy: native layers only, or a proven equivalent lowering for older targets?                                                                                                       |
| D-BP-11  | CE-01       | #44      | Which reduced-motion, forced-colors, contrast and pointer/hover media features are required per target?                                                                                                               |
| D-BP-12  | CE-13       | #78      | The ssr profile inherits the browser targets of the application it delivers; which first-paint, hydration and asset-load proofs bind it to those targets?                                                             |
| D-BP-13  | CE-01       | #44, #70 | How does a reusable package declare its minimum target range so the consuming application resolves targets once?                                                                                                      |

## Comparator refresh

The pinned comparator is retained. Registry metadata was re-queried on
2026-10-18. Exact request timestamps, full distribution tags, response digests
and newer stable versions are recorded per package. Every pinned package is
still `latest`. Obsolete `@pandacss/core` remains 1.12.1 and is recorded as not
the comparator. All eight downloaded tarballs match the evidence lock's SHA-512
integrity. All 40 pinned upstream source digests and the 7 PandamStyle baseline
digests match.

| Package                    | Pinned | `latest` at observation | Delta                  | Integrity matches lock   |
| -------------------------- | ------ | ----------------------- | ---------------------- | ------------------------ |
| `@stylexjs/stylex`         | 0.19.1 | 0.19.1                  | `latest-equals-pinned` | True                     |
| `@stylexjs/babel-plugin`   | 0.19.1 | 0.19.1                  | `latest-equals-pinned` | True                     |
| `@stylexjs/unplugin`       | 0.19.1 | 0.19.1                  | `latest-equals-pinned` | True                     |
| `@pandacss/dev`            | 2.2.0  | 2.2.0                   | `latest-equals-pinned` | True                     |
| `@pandacss/compiler`       | 2.2.0  | 2.2.0                   | `latest-equals-pinned` | True                     |
| `@pandacss/preset-base`    | 2.2.0  | 2.2.0                   | `latest-equals-pinned` | True                     |
| `@pandacss/types`          | 2.2.0  | 2.2.0                   | `latest-equals-pinned` | True                     |
| `@mdn/browser-compat-data` | 8.1.6  | 8.1.6                   | `latest-equals-pinned` | True                     |
| `@pandacss/core`           | 1.12.1 | 1.12.1                  | `latest-equals-pinned` | not locked (v1 internal) |

## Limits of this task

- Source inspection and upstream emission probes are E1 evidence. They do not
  qualify PandamStyle syntax, emitted CSS, browser behavior or hosts.
- Family membership and overlay rules are reviewable scope judgments recorded in
  the classification rules. CE-00.2 corpus evidence can extend them.
- BCD base statements do not qualify values, keywords or subfeatures. Keyword
  records are D-BP-08.
- Raw probe and extraction outputs are not committed. They are regenerable and
  identified by digest, and the registry embeds their per-entry facts.
