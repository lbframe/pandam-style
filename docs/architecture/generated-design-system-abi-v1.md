# Generated design-system ABI v1

The compiler generates a project-specific module that binds application source
to one authenticated design-system identity. The runtime consumes compiled
references; it does not interpret arbitrary CSS or load compiler internals.

## Generated artifacts

The generated output includes:

- an application-facing ESM module with the configured design-system vocabulary;
- adjacent TypeScript declarations derived from the same definitions;
- a manifest for tooling and vocabulary inspection;
- artifact metadata that records ABI and content identities; and
- extracted CSS for the selected host integration.

Applications use the configured generated module path. Internal generated
leaves are compiler-owned output, not additional package entry points.

Since CE-02.1, the manifest has `manifestSchemaVersion: 2`, and since CE-02.2
`manifestSchemaVersion: 3`. Version 2 removed the `supportedProperties`
member. It is replaced by `properties`, the
projection of the compiler's effective property table:

```text
properties: { catalogVersion, digest, byProperty: { [authoring key]: entry } }
entry:      { css?, values?, tokens?, form?, origin? }
```

- `values` are the admitted finite literal values and `tokens` the admitted
  token categories. A property can have both: its domain is their union.
- Version 3 (CE-02.2): every domain is finite and a compiler never emits
  `range`. A version 2 (CE-02.1) manifest carries `range` on the four rows
  `opacity`, `flex`, `flexGrow` and `flexShrink`, a continuous legacy interval
  (`{ min, max?, legacy: true }`) with finite bounds, and its generated
  declarations require `range` on those rows. Version 3 entries carry
  `values` there instead, so a version 2 reader cannot read them: the version
  changed. `properties.catalogVersion` is 1 in CE-02.1 and 2 since CE-02.2.
- A reader validates exactly its own manifest schema version and refuses a
  newer one explicitly (`manifest schema version N is newer than this
  reader's version M`). The CE-02.1 reader refuses a version 3 artifact set;
  the CE-02.2 reader refuses a version 2 one.
- The manifest's own `schemaVersion` equals `manifestSchemaVersion`. CE-02.1
  generated declarations typed it as `1`; since CE-02.2 they type it from the
  manifest.
- Generated declarations type a property's values as the union of its finite
  literals and token references; there is no `number` branch.
- `form: 'rejected-composite'` marks a refused composite form.
- `origin` is `approved` or `narrowed` for a property the design system's
  `propertyDomains` overrides: the entry is then the whole admitted domain.
- Members are omitted when empty, `css` when it is the kebab-case key, and
  `origin` when it is `default`.

Each version is a compatibility break for manifest readers: a reader branches
on `manifestSchemaVersion`. An Alpha 1 compiler rejects a version 2 artifact
set, and a CE-02.1 compiler a version 3 one. The runtime identity type in
`@pandamstyle/core` admits `manifestSchemaVersion` 1, 2 and 3.
The runtime ABI is unchanged (`abiVersion` 1, `compilerContractVersion`
`pms-0.1`), so the manifest version, not the contract version, signals the
change.

## Runtime references

`create`, `token`, and design-system definitions are compile-time inputs. The
compiler validates their static identities and emits runtime values. `props`
composes finite style and theme references in order. Recipe, slot, compound
variant, and pattern output is bounded by the authored design-system
definitions.

Core owns the runtime reference shapes and composition behavior. Compiler owns
generation, identity checks, static recognition, CSS extraction, and generated
declarations. The application runtime does not depend on compiler code.

## Identity and consistency

Generated references from different design systems or incompatible ABI versions
cannot be composed as if they were interchangeable. Artifact metadata binds the
generated JavaScript, declarations, manifest, and CSS to the same validated
design-system revision. If the generated set is stale or inconsistent, the
compiler reports a structured diagnostic and requires regeneration.

Type declarations describe the authored public token paths, property and
condition constraints, recipe domains, themes, and supported layout APIs. They
improve editor feedback; compiler validation remains authoritative.
