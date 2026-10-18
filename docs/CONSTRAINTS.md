# Repository constraints

These rules apply while developing PandamStyle. Component details live in the
existing ADRs and references routed by `agentdoc query <path>`.

## Product audience

Design product surfaces exclusively for AI/LLM agents, as required by
[PRODUCT](PRODUCT.md#audience-and-purpose). This prevents new work from extending
the known human-oriented Alpha 1 deviations. Check proposed API/CLI/workflow
changes against that policy; AG-13 removal remains planned, not verified here.

## Semantic authority

Preserve compiler enforcement of finite vocabulary and the separation between
consumer composition and authorized design-system authoring. This prevents a
repair from granting new design authority. Review policy, role, provenance and
negative-fixture changes together; relevant sources are the
[design-system reference](reference/design-system.md) and
[ADR 0003](architecture/adr/0003-authoring-api.md).

## Generated artifacts and execution

Regenerate project modules and declarations from the validated definition, and
keep application execution limited to compiled references and finite selections.
Manual generated edits or runtime style injection would sever vocabulary and
ABI identity. Review generation, static extraction and core composition together
against [the ABI](architecture/generated-design-system-abi-v1.md) and
[ADR 0005](architecture/adr/0005-runtime-compiler-boundary.md).

## Publication and integrations

Keep one canonical Project Service with revision-bound publication and host
adapters using public compiler interfaces. Independent host semantics or output
commits would invalidate a revision's authority. Review lifecycle and adapter
changes against [ADR 0006](architecture/adr/0006-single-project-authority.md),
[ADR 0010](architecture/adr/0010-host-adapter-isolation.md) and public SDK types.

## Provenance and qualification

Retain required attribution and license notices; do not ship donor archives or
source trees as new packages. Follow [ADR 0007](architecture/adr/0007-donor-deletion-policy.md).
Distinguish source inspection, retained qualification results and a check actually
run now. Use the [installation contract](agent-install.md) for supported hosts
and [benchmark contract](agent-benchmark.md) for measurement claims. A compatible
manifest, fixture or historical report alone does not qualify a new host/mode.

## Documentation integrity

Keep obligations, current implementation and future plans distinguishable.
Route changed documentation and review normative coverage; regenerate the graph
with `agentdoc validate`, `agentdoc compile`, then `agentdoc check --strict`.
The pinned [CI gate](../.github/workflows/agentdoc.yml) also compares two generated
graphs for determinism. Follow [maintenance](agentdoc.md) when evidence changes.
