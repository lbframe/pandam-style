# Independent review of the core evolution plan

## Decision and scope

Review date: 2026-10-18. Verdict: **ship**. Blocking findings: **none**.

The independent reviewer accepts the [implementation plan](core-evolution-plan.md),
its [coverage matrix](core-evolution-coverage.md), research and recorded inputs
as coherent implementation guidance. This decision establishes no newly shipped
CSS capability, browser support, host qualification or publication result.

The plan header and its final open-review row describe the **pre-review
preparation state** at candidate commit `1261517d`. This dated record supplies
the current review status: the frozen candidate is accepted as a plan.
Implementation and release qualification remain open.

## Frozen candidate

- Candidate commit: `1261517dbf910ec758a194d5b4da503795284bdf`.
- Product source baseline: `415e05539fcb5d36a78226112b5cf488b200b1aa`.
- Plan SHA-256: `b2e6778082f30a11b8a45e08737f416fba97082f81d70db48d9a0dc2aa5b4a65`.

All six candidate files remained byte-identical throughout review and recording
of this decision. The acceptance record and its supplementary registry
observation are separate additions, not changes to the reviewed plan.

| Candidate file | SHA-256 |
| --- | --- |
| `agentdoc/systems.yaml` | `e7576906acc7335edc2a9e221077101cc48b4de2b9d5ce1e77e941eaa2270264` |
| `docs/architecture/core-evolution-coverage.md` | `836862300daed926ab3cffd7c40dc17f0774c68e10b9619fe053edec6fa11381` |
| `docs/architecture/core-evolution-plan.md` | `b2e6778082f30a11b8a45e08737f416fba97082f81d70db48d9a0dc2aa5b4a65` |
| `docs/research/core-evolution-evidence.json` | `ef6fa57627bba9f301e223fcaf6ee867d594dbb4a78e1b2a1ad405d0f836ba7a` |
| `docs/research/core-evolution-inventory.json` | `34608bd41f3c05b3c1e81fd039416d4e7bb91b248b36d79848941e2e33557526` |
| `docs/research/core-evolution-upstreams.md` | `dd13310283d52f707ec272f814fc609728ff4e83c695514e185c68ef3c387716` |

## Independence and execution identity

- Reviewer: `/root/review_core_evolution_plan`; author and reviewer are distinct.
- Mission role: `auditeur_contrat`; native agent-role metadata is unset.
- Requested and observed model: `gpt-6.1-sol`.
- Requested and observed reasoning effort: `high`.
- Context: fresh mission, `fork_turns: none`; no inherited author conversation.
- Route: native independent review under the `orchestration-multi-agents` skill
  and its `references/native-orchestration-contract.md`.

The parent checked the exact reviewer session's `session_meta` and
`turn_context` records for model, effort and task-path identity. A successful
spawn or the reviewer's self-report alone was not treated as runtime proof.

Read-only behavior was requested and observed: no edits, installations,
commits, product tests/builds or subagents. The runtime used
`danger-full-access` with approval policy `never`, so mechanical read-only
isolation is not claimed. The six candidate hashes and clean working tree
were checked before and after the review.

## Independent verification

The reviewer reported the following concrete inspections and reconstructions:

- Established identity and scope with `git rev-parse HEAD`, `git diff --stat`,
  the scoped catalog diff and SHA-256 comparisons.
- Read all 16 CE work packages, all 48 CAP families, original-request
  traceability, research, evidence lock and inventory metadata/relevant rows.
- Read repository product/architecture/constraint contracts, relevant ADRs and
  the accepted agentic plan's ownership boundaries; used scoped AgentDoc
  queries for context.
- Inspected property policy, registry, lowering, generated declarations,
  frontend provenance, patterns, runtime composition and publication sources.
- Queried npm's primary metadata independently. StyleX packages resolve to
  `0.19.1`; Panda dev/compiler/preset-base/types to `2.2.0`; obsolete Panda
  core to `1.12.1`; MDN BCD to `8.1.6`. Publication times and integrity values
  match the research lock.
- Compared 47 recorded baseline/upstream file digests: no mismatches.
- Reconstructed 522 StyleX property keys, 863 Panda property keys, 372 Panda
  base utility keys and 652 BCD property keys. Panda property extraction
  excludes its separate at-rule descriptor namespace; occurrence flags match
  the committed inventory.
- Compared all 25 selected browser compatibility records with pinned BCD data:
  no mismatches.

These are source, metadata and inventory checks. The reviewer did not execute
the documentation gates; parent results below are recorded separately.

## Judgment

No blocking architectural, scope or sequencing defect was found.

- Exclusive agent audience, finite approved consumer domains, compiler
  authority, static CSS, finite runtime selection and one revision/publication
  owner remain explicit.
- Coverage assigns implementation and proof work across application shells,
  content, controls, SVG/media, writing systems, resources, modern CSS, shared
  definitions, extraction, SSR, hosts and packaging.
- Exact schemas, browser floors, transformation choices and expansion budgets
  are appropriately assigned to named early implementation lots. They are
  not misrepresented as existing APIs.
- Completion distinguishes syntax, emitted CSS, browser behavior, host operation
  and clean-package evidence. Workarounds and reduced denominators cannot
  supply the zero-unexpressible-declaration gate.
- Unbounded runtime values remain an explicit product limitation. AG delivery
  and LLM evaluation remain separately owned; inherited development CSP
  violations still block the affected CE qualification.

## Nonblocking reservations and disposition

| Reservation | Disposition |
| --- | --- |
| Preparation-status wording in the frozen plan could be mistaken for current review status. | The decision section explicitly identifies it as pre-review history and establishes current plan acceptance. Candidate bytes remain unchanged. |
| The research lock preserves version identities/integrity but not the full npm distribution-tag observations. | The reviewer independently confirmed current latest identities. The parent subsequently captured complete tag maps in a separate [review-time observation](../research/core-evolution-review-evidence.json), with its own timestamp. It does not retroactively reconstruct the earlier registry response. Future qualification refreshes should preserve the same evidence class. |

Cascade transformations, responsive compound expansion, real browser coverage
and recovery of the declaration classifier remain substantial implementation
uncertainties. The plan names them and prevents qualification claims until
their required evidence exists. They are not unresolved review blockers.

## Parent verification and limits

The parent separately verified all six frozen candidate hashes, baseline and
inspected upstream file freshness, 1,108 unique inventory rows and 102 admitted
Alpha 1 property names. `agentdoc check --strict --require-clean` passed on the
clean candidate before review. Documentation/catalog checks for recording this
decision do not validate any future product behavior.

No product tests, browser tests, builds, benchmarks, migrations or publication
were executed for this review. The decision applies to the pinned candidate;
changes to its substance require a fresh independent review.

For catalog context, use `agentdoc query system:pandamstyle/pandamstyle --json`
and the linked plan. This separate historical acceptance record is not a new
implemented requirement of Alpha 1.
