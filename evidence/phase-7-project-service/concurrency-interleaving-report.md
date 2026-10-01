# Concurrency and interleaving report

The Project Service's per-session promise queue serialized concurrent calls in
the official `pandamstyle` suite. The exact tested commit was
`4e72cf32e498d5f4c3be0a9153c1d9c9aaba1d0a`.

| Interleaving | Observed result |
| --- | --- |
| `compile()` followed by `applyChanges()` | Compile returns the prior exact revision; the mutation creates the next revision. |
| `validate()` followed by `applyChanges()` | Validation is bound to its original revision; later retrieval after supersession rejects as stale. |
| `candidateTokens()` followed by `close()` | The queued query completes against its exact revision, then later calls reject as closed. |
| `preparePublication()` followed by `applyChanges()` | The mutation advances once and revokes the prepared ticket; commit rejects as stale. |
| Watch event flush racing an explicit mutation | The watcher transaction wins the queue; the explicit transaction with the old base revision is rejected. |

The tests also prove that superseded validation results cannot be used for
artifact reads, candidate queries, audits, or publication. The relevant cases
are `the per-session queue gives concurrent operations deterministic order`,
`revisions and tickets reject foreign, stale, aborted, and reused input`, and
`watcher events enter the same queue and do not revise another project` in
`packages/compiler/__tests__/pandamstyle/project-api-test.js`.
