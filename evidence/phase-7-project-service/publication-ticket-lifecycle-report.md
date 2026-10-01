# Publication ticket lifecycle report

The `/host` bridge delegates ticket operations to the same Project Service
session. Qualification in
`packages/compiler/__tests__/pandamstyle/project-api-test.js` verified:

- tickets carry the exact project, session, and revision identity plus a
  candidate digest;
- invalid revisions cannot prepare publication;
- a ticket from another session cannot commit;
- a ticket is single-use and cannot be replayed after commit;
- validation invalidation and a newer accepted revision revoke prepared work;
- `abortPrepared()` succeeds once and makes later abort/commit attempts stale;
- closing the session revokes outstanding work;
- a failed host commit leaves the previously committed generation byte-for-byte
  current and invalidates the failed ticket.

Cold reopen assertions distinguish `GenerationId`, `artifactRevision`, and
`associationRevision`: unchanged recovered bytes retain their origin and
generation while associating with the new session revision; changed bytes
publish a later generation. The corresponding publication and CLI regression
tests passed in the official verifier.
