# Phase 7 authority inventory result

The production entry point is `createProjectSession()` from the package root.
The CLI constructs one service session and runs initialize, validate, audit,
compile, and close through it. `/host` binds revision-bound artifact and
publication calls from that same session. The watcher supplies filesystem
evidence to the service queue; it does not own graph, coverage, CSS, registry,
or publication state.

The synchronous implementation in `project/session/index.js`, mutation and
graph modules, CSS state, and the publication transaction are internal
algorithms called by the public service. The independent fresh build remains a
test/reference oracle. Private inspection, semantic tests, benchmarks, and the
Vite pilot are qualification-only paths. No production Vite or Next adapter was
added.

The detailed path-by-path classification and process-global state review are in
[`phase-7-authority-inventory.md`](../../docs/architecture/phase-7-authority-inventory.md).
The official verifier's `artifacts` and `donor-closure` steps both passed on
tested commit `4e72cf32e498d5f4c3be0a9153c1d9c9aaba1d0a`.

## Result

- One production project/session authority remains: the public Project Service.
- The remaining process-wide mutable service registry is the output lease map;
  it stores canonical output paths and opaque session IDs, and is emptied on
  close or initialization failure.
- No compiler graph, module overlay, CSS, registry, coverage, or validity map is
  retained as process-global semantic state.
- The fresh path and private seams remain outside package exports.
