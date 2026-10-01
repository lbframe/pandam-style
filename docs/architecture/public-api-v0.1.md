# PandamStyle public API v0.1

Status: Accepted Phase 0 contract, reconciled against the exact canonical
[master plan](../../master-plan.md). These are frozen target contracts, not
claims of delivered APIs. Implementation follows the canonical phase gates; this
closure performs no implementation. See the
[reconciliation](master-plan-reconciliation.md) and
[delivery record](phase-0-delivery.md) for acceptance and sequencing.

PandamStyle is a standalone CSS/design-system compiler and runtime designed for
AI-agent-driven application development. The page-generation LLM performs
composition, not micro-design. Donor ancestry is implementation history, not a
public dependency or compatibility promise.

## Application import decision (ARCH-03 through ARCH-07)

Choose Model A: application value imports come from one generated design-system
module. Core owns the small runtime; the generated facade binds vocabulary and
compiler intrinsics to one design-system identity. There is no unscoped
`pandamstyle` package and no second value-authoring entry in core.

```jsx
import {
  create,
  token,
  recipes,
  themes,
  props,
} from './.pandamstyle/design.js';

const styles = create({
  row: {
    display: 'flex',
    gap: token('spacing.md'),
    padding: { base: token('spacing.sm'), wide: token('spacing.lg') },
  },
});

export function Actions({ quiet }) {
  return (
    <div {...props(themes.light, styles.row)}>
      <button {...props(recipes.button({ tone: quiet ? 'quiet' : 'primary' }))}>
        Continue
      </button>
    </div>
  );
}
```

The filename is configurable; its authenticated generated identity is what
matters. Static named imports, aliases, namespace imports and unambiguous
re-exports must preserve the binding identity. Explicit exports override stars;
ambiguous star exports, shadowed names, mutation and unknown escapes fail
closed. No helper name or forged marker alone grants authority.
Compiler-generated module metadata is checked against the project-owned
generated artifact digest. Type-only imports from core are permitted;
application value imports of its ABI construction helpers are forbidden in the
closed profile.

| Criterion                              | Model A, selected                                  | Model B, rejected                                           | Model C: single unscoped facade, rejected      |
| -------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| Binding provenance/static analysis     | One authenticated vocabulary binding               | Requires a separate rule to bind generic create to a system | Still needs a per-project generated identity   |
| Tree shaking/runtime size              | Pure finite factories; compile-time helpers erased | Similar runtime minimum but split import surface            | Duplicate package surface adds no capability   |
| Agent discoverability/generated typing | One module and adjacent exact declarations         | Two modules with generic versus system-specific typing      | Generic package cannot contain project domains |
| Refactoring/barrels                    | Resolver preserves ultimate export identity        | Two origins complicate relay diagnostics                    | Extra indirection without new ownership        |
| Ergonomics/diagnostics                 | Vocabulary, roles and repairs refer to one system  | Easier accidental unbound intrinsic                         | Package name obscures project authority        |
| Design-system authority                | Explicit module selected by project configuration  | Generic runtime needs additional context                    | Cannot replace generated vocabulary            |

## Decision matrix

Exactly one product decision applies per concept: KEEP, REDESIGN or REMOVE, as
required by the master plan. KEEP retains the conceptual syntax; ABI changes are
migration work, not permission to change semantics. For slot recipes, compound
variants and patterns, the product decision is KEEP and the existing DEFER
implementation decision remains: architecture reserved here, capability false
until implemented and independently verified in Phase 12 after Phase 11 closes.
The table's DEFER entries describe implementation timing, not a fourth product
disposition.

