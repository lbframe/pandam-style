# PandamStyle Phase 6 delivery

## Delivery identity

| Field                  | Value                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Branch                 | `feat/pandamstyle-phase-6-canonical-design-system-2026-10`                                                               |
| Worktree               | `/home/kyle/work/pandam-style-phase-6-design-system-2026-10`                                                             |
| Base commit            | `dd93bd4da211333bacf4c470554e5daab009e84e`                                                                               |
| Base tree              | `306f083735fca2be5aa84fc03ef5164dd139d8cf`                                                                               |
| Implementation commits | `6b3c5866` (`feat: add canonical PandamStyle design system`); `02f6f36d` (`fix: preserve PandamStyle catalog semantics`) |
| Tested commit          | `02f6f36df8e51e8655b820e25009c4d6fedb90d2`                                                                               |
| Tested tree            | `9b2d7c03ca7e3a2997c6e44bc0f8b7e8220d0872`                                                                               |
| Tested working tree    | Clean                                                                                                                    |

The official verifier ran on the tested commit with `workingTree: clean`. The
evidence-only closure commit contains only
`evidence/phase-6-canonical-design-system/**` and this delivery document. Its
commit and tree IDs, the pushed remote head, and the final clean-tree check are
in the completion receipt. Git commit and tree IDs cannot be embedded in the
tree that creates those same IDs.

## Canonical model and projections

The compiler-owned immutable snapshot is
[`snapshot.js`](../../packages/compiler/src/design-system/registry/snapshot.js).
It carries `systemId`, `registryDigest`, ABI version, compiler contract version,
manifest schema version, capability flags, normalized public/private vocabulary,
alias relationships, compiled theme and recipe data, CSS rule inputs, tooling
domains and repair domains. Runtime code receives projections, not the snapshot.

- Generated JavaScript and declarations come from the snapshot projection API.
- `manifest.json` preserves the existing `{ category }` shape under `tokens`;
  public alias information is projected separately under `semanticTokens`. A
  private target is omitted from that public relation.
- Theme and recipe catalogs, CSS inputs, candidate domains and repair domains
  use the same normalized registry vocabulary. Candidate and repair token paths
  retain registry declaration order to preserve the diagnostics contract.
- `artifacts.json` records SHA-256 and byte length for the design module,
  declaration, manifest and CSS, plus their common design identity. The five
  generated files are staged in one publication transaction.
- Runtime refs contain no project/session/revision/generation lifecycle fields.
  ABI v1 capabilities for slots, compound variants, patterns and raw dynamic
  styles remain `false`.

The project service consumes `candidateDomainOf` and `repairDomainOf`; it does
not rebuild a token, theme or recipe registry. The Phase 7 integration boundary
is documented in
[`phase-6-project-service-integration-contract.md`](phase-6-project-service-integration-contract.md).

### Artifact coherence and privacy

The verified generated set is in
[`generated-artifact-sample`](../../evidence/phase-6-canonical-design-system/generated-artifact-sample/).
Its `.txt` sidecars preserve the exact bytes without running source formatters;
[`artifact-set-samples.tar.gz`](../../evidence/phase-6-canonical-design-system/artifact-set-samples.tar.gz)
contains the same files with their generated filenames and extensions.
[`artifact-coherence.json`](../../evidence/phase-6-canonical-design-system/artifact-coherence.json)
records the common identity, artifact digests, successful validation and
rejection of JavaScript, declaration, manifest and CSS members from another
registry. The Phase 6 tests also reject an altered artifact-set digest.

[`private-vocabulary-leak-scan.json`](../../evidence/phase-6-canonical-design-system/private-vocabulary-leak-scan.json)
records a generated fixture with private token `colors.ink`, private recipe
`internalButton`, and public alias `colors.text`. The private token path and
recipe ID are absent from JavaScript, declarations, manifest, artifact metadata
and CSS. The alias remains public without disclosing its private target.

## Qualification

The full report is
[`verify/summary.json`](../../evidence/phase-6-canonical-design-system/verify/summary.json).
All nine required steps passed, in order: install, build, PandamStyle tests,
core tests, semantic oracle, tooling tests, pilot, artifacts, donor closure.
Result: **verified**, 757 tests passed in 50 suites, zero failures and zero
skips. Compiler/core package closure and donor closure passed.

