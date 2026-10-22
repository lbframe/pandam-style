# Repository tools

The tools in this directory support PandamStyle development and qualification.

- `tools/pms/` contains the official verifier's reporting, test discovery,
  package closure, and evidence helpers.
- `tools/semantic-oracle/` runs the independently inventoried semantic cases.
- `tools/pilot/` packs the owned packages and installs them into the Vite
  qualification app outside the workspace.
- `tools/husky/` contains the local commit hooks.
- `tools/eslint/` contains lint support used by the repository.
- `tools/coverage/` contains the CE-00.2 declaration classifier, calibrated
  against the reported consumer baseline. It measures policy coverage only, not
  rendering; see its [README](coverage/README.md).
- `tools/baselines/` contains the CE-00.3 tooling for the frozen Alpha 1
  baseline epoch: the digest-bound archive store, measurement workloads and
  harness, and the non-regression budget gate; see its
  [README](baselines/README.md).
- `tools/targets/` contains the CE-01.1 browser-target generators and reports:
  `build-compat-data.mjs` regenerates the bundled BCD 8.1.6 compat data,
  `measure-floor.mjs` measures and freezes the default profile floors,
  `build-builtin-resolutions.mjs` precomputes the built-in profiles' browser
  lists (all three take `--check` to require byte identity), and `impact.mjs`
  reports target
  outcomes for the CE-00.2 corpus, both Wacando sets and the compiler's output
  (`--profiles <json>` selects enforced targets). Two CE-01.2 design reports
  back the [transformation-stage note](../docs/architecture/ce-01.2-transformation-stage.md):
  `transform-needs.mjs` evaluates the #45 transformation families and a prefix
  sweep at the O13 minimum and default floors (`--json`), and
  `lightningcss-probe.mjs` runs the Vite-installed Lightning CSS on the same
  probes.

- `tools/policy/` contains the CE-02.1 and CE-02.2 property-descriptor tools:
  `build-recognized.mjs` regenerates the recognized property names
  (`packages/compiler/src/design-system/policy/recognized.v1.json`) from the
  CE-00.1 registry (`--check` requires byte identity);
  `alpha1-equivalence.mjs --alpha1 <closure>` compiles the same probes with an
  installed Alpha 1 compiler (such as the CE-00.3 store closure, read only)
  and the workspace build, and fails on any difference other than the
  CE-02.1 rule suffixes and the two listed CE-02.2 delta classes (finite
  defaults of the former ranges, token values refused at use);
  `measure-catalog.mjs [--base <root>] [--definition <design.mjs>]` reports
  the catalog's bundle bytes and heap/RSS costs in the built compiler, with no
  verdict; `numeric-token-report.mjs [<workload id> ...]` reports, for the
  frozen CE-00.3 workloads, the tokens the CE-02.2 token numeric checks would
  refuse on some admitted property and the refusals a validation of the
  workload's own source raises, with no verdict;
  `migration-examples.mjs [--alpha1 <closure>] [--ce021 <pack dir>]` runs the
  CE-02.2 migration examples (M1-M5, M7) against their Alpha 1 or CE-02.1
  baseline and the workspace build, skipping a baseline that is not given
  with its reason (the `migration-examples-test.js` suite reads
  `PMS_ALPHA1_CLOSURE` and `PMS_CE021_PACK`);
  `value-safety-scan.mjs [--emitted]` runs the CE-02.2 S1 predicate over every
  importable design system (workloads, fixtures, examples, agentic benchmark
  fixtures) and reports the functions they use and every refusal, the scan
  that froze `APPROVED_FUNCTIONS`; with `--emitted` it also compiles each
  workload and re-reads its `styles.css` (S2).

## Qualification browser

The semantic oracle and the Next and Rsbuild qualifications launch a system
browser. [`pms/browser.js`](pms/browser.js) resolves it for all of them.

- `PMS_CHROMIUM` names the browser executable. It defaults to
  `/opt/google/chrome/chrome`.
- `PMS_NEXT_CHROMIUM` overrides it for the Next qualification only, for
  example with a profile-storage wrapper.
- The tooling reads the browser identity from `<executable> --version` and
  records the executable, product, version and pin in its reports: the
  semantic oracle in `semantic-oracle.json`, the Next and Rsbuild
  qualifications in their `report.json`.
- [`pms/ci-browser.json`](pms/ci-browser.json) commits the expected CI browser
  product and full version. The CI host manages that browser, outside this
  repository. When `CI` is set, the semantic oracle and the Next and Rsbuild
  qualifications fail before any case or build runs if the browser reports another
  identity. Locally, they only print a warning. After a deliberate browser
  upgrade on the CI host, update `product` and `version` in that file from the
  host's `--version` output.
- `PMS_BROWSER_PIN` names another committed pin, as a path inside this
  repository (relative paths resolve from its root). The pin replaces the CI
  pin, and a browser with another identity fails even outside CI.
  [`epochs/alpha1/browser.v1.json`](../benchmarks/core-evolution/epochs/alpha1/browser.v1.json)
  pins the archived Chromium engine of the `alpha1` store; see
  [Browser evidence on the archived engine](../benchmarks/core-evolution/README.md#browser-evidence-on-the-archived-engine).
- A semantic-oracle browser failure keeps the last 65,536 characters of the
  browser's stderr in its case report. A longer stream is cut with an explicit
  truncation line.
- The Next qualification reads computed styles through
  [`pms/page-readiness.js`](pms/page-readiness.js). Before a page expected to be
  valid, once the server has answered HTTP 200, it navigates again while the
  document is a transient 5xx or reloads itself, for at most
  `QUALIFIED_ELEMENT_TIMEOUT_MS`. Each re-navigation is listed in the report's
  `documentRenavigations`. It then waits up to the same bound for the elements
  to exist. A persistent 5xx, another status or an element that never appears
  fails with the page URL, the document's HTTP status and a body excerpt. Steps
  that expect a failure never re-navigate.

Run the full required qualification from the repository root with
`./verify-pms.sh`. Package publication is handled only after the later release
qualification phase; this repository currently keeps its root workspace
private.
