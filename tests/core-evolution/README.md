# Core evolution inventory, profiles and proof corpus

These files implement the CE-00.1 scope contract described in
[the registry document](../../docs/research/core-evolution-registry.md) and the
CE-00.2 proof corpus and classifier calibration described
[below](#proof-corpus-and-classifier-calibration-ce-002). They contain
specifications, fixtures and record tooling only. They change no product
behavior and are not part of the product test suites.

## Files

| Path                                                               | Kind      | Content                                                                                                                                            |
| ------------------------------------------------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `classification-rules.v1.json`                                     | authored  | Disposition definitions, ordered procedure, curated records, alias audits, families and overlay requirements                                       |
| `profiles.v1.json`                                                 | authored  | The nine accepted project profiles and their required capability families                                                                          |
| `capabilities.v1.json`                                             | authored  | CAP-01–CAP-48 dispositions, owners, planned proof records, limitations, request cases and lot issues                                               |
| `scope-decisions.v1.json`                                          | authored  | Source-format decisions (D-SF-01..10, closing in CE-13) and browser-profile decisions (D-BP-01..11 and D-BP-13 closing in CE-01, D-BP-12 in CE-13) |
| `schema/*.schema.json`                                             | authored  | JSON Schemas for the six CE-00.1 records and the five CE-00.2 records                                                                              |
| `validate.mjs`                                                     | tool      | Dependency-free validator and drift self-test                                                                                                      |
| `tools/derive-registry.mjs`                                        | tool      | Pure derivation of the registry from authored inputs and recorded facts, shared by builder and validator                                           |
| `tools/*.mjs`, `tools/regenerate.sh`                               | tool      | Key extraction, emission probes, registry observation and registry build                                                                           |
| `../../docs/research/core-evolution-registry.v1.json`              | generated | The registry; rebuild it, never edit it                                                                                                            |
| `../../docs/research/core-evolution-upstream-observations.v1.json` | generated | Timestamped comparator refresh; regenerate it, never edit it                                                                                       |
| `corpus/corpus.v1.json`                                            | authored  | CE-00.2 positive fixtures, success criteria, assertions and negative fixtures                                                                      |
| `corpus/oracles.v1.json`                                           | authored  | CE-00.2 oracle definitions, outcome classes and interaction states                                                                                 |
| `corpus/fixtures/*/`                                               | authored  | Reference pages, stylesheets and assets pinned by the corpus manifest                                                                              |
| `corpus/calibration/baseline.v1.json`                              | authored  | Reported consumer baseline, recovered classifier provenance, inputs, reproduction and calibration limits                                           |
| `corpus/calibration/*.declarations.v1.json`                        | generated | Redacted consumer declaration sets; extract them with `tools/coverage`, never edit them                                                            |
| `corpus/accounting.v1.json`                                        | generated | Accounting of every corpus declaration; regenerate with `node tools/coverage/cli.mjs corpus`                                                       |
| `validate-corpus.mjs`                                              | tool      | CE-00.2 validator and mutation self-test                                                                                                           |

Changing an authored record requires regenerating the registry. Each registry
entry keeps its recorded upstream facts (`sources`, `bcd`, `bcdRelations`,
`alpha1`, `upstream`); everything else is derived from those facts and the
authored records.

## Validate

```sh
node tests/core-evolution/validate.mjs --self-test
```

The validator needs no install and reads committed files only. It:

- checks every record against its schema;
- requires exactly the fixed input keys and repository paths, each with a
  matching digest;
- re-derives the whole registry with `tools/derive-registry.mjs` and requires
  the committed registry to be identical, apart from its file digests, which
  must match the committed inputs. Dispositions, owners, requirements, target
  decisions, proof classes, counts and capability records therefore cannot drift
  from the authored rules;
- reconciles the recorded facts with the pinned inventory: 1,108 names, source
  flags, BCD status and Alpha 1 domains;
- never accepts a vendor-prefixed normalized alias, requires every alias to
  carry a positive equivalence statement with sources, and rejects missing,
  stale, source-less or grammar-contradicting audits;
- repeats key invariants independently: owners within capability Work lots,
  authored proof records, the CAP-xx proof identity of every proof record, alias
  targets, required-entry proof classes, Alpha 1 names staying required, all 48
  capabilities required by some profile, decision kind and closing lot derived
  from each decision identifier (D-SF-_ and D-BP-12 close in CE-13, the other
  D-BP-_ in CE-01), and recomputed counts;
- checks the comparator observation, byte-identical reviewed planning files and
  pinned research inputs, and the absence of any percentage or score field.

`--self-test` then applies 23 mutations in memory, each of which must fail for
its stated reason. Some edit only the generated registry. Others edit the
authored records and re-derive the registry consistently, the way a careful edit
would. They cover:

- registry drift: a dropped entry, a redirected alias, a removed requirement, an
  out-of-lot owner, weakened proof classes and a stale profile count;
- alias rules: grammar-divergent or vendor variants relabeled as aliases;
  missing, flipped or stale audits; a curated vendor alias; an alias without
  sources; an unprefixed alias without a verdict;
- inputs: a missing, redirected or dropped input path;
- proof identity: a capability given another capability's proof identity, and a
  proof reduced to source inspection;
- decisions: a decision kind contradicting its identifier;
- facts: a changed source fact.

It exits non-zero if the baseline fails or any mutation passes. Each passing run
prints required-entry, requirement and proof-class totals.

A pass proves record shape and consistency, not that any capability works.

## Changing authored scope

Re-derivation proves that the registry follows the authored specifications. It
cannot judge an authored change. Any change to `classification-rules`,
`profiles`, `capabilities` or `scope-decisions` is a scope change that needs
independent review. A diff that reduces required entries, profile requirements,
capability requirements or proof classes must be called out explicitly in its
pull request. Compare the totals the validator prints before and after the
change.

## Alias evidence

Alias audits and curated aliases cite pinned sources by URL and SHA-256. They
can be re-checked outside the repository, for example:

```sh
dir=$(mktemp -d)
curl -sSL -o "$dir/CSSProperties.json" \
  https://raw.githubusercontent.com/WebKit/WebKit/77f8a2bc5a964cb740a0b27dcb2c757b0861a0c1/Source/WebCore/css/CSSProperties.json
curl -sSL -o "$dir/css-align-3.html" https://www.w3.org/TR/2025/WD-css-align-3-20250311/
curl -sSL -o "$dir/css-overflow-4.html" https://www.w3.org/TR/2023/WD-css-overflow-4-20230321/
sha256sum "$dir"/*
```

The CSS Text 3 digest was recorded from `https://www.w3.org/TR/css-text-3/`. On
2026-10-18 that page identified itself as the dated CRD
`https://www.w3.org/TR/2026/CRD-css-text-3-20260814/`.

## Regenerate

Upstream downloads are untrusted data. Give each its own new empty directory
outside the repository. Install with `--ignore-scripts`, and pass the
directories to the tools as arguments. The tools load upstream compilers from
those paths and never run inside them. The 2026-10-18 run used this layout:

```sh
up=/tmp/ce001-upstream
for spec in @stylexjs/stylex@0.19.1 @stylexjs/babel-plugin@0.19.1 \
  @stylexjs/unplugin@0.19.1 @pandacss/dev@2.2.0 @pandacss/compiler@2.2.0 \
  @pandacss/preset-base@2.2.0 @pandacss/types@2.2.0 \
  @mdn/browser-compat-data@8.1.6; do
  dir="$up/pack/$(echo "$spec" | tr '/@' '__')"
  mkdir -p "$dir" && (cd "$dir" && npm pack "$spec" --ignore-scripts)
  mkdir -p "$up/unpacked/$(basename "$dir")"
  tar -xzf "$dir"/*.tgz -C "$up/unpacked/$(basename "$dir")"
done
# Pinned source archives (commits from core-evolution-evidence.json):
#   src-archive/<name>/<archive>.tar.gz, extracted with --strip-components=1
#   into src/stylex (1fcb9a51…), src/panda (d149285e…) and src/bcd (3e566588…).
# Comparator installs, each in its own directory:
#   run-stylex: npm install --ignore-scripts --save-exact
#     @stylexjs/babel-plugin@0.19.1 @stylexjs/stylex@0.19.1 @babel/core@7.28.5
#   run-panda: npm install --ignore-scripts --save-exact @pandacss/dev@2.2.0
#     @pandacss/compiler@2.2.0 @pandacss/preset-base@2.2.0 @pandacss/types@2.2.0
yarn install --frozen-lockfile --ignore-scripts   # repository parsers and Prettier
tests/core-evolution/tools/regenerate.sh "$up" /tmp/ce001-work
```

The extraction and both emission probes are deterministic, and the observation
record names their digests. Each run refreshes the npm observation, so its
timestamps and response digests change. A newer `latest` tag is recorded as
`newer-latest-requires-delta-review`; it never replaces the pinned comparator.

## Proof corpus and classifier calibration (CE-00.2)

The corpus binds reproducible outcomes to the CE-00.1 profiles and capability
fixture sets. Its parts are kept apart: compiler acceptance, vocabulary gaps,
unsupported behavior and rendered fidelity are separate outcome classes. Nothing
here has been rendered or compiled yet. The oracles define their inputs and
negative controls, and the lots named in each oracle execute them.

- **Positive fixtures.** Ten authored reference pages: application shell, forms,
  notices and empty states, dense data grid, content, RTL and vertical text, SVG
  and media, SSR with a lazy route, component library, and an interaction-state
  matrix. Every profile's fixture classes are covered. Each fixture states
  accepted vocabulary, expected CSS, geometry, text wrapping, state behavior,
  keyboard, accessibility and CSP criteria as assertions of the oracles. Each
  assertion is a positive, boundary or negative case. Expected values are
  authored numbers and computed values chosen not to depend on fonts.
- **States.** Pointer, touch, keyboard, error, loading, disabled, forced colors
  and increased contrast are all exercised, plus reduced motion, print, RTL,
  scrolled and hydrated states.
- **Negative fixtures.** Sixteen consumer sources against the existing
  `tests/fixtures/design-systems/conformance.js` definition. They cover wrong
  categories, private tokens and unowned URLs, raw and unknown selectors, inline
  styles, raw values and composites, runtime values, inline custom-property
  transport, mixed design systems and a desktop-only platform extension. Each
  records the Alpha 1 diagnostic and rule found by source inspection (E1, not
  executed) and the rejection that every later lot must keep.
- **Accounting.** `accounting.v1.json` classifies every declaration of every
  reference stylesheet (835, of which 829 are in the Alpha 1 denominator)
  against the pinned Alpha 1 policy. Each declaration is bound to its registry
  entry and `CE-FX-PROP-*` fixture, and composites carry the longhands their
  rewrite needs.
- **Calibration.** The consumer's reported 343 = 212 + 37 + 94 and 1,559 =
  1,111 + 124 + 324 reconcile exactly. The original classifier and both inputs
  were recovered; [`tools/coverage`](../../tools/coverage/README.md) describes
  their provenance and the parser-based reconstruction.
  `calibration/baseline.v1.json` records the evidence and the twelve calibration
  limits. It supersedes the CE-00.1 evidence lock's
  `originalClassifierRecovered: false` and `classificationResultsRerun: false`.
  That frozen record is left unchanged.

```sh
node tests/core-evolution/validate-corpus.mjs --self-test
node tools/coverage/cli.mjs calibrate
```

The corpus validator needs the repository install for postcss. It checks:

- the five schemas and every input, source and definition digest;
- profile, capability fixture set, oracle, viewport, state and target bindings;
- the selectors and properties named by each mutation;
- coverage: a positive fixture, a boundary assertion and a negative fixture for
  every profile; positive, boundary and negative cases for every oracle; every
  required interaction state and negative category;
- every success criterion of each positive fixture;
- re-derivation of the accounting and of both consumer sets, the reported counts
  and each calibration limit;
- regular-expression parity of the parser on every corpus stylesheet;
- the publication rules for consumer data.

`--self-test` applies 24 mutations, and each must fail for its stated reason.

Changing a fixture input, expectation or negative fixture is a corpus change and
needs a reviewed reason. Regenerate the accounting rather than editing it.