The Phase 5 semantic oracle remained unchanged: 129 cases, 125 `MUST_PRESERVE`,
0 `KNOWN_GAP`, 4 `DEFERRED`, 0 failed and 0 unknown. The full report is in
[`verify/semantic-oracle/semantic-oracle.json`](../../evidence/phase-6-canonical-design-system/verify/semantic-oracle/semantic-oracle.json).
All six browser/SSR cases passed, including computed style, token values, theme
scope, conflict/cascade behavior and SSR hydration; see
[`browser-ssr.json`](../../evidence/phase-6-canonical-design-system/browser-ssr.json).

The generated declaration qualification is in
[`verify/phase-6-typescript.json`](../../evidence/phase-6-canonical-design-system/verify/phase-6-typescript.json):
the positive fixture typechecked, the negative fixture rejected all 11 invalid
lines, and the 9,488-byte declaration fixture took 653 ms for the positive check
and 721 ms for the negative check. The report also records five token literals,
four recipe-domain literals and sampled heap use. The 10k corpus declaration
size and generation time are recorded in the performance report.

The multi-revision test covers token add/remove/rename/category change, alias
retarget, theme override, condition definition, recipe axis add/remove, recipe
finite-domain change and public/private recipe visibility transitions. All 13
revisions rebuilt their design system; the 12 changed revisions took the
required global fallback and refreshed JS, CSS, declarations, manifest,
candidates and repairs together. Per-revision observations are in
[`verify/phase-6-mutations.json`](../../evidence/phase-6-canonical-design-system/verify/phase-6-mutations.json).

## Performance

Three independent warm-session iterations were run per scenario against the
generated `c10000-t1000-r100-s307-f8` corpus (10,000 components, 10,015 source
files, 70,828 style sites, 43,329 token references and 4,001 recipe calls). The
corpus manifest and raw 843-row observation set are retained under
[`performance/`](../../evidence/phase-6-canonical-design-system/performance/).
Times below are median diagnostics, then publication-ready/committed medians;
`—` means the expected unresolved-import refusal did not publish.

| Scenario                     | Diagnostics ms (p95) | Recompiled / reused | Global fallback | Ready / committed ms |
| ---------------------------- | -------------------: | ------------------: | --------------: | -------------------: |
| No change                    |          69.6 (77.1) |          1 / 10,001 |               0 |        582.5 / 707.3 |
| One-file style edit          |          72.8 (86.7) |          1 / 10,001 |               0 |        565.4 / 692.2 |
| Unresolved import edit       |          21.1 (21.3) |          0 / 10,002 |               0 |                — / — |
| Re-export edit               |        131.9 (159.6) |          1 / 10,001 |               0 |        630.6 / 753.6 |
| Design-system token mutation |  23,491.4 (23,649.6) |          10,002 / 0 |               1 |  23,985.2 / 24,109.2 |

On the token mutation, each measured revision rebuilt the design system once,
performed one global fallback and one design-system-view fallback. Median
registry rebuild time was 1.21 ms; snapshot build 3.53 ms; recipe compile 20.13
ms; JavaScript generation 1.86 ms; `.d.ts` generation 2.29 ms; manifest
generation 0.19 ms; artifact-set generation 1.51 ms. The generated `.d.ts` was
186,436 bytes. The design module, declarations, manifest, CSS and
`artifacts.json` together were 701,893 bytes. The performance report includes
per-file bytes, all measured iterations and view invalidation counters.

These are current measurements for this corpus and runtime. No Phase 5
performance result is reused as qualification, and no relative regression or
improvement claim is made.

## Phase 7 boundary and final state

Minimal Phase 7-owned/shared files changed for the Phase 6 artifact contract:

- `packages/compiler/src/project/session/index.js` stages the new declaration,
  manifest, CSS and artifact metadata atomically and serves candidate/repair
  vocabulary from the snapshot.
- `packages/compiler/src/project/session/fresh.js` uses the same artifact
  projections in the fresh-build path.
- `packages/compiler/src/artifacts/publication/transaction.js` classifies
  declarations as a `types` output kind.
- `packages/compiler/src/project/graph/resolution.js` recognizes and
  authenticates the frozen `__pandamstyle` ABI v1 marker while retaining the
  service-owned source check.

These changes do not add lifecycle identity or a second lifecycle authority. The
independent Phase 7 branch
`refactor/pandamstyle-phase-7-project-service-2026-10` exists and was left
untouched. Phase 6 and Phase 7 must reconcile their shared identity/publication
boundary before Phase 8/9 acceptance.

Phase 6: **complete**. The branch is pushed; the final receipt confirms remote
head equals local and the worktree is clean. Main remains at
`71fcc045b18eb215f0c3a815bb8c8d15a9f99489`. No PR was opened, no merge was
performed, and no package was published.
