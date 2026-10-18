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

Run the full required qualification from the repository root with
`./verify-pms.sh`. Package publication is handled only after the later release
qualification phase; this repository currently keeps its root workspace
private.

Browser-backed steps launch the executable named by `PMS_CHROMIUM` when it is
set. Their defaults differ by tool and match only some machines. The CI job sets
it to the runner's sandbox-capable Google Chrome and pins Node 22.22.0, the
runtime the package and Next qualifications assert; see the
[CE-00.4 record](../docs/research/core-evolution-ci-repair.md).
