# Declaration coverage classifier

CE-00.2 tooling. It measures how the declarations of a stylesheet map onto a
PandamStyle policy and onto the CE-00.1 property registry. It changes no product
behavior and is not part of the product test suites.

A classification is policy-level evidence. "Expressible" means that the pinned
Alpha 1 policy module admits the property and value. It does not mean compiler
acceptance (E2), emitted CSS (E3) or rendered behavior (E4). Rendered and
behavioral fidelity is a separate gate: see the oracles in
[`tests/core-evolution/corpus/oracles.v1.json`](../../tests/core-evolution/corpus/oracles.v1.json).

## Provenance

The consumer integration note reports two measurements:

- 343 declarations = 212 expressible + 37 composite rewrites + 94 gaps;
- 1,559 declarations = 1,111 + 124 + 324.

The note says that a script imported the compiler's policy module. That script
was never committed to any repository. CE-00.2 recovered it from the consumer
agent session transcript on the maintainer's machine. It also recovered the
exact mockup input and pinned a replacement candidate for the utilities input.
The script itself is not published. Its SHA-256, its algorithm and the evidence
for each input are recorded in
[`baseline.v1.json`](../../tests/core-evolution/corpus/calibration/baseline.v1.json).

This directory is a parser-based reconstruction. It uses postcss 8.5.28 (locked
through vite 8.3.1) instead of a regular expression, and it imports the same
Alpha 1 policy module. It loads that module from its digested bytes and refuses
any other version unless one is passed explicitly. It also keeps the original
script's buckets and coercions, so that the reported numbers can be
recalibrated.

The recovered script and this reconstruction each reproduce every reported
category exactly: 160 + 52 / 37 / 47 + 47 and 811 + 300 / 124 / 112 + 212. The
two extractions also yield identical (property, value) multisets.

- **Mockup input:** recovered exactly. Its digest matches the package manifest.
- **Utilities input:** a pinned replacement candidate, rebuilt from unchanged
  sources. Its block span and category counts reconcile with the original run,
  but its byte identity is unproven, so no exact-input recovery is claimed.

The calibration limits (CAL-01 to CAL-13) list what the reported numbers do not
measure.

The consumer's badge comparison script (blob `8a97a049`) compares rendered
badges under CSP. It is a different, separate check, and nothing here uses it.

## Files

| Path                  | Content                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `declarations.mjs`    | postcss extraction, standard state context, value redaction                                 |
| `publication.mjs`     | CSS vocabulary, approved-identifier policy and the per-field publication check              |
| `css-colors.mjs`      | CSS Color 4 named and system colors, hex notation and color functions                       |
| `digest.mjs`          | plain SHA-256 for authored data, keyed HMAC-SHA256 for consumer redactions                  |
| `private-paths.mjs`   | real-path containment check for the private key and position maps                           |
| `classify.mjs`        | pinned Alpha 1 policy loader, Alpha 1 buckets, composite longhands, registry binding, flags |
| `declaration-set.mjs` | builds and re-derives a publishable declaration set                                         |
| `accounting.mjs`      | accounts for every declaration of the corpus reference stylesheets                          |
| `cli.mjs`             | `extract`, `check`, `calibrate`, `corpus` and `account` commands                            |

## Commands

```sh
node tools/coverage/cli.mjs calibrate     # committed sets against the reported baseline
node tools/coverage/cli.mjs corpus        # regenerate tests/core-evolution/corpus/accounting.v1.json
node tools/coverage/cli.mjs check --set <declaration set>
node tools/coverage/cli.mjs account --css <stylesheet>
node tests/core-evolution/validate-corpus.mjs --self-test
```

These need the repository install
(`yarn install --frozen-lockfile --ignore-scripts`) for postcss.

`extract` reads a stylesheet as data and writes a declaration set. A holder of
the private consumer inputs can re-create the committed sets byte for byte:

```sh
node tools/coverage/cli.mjs extract --css <renderer stylesheet> \
  --input-id W-UTIL-343 --baseline-layer utilities --header <header json> \
  --positions-out <private directory>/w-util-343.positions.json \
  --redaction-key <private directory>/redaction.key \
  --out w-util-343.declarations.v1.json
node tools/coverage/cli.mjs extract --css <mockup stylesheet> \
  --input-id W-MOCKUP-1559 --header <header json> \
  --positions-out <private directory>/w-mockup-1559.positions.json \
  --redaction-key <private directory>/redaction.key \
  --out w-mockup-1559.declarations.v1.json
```

The header JSON holds the set's `schemaVersion`, `kind`, `task`, `description`
and `input` provenance fields.

