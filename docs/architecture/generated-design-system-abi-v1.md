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

Since CE-02.1, the manifest has `manifestSchemaVersion: 2`. The
`supportedProperties` member is removed. It is replaced by `properties`, the
projection of the compiler's effective property table:

```text
properties: { catalogVersion, digest, byProperty: { [authoring key]: entry } }
entry:      { css?, values?, tokens?, range?, form?, origin? }
```

- `values` are the admitted finite literal values and `tokens` the admitted
  token categories. A property can have both: its domain is their union.
- `range` exists only on the four Alpha 1 rows `opacity`, `flex`, `flexGrow`
  and `flexShrink`. It is a continuous legacy interval
  (`{ min, max?, legacy: true }`), not a finite domain. Both bounds are finite
  numbers; an interval with no upper bound omits `max` (`flex` is
  `{ min: 0, legacy: true }`). An artifact set whose manifest has a `null` or
  non-finite bound is invalid.
- `form: 'rejected-composite'` marks a refused composite form.
- `origin` is `approved` or `narrowed` for a property the design system's
  `propertyDomains` overrides: the entry is then the whole admitted domain.
- Members are omitted when empty, `css` when it is the kebab-case key, and
  `origin` when it is `default`.

This is a compatibility break for manifest readers: a reader branches on
`manifestSchemaVersion`. An Alpha 1 compiler rejects a version 2 artifact set.
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