| Concept           | Decision | Problem and agent/source use                                                                                                                                         | Static and runtime contract                                                                                                                              | Value policy and diagnostics                                                                                                                                                                                                                                  |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create()`        | KEEP     | Author-facing static namespace declarations; agents write it for vocabulary-constrained composition and import it from generated source                              | Compiler recognizes binding, folds input and extracts atoms; runtime sentinel throws; output is a namespace map of StyleRefs                             | Category properties require public TokenRefs; structural properties require admitted literals/ranges; unsupported/raw/dynamic values rejected with `PMS_FORBIDDEN_VALUE`, `PMS_NON_STATIC_VALUE`, `PMS_UNSUPPORTED_PROPERTY`, `PMS_UNSUPPORTED_PROPERTY_FORM` |
| `props()`         | KEEP     | Author-facing application composition; agents spread its result into JSX or read className for another framework                                                     | Compiler proves arguments; runtime composes finite refs in order; SSR-safe and pure                                                                      | No arbitrary class strings, CSS objects or inline tuples; `PMS_UNVERIFIED_PROPS_SOURCE`, `PMS_UNVERIFIED_PROVENANCE`, `PMS_UNVERIFIED_JSX_SPREAD`                                                                                                             |
| `token()`         | KEEP     | Author-facing typed literal path intrinsic imported from generated source; agents select catalog paths                                                               | Binding-aware static lookup and category check; erased into variable use; sentinel throws at runtime                                                     | Public path union only, no arbitrary strings/computed paths; `PMS_UNKNOWN_TOKEN`, `PMS_TOKEN_NOT_PUBLIC`, `PMS_INVALID_TOKEN_CATEGORY`                                                                                                                        |
| recipes           | KEEP     | System author defines; application imports generated selectors; agent selects designed component vocabulary                                                          | Static literals validated/foldable; finite dynamic selector remains in core; no runtime CSS interpreter                                                  | No consumer `.raw`, `.merge` or recipe redefinition; bounded axes and values; invalid key/value diagnostics                                                                                                                                                   |
| themes            | KEEP     | System author defines token projections; agents import/select generated ThemeRefs and compose on a scope                                                             | Static identity checked; runtime only ref composition; CSS variables extracted                                                                           | No page-authored token override; unknown references/category errors; advanced theme composition deferred                                                                                                                                                      |
| conditions        | KEEP     | System author names predicates; agents write those names in create/recipe declarations; names are generated typing/manifest vocabulary, not runtime predicates       | Compiler lowers named conditions without losing selector/at-rule meaning; zero runtime evaluation                                                        | No arbitrary page selectors/queries; `PMS_UNKNOWN_CONDITION`, unsupported-feature diagnostics                                                                                                                                                                 |
| variants          | KEEP     | System author declares recipe axes/domains/defaults; agents select generated finite values                                                                           | Literal validation; dynamic bounded selector; axes ordered by declaration                                                                                | No invented axes/values; `PMS_INVALID_VARIANT_KEY`, `PMS_INVALID_VARIANT_VALUE`                                                                                                                                                                               |
| slot recipes      | DEFER    | System source owns slot names and styles; future generated `slotRecipes.card(selection).root` returns StyleRef; agents only select/use slots                         | Compiler owns declaration/extraction; core will own finite selection; no React components                                                                | No arbitrary slots/styles; unsupported feature today, future unknown slot/domain diagnostic                                                                                                                                                                   |
| compound variants | DEFER    | System recipe declaration owns finite match clauses and styles; agents select ordinary variants                                                                      | Compiler precompiles each declared clause; core finite matching after axis branches                                                                      | No page clauses or Cartesian expansion; unsupported feature today, invalid match-domain diagnostics later                                                                                                                                                     |
| patterns/layout   | DEFER    | System source owns schema-constrained Stack/Grid/Cluster/Container/Section/Split vocabulary; future `patterns.stack({ gap: 'md' })` produces StyleRef; no components | Compiler expands typed schema parameters before category validation; generated finite selection only where bounded; no runtime arbitrary style expansion | Only declared token/domain parameters; unsupported today, future parameter/domain/category diagnostics                                                                                                                                                        |

## Style creation and token ergonomics

`create({ namespace: style })` remains canonical because namespace results are
atomic-extraction units, preserve source ownership for diagnostics/invalidation,
and compose without creating a per-page variant system. Its single static
argument may use proven immutable constants, literal spreads, static computed
keys and type wrappers supported by the frontend. It does not accept functions,
runtime style values or dynamic tokens. Styles are property-oriented condition
maps with `base` plus declared names; author-side `_hover` blocks remain
admitted where the design-system schema already admits them. The existing
`default` alias for `base` is preserved by the migration oracle, not silently
removed. Precedence and overlapping conditions must retain the independently
verified cascade semantics. Generated declarations express supported properties,
token categories and condition keys; the compiler remains authoritative when
casts bypass typing.

Keep `token('spacing.md')`, not `tokens.spacing.md`. Both can carry static
identity, but a literal-path union yields completion, a small sentinel rather
than a token object tree, and direct structured repairs referencing canonical
token IDs. Nested access is easier to spell without quotes but encourages
dynamic indexing and increases generated JS/object size. Neither model makes
renames automatic: registry-aware tooling must update source and vocabulary
together and diagnose old paths. Semantic tokens are aliases/projections with
category and visibility, not strings of resolved CSS. The manifest identifies
primitive versus alias tokens; public semantic names are preferred for agents,
private primitives remain inaccessible. Category typing can reject a colors ref
in spacing, while registry validation checks aliases, cycles and theme
projections. Token paths are stable logical IDs, not checkout paths.
Design-system source uses `token()` from `@pandamstyle/compiler/config`; that
author-role ref never proves a page binding.

## Composition contract

`props(...inputs)` accepts StyleRef, ThemeRef, nested readonly arrays of those,
and `null`, `undefined`, `false` conditional omissions. `true`, numbers,
strings, raw objects and functions are errors. Flatten arrays left-to-right
without sorting; compose recipe base then selected axes in declaration order. A
later compiled conflict key replaces an earlier entry with the same key,
including a null cancellation entry. Distinct condition/conflict keys coexist:
JS argument order does not replace CSS ordering or specificity rules.
Compiler-owned expansion must preserve shorthand/longhand conflicts and
directional semantics.

Return `{}` for empty input or `{ className: string }` for nonempty classes; no
inline style, stylesheet injection, DOM calls, framework imports or React hooks.
An optional `data-style-src` debug annotation is permitted when configured and
must never affect style semantics. The same server and browser inputs produce
the same result. Non-React consumers can read `className` and assign their
framework's class attribute; no React component ABI is required. A runtime
malformed ref raises a structured `PMS_UNVERIFIED_PROPS_SOURCE` selection error
rather than accepting a raw class. Runtime brands are a format check, not
compiler provenance.

## Recipe, theme and condition contracts (ARCH-08 through ARCH-12)

Only design-system authors declare `base`, `variants`, `defaultVariants` and
future `compoundVariants`/slots/pattern schemas. Branches use the same policy
and engine as consumer create; system source can use private tokens within its
role. Agents may select public recipes and themes, never redefine their
micro-design. Private recipes must be absent from consumer
facade/types/manifest; baseline visibility handling must be pinned as a gap if
extraction exposes them today.

Recipes compile one base and each declared branch, not the cross product.
`recipes.button()` equals an empty selection. Whole-selection `null` retains the
baseline empty-selection behavior; explicit `axis: null` is invalid. An absent
or undefined axis uses its default; if no default, it contributes no branch.
`false` is a valid boolean-axis value. Canonical strings and booleans are
admitted by generated domains; baseline scalar string-coercion behavior must be
captured in Phase 1 before tightening accepted input types. Unknown axes/values
throw a structured diagnostic at runtime and fail static validation for literal
calls. Base, then axes in declaration order, then future matching compounds in
declaration order determine composition. Defaults are validated against domains.
Existing `variantKeys`, `variantMap`, `axisOrder`, `defaultVariants`,
`splitVariantProps` and `getVariantProps` become readonly generated selector
metadata/helpers; `spec` and donor markers are private. Split returns
`[axisProps, restProps]`; get applies defaults with only defined selections
overriding them. Helpers do not authorize raw style channels or arbitrary
forwarding of rest props.

Future slot recipes return a readonly slot-name map, never a React element. All
slots use one selection/default resolution; missing branch styles contribute
nothing for that slot. Future compounds match conjunctions of declared axes; an
allowed-value array means membership; omitted axes mean unconstrained; matching
clauses all contribute in declaration order. No selector functions or arbitrary
predicates. Future pattern params have declared finite enum/token domains,
defaults and property-category mappings; unbounded numeric layouts need a
separate evidence-backed contract amendment. Do not add those exports while
capabilities remain false.

Themes project a common token-variable identity with a complete base and partial
overrides; same-group ThemeRefs compose with later selection winning on that
element. CSS scope determines inheritance and nested-theme effects. Advanced
theme axes, runtime theme generation and automatic persistence are deferred to
the compiler design-system/themes owner. Named conditions preserve full selector
meaning, including data attributes; `:is(:hover, [data-hover])` cannot be
reduced to `:hover`. Restricted frontend support must reject unsupported
condition forms.

## Compiler SDK boundary (ARCH-14, ARCH-15, ARCH-19)

The following is the target stable SDK shape. Method signatures are
Promise-based so filesystem/host scheduling is not part of semantics. An
implementation may do synchronous internal work. One operation queue per session
serializes transitions.

```ts
import { createProjectSession } from '@pandamstyle/compiler';
import { defineConfig, token } from '@pandamstyle/compiler/config';

