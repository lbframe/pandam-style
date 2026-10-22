# Changelog

## Unreleased

- Compiler (AG-01.1, #8): a definition whose `systemId` is missing, not a
  string, empty or longer than 128 UTF-8 bytes now fails with the new
  `PMS_INVALID_DEFINITION` (rule `definition.system-id`) instead of
  `PMS_SESSION_INTERNAL` or an accepted unbounded identity.
- Compiler: a failed definition or `targets` build is retried on every later
  revision. Before, the next revision with no change validated and published
  under the last good design system.
- Compiler: a diagnostics result for a revision without a design system built
  from its own definition and configuration reports `designSystem.systemId`
  and `registryDigest` as `null`, never the project id. `DiagnosticsResult`
  types them `string | null`. `candidateTokens()` then fails with
  `PMS_INVALID_REVISION`, reason `design-system-unavailable`, instead of serving
  the previous vocabulary or throwing a plain `Error`.
- Compiler: every `PMS_INVALID_REVISION`, `PMS_STALE_REVISION` and
  `PMS_SESSION_CLOSED` raised by the Project Service carries a closed
  `context.reason`. Codes and rules are unchanged.
- The agent operation registry and machine protocol are added as private
  compiler source, with no package export (AG-02.5 exposes them).
- Compiler (AG-01.2, #9): `requestFullAudit()` after publication writes its
  standalone coverage document through directory descriptors and never follows
  a symbolic link: a temporary file, then a rename and a read-back of the
  installed bytes. A symlinked or replaced audit directory, a directory at the
  file name, a substitution during the write, or a failed write now fails with
  the new `PMS_UNSAFE_AUDIT_PATH` (closed `context.reason`) and leaves no file
  it created. Where `/proc/self/fd` anchoring is unavailable (non-Linux), the
  standalone document fails closed with reason `anchoring-unavailable`; the
  pre-publication staging branch, used by the CLI, is unchanged.
- The agent layer implements `audit.read`, `audit.compute` and
  `audit.materialize` (private compiler source, no package export).
- Compiler (AG-03.1, #12): design-system definitions can declare descriptive
  `meta` on the system, token leaves, themes, conditions (object form), recipes,
  slots, variant axes and values, compiler patterns and `propertyDomains`
  entries. It is validated against a closed schema, stored in
  `registry.semantics` outside every compiled record, and never changes the
  registry digest, CSS, types, manifest or module. Invalid metadata fails with
  the new `PMS_INVALID_METADATA` (rules `metadata.*`). Migration:
  - a `meta` key that was silently ignored at one of those positions is now
    validated, and invalid content fails the build;
  - a token group or category key named `meta` is now an error
    (`metadata.unsupported-position`) instead of a token path segment: rename
    the segment;
  - a definition that is not plain data (an accessor, a function, a class
    instance, a `Date`, `Map`, `Set` or `RegExp`, any other non-plain prototype,
    a symbol key other than a `token()` mark) is now rejected by
    `createProjectSession` and `applyChanges` with `PMS_INVALID_DEFINITION`,
    rule `definition.shape`. The compiler no longer runs author getters while
    copying a definition.

## 0.1.0-alpha.1

First public Alpha release of PandamStyle. The release provides five packages
for the core runtime, compiler, and Vite, Next.js, and Rsbuild integrations.
See the [Alpha 1 release notes](docs/release/alpha1.md) for the supported host
versions, installation contract, and release scope.
