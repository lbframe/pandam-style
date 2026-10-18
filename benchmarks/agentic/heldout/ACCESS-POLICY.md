# Held-out set access policy

The held-out set measures the final candidate on tasks that development work
has never seen. It is only useful while it stays unseen. This policy covers
the 16 tasks listed in [`MANIFEST.json`](MANIFEST.json).

## Custody

- Plaintext held-out tasks are never committed. They are authored in
  `benchmarks/agentic/heldout/.plaintext/` and unsealed only into
  `benchmarks/agentic/heldout/.unsealed/` (both gitignored) or a location
  outside the repository.
- The repository tracks only `heldout.tar.gpg` and `MANIFEST.json`. The archive
  is a deterministic tar of `tasks/` encrypted with symmetric gpg (AES256,
  SHA512 S2K, no compression). The manifest lists each task's ID, workflow,
  case type, tags, fixture, per-epoch classification and plaintext tree digest
  (`pms-tree-sha256/v1`). Coverage and integrity are checkable without
  decryption (`pms-agentic heldout verify`, `pms-agentic validate`).
- The passphrase is held by the project owner, outside the repository. Tools
  read it only from the file named by `PMS_HELDOUT_PASSPHRASE_FILE`. It is never
  written into the repository, CI configuration, logs, prompts or agent
  context.
- `pms-agentic heldout guard` and the test suite fail if any file under the
  plaintext or unsealed paths is tracked, if those paths stop being ignored, or
  if a held-out task appears in the development split.

## Who may unseal, and when

- **AG-12.2 final qualification only.** The run is performed by the qualifying
  harness operator, not by an evaluated agent and not during feature
  development. `pms-agentic heldout unseal` refuses to run unless
  `PMS_HELDOUT_PURPOSE=ag-12.2-final-qualification`.
- **Seal verification.** Right after sealing, the operator who sealed may
  unseal once with `PMS_HELDOUT_PURPOSE=seal-verification` to confirm the
  archive round-trips to the manifest digests. Then delete the unsealed copy.
- **Pre-freeze revision.** The author may unseal with
  `PMS_HELDOUT_PURPOSE=pre-freeze-revision` to revise the held-out set before
  it has ever been consumed. That means no baseline run and no feature work,
  and only while `corpus.json` has `freeze.thresholdsFrozen: false`. AG-00.3
  sets that flag to `true` when it freezes the thresholds, and the tool refuses
  this purpose from then on. Each use is recorded below.
- Agents implementing AG-01 to AG-13 must not read, decrypt or derive work from
  the held-out set. Development uses only `tasks/`.

## Revision record

| Date | Purpose | Reason | Result |
| --- | --- | --- | --- |
| 2026-10-18 | `pre-freeze-revision` | Independent review of AG-00.1 (PR #88) found oracle classes that asserted structure but not content or behavior, a too-narrow generated-integrity check and missing static bypass rules. The held-out set had not been consumed (no baseline, no feature work), so its author applied the same fixes. | Corpus 1.1.0: content assertions, the extended static rule set and generated-integrity checks were added to the affected held-out tasks. The set was re-sealed and verified by a seal-verification round trip, and the plaintext was deleted. |

## Rotation and changes

Any change to held-out content requires a new corpus version, a new manifest
and a new seal. If plaintext is exposed (committed, logged or shown to an
evaluated or developing agent), the affected tasks are burned. They must be
replaced with new tasks under a new corpus version, and the exposure recorded
in the qualification evidence.

## Commands

```sh
# Author or update plaintext in .plaintext/tasks/, then:
node benchmarks/agentic/bin/pms-agentic.mjs heldout manifest
PMS_HELDOUT_PASSPHRASE_FILE=/path/outside/repo node benchmarks/agentic/bin/pms-agentic.mjs heldout seal
node benchmarks/agentic/bin/pms-agentic.mjs lock
node benchmarks/agentic/bin/pms-agentic.mjs heldout verify

# AG-12.2 only:
PMS_HELDOUT_PURPOSE=ag-12.2-final-qualification \
PMS_HELDOUT_PASSPHRASE_FILE=/path/outside/repo \
  node benchmarks/agentic/bin/pms-agentic.mjs heldout unseal
```
