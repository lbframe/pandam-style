# Core evolution inventory and profile specifications

These files implement the CE-00.1 scope contract described in
[the registry document](../../docs/research/core-evolution-registry.md). They
contain specifications and record tooling only. They change no product behavior
and are not part of the product test suites.

## Files

| Path                                                               | Kind      | Content                                                                                              |
| ------------------------------------------------------------------ | --------- | ---------------------------------------------------------------------------------------------------- |
| `classification-rules.v1.json`                                     | authored  | Disposition definitions, ordered procedure, curated records, families and overlay requirements       |
| `profiles.v1.json`                                                 | authored  | The nine accepted project profiles and their required capability families                            |
| `capabilities.v1.json`                                             | authored  | CAP-01–CAP-48 dispositions, owners, planned proof records, limitations, request cases and lot issues |
| `scope-decisions.v1.json`                                          | authored  | Source-format (CE-13) and browser-profile (CE-01) decisions                                          |
| `schema/*.schema.json`                                             | authored  | JSON Schemas for the five validated records                                                          |
| `validate.mjs`                                                     | tool      | Dependency-free schema and invariant validator                                                       |
| `tools/*.mjs`, `tools/regenerate.sh`                               | tool      | Key extraction, emission probes, registry observation and registry build                             |
| `../../docs/research/core-evolution-registry.v1.json`              | generated | The registry; rebuild it, never edit it                                                              |
| `../../docs/research/core-evolution-upstream-observations.v1.json` | generated | Timestamped comparator refresh; regenerate it, never edit it                                         |

Changing an authored record requires regenerating the registry. The registry
records every input's SHA-256, and the validator fails when an input changed
after the build.

## Validate

```sh
node tests/core-evolution/validate.mjs
```

The validator needs no install and reads committed files only. It checks:

- every record against its schema;
- the same 1,108 names and source counts as the pinned inventory, with one
  disposition each;
- recomputable counts;
- alias targets, requirement and evidence-class rules, and that Alpha 1 admitted
  names stay required;
- CAP-01–CAP-48 with in-Work owners, a proof record each, and profiles that
  together require all 48;
- limitation, decision and request traceability;
- that the comparator was not replaced;
- byte-identical reviewed planning files and pinned research inputs;
- the absence of any percentage or score field.

A pass proves record shape and consistency, not that any capability works.

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
