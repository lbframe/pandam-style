# Design-system forwarding semantic contract

This document records the forwarding-semantics contract for the Alpha 1 compiler.
It corrects forwarding semantics using the existing Babel pipeline. Publication,
CSS aggregation, cold compilation and agent result formats retain their existing
architecture.

The old walk grouped source markers without their named specifiers, returned the
first successful source, and reconstructed star exports from the original design
module instead of each relay's actual exports. Consumer classification then used
`relay.get(exported) ?? exported`. Reachability could grant helper authority to
missing exports, while aliases and namespace forwarding lost their identity.

The new syntax relations carry `kind`, `request`, `imported`, and `exported`.
Local re-exports resolve through Babel import bindings. The module resolver
composes those relations into per-export descriptors carrying original
`modulePath`, `imported`, `designSystem`, `chain`, `forwardingKind`, and
`sourceRequest`. Namespace descriptors contain the target's member descriptors.
Ordinary exports also carry identity so a star collision with an ordinary export
cannot confer PandamStyle authority. Ambiguous star entries remain ambiguous
through subsequent barrels. Explicit exports override stars; stars omit default.

Consumer maps remain keyed by Babel Binding. Only an actual forwarded descriptor
for a compiler API can enter that map. Namespace member access looks up each
member in its forwarded map before translating it to the original API; spelling
alone never grants authority.

The relay answer includes the generated module/marker, forwarded descriptors,
consulted dependencies, chain and structured issues. The session hashes all
forwarded descriptors and issues into its existing DSV digest. Byte versions
validate cached answers, including null answers. Consulted modules and downstream
resolution candidates participate in reverse invalidation, including removed
modules. Cached hits contribute their dependencies to every consuming view.
First-hop resolution belongs to each consumer's existing resolution state; shared
answers begin at the resolved hop. The candidate index now also retains positive
resolutions: a new earlier candidate or removal of a winner changes provenance.
This is a required resolution interface correction, not a new coverage or dirty
input architecture. Restored covered nodes with retired file state receive a new
view.

`session.inspectForwarding(file)` is a read-only oracle/debugging surface over
the cached answers used by the current revision. It does not invoke a fresh
resolver. The semantic oracle compares those answers, independent full-build
answers, structured diagnostic codes and compiled probe output against handwritten
expectations. Successful fresh/incremental probe bytes must also agree. Each of
the three semantic comparisons has its own verdict.

## Generated API audit

Source: `pandamstyle/codegen.js::generateDesignSystemModule`, not an assumed API.
The oracle uses that generator's real output; tests verify the complete export
inventory separately.

| Generated export | Classification | Compiler authority |
| --- | --- | --- |
| `create` | compiler-recognized API | declaration compilation; runtime trap |
| `token` | compiler-recognized API | static token references; runtime trap |
| `props` | compiler-recognized API and runtime composition API | validated composition/provenance |
| `recipes` | compiler-recognized API and finite runtime selectors | recipe selection/provenance |
| `themes` | compiler-recognized API and runtime theme data | theme selection/provenance |
| `manifest` | metadata export | none |
| `__PMS_DESIGN_SYSTEM__` | internal/generated marker, not user-facing | module identification only; no helper authority |

There is no separate runtime-only export. Some recognized APIs also have runtime
behavior. Imported runtime implementation helpers and generated recipe selector
constants are not exported. The generated module has no default API: direct
default imports and `export { default }` / `export { default as foo }` cannot gain
design-system recognition. Default forwarding is represented generically, but is
irrelevant to the generated API and missing consumer defaults are rejected.

## Module invariants

- **MODULE-01:** Module reachability and binding forwarding are distinct.
- **MODULE-02:** Every recognized binding has complete forwarding provenance.
- **MODULE-03:** Export names may change without changing underlying provenance.
- **MODULE-04:** Provenance may change without changing exported spelling.
- **MODULE-05:** Negative answers retain invalidation dependencies.
- **MODULE-06:** Fresh and incremental semantics use the same forwarding model.
- **MODULE-07:** Ambiguous forwarding fails closed.
- **MODULE-08:** Ordinary bindings participate in collision resolution but receive
  no design-system authority.
- **MODULE-09:** Namespace membership comes from the immediate relay's export
  map, never from all exports of a reachable design module.
- **MODULE-10:** Resolution candidate existence/order is a semantic input to both
  positive and negative answers.

## Scope and limits

Named, renamed, imported-local, star, namespace and multi-hop forwarding are
covered by the independent matrix, including partial/mixed sources, removals,
same-spelling remaps, break/repair, collisions and resolution changes.

Unknown external star sets, cycles that truncate star enumeration, parse errors
and depth exhaustion fail closed. This resolver does not implement the complete
ECMAScript cyclic ResolveExport algorithm; some legal cyclic forwarding therefore
remains unrecognized. Explicit noncyclic bindings can still resolve independently
of an incomplete star set. It does not forward arbitrary value aliases such as
`const css = create; export { css }`, CommonJS or dynamically computed exports.
Multiple generated systems in one answer fail closed because the current compiler
applies one project's policy. The generated marker remains the existing trust
boundary; this batch does not authenticate manually forged generated modules.

Missing/ambiguous named imports use `PMS_FORBIDDEN_IMPORT`, rule
`module.forwarding`, source location, structured forwarding issues and
`context.repairShape`. Existing static-value/coverage/provenance diagnostics apply
when an unrecognized namespace member or ordinary value is used in a style.
These limitations are not a claim of complete ECMAScript module support.
