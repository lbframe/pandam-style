# Multi-project isolation report

Qualification ran as part of the official verifier on tested commit
`4e72cf32e498d5f4c3be0a9153c1d9c9aaba1d0a`. The `pandamstyle` step passed all
520 tests in 23 suites; the complete verifier passed all 763 tests in 49 suites.

## Scenarios exercised

- Two projects with the same relative source paths receive different
  `projectId` and `sessionId` values and read separate artifacts.
- Two projects using the same `systemId` but different `registryDigest` values
  retain distinct CSS and design-system views.
- A module created in project A does not resolve project B's missing import;
  B continues to report its coverage gap after a full rescan.
- A watcher event for project A advances A's revision and leaves project B's
  current revision unchanged.
- A publication ticket from another session is rejected. Foreign revision
  identities are rejected as well.
- Closing project A leaves project B usable.
- A closed session releases its output registration; repeated create/close
  cycles return the observable service resource counts to baseline.
- A sequential cold reopen receives a new `sessionId`, recovers the committed
  generation origin, and associates the unchanged output with the new session.

Evidence is in `packages/compiler/__tests__/pandamstyle/project-api-test.js`,
especially the tests for separate sessions, distinct registries, watcher
isolation, foreign tickets, cold reopen, and close/resource release. Semantic
positive and negative dependency comparisons also passed in
[`verify/semantic-oracle/semantic-oracle.json`](verify/semantic-oracle/semantic-oracle.json):
129 cases, 0 known gaps, 0 failures, and 0 unknown cases.
