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
agent session transcript on the maintainer's machine, together with both
measured inputs. The script itself is not published. Its SHA-256, its algorithm
and the evidence for each input are recorded in
[`baseline.v1.json`](../../tests/core-evolution/corpus/calibration/baseline.v1.json).

This directory is a parser-based reconstruction. It uses postcss 8.5.28 (locked
through vite 8.3.1) instead of a regular expression, and it imports the same
Alpha 1 policy module. It loads that module from its digested bytes and refuses
any other version unless one is passed explicitly. It also keeps the original
script's buckets and coercions, so that the reported numbers can be
recalibrated.

On the recovered inputs, the recovered script and this reconstruction each
reproduce every reported category exactly: 160 + 52 / 37 / 47 + 47 and 811 + 300
/ 124 / 112 + 212. The two extractions also yield identical (property, value)
multisets. The mockup input matches its package manifest digest. The utilities
input is a rebuild from unchanged sources: its block span and every count match
the original run, but its byte identity cannot be proven. The calibration limits
(CAL-01 to CAL-12) list what the reported numbers do not measure.

The consumer's badge comparison script (blob `8a97a049`) compares rendered
badges under CSP. It is a different, separate check, and nothing here uses it.

## Files

| Path                  | Content                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `declarations.mjs`    | postcss extraction, standard state context, value redaction, opaque location digests        |
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
  --input-id W-UTIL-343 --source-path <its project-relative path> \
  --baseline-layer utilities --header <header json> --out w-util-343.declarations.v1.json
node tools/coverage/cli.mjs extract --css <mockup stylesheet> \
  --input-id W-MOCKUP-1559 --source-path <its package-relative path> \
  --header <header json> --out w-mockup-1559.declarations.v1.json
```

The header JSON holds the set's `schemaVersion`, `kind`, `task`, `description`
and `input` provenance fields. The source path is the one the private
integration note names. It is used only inside location digests and is never
written out, so reproducing the location digests also confirms it.

## Publication rules

The consumer repository is private. A declaration set publishes only the
following:

- property and value;
- the condition context: media and supports queries, standard pseudo-classes and
  pseudo-elements, and allow-listed state attribute names;
- the Alpha 1 classification and registry binding;
- an opaque location: the SHA-256 of the logical path, line and column;
- input digests and counts.

Selectors, class names, attribute values, file paths and the original script are
never written. URLs, non-empty quoted strings, e-mail addresses, URIs, long
opaque tokens and non-ASCII text become a placeholder carrying the SHA-256 of
the removed text. Extraction fails if a redaction would change a classification.
The corpus validator rejects any record that still carries such a value.

A digest of a short, guessable value, such as a font name, does not keep that
value confidential. Digests identify removed text; they do not encrypt it.
