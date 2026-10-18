# Developing PandamStyle

PandamStyle is exclusively for AI/LLM agents. Develop the compiler and its
constrained design-system language according to [the product contract](docs/PRODUCT.md).
The [PandamStyle skill](.agents/skills/pandamstyle/SKILL.md) serves agents using
PandamStyle in consumer projects; it is not this repository's contributor guide.

- Before a change, use `agentdoc query <path>` and `agentdoc impact <paths>`.
  If the graph is stale, follow [catalog maintenance](docs/agentdoc.md).
  Prefer `--json` to select relevant review commitments. Root guidance routes to
  `component:pandamstyle/tooling`; product pillars to `system:pandamstyle/pandamstyle`.
- Load [architecture](docs/ARCHITECTURE.md), [constraints](docs/CONSTRAINTS.md)
  and relevant existing ADRs only as the task requires. Preserve the compiler's
  authority, generated vocabulary, runtime boundary and revision-bound publication.
- Preserve unrelated changes. Use `apply_patch` for manual edits. Never edit
  generated design-system output or `.agentdoc/graph.json` manually.
- Keep present implementation, intended policy and planned work distinct.
  The agentic optimization plan and review are accepted plans, not shipped APIs.
- Run checks proportional to the change; choose from the relevant package,
  existing CI and `tools/README.md`. Do not invoke the full `verify-pms.sh`
  workflow without a reason. Documentation changes use the AgentDoc gate.
- Update affected contracts and catalog evidence with the change; report files,
  commands, results and remaining gaps. Never describe unrun checks as passing.
