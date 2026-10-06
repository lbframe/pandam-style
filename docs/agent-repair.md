# Agent contract: repair PandamStyle diagnostics

## Objective

Use compiler diagnostics as structured feedback and make the smallest repair
that restores the violated constraint:

```text
generate/change
→ compile
→ read diagnostic
→ identify violated constraint
→ minimal repair
→ compile again
```

Use the [narrow reference index](reference/README.md) for API questions. Do not
rewrite a component or design system when a local token, property, condition,
variant or import correction is enough.

## Read the diagnostic

Prefer the structured diagnostic over parsing its message alone. Inspect
`code`, `phase`, `rule`, `source` location, `context`, `expected`,
`candidates`, `candidatesTotal`, `candidatesTruncated`, `repair`, `coverage`,
`affectedRegion` and `revision`. Candidate lists can be truncated; query the
available project tooling if it supports candidate lookup, otherwise use the
design-system definition as authority. Diagnostic `autofix` is `null`; do not
claim compiler autofix.

## Common categories and local repair

| Category / examples | Constraint | Minimal repair |
| --- | --- | --- |
| Token: `PMS_UNKNOWN_TOKEN`, `PMS_INVALID_TOKEN_CATEGORY`, `PMS_TOKEN_NOT_PUBLIC`, `PMS_FORBIDDEN_VALUE` | Token path, category, visibility, or value policy is invalid. | Use an existing public token of the required category. If vocabulary is missing, request/plan a design-system change; do not substitute an arbitrary value. |
| Property: `PMS_UNSUPPORTED_PROPERTY`, `PMS_UNSUPPORTED_PROPERTY_FORM` | Property or shorthand is outside the finite compiler policy. | Use individually supported longhands or an existing recipe/pattern. Do not split a shorthand unless equivalent semantics are clear. |
| Condition: `PMS_UNKNOWN_CONDITION` | Responsive/state name is not declared. | Correct to an existing declared condition; only add a condition through an authorized design-system change. |
| Recipe: `PMS_INVALID_VARIANT_KEY`, `PMS_INVALID_VARIANT_VALUE`, `PMS_INVALID_RECIPE_SLOT`, `PMS_AMBIGUOUS_RECIPE_COMPOUND` | Unknown axis/value/slot or duplicate compound predicate. | Select an admitted value/slot or repair the recipe definition with the exact finite domain and predicate intended. Preserve declaration order where it affects precedence. |
| Pattern: `PMS_UNKNOWN_PATTERN`, `PMS_INVALID_PATTERN_PARAMETER` | Pattern name or bounded parameter is invalid. | Use one of `stack`, `inline`, `center`, `grid`, `box` and an admitted parameter value. Use spacing token refs for pattern gap/padding. |
| Static/provenance: `PMS_NON_STATIC_VALUE`, `PMS_UNVERIFIED_PROPS_SOURCE`, `PMS_UNVERIFIED_PROVENANCE`, `PMS_FORBIDDEN_IMPORT` | Compiler cannot prove a finite source value or trusted generated reference. | Replace only the dynamic expression with a static local constant or generated module import when semantics match. Do not cast, alias around, or conceal uncertainty. |
| Coverage/role: `PMS_COVERAGE_GAP`, `PMS_ROLE_VIOLATION`, `PMS_FORBIDDEN_STYLE_CHANNEL`, `PMS_UNVERIFIED_JSX_SPREAD` | Source is outside declared roots or uses an unverified style channel/spread. | Correct the bounded root/import/known `props()` spread if evidence supports it. Otherwise leave it out of PandamStyle and report it. |
| Runtime selection: `PMS_INVALID_VARIANT_KEY`, `PMS_INVALID_VARIANT_VALUE`, `PMS_ABI_MISMATCH` | A finite selector received an invalid selection or generated/runtime ABI mismatch. | Correct the selected axis/value or rebuild through the qualified host so source and generated artifacts agree. Do not patch generated runtime data. |

The code list is representative, not exhaustive. The compiler's diagnostic
`code` and source are authoritative for each failure.

## Forbidden repair behavior

- Do not delete or suppress a diagnostic without fixing its cause.
- Do not replace a missing semantic token with a guessed literal.
- Do not widen domains, add arbitrary conditions, change design, or rewrite
  unrelated files merely to make the build pass.
- Do not hand-edit `.pandamstyle` outputs, manifests, CSS, maps or declarations.
- Do not use non-qualified build flags or another host as a substitute for the
  failing supported host.

## Fallback and stop condition

If the diagnostic has no precise candidate or the repair changes design-system
semantics, inspect the exact source and definition. If intent remains ambiguous,
stop that change, report the constraint and ask for the missing design-system
decision. Preserve the last valid generated state and continue only independent
repairs.

## Completion report

Report original diagnostic codes/locations, minimal source/config files changed,
the resulting compile command and result, remaining diagnostics, and any
design-system decision that could not be inferred.
