# PandamStyle P0 design-system forwarding delivery

PandamStyle named and renamed design-system forwarding semantics are corrected
on the tested scope. Fresh compilation matches independently specified
forwarding expectations, persistent incremental compilation matches the same
expectations, positive and negative answers invalidate from their dependency
sets, and consumer provenance remains based on Babel bindings.

## Identity and boundaries

| Field | Value |
| --- | --- |
| Branch | `fix/pandamstyle-forwarding-semantics-2026-09` |
| Base SHA | `88a4c51180680c2efde09cb248f8a9a8f13342ea` |
| Base tree | `5150b4f1d16a1850147c2fe6258271c4f6aa09a4` |
| Implementation commit | `1719a0494f3f593cfa052493ef7a28be4c9d448e` |
| Tested commit | `1719a0494f3f593cfa052493ef7a28be4c9d448e` |
| Tested tree | `024073d3190df441c0ee582dfd17f91ea34a2875` |
| Starting verification tree | clean |
| Final head / remote head | The evidence commit containing this report; exact Git identities and remote equality are reported after commit/push, without embedding a self-referential commit hash here. |
| Main SHA, local and remote | `71fcc045b18eb215f0c3a815bb8c8d15a9f99489` |
| PR / merge / package publication | no / no / no |

The final evidence commit changes only documentation and recorded results after
the tested implementation. Main and the strategic checkpoint branch remain
unchanged. No compiler frontend, publication architecture, CSS aggregation,
agent result schema or general performance optimization was introduced.

## Files changed

The exact batch inventory is [files-changed.txt](files-changed.txt).

Implementation and regression code:

- `packages/@stylexjs/babel-plugin/pandamstyle/module-graph.js`
- `packages/@stylexjs/babel-plugin/pandamstyle/evaluate-usage.js`
- `packages/@stylexjs/babel-plugin/pandamstyle/session.js`
- `packages/@stylexjs/babel-plugin/__tests__/pandamstyle/design-system-view-test.js`
- `packages/@stylexjs/babel-plugin/__tests__/pandamstyle/forwarding-semantics-test.js`
- `tools/pms/forwarding-semantic-oracle.js`
- `tools/pms/forwarding-warm-guard.js`

Documentation:

- `docs/forwarding-semantics-2026-09.md`
- `docs/strategic-checkpoint-2026-09.md` — forwarding P0 status only
- `evidence/performance/spike-4/phase-d/DEBT.md` — history preserved, resolved
  status, exact fix commit and regression references

New evidence is entirely under `evidence/forwarding-semantics-2026-09/`: this
report, JSON/Markdown semantic matrices, warm-regression samples, separate
tooling log/counts, and verification environment/summary/step logs/digests and
small generated demonstrator artifacts. Heavy reproducible compiler artifacts
and the pilot work tree remain ignored by the repository's existing rules.

## Root cause and representation

`collectReexports()` emitted named specifiers without their source requests and
separate source markers. The walker grouped only those markers, returned the
first successful source and reconstructed stars from the original design
module's exports. The consumer's `relay.get(exported) ?? exported` fallback
granted same-spelling helper recognition without proof of forwarding.

The old representation was a reachability answer with an incomplete flat
exported/imported list. The new syntax relations explicitly carry source,
exported and imported names and kind. Composed per-export descriptors preserve
original module/binding identity, forwarding kind/request and chain. Namespace
descriptors contain actual member maps. Ordinary identities participate in
collision analysis but receive no compiler helper authority.

| Forwarding form | Corrected behavior |
| --- | --- |
| Named | Only actual source exports are forwarded. |
| Renamed | Exported spelling maps to the original binding/API. |
| Local re-export | Babel import binding identity resolves local names and aliases. |
| Export star | Immediate export maps compose; default is excluded; explicit exports override; distinct identities remain ambiguous. |
| Namespace | Namespace objects carry their relay's actual member map, including renamed members. |
| Multi-hop | Each hop composes descriptors; intermediate names never replace original identity. |
| Partial | Missing names receive no helper recognition; missing/ambiguous named imports get structured diagnostics. |
| Mixed source barrel | Each export has its own origin; ordinary bindings remain ordinary. |

The generated API audit and MODULE-01–10 are in the
[semantic contract](../../docs/forwarding-semantics-2026-09.md). Its real exports
are `create`, `token`, `props`, `recipes`, `themes`, `manifest` and
`__PMS_DESIGN_SYSTEM__`. The first five are recognized APIs. Manifest is
metadata; the marker identifies the module and is not a helper. There is no
separate runtime-only export and no generated default API. Source default
forwarding is represented, but cannot confer nonexistent design default
semantics.

## Cache invalidation

Positive and negative relay entries retain all derivation dependencies. Every
module whose bytes were consulted is recorded, even if its branch contributes
no recognized binding. Downstream resolution candidates are recorded separately
from read modules and participate in the owner's version set. Cached hits
contribute their dependencies to every consumer's DSV. Reverse dependencies also
seed affected consumers when a consulted module is removed. Restored covered
nodes whose file state was retired receive a fresh view.

