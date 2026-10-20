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

Run the full required qualification from the repository root with
`./verify-pms.sh`. Package publication is handled only after the later release
qualification phase; this repository currently keeps its root workspace
private.
