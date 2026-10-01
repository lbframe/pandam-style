# Generated design-system ABI v1

Status: Accepted target contract after canonical
[master-plan reconciliation](master-plan-reconciliation.md), implemented by
PandamStyle Phase 6. ABI version: `1`. No permanent donor namespace is admitted.
See [public API](public-api-v0.1.md) for syntax/selection semantics and
[package architecture](package-architecture-v1.md) for ownership.

## Parties and artifact set (ARCH-13, ARCH-17)

Compiler owns generation, identity authentication, static recognition and CSS
extraction. Core owns reading compiled StyleRefs, finite recipe selection and
composition. Application imports the generated facade, never compiler values.
The authoritative registry produces JS, declarations, manifest and extracted CSS
as one revision-bound artifact set; types are never an alternate registry.

```text
.pandamstyle/
  design.js                 # ESM facade, public vocabulary only
  design.d.ts               # Phase 6 adjacent declarations
  manifest.json             # tooling vocabulary/policy, independently versioned
  artifacts.json            # digests, ABI/protocol versions, source associations
  styles.css                # extracted canonical CSS artifact
  vocabulary/               # optional pure per-recipe/theme generated leaves
```

Only the facade path is application-facing. Leaves are compiler-owned generation
details, not supported deep-import entry points. This is a logical artifact
layout; host bundling/chunk filenames need not equal it. `.d.ts` and vocabulary
leaves are not delivered by Phase 0.

## Generated exports and imports

| Export          | Runtime meaning                                             | Compiler meaning                                                                      |
| --------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `create`        | Throwing `PMS_UNCOMPILED_CREATE` sentinel                   | Bind static declarations to authenticated design identity, replace with compiled refs |
| `token`         | Throwing `PMS_TOKEN_RUNTIME` sentinel                       | Resolve literal public token path and category before losing token provenance         |
| `props`         | Pure core composition function re-export                    | Proven argument/result identity required in closed source                             |
| `recipes`       | Readonly public recipe selector map                         | Validate literal selection; recognize bounded dynamic selection                       |
| `themes`        | Readonly public ThemeRef map                                | Validate same-system theme provenance                                                 |
| `manifest`      | Readonly optional tooling catalog, no compilation functions | Catalog digest matches registry; never authoritative merely because user copied it    |
| `__pandamstyle` | Readonly identity metadata, no mutable state                | Marker authenticated against service-owned generated artifact                         |

`slotRecipes` and `patterns` are reserved future exports, absent while their
capability is false. Conditions are named keys in static source and generated
declarations/manifest, not executable JS predicates. No `tokens` object tree,
raw CSS interpreter, registry, Babel, config loader, filesystem or donor import.

Generated runtime value imports may use only core root public exports: `props`,
`defineRecipeSelector`, `assertAbi`, `PmsSelectionError` as required. Factory
calls are side-effect-free and annotated pure when removable. No module
evaluation injects CSS, reads DOM/window, reads process state or depends on
React. Compiled consumer JS imports core only when composition/selection
survives constant folding; resolved create/token calls and their sentinel
imports are erased.

```ts
type DesignIdentity = Readonly<{ systemId: string; registryDigest: string }>;
type GeneratedIdentity = Readonly<{
  abiVersion: 1;
  compilerContractVersion: 'pms-0.1';
  designSystem: DesignIdentity;
  manifestSchemaVersion: 1;
  capabilities: Readonly<{
    slots: boolean;
    compoundVariants: boolean;
    patterns: boolean;
    rawDynamicStyles: false;
  }>;
}>;
```

Metadata has no SessionId/RevisionId/GenerationId in runtime payload: those
belong to artifact publication metadata, avoid invalidating every generated ref
for a page-only edit, and are validated by compiler/host before serving output.
System ID/digest and contract versions bind facade/types to the right
vocabulary. Capabilities assert delivered semantics only; no feature is inferred
from package presence or a reserved export name.

## Ref representations

The following fields are stable ABI, readonly and JSON-serializable (except
functions and nominal type brands). Extra private fields must not affect
composition. Compile-time binding provenance is independent of serialized shape.

```ts
type StyleEntry = readonly [conflictKey: string, className: string | null];
type StyleRef = Readonly<{
  kind: 'pandamstyle-style-ref';
  abiVersion: 1;
  systemId: string;
  entries: readonly StyleEntry[];
}>;

type ThemeRef = Readonly<{
  kind: 'pandamstyle-theme-ref';
  abiVersion: 1;
  systemId: string;
  themeId: string;
  entries: readonly StyleEntry[];
}>;

type RecipeSpec = Readonly<{
  abiVersion: 1;
  systemId: string;
  recipeId: string;
  axisOrder: readonly string[];
  variantMap: Readonly<Record<string, readonly string[]>>;
  defaultVariants: Readonly<Record<string, string | boolean>>;
  base: StyleRef;
  branches: Readonly<Record<string, Readonly<Record<string, StyleRef>>>>;
}>;
```

Entries represent ordered engine-generated conflict identities. Keys are opaque,
stable for identical semantic declarations/options, and contain sufficient
property/condition/direction identity to retain cascade behavior. Core compares
keys; it never parses CSS or regenerates keys. Null is a cancellation tombstone
that suppresses an earlier identical key without emitting a class. A className
entry is a compiler-produced single class identifier, not whitespace-separated
arbitrary source CSS. Flatten refs in order, keep last entry per key, discard
tombstones, deduplicate identical emitted classes, and order surviving classes
by their last occurrence. Phase 1 must pin composed class and browser semantics,
including shorthand/null cancellations, before translating old representation.
Source directories/absolute checkout paths must not participate in stable
hashes.

