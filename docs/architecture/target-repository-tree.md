# Target repository tree

Status: Accepted target after canonical
[master-plan reconciliation](master-plan-reconciliation.md). Concrete final
ownership layout (ARCH-18/ARCH-20); not a file move authorization in Phase 0.

```text
pandam-style/
  package.json                        # private PandamStyle workspace
  yarn.lock                           # one verified dependency lock
  master-plan.md                      # exact human canonical plan, present unchanged
  README.md
  PANDAMSTYLE.md                       # product/status entry
  LICENSE
  ATTRIBUTIONS.md                      # origin/revision/license record
  LICENSES/                           # required third-party legal texts only
  packages/
    core/
      package.json                    # @pandamstyle/core
      src/
        index.js
        abi.js
        props.js
        recipe.js
        recipe-select.js
        selection-error.js
        types.ts                      # public runtime declarations source
    compiler/
      package.json                    # @pandamstyle/compiler
      bin/pms-build.js
      src/
        api/{index,config,host,project,cli}.js
        protocol/{identities,diagnostics,diagnostics-result,audit}.js
        frontend/
          babel/{plugin,evaluate,transform,compile-file}.js
          resolution/{module-summary,exports,design-access}.js
        semantics/
          provenance/index.js
          conformance/{channels,values}.js
        design-system/
          registry/{index,build-system}.js
          tokens/{ref,graph,compile}.js
          themes/{registry,compile}.js
          conditions/{registry,normalize}.js
          recipes/{registry,compile}.js
          policy/properties.js
        engine/
          atomic/                     # useful adapted engine closure
          lowering/styles.js
          ordering/                   # priority/direction/cascade ownership
        project/
          session/{index,fresh,overlay}.js
          mutations/{transaction,providers}.js
          graph/{resolution,coverage,design-system-views}.js
          css-state/index.js
        artifacts/
          javascript/{design-module,intrinsics,refs}.js
          types/                      # Phase 6 generator
          css/render.js
          metadata/audit.js
          publication/transaction.js
        hosts/watcher/{index,journal}.js
        observability/metrics.js
    vite/
      package.json                    # @pandamstyle/vite
      src/index.js                    # thin compiler SDK adapter
    next/
      package.json                    # @pandamstyle/next, later phase
      src/
        index.js
        webpack.js
        turbopack.js                  # only when separately supported/verified
  tests/
    fixtures/design-systems/conformance.js
    contracts/                        # ABI/SDK/protocol/dependency tests
    semantics/                        # independent policy/provenance/cascade cases
    oracles/{fresh,coverage,composition}.js
    incremental/                      # independent fresh equivalence + counters
    publication/                      # rollback/crash/no-op generation fixtures
    browser/                          # computed styles, SSR/hydration
    types/                            # generated vocabulary/category cases
    hosts/{cli,vite,next-webpack,next-turbopack}/
    support/{compiler-inspection,faults}.js
  benchmarks/
    pandamstyle/                       # reproducible corpora/drivers/reports
    support/experiments.js             # private experiments, no public package
  docs/
    architecture/
      public-api-v0.1.md
      package-architecture-v1.md
      generated-design-system-abi-v1.md
      diagnostics-protocol-v1.md
      current-to-target-module-map.md
      target-repository-tree.md
      phase-0-delivery.md
      master-plan-reconciliation.md
      adr/0001-*.md ... 0010-*.md
    pandamstyle-specification-v0.1/     # historical requirements/evidence
    strategic-checkpoint-2026-09.md    # historical evidence, not delivery claims
  tools/
    pms/                              # verifier/inventory/protocol tooling
    release/                          # PandamStyle-specific packaging checks
  verify-pms.sh
  examples/
    pilots/
      vite-react/                     # useful migrated standalone pilot
      next/                           # only after standalone + prior gates
  evidence/                           # durable results, no donor source copies
```

Brace notation enumerates proposed files within one folder, not npm packages.
Internal filename extensions may follow the repository's implementation
language; domains and ownership are fixed. No native production tree is
promised; Phase 13 may introduce a measured internal backend without adding a
public authoring API.

## Disappearing structures

| Current structure                                                                | Final action and gate                                                                                                                                              |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| packages/@stylexjs/                                                              | DELETE Phase 5 after useful engine/runtime/tests move under owned domains                                                                                          |
| upstream/stylex/                                                                 | DELETE Phase 5; Git history and legal records preserve provenance                                                                                                  |
| upstream/panda/                                                                  | DELETE Phase 5; selected mechanisms/tests adapted, no source archive                                                                                               |
| packages/@pandamstyle/compiler/                                                  | Compiler lives in packages/compiler; old path disappears after Phase 3/packaging migration                                                                         |
| compiler /runtime and /vite distribution subpaths                                | DELETE after core/vite consumers migrate; no permanent forwarding exports                                                                                          |
| donor examples/example-\* and donor docs UI/shared-ui/devtools/atoms scaffolding | Useful semantic tests/pilots transferred; obsolete source deleted in donor cleanup                                                                                 |
| packages/style-value-parser and other donor helper package directories           | Reachable useful helpers become owned compiler internal modules; unreachable historical package removed; no independent npm package merely from directory presence |
| packages/benchmarks, typescript-tests and scripts donor layout                   | Useful tests/benchmarks/tools move to top-level owned domains; obsolete structure deleted                                                                          |
| pilot/vite-react/                                                                | Useful pilot moves to examples/pilots/vite-react in its authorized later batch                                                                                     |
| tools/npm and obsolete donor tools/workflows                                     | Replace useful release checks with owned tools/release; delete obsolete donor-specific machinery                                                                   |
| legacy/, archive/, old-stylex/, reference-copy/, vendor-history/                 | Forbidden; do not create                                                                                                                                           |

Historical docs/evidence may name donor paths to identify past measurements.
They must not contain an executable donor checkout kept as an archive. Necessary
attribution/license material survives without legacy architecture. Phase 5 must
prove zero donor package references in all final production artifacts/dependency
edges, not require erasing truthful historical/legal prose.

Phase 0 changes docs only: no moves/deletions, no package
manifests/dependencies, no runtime/core/Next implementation, no main change. The
target tree is a destination checklist, not a declaration that these files now
exist.
