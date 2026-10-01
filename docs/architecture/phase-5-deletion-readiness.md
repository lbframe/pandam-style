# Phase 5 donor deletion readiness

## Current state

Phase 4 leaves the owned `@pandamstyle/core` and `@pandamstyle/compiler`
production graphs donor-free. The donor source trees remain physically present,
as required for this phase. The Vite qualification seam has moved to
`tools/pilot/vite-seam.js`; it no longer lives in a donor package or compiler
build input.

| Donor tree | Present at Phase 4 base | Phase 4 disposition | Phase 5 readiness |
| --- | --- | --- | --- |
| `packages/@stylexjs/` | Yes: atoms, Babel plugin, CLI, app generator, devtools, ESLint, PostCSS, Rollup, shared, StyleX runtime, and unplugin packages | Retained for the upstream reference suites; only the temporary Vite seam was moved | Production deletion is unblocked. Before removal, move PandamStyle integration tests/fixtures and retarget test/oracle helpers and repository scripts. Review which reference tests still merit an owned replacement. |
| `packages/style-value-parser/` | Yes: separate StyleX 0.19.1 workspace package | Its eight required media-query modules were absorbed into the compiler; the donor Babel plugin remains its only source importer | Not used by the compiler production graph. Keep for the Phase 4 upstream plugin suite; review workspace/package tests when that suite and donor plugin are removed in Phase 5. |
| `upstream/stylex/` | No | Not present in the Phase 4 starting tree; the fork is `packages/@stylexjs/*` | No deletion work is needed for this path. Confirm no later batch has introduced it before cleanup. |
| `upstream/panda/` | Yes: vendored comparison source at `1a310482ff18102c44b2a478b7644b064a80d7c6` | No compiler/core production dependency; retained as comparison and source-reading material | No production blocker. Preserve required source/license citations, then remove only under the Phase 5 cleanup scope. |

No donor tree has been deleted or archived by Phase 4.

## Behavior and test ownership

The unchanged 129-case semantic oracle remains authoritative: 125
`MUST_PRESERVE`, zero `KNOWN_GAP`, and four accepted `DEFERRED` cases. Phase 4
adds `packages/compiler/__tests__/engine-absorption-test.js` for owned static
evaluation, pass-state isolation, atomic generation, stable hashes, conflict
priority, conditions, token variables, theme projection, ordering, RTL float
generation, layers, and deduplication. The 129 oracle cases and browser/SSR
integration cases continue to run from `packages/@stylexjs/babel-plugin` during
this phase.

Before deleting the donor Babel plugin package, Phase 5 must move:

- `packages/@stylexjs/babel-plugin/__tests__/pandamstyle/` and its fixture
  projects to a PandamStyle-owned test root;
- `tools/pms/collect-regression-cases.js`,
  `tools/pms/forwarding-semantic-oracle.js`,
  `tools/pms/forwarding-warm-guard.js`, and the two tooling test fixture
  references that name the current test root;
- the PandamStyle test invocation in `verify-pms.sh`, plus `jest.config.js`
  setup that currently points upstream Babel tests at the fork package.

The upstream Babel plugin and StyleX suites remain secondary Phase 4 checks.
Phase 5 should retain owned equivalents for supported atomic lowering, value
normalization, ordering, RTL, and token/theme behavior before removing any
reference test that is the only guard for a retained behavior. No upstream test
failure was waived or removed in Phase 4.

## Legal and provenance records

Before removing source trees, keep the MIT notices needed by files moved into
PandamStyle-owned code, preserve the corresponding donor license files until the
cleanup is approved, and update:

- `docs/architecture/phase-4-derived-source-provenance.md`;
- `docs/architecture/phase-4-engine-absorption-map.md`;
- `upstream/README.md` and the existing specification source maps if any cited
  path or revision record is being removed.

Do not replace donor notices with an unsupported legal conclusion. The Phase 4
source manifest records StyleX `0.19.1` and donor commit
`fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`; Panda comparison source provenance
is recorded as commit `1a310482ff18102c44b2a478b7644b064a80d7c6` in
`upstream/README.md`.

## Vite seam disposition

`tools/pilot/vite-seam.js` is qualification-only and is loaded by the pilot
through `PMS_VITE_SEAM_PATH`. The compiler does not export it or include it in
its Rollup graph. It exists only to preserve the current Vite pilot while Phase
8 is still later in the plan. Phase 8 remains required for public Vite product
support; this seam does not claim or substitute for it.

The seam imports owned compiler source directly. If Phase 5 moves the pilot or
deletes this seam, it must preserve the packed-package Vite qualification until
the Phase 8 adapter takes over.

## Deletion blockers by tree

| Tree | Items that must be resolved before physical deletion |
| --- | --- |
| `packages/@stylexjs/` | Relocate PandamStyle tests/fixtures and their helpers; update workspaces, Babel/Jest configuration, upstream build/test commands, and test inventory; retain the required owned behavior tests; keep the qualification seam outside the tree. |
| `upstream/stylex/` | No such tree exists in the Phase 4 starting checkout. |
| `upstream/panda/` | Check all remaining source-map/spec references and preserve the vendor license/revision record in a durable owned document before deletion. |

## Readiness decision

**Phase 5 semantic readiness: yes.** The production donor closure is zero and
the required supported engine behavior has owned tests. **Physical cleanup
preconditions remain:** the PandamStyle test harness still lives under
`packages/@stylexjs/babel-plugin`, and legal/provenance references must be
reconciled as part of Phase 5. These are explicit Phase 5 tasks, not hidden
compiler dependencies. Phase 4 itself performs no donor deletion.