All refs in one props call must have the same systemId and ABI; mixing
independent systems fails with `PMS_UNVERIFIED_PROPS_SOURCE`. Theme conflict
keys carry the variable-group identity: later themes for the same group
override, styles remain independent. CSS artifact metadata binds generation to
registryDigest. Runtime refs omit registryDigest to avoid global consumer JS
churn on token-value edits; the compiler ensures all inputs are validated
against the current system view. Runtime shape checks cannot authenticate
user-created objects; static provenance does. Local readonly const aliases may
preserve provenance; mutations/unknown escapes cannot.

TokenRef is compiler-only typed IR, not an exposed CSS variable string
constructor:

```ts
type TokenRef<Category extends string, Path extends string> = Readonly<{
  kind: 'pandamstyle-token-ref';
  abiVersion: 1;
  systemId: string;
  path: Path;
  category: Category;
}>; // plus a private nominal brand in declarations/compiler IR
```

An application `token()` expression never returns this at runtime. Compiler
creates trusted refs after binding recognition, validates visibility/category,
then lowers to `var(...)` for CSS extraction. Source author token refs in config
have a separate role/trust identity and cannot be used to impersonate a page
token. A raw `var(--...)`, Symbol or copied object is not a token.
Primitive/alias classification, visibility and alias graph remain
compiler/manifest metadata; private token IDs/values are not required in browser
JS.

RecipeRef is a generated callable with readonly `recipeId`, `axisOrder`,
`variantMap`, `variantKeys`, `defaultVariants`, `splitVariantProps` and
`getVariantProps`; calling returns one StyleRef whose entries flatten base and
selected branches. Serialized RecipeSpec is private generated data admitted by
the core factory, not a page recipe-definition API. No `.spec`, `.raw`,
`.merge`, `__pmsRecipe`, `$$css` or donor-specific field is a public contract.
Literal calls may fold to a StyleRef. Dynamic calls use exactly the same finite
selector as static lowering. Runtime invalid selection raises
`PmsSelectionError` with code/rule/context/domain/repair fields, no fabricated
source revision.

Conditions have compiler IR `{ name, definition, kind }`, with kind `selector`
or `at-rule` in the admitted subset. Runtime has no condition evaluator.
Manifest stores names and canonical definitions for tooling; generated style
types use a literal union of names plus base. Engine condition keys and lowering
details are private; adding condition syntax requires semantics/diagnostic
fixtures, not a host rewrite.

## Tree shaking, module format and compatibility

Generated modules and core are ESM-first, ESM-only target value entry points.
Compiler/host packages are Node ESM target SDKs; CLI is a Node executable. No
parallel CJS public authoring ABI or `compiler/runtime`/`compiler/vite`
forwarding package persists. Loading a legacy definition file may be an internal
config loader concern during migration, not a permanent duplicate authoring
entry. Removing baseline require entry points is an explicit packaging migration
item, not a change made here.

All generated imports/factories must be side-effect-free. Unused recipes/themes
and manifest must be removable; namespace access that is genuinely dynamic may
retain the selected map. Whole-object retention must be measured honestly; a
pure annotation does not prove each property is removable. Phase 6
packaging/type checks must inspect bundles for unrelated vocabulary and
Node/donor imports. Core must not eagerly load all registry/policy metadata.

Core declares supported ABI versions and `assertAbi(1)` fails deterministically
when unsupported. Compiler checks ABI/compilerContractVersion and generated
digest before static recognition; mismatched artifacts yield `PMS_ABI_MISMATCH`
or `PMS_GENERATED_ARTIFACT_MISMATCH`, never fall back to raw CSS or silently use
a different system. Additive optional metadata may retain ABI 1; changed
mandatory fields, conflict/selection semantics or removed fields requires ABI 2
and explicit regeneration. Package semver compatibility is declared by
compiler/core ranges; different package versions are allowed only when
ABI/contract support agrees. Runtime factories enforce ABI during module
evaluation; props checks refs too. Format authentication failure must remain
visible even when metadata exports are tree-shaken out of the browser bundle.

## Type ownership

Core owns
StyleRef/ThemeRef/TokenRef/RecipeRef/CompositionInput/CompositionProps, ABI
metadata and runtime error types; compiler owns ProjectConfig, Definition,
ProjectSession, MutationTransaction, RevisionIdentity, PublicationReceipt,
DiagnosticsResult and host bridge types. Protocol types are compiler SDK types;
core owns only the small selection-error diagnostic subset it needs, avoiding a
runtime dependency on compiler. Cross-package schema consistency is tested by
contract fixtures, not a fifth protocol npm package.

Compiler generates adjacent `design.d.ts` from the same registry/digest as JS:
PublicTokenPath and category-specific unions, nominal category/path TokenRefs,
property/condition style constraints, recipe axes/defaults/domains, theme names,
and later slot names/pattern parameter domains. Literal path overloads map token
IDs to categories without a runtime object tree. Generated recipes use finite
unions including boolean axes, never unrestricted strings/records. No private
vocabulary appears in consumer declarations.

Declarations import runtime types from core and encode literal ABI `1` and
system identity metadata. `artifacts.json` records their digest alongside the
JavaScript, manifest and CSS digests. A mismatch requires regeneration; casts do
not bypass compiler validation. Phase 6 generates these declarations alongside
the application artifact set; they are not part of the Phase 0 compiler package
exports. Reserved features produce no declaration claim until capability
verification. Tests cover completion/category errors, tsc cost/size and JS/type
parity.