const project = createProjectSession(config);
const initial = await project.initialize();
await project.validate(initial.revision);
const revision = await project.applyChanges({
  baseRevision: initial.revision,
  mode: 'verified-explicit',
  changed: ['src/Actions.tsx'],
  added: [],
  removed: [],
  renamed: [],
});
const result = await project.validate(revision.revision);
const publication = result.ok ? await project.compile(revision.revision) : null;
await project.close();
```

Stable exports: `createProjectSession`, `PmsError`, `Codes`, `formatDiagnostic`,
protocol kind/version constants and SDK types. `/config` exports `defineConfig`,
author `token`, definition/config types; defineConfig is an identity/type
helper, not an alternate loader. `/host` is ADVANCED PUBLIC for adapter artifact
access and bundler settlement. No graph, Babel objects, engine options, registry
mutation, raw per-file compiler or cache-clear functions are public. CLI belongs
in compiler, not a fifth package.

| Operation        | Exact boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| create/open      | `createProjectSession(config)` creates an uninitialized owner. Opening existing output uses the same call plus initialize; no independent open API                                                                                                                                                                                                                                                                                                                                                          |
| initialize       | Full discovery and publisher recovery, revision 1, no publication; second call rejects already-initialized state                                                                                                                                                                                                                                                                                                                                                                                            |
| applyChanges     | Requires expected baseRevision, complete transaction fields and mode; one accepted transaction produces one revision even if byte-identical; caller performs writes, service reads/hashes. A host may attach revision-bound `sourceOverlays` only to changed/added/renamed-to paths when the Vite pipeline's exact source bytes are not on disk; overlay bytes enter the same service source hashing, graph, provenance and compilation path and are cleared by the next filesystem mutation for that path. |
| validate         | Requires exact current revision; returns authoritative compact DiagnosticsResult, with ok independent of publication; no writes to committed output                                                                                                                                                                                                                                                                                                                                                         |
| compile          | Requires valid current revision, or performs its validation first; stages and transactionally publishes via canonical publisher; returns PublicationReceipt; invalid revision never publishes                                                                                                                                                                                                                                                                                                               |
| current          | Readonly current revision state plus last committed generation association, initially null                                                                                                                                                                                                                                                                                                                                                                                                                  |
| agentResult      | Current-revision result only; unavailable before validation; no hidden validation                                                                                                                                                                                                                                                                                                                                                                                                                           |
| candidateTokens  | Revision-bound pagination filtered by category/visibility; deterministic ID order, total and truncation                                                                                                                                                                                                                                                                                                                                                                                                     |
| requestFullAudit | Current validated valid revision only; before publication returns a queued request for inclusion, after publication materializes outside the immutable generation                                                                                                                                                                                                                                                                                                                                           |
| auditMutationSet | ADVANCED PUBLIC completeness check: rederive filesystem mutation set; discovered divergence forces full discovery and explicit result                                                                                                                                                                                                                                                                                                                                                                       |
| watch            | ADVANCED PUBLIC journal subscription/provider, feeds applyChanges; loss/overflow/restart triggers resync; no independent compilation                                                                                                                                                                                                                                                                                                                                                                        |
| close/recovery   | Idempotent close cancels uncommitted work, releases watchers/locks and caches; committed output survives. Reopen cold-initializes; publisher reconciliation is not persisted warm cache recovery                                                                                                                                                                                                                                                                                                            |

Config owns projectId, rootDir, definition path/object, covered roots, roles,
output directory, design module filename, closed policy, CSS layers/direction
and diagnostic bounds. Relative paths resolve against rootDir. Config/definition
changes are explicit revision inputs; semantic option changes invalidate
affected state or trigger a reported full fallback. Backend/cache strategy and
fault injection are internal/test-only, not public tuning knobs. Missing
mutation completeness cannot be presented as full independently observed
coverage. Explicit mode trusts the reported set only, never bytes;
full-discovery is default; watcher mode records its weaker evidence and forces
resync on uncertainty. Positive and negative resolution dependencies invalidate
on file creation/deletion/rename.

The `/host` SDK exposes immutable `readArtifact(revision, moduleId)`,
`readGeneratedArtifacts(revision)`, `preparePublication(revision)`,
`commitPrepared(ticket)` and `abortPrepared(ticket)` on the same service.
ArtifactResult contains canonical source identity and source digest, transformed
JS/map, CSS artifact references, dependencies and revision/design/ABI metadata.
`readGeneratedArtifacts` returns the canonical `design.js`, `design.d.ts`,
`manifest.json`, `styles.css` and `artifacts.json` members selected for that
valid revision. Neither operation returns mutable graph/cache nodes. Ticket
binds session, exact revision, staged artifact digest and terminal state; it is
single-use and revocation occurs on a newer revision, validation failure, host
failure or close. No GenerationId is allocated before commit. Host success may
gate commit; adapters never write the PandamStyle generation themselves.
`compile()` wraps this lifecycle for the CLI. CSS delivery is a public artifact,
not adapter-owned per-file rule aggregation.

## Identity and lifecycle terminology

| Term                        | Meaning and scope                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project identity            | Configured logical projectId plus canonical root/output authority; exclusive publisher per output; path spelling alone does not authorize another writer                                    |
| Session identity            | Unique sessionId for one service lifetime; restart creates a new one; no cross-session RevisionId comparison                                                                                |
| RevisionId                  | Monotonically increasing session-local accepted transaction sequence; compare full `{ projectId, sessionId, revisionId }`                                                                   |
| GenerationId                | Committed artifact identity in project/output publication lineage; preserved/recovered by publication metadata; reused for byte-identical generations, never allocated for validation alone |
| DesignSystem identity       | `{ systemId, registryDigest }`; same name with changed registry is a different view; definition/projection digests drive invalidation                                                       |
| ABI version                 | Generated/runtime shape and semantics contract integer, independent of package semver and registry digest                                                                                   |
| Diagnostics result revision | Exact full revision identity whose inputs were validated; never inferred from last published generation                                                                                     |
| Published generation        | Committed generation receipt containing original artifact revision/digest and current association; a no-op revision can reuse its bytes                                                     |

Stale expected baseRevision is rejected before acceptance; it produces no new
revision. A newer accepted revision supersedes older tickets/results for active
operations; retained immutable result bytes remain historical evidence, never
current truth. Invalid revision reports errors and preserves last publication.
Valid unpublished revision reports generationId null and committed false.
Compilation failure rolls back staged output. New artifact bytes commit a new
generation; byte-identical publication may associate the new revision with the
existing generation without rewriting its embedded origin revision. Receipt must
name both association revision and artifact revision/digest. Thus revision and
generation counters must never be equated.

An audit requested before commit is pending, not ready, until written in the
generation. An audit after commit is a separate revision-bound artifact; it must
not mutate the committed build report or claim that a previously false
materialized flag was true. Superseded/invalid audit requests reject explicitly.
Audit readiness, diagnostics readiness, artifact readiness and commit readiness
are separate milestones.

## Phase 1 oracle obligations

The semantic safety net must compare fresh and incremental results at the same
revision, plus independent expected diagnostics, policy/provenance answers,
conflict/cascade results, browser computed styles, SSR/hydration, finite
selection, coverage and publication failure/recovery. Pin no-change work and
bounded warm paths with structural counters, without inventing new performance
targets. Known defects get explicit expected-target fixtures and baseline-gap
labels, not weakened assertions. New ABI serialization is compared through
logical semantics as well as exact shape; both paths agreeing on a bug is
insufficient. Core and compiler can proceed in separate domains only after Phase
0 and Phase 1 close. Phase 2 owns runtime/core and generated runtime imports;
Phase 3 owns compiler movement and the public SDK. The generated ABI and
independent composition vectors form their shared boundary. Shared contract
files require one named integration owner in the future implementation brief;
neither lane may change the ABI independently. Phase 1 is the next authorized
phase, but is not started by this closure.

See [package architecture](package-architecture-v1.md),
[generated ABI](generated-design-system-abi-v1.md),
[diagnostics](diagnostics-protocol-v1.md), and
[module mapping](current-to-target-module-map.md) for normative companion
details.