Declarations are identified by their ordinal within the input, for example
`W-UTIL-343#221`. Each declaration's line and column go to a private position
map, which must sit outside the repository. The maintainer keeps it with the
private inputs, and the tool refuses a path inside the repository. Only the
map's SHA-256 (`input.positionMapSha256`) is published.

## Publication rules

The consumer repository is private. A declaration set publishes only the
following:

- property and value;
- the condition context: media and supports queries, standard pseudo-classes and
  pseudo-elements, and allow-listed state attribute names;
- the Alpha 1 classification and registry binding;
- an ordinal id;
- input digests and counts.

Selectors, class names, attribute values, file paths, source positions and the
original script are never written.

Every value and every media or supports condition is tokenized with
postcss-value-parser, and each token must be exactly one of the following.
Nothing is skipped by prefix:

- a CSS keyword or function name from the fixed vocabulary in `publication.mjs`;
- a number, or a dimension whose unit is in the fixed CSS unit list;
- a hash token that is a 3, 4, 6 or 8 digit hex color;
- an identifier listed with a reason in
  [`approved-identifiers.v1.json`](../../tests/core-evolution/corpus/calibration/approved-identifiers.v1.json);
- a keyed redaction placeholder of a listed kind (`PLACEHOLDER_KINDS` in
  `digest.mjs`); a placeholder of any other kind is not a placeholder;
- whitespace, a comma, slash or colon separator, a `calc()` operator or a
  parenthesized group.

At extraction, any other token becomes a placeholder: an unknown identifier, a
non-hex `#name` hash, a number with an unknown unit, an unknown function, a
comment, a quoted string or a `url()` that holds anything but one placeholder.
URLs, e-mail addresses, URIs, long opaque tokens and non-ASCII text are replaced
first, and so is a condition that holds a disallowed token. Further rules:

- **Custom-property and layer names** must be approved; otherwise they are
  redacted.
- **Other properties** must be CE-00.1 registry names or `font-display`;
  otherwise they are redacted.
- **At-rules** are `@media` and `@supports` with clean conditions, `@font-face`
  or `@keyframes`; any other at-rule becomes one placeholder.
- **Pseudo-classes and pseudo-elements** must be on their allow-lists (others
  are only counted).
- **State attributes** come from an explicit list: every WAI-ARIA 1.2 state and
  property, the HTML state attributes and the listed `data-` state names.
- **Ids** are ordinals of their input.

Every record derived from or describing the consumer has a closed surface. That
covers the declaration sets, `baseline.v1.json`, `accounting.v1.json`,
`scope-findings.v1.json`, `approved-identifiers.v1.json` and
`publication-review.v1.json`. Each string field is one of the following:

- an enum;
- an anchored pattern with a maximum length (digests, commits, ordinal ids,
  timestamps);
- an `x-closed` type checked in code (CSS strings through the allow-list,
  registry names, allow-listed pseudo-classes, state attributes and composite
  longhands).

Object keys are declared properties or closed `propertyNames`. The records
contain no free text: provenance, calibration limits, rule ids, approval reasons
and scope findings are explained by hand in
[`tests/core-evolution/corpus/calibration/README.md`](../../tests/core-evolution/corpus/calibration/README.md),
and the records refer to them by fixed id.

Each set header has a canonical shape: `extractionHeader()` rebuilds its
extraction block from the baseline layer that the calibration record fixes for
the input (`utilities` or null). The calibration record, the approved
identifiers and the scope findings are pinned by `publication-review.v1.json`.

Extraction fails if a redaction would change a classification or a composite
accounting. The corpus validator applies these rules to every published field
and rejects any record that breaks them. It also rejects approvals that are
never used.

The private files (the redaction key and the position maps) must lie outside the
repository, judged on real paths. A `..`-prefixed name inside the repository, a
symlinked directory into it and a symbolic link file are all refused.

## Composite accounting

A `background` whose value is one CSS color rewrites to `background-color`. A
color is a CSS Color 4 named or system color, `transparent`, `currentcolor`, hex
notation, a color function, or a custom property whose every declaration in the
same stylesheet is such a color. Every other composite needs its full longhand
reset, which Alpha 1 does not admit. That includes `background: none` (it resets
`background-image` to `none` and `background-color` to `transparent`) and a
reference to an undefined custom property. The five historical buckets do not
depend on this accounting.

Placeholders in consumer sets carry an HMAC-SHA256 digest, not a plain hash. A
plain SHA-256 of a short or guessable value, such as a font name or a relative
asset path, could be reversed by hashing candidates. The HMAC key (32 random
bytes) is kept with the private inputs and position maps, outside the
repository; each set publishes only the key's SHA-256 fingerprint. A holder of
the key can recompute and verify every placeholder. Authored corpus data has
nothing private and keeps plain SHA-256.
