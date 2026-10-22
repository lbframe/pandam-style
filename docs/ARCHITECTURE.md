# Architecture rationale

## Constraint before composition

The [product contract](PRODUCT.md) makes the design system an authority boundary.
Static recognition, role checks and finite domains allow an agent to compose
approved semantics while the compiler rejects invalid values and provenance.
[ADR 0003](architecture/adr/0003-authoring-api.md) records the authoring choice;
[ADR 0004](architecture/adr/0004-generated-import-model.md) explains why project
vocabulary arrives through an authenticated generated module. Compiler
[policy](../packages/compiler/src/design-system/policy/descriptors.js),
[registry](../packages/compiler/src/design-system/registry/build-system.js)
and [frontend](../packages/compiler/src/frontend/babel/compile-file.js)
implement distinct parts of that boundary.

## Static output and finite execution

[ADR 0005](architecture/adr/0005-runtime-compiler-boundary.md) separates Node-side
source evaluation and CSS extraction from runtime composition. The runtime
operates on already compiled identities and finite recipe data. That keeps
compiler dependencies out of application execution and prevents execution from
becoming an alternate styling language. The
[generated ABI](architecture/generated-design-system-abi-v1.md) describes the
shared contract; [core](../packages/core/src/index.js) owns runtime
reference validation and composition. [ADR 0009](architecture/adr/0009-generated-types-ownership.md)
keeps generated declarations under the same validated definition as the module.

## Revision authority and host lifecycle

Incremental work needs one answer to which source revision was accepted,
validated, staged and committed. [ADR 0006](architecture/adr/0006-single-project-authority.md)
places that authority in the Project Service, implemented by
[api/project.js](../packages/compiler/src/api/project.js) over the
[session](../packages/compiler/src/project/session/index.js) and
[publication transaction](../packages/compiler/src/artifacts/publication/transaction.js).
The [SDK types](../packages/compiler/types/index.d.ts) and
[host types](../packages/compiler/types/host.d.ts) describe exported boundaries.

[ADR 0010](architecture/adr/0010-host-adapter-isolation.md) leaves bundling,
loading, framework lifecycle and HMR with hosts. Hosts consume compiler snapshots
and publication tickets; they do not implement semantic rule maps. This avoids
divergent caches or host-specific publication truth. The accepted ADR discusses
the original Vite/Next boundary; the present Rsbuild integration follows the
same public compiler interface.

## Diagnostics and evidence

Structured diagnostics are a versioned agent protocol, as recorded in
[ADR 0008](architecture/adr/0008-diagnostics-protocol.md) and the
[protocol contract](architecture/diagnostics-protocol-v1.md). Exact revision,
coverage, candidates and publication milestones make local repair possible
without treating formatted prose as authority.

The catalog derives topology from manifests/imports and routes related source,
contracts and ADRs. [Catalog maintenance](agentdoc.md) explains its evidence
classes and limitations. Package topology details remain in the existing
[package architecture](architecture/package-architecture-v1.md).
Provenance and retained license obligations follow
[ADR 0007](architecture/adr/0007-donor-deletion-policy.md) and the existing
[derived-source record](architecture/phase-4-derived-source-provenance.md).
