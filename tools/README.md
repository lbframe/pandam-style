# Repository tools

The tools in this directory support PandamStyle development and qualification.

- `tools/pms/` contains the official verifier's reporting, test discovery,
  package closure, and evidence helpers.
- `tools/semantic-oracle/` runs the independently inventoried semantic cases.
- `tools/pilot/` packs the owned packages and installs them into the Vite
  qualification app outside the workspace.
- `tools/husky/` contains the local commit hooks.
- `tools/eslint/` contains lint support used by the repository.

Run the full required qualification from the repository root with
`./verify-pms.sh`. Package publication is handled only after the later release
qualification phase; this repository currently keeps its root workspace
private.
