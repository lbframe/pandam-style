# AgentDoc maintenance and evidence

## Installation and catalog scope

AgentDoc is installed on the machine, never vendored or added to product
dependencies. This migration uses `agentdoc 1.0.0` from
[`lbframe/agent-doc-system@9f9847848a5177e6a68b1f4d224eef2dcd41d32a`](https://github.com/lbframe/agent-doc-system/tree/9f9847848a5177e6a68b1f4d224eef2dcd41d32a),
with Node 22.22.0. The source pin matters: the package version alone does not
identify a GitHub source revision.

```sh
npm install -g github:lbframe/agent-doc-system#9f9847848a5177e6a68b1f4d224eef2dcd41d32a
agentdoc --version
agentdoc doctor
```

The installed package provides `skills/agent-doc-system/SKILL.md` and its
references. It describes catalog operations; the repository's consumer
PandamStyle skill describes downstream interface tasks. Neither is a runtime
dependency.

This was a MIGRATE of existing documentation, not a new project scaffold.
`agentdoc audit` supplied an inventory; source and contract review established
the mappings below. The catalog covers the five release packages, contributor
tooling, repository automation and Vite React pilot. Compiler test fixtures are test input, not
independent product components. The CLI walks the filesystem without consulting
gitignore; configured generated directories exclude local build, benchmark and
historical evidence output so those artifacts cannot masquerade as current
source authority. Canonical documentation and the accepted plan/review remain
included. No external runtime observations were collected.

## Source of truth and responsibility

| Claim | Canonical source | Review responsibility |
| --- | --- | --- |
| Mandatory audience, design objective and scope | [PRODUCT](PRODUCT.md), user-confirmed product intent | Any agent proposing a product surface change |
| Architectural decisions and rationale | [Existing ADRs](architecture/adr/0001-package-topology.md), [ARCHITECTURE](ARCHITECTURE.md) | Agent changing the affected boundary |
| Runtime reference ABI and composition | [ABI](architecture/generated-design-system-abi-v1.md), `packages/core/src/` | Core implementation boundary, ADR 0005 |
| Policy, generation, revision and publication | `packages/compiler/src/`, [public declarations](../packages/compiler/types/index.d.ts) | Compiler implementation boundary, ADRs 0003–0009 |
| Host transport and framework lifecycle | Adapter source and exported types | Corresponding host boundary, ADR 0010 |
| Qualification scope | [Installation contract](agent-install.md), [Alpha 1 release](release/alpha1.md) | Agent changing host support or making a qualification claim |
| Derived-source provenance | [ATTRIBUTIONS](../ATTRIBUTIONS.md), [source map](architecture/phase-4-derived-source-provenance.md), retained licenses and headers | Agent editing derived code, ADR 0007 |
| Future agentic optimization work | [Accepted plan](architecture/agentic-optimizations-plan.md) and [review](architecture/agentic-optimizations-review.md) | Future implementation task; plan acceptance is not shipping evidence |

These are responsibility boundaries, not invented organizational team owners.
`system:pandamstyle/pandamstyle` groups the product based on ADR 0001. The
catalog does not assign people or establish governance beyond the supplied
product intent and accepted ADRs. A changed architectural decision needs an
explicit decision with rationale and links to the affected ADR.

## Evidence and normative review

Authored documents state intent. Adapters derive bounded manifest/import/CI
facts. A `REVIEWED_OVERRIDE` is a source review with pinned file digests and a
review condition; it is not a passing test or a live observation. There is no
universal precedence among those classes. No authority election is configured:
a real contradictory fact must be investigated rather than silently elected.

`docs.normative` includes the product and repository constraints, existing ADRs,
public ABI/protocol/package/forwarding contracts, semantic oracle and source
provenance records, release procedures, reference pages and agent workflows.
Implementation obligations are component requirements corroborated by specific
reviewed source evidence where the bundled adapters cannot prove JavaScript
semantics. Agent procedures, authorization rules, rationale and explicit future
status use section-specific attestations only when they impose no current
implementation obligation. Such attestations do not waive a software guarantee.
Sections containing both instructions and software behavior map the behavior to
a requirement. The accepted optimization plan/review are routed as future work,
not treated as implemented requirements of Alpha 1.

Every covered section and reviewed implementation file is digest-bound. Source
evidence supports the stated, bounded interpretation; it does not demonstrate
all behaviors under all inputs. Audit prose checks are narrow (component
negations and port claims); strict success proves declared coverage and evidence
freshness, not arbitrary prose correctness or product optimization.

AgentDoc 1.0.0 has two relevant extractor limitations. Its Node adapter labels
every npm package `runtimes: [node]` from a manifest, including browser-safe
core and the browser pilot. Read that as package-toolchain evidence; the actual
runtime boundary is [ADR 0005](architecture/adr/0005-runtime-compiler-boundary.md)
and source imports. It is not evidence that core needs Node at execution.
Also, its API descriptor schema has no native JavaScript/TypeScript module
contract kind. Exported `.d.ts`/ESM boundaries remain canonical, linked from
their component context; no fake OpenAPI service or duplicate contract is
introduced. The graph derives build dependencies, not exhaustive call graphs.

The root workspace is not modeled as a deployed component. In this CLI revision,
a repository-root descriptor combined with the GitHub Actions marker tries to
hash a directory as file evidence. The real contributor tooling and automation
boundaries are therefore rooted at `tools/` and `.github/`. They do not own
application source outside those directories. Root guidance is linked context;
canonical repository pillars route through the product system entity.

## Query and change impact

Generate the ignored graph before the first query in a fresh checkout:

```sh
agentdoc validate
agentdoc compile
agentdoc check --strict
agentdoc query packages/compiler/src/api/project.js
agentdoc query component:pandamstyle/core --json
agentdoc query AGENTS.md --json
agentdoc query docs/PRODUCT.md --json
agentdoc impact packages/core/src/props.js packages/compiler/types/index.d.ts
agentdoc audit
```

The project-service query routes compiler contracts and related components.
The core query exposes ABI, composition and consumers. Impact identifies
affected boundaries and checks to consider; it does not execute those checks.
Use the JSON payload when compact output omits detail. Load only documents
needed for the requested change.

`AGENTS.md` and `README.md` route to `component:pandamstyle/tooling` through
explicit documentation links. `docs/PRODUCT.md` routes to
`system:pandamstyle/pandamstyle`; those entity refs are also usable fallbacks for
repository metadata that has no source-root owner. The current compact renderer
prints the global reviewed-override commitments without a budget, which can be
verbose with fully mapped normative requirements. Prefer JSON for selective
consumption: inspect the entity, constraints, relations, relevant subject's
review commitments and all reported conflicts. This is a CLI output limitation,
not a reason to omit obligations from the catalog.

The audit also reports two artifact-shape unknowns for `tools/` and `.github/`:
these authored script/configuration boundaries have no package/deployment marker
under the bundled adapters. It reports core, hosts and tooling as lacking direct
component verification rows because most existing checks are dispatched through
repository scripts/CI rather than package scripts. These are catalog discovery
limits; they neither establish absent verification nor supply a passing result.
Follow the existing CI and tooling guide for appropriate implementation checks.

## Maintenance and CI

1. Query and inspect impact before editing. Preserve unrelated changes.
2. Update the canonical document or source, relevant component context and any
   affected requirements. Review changed evidence and section semantics before
   updating their digests; `agentdoc audit` reports section digests and
   `agentdoc pin-evidence --json` reports pinned-file freshness.
3. Run `agentdoc validate`, `agentdoc compile`, then `agentdoc check --strict`.
   Never hand-edit `.agentdoc/graph.json`, suppress an unknown requirement or
   accept warnings merely to pass the gate. An actual gap remains explicit.
4. Review `agentdoc impact <changed-paths>` and report executed checks and gaps.

Graph policy: `.agentdoc/` is ignored and generated on demand. It is not a
committed authority file. Config, descriptors, normative coverage and evidence
pins are the reviewed inputs. The graph serializes Git provenance (including
working-tree dirty state), so local and clean-checkout graphs can differ while
describing the same source. Ignoring it avoids committing misleading provenance.

The [CI workflow](../.github/workflows/agentdoc.yml) installs the exact CLI pin,
validates, compiles and runs `check --strict --require-clean` in a clean checkout.
It compiles a second time and byte-compares both outputs to catch nondeterminism.
`--require-clean` is a clean-checkout gate; newly added or edited catalog inputs
make it fail locally until their intended Git handover. This documentation task
does not make a commit to satisfy it. No product tests/builds are part of this
documentation-only workflow. Product changes require checks appropriate to the
affected behavior and existing CI.

For CLI upgrades, change the source pin here and in CI together, read the new
schema/compiler contract, re-review evidence and regenerate. For API, protocol
or qualification changes, update their canonical references rather than writing
a second competing specification.
