# Core evolution inventory and profile specifications

These files implement the CE-00.1 scope contract described in
[the registry document](../../docs/research/core-evolution-registry.md). They
contain specifications and record tooling only. They change no product behavior
and are not part of the product test suites.

## Files

| Path                                                               | Kind      | Content                                                                                                                                            |
| ------------------------------------------------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Path                                                               | Kind      | Content                                                                                                                                            |
| ---                                                                | ---       | ---                                                                                                                                                |
| `classification-rules.v1.json`                                     | authored  | Disposition definitions, ordered procedure, curated records, alias audits, families and overlay requirements                                       |
| `profiles.v1.json`                                                 | authored  | The nine accepted project profiles and their required capability families                                                                          |
| `capabilities.v1.json`                                             | authored  | CAP-01–CAP-48 dispositions, owners, planned proof records, limitations, request cases and lot issues                                               |
| `scope-decisions.v1.json`                                          | authored  | Source-format decisions (D-SF-01..10, closing in CE-13) and browser-profile decisions (D-BP-01..11 and D-BP-13 closing in CE-01, D-BP-12 in CE-13) |
| `schema/*.schema.json`                                             | authored  | JSON Schemas for the six validated records                                                                                                         |
| `validate.mjs`                                                     | tool      | Dependency-free validator and drift self-test                                                                                                      |
| `tools/derive-registry.mjs`                                        | tool      | Pure derivation of the registry from authored inputs and recorded facts, shared by builder and validator                                           |
| `tools/*.mjs`, `tools/regenerate.sh`                               | tool      | Key extraction, emission probes, registry observation and registry build                                                                           |
| `../../docs/research/core-evolution-registry.v1.json`              | generated | The registry; rebuild it, never edit it                                                                                                            |
| `../../docs/research/core-evolution-upstream-observations.v1.json` | generated | Timestamped comparator refresh; regenerate it, never edit it                                                                                       |

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
- re-derives the whole registry with `tools/derive-registry.mjs` and requires
  the committed registry to be identical, apart from its file digests, which
  must match the committed inputs. Dispositions, owners, requirements, target
  decisions, proof classes, counts and capability records therefore cannot drift
  from the authored rules;
- reconciles the recorded facts with the pinned inventory: 1,108 names, source
  flags, BCD status and Alpha 1 domains;
- requires an alias audit for every automatic alias whose BCD statements carry
  caveats, and rejects missing, stale or grammar-contradicting verdicts;
- repeats key invariants independently: owners within capability Work lots,
  authored proof records, alias targets, required-entry proof classes, Alpha 1
  names staying required, all 48 capabilities required by some profile, the
  decision closing lots and recomputed counts;
- checks the comparator observation, byte-identical reviewed planning files and
  pinned research inputs, and the absence of any percentage or score field.

`--self-test` then applies, in memory, mutations that must fail: a dropped
entry, a redirected alias, a removed requirement, an out-of-lot owner, weakened
proof classes, a stale profile count, a grammar-divergent name relabeled as an
alias, missing, flipped or stale alias audits, an out-of-lot family owner, a
weakened authored proof record and a changed source fact. It exits non-zero if
the baseline fails or any mutation passes. A pass proves record shape and
consistency, not that any capability works.

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