The existing consumer resolution index now retains candidate dependencies for
positive answers too. Appearance of an earlier candidate or removal of a winner
can change forwarding provenance without changing a relay's bytes. The existing
unreadable-stub coverage behavior remains intact when no replacement exists.
This narrow resolution interface adjustment is required by semantic dependency
correctness; the coverage graph and mutation architecture were not redesigned.

## Independent oracle and tests

- Fresh semantic oracle: **47 fixtures/revision rows; 47 passed; 0 failed**.
- Incremental semantic oracle: **47 fixtures/revision rows; 47 passed; 0 failed**.
- Fresh equals incremental: **47 passed; 0 failed**.
- Fresh view audit: **47 passed; 0 failed**.
- Expected bindings, expected diagnostic codes and expected compiled probe
  shapes are handwritten independently of fresh output. Each dimension has a
  separate result. Successful compiled consumer bytes also agree.
- Incremental binding maps come from the cached answers used by the active
  persistent session through `inspectForwarding()`, not a fresh lookup.
- Babel binding tests independently verify alias/shadowing identity, namespace
  member authorization, metadata exclusion and ordinary local declarations.
- The generated export inventory is asserted from the real generator output.

The complete required-format table is the
[semantic matrix](semantic-matrix.md); [JSON](semantic-matrix.json) retains all
expected/actual fields and separate boolean gates. It includes the required
17 cases, both removal/restore sequences, stable-spelling remaps, deeper
negative repair, defaults, namespace partial/renamed members, star collisions,
explicit overrides, same-origin diamonds, unknown external stars, cycles and
downstream/first-hop resolution candidate replacement/restoration.

| Required document/test change | Completed |
| --- | --- |
| Phase D debt test converted rather than deleted | yes |
| DEBT.md updated with history preserved | yes |
| Strategic checkpoint forwarding P0 status updated | yes |
| Historical 460 tests / 20 suites preserved | yes; increased by 38 tests / 1 suite |

## Verified pipeline

All seven normal steps ran without skip flags: install, build,
upstream-babel-plugin, upstream-stylex, pandamstyle, pilot and artifacts.

| Population | Tests passed / failed / skipped | Suites passed / failed / skipped |
| --- | --- | --- |
| PandamStyle | 498 / 0 / 0 | 21 / 0 / 0 |
| tools/pms, separate | 43 / 0 / 0 | 3 / 0 / 0 |
| Upstream Babel | 1007 / 0 / 64 | 42 / 0 / 1 |
| Upstream StyleX | 99 / 0 / 0 | 4 / 0 / 0 |
| Seven-step total, excludes tools/pms | 1604 / 0 / 64 | 67 / 0 / 1 |

`verify-pms`: **complete: true; verdict: verified; failedSteps: [];
skippedSteps: []**. The upstream skips are unchanged declared upstream Jest
skips; no runner step was skipped. The packed production pilot and artifact
checks passed. Evidence: [summary](verification/summary.json),
[environment](verification/env.json), [steps](verification/steps.tsv),
[artifact digests](verification/artifact-digests.txt),
[separate tooling counts](tools-pms.json).

An earlier development run encountered ENOSPC from disposable fixture copies.
They were retired after checking that no PandamStyle test process remained.
The successful pipeline used `TMPDIR=/dev/shm/pms-forwarding-tmp`; no verification
step or test was skipped to work around disk capacity. One development failure
from changed coverage-stub behavior was corrected while preserving its original
test assertion; the verified run has no failures.

## Small warm regression guard

Node 22.22.0; actual checkpoint compiler rebuilt in an isolated detached checkout;
same valid fixture plus one relay/consumer; three independently initialized warm
sessions on each side; filesystem writes and initialization excluded. Timer:
`applyAgentChanges + validate`; no publication. Raw samples and verdicts are in
[warm-regression.json](warm-regression.json).

| Mutation | Before median ms | After median ms |
| --- | ---: | ---: |
| Direct local style edit | 4.71 | 4.63 |
| Named relay edit | 3.25 | 6.10 |
| Renamed relay edit | 3.53 | 3.62 |
| Relay stops reaching design system | 4.31 | 4.30 |
| Relay restoration | 5.58 | 4.78 |

The named edit now invalidates and recompiles the consumer, which the defective
map did not do. Its ~2.85 ms increase is the measured cost of changed semantics
on this small fixture. The renamed mutation intentionally removes the name the
consumer imports: the old compiler accepted it; the corrected compiler rejects
it. Those timings measure different semantic outcomes. The other small changes
do not establish speedups or tail-latency guarantees. No optimization campaign
was launched.

## Remaining semantic limits

General ECMAScript cyclic ResolveExport semantics are not solved. Unknown
external star sets, cyclic/truncated star enumeration, parse errors and depth
exhaustion fail closed. Arbitrary value aliases (`const css = create; export {
css }`), CommonJS and computed exports are not forwarded. Multiple generated
systems in one answer fail closed because the project applies one policy.
The existing generated-marker trust boundary is unchanged.

Missing/ambiguous imports expose `PMS_FORBIDDEN_IMPORT`, source, rule
`module.forwarding`, structured reason/issues and repair shape. Existing
static-value, coverage and provenance diagnostics cover invalid uses of
ordinary or missing namespace members. These limitations bound the acceptance
claim; types, SSR/hydration, browser cascade and broader agent protocol P0s remain.
