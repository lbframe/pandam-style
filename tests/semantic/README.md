# PandamStyle semantic migration oracle

Repository qualification only. Nothing here is a workspace package, published
runtime, or harness installed into applications. Production never imports it.

Read
[the authority and case contract](../../docs/architecture/semantic-oracle-v1.md)
and the
[semantic gap register](../../docs/architecture/semantic-gap-register.md).

After installing with repository Node 22 and building, a targeted run is:

```sh
node tools/semantic-oracle/run.js .pms-bench/semantic-development
```

Chromium must be available as `chromium`, or `PMS_CHROMIUM` must name its
executable. The browser sandbox remains enabled. Six cases test actual computed
styles, including server-rendered markup hydrated with the compiled App.

Official qualification runs this automatically between `pandamstyle` and
`tooling-tests` in `verify-pms.sh`. Use the complete verifier for delivery.

`cases/` describes human intent, sources, transactions and independent expected
assertions. `fixtures/` contains a small authored design system and source
builders. `expectations/` contains authored semantic values. These cannot import
the implementation. `harness/implementation-adapter.js` is the current test-only
compiler seam; `browser-adapter.js` transports actual artifacts into Chromium.
`projection.js` defines implementation-independent semantic comparison.

`inventory.json` explicitly lists every suite and test identity. Adding or
removing a case requires a reviewable inventory edit; deleting a suite, even
from the Git index, cannot silently shrink its population. Integrity tests also
prove that two implementations agreeing on a wrong result still fail.

There is no snapshot, record, blessing, or expectation regeneration command. The
runner writes execution evidence only. A successful KNOWN_GAP registration test
certifies the discrepancy's boundary; it does **not** pass its target.

Migration authors may replace the adapter, but may not silently rewrite truth.
Expectation edits require an architecture/product decision, contract or ADR
reference, reason, intentional semantic change declaration and reviewable diff.
