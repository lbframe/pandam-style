# Watcher and resync report

The watcher is a bounded input journal. Its events enter the Project Service's
queued mutation path; watcher state does not decide coverage or validity.

The `watcher-provider` tests verified coalescing, create/change/delete/rename
classification, ignored output paths, and that explicit and watched changes
cannot both accept the same base revision. Overflow discards partial events and
requires a full resync; unattributable events and watch startup loss also force
resync. A resync supersedes queued event fragments and uses full discovery
before validation. After process restart, the in-memory journal is not restored
and a fresh service session begins through full discovery. Close clears pending
events and closes established watchers.

Evidence: `packages/compiler/__tests__/pandamstyle/watcher-provider-test.js`
and the service-level watcher cases in
`packages/compiler/__tests__/pandamstyle/project-api-test.js`. All were included
in the official 520-test `pandamstyle` step, which passed.
