# Resource lifecycle report

The close/resource test observes the service's explicit resource registrations,
watcher pending count, output leases, and session state access. Close rejects
new mutations, validation, compile, artifact reads, and ticket commits; it
clears pending watcher events, releases the output registration, and leaves
committed files on disk. Three repeated create/initialize/close cycles returned
resource counts to the initial baseline. The other project remains usable when
one session closes.

No assertion depends on garbage-collection timing. The process-global output
lease registry contains no session object or semantic cache. See
`packages/compiler/__tests__/pandamstyle/project-api-test.js`, test
`watch loss falls back to full discovery and close releases service
registrations`, plus the authority inventory.
