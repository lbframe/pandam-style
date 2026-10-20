# Agent contract: plan and migrate to PandamStyle

## Objective

Move a bounded part of an existing project to PandamStyle while preserving
visible behavior and product semantics. Migration follows:

```text
read-only audit
→ migration plan
→ baseline verification
→ incremental batch
→ compile
→ repair
→ regression verification
→ benchmark comparison (when requested and ready)
```

Use [agent-audit](agent-audit.md), [agent-use](agent-use.md), and
[agent-repair](agent-repair.md). Installation is a separate workflow;
follow [agent-install](agent-install.md) only if required or requested.

## Prerequisites

The agent MUST have a read-only audit, an exact supported host/backend, access
to the existing design system and a reproducible baseline check. If any are
missing, complete the audit or report the missing input before source edits.

## Plan before edits

Before broad source changes, write a bounded plan naming:

- Qualified host/backend and the migration roots.
- Styling sources and representative constructs included in each batch.
- Exact token, theme, recipe and pattern mappings grounded in project evidence.
- Files excluded or requiring manual review.
- Baseline commands/results and regression checks.
- Rollback point and batch size.

Do not treat the audit's candidate list as approved mappings. If the user
requested a migration, proceed through a documented, bounded plan without
silently redesigning the interface. If scope or a mapping is ambiguous, ask
about that decision before making the affected change; continue independent,
well-defined batches.

## Allowed automatic transformations

Only make a mechanical transformation when both semantics are known and
verifiable, for example:

- Replace a literal with an existing semantic token whose resolved value and
  condition behavior match the old value.
- Convert a repeated, statically defined component variant to an existing
  recipe with the same finite selection domain.
- Replace repeated layout declarations with an existing supported pattern
  whose emitted behavior matches.
- Move a known semantic token mapping into a theme only when selector scope,
  cascade and default behavior are preserved.

Keep each batch small enough to compile and review independently. Preserve
classes, component props, stylesheet order, responsive behavior, interaction
states and markup semantics unless the user explicitly authorizes a change.

## Review-required changes

Stop for review before transforming when behavior depends on:

- Dynamic style construction, runtime values, computed classes or source
  generation.
- Cascade/specificity, global selectors, CSS Modules scoping, media/container
  query interactions, animation or pseudo-element details.
- A property/value outside the compiler's qualified finite policy.
- A visual value without an evidenced semantic token mapping.
- A recipe candidate with different defaults, overlapping variants or slot
  boundaries.
- A theme conversion that changes inheritance, DOM scope or fallback values.
- Third-party or generated component code.

Keep these constructs in their existing styling system until the user chooses a
supported mapping. Do not guess at a replacement or weaken compiler checks.

## Forbidden behavior

- A blind whole-repository rewrite or unbounded codemod.
- Arbitrary visual redesign, token invention, renamed public component API, or
  changed interaction/markup behavior as incidental migration work.
- Deleting the old styling dependency or source until migrated ownership and
  parity are verified.
- Ignoring uncovered or dynamic files, pretending they compiled, or using
  `passthroughUncovered` to claim complete migration.
- Editing generated CSS, declarations, manifest or design-system module.
- Claiming successful migration from lint/typecheck alone.

## Batch procedure

1. Save or record the baseline using existing project checks and, if available,
   browser snapshots for the selected routes. Do not add a new test harness
   unless requested.
2. Migrate one component/file family using the plan's evidenced vocabulary.
3. Run the supported host compilation. Read diagnostics and make only the
   minimal repairs described in [agent-repair](agent-repair.md).
4. Run relevant existing type, lint, unit and route/build checks. Compare the
   same visual states where the project has a repeatable baseline.
5. Review the diff for changed selectors, deleted CSS, markup/API changes, and
   generated or unrelated file edits. Keep unresolved files in the existing
   styling system.
6. Record the batch outcome and rollback point before the next batch.

## Browser targets (CE-01.1 behavior change)

Since CE-01.1 the compiler checks every emitted CSS feature against browser
target profiles; the behavior is specified in
[compiler API diagnostics](reference/compiler-api.md#diagnostics). Without a
`targets` configuration, target findings are warnings
(`context.enforcement: "advisory"`), the revision stays `ok` and
`build-report.json` records the default profile as `failing`: a build that was
valid before stays valid, with new warnings. With explicit `targets`, the same
findings are errors and nothing is published.

Explicit `targets` must stay at or above PandamStyle's minimum floor
(orchestrator decision O13: Chrome, Edge and Firefox 100, Safari and iOS
Safari 15.4, Android WebView 100, Electron and Chromium-based browsers at
Chromium 100). A query reaching older engines is refused with
`PMS_INVALID_TARGET_CONFIG` (`targets.below-minimum`); raise its floor, never
work around it.

During migration, record target warnings in the batch outcome as baseline
facts. Do not add, remove or weaken `targets`, and do not declare
`enhancements`, to change a migration result: target profiles are an
application decision and enhancements a design-system decision. When the user
asks to adopt targets, configure them explicitly and treat each new error as a
design question.

## CSS transformation stage (CE-01.2 behavior change)

Since CE-01.2 the compiler applies one proven rewrite to every emitted rule
before `styles.css`, its source map and the artifact digests are produced
([design note](architecture/ce-01.2-transformation-stage.md)): a
`user-select` declaration is emitted as
`-webkit-user-select:<value>;user-select:<value>`. The rewrite takes no target
input, so the CSS bytes do not depend on `targets`. A design system that uses
`userSelect` gets one more declaration per such rule; nothing else in the CSS,
the design module or its declarations changes.

- The target facts read the pair as `property:user-select/prefix-alias`. On
  Safari and iOS Safari it is `transformed-with-proof` (reason
  `transformation-proven`), so `userSelect: 'none'` no longer fails an
  enforced profile there. An enhancement policy on `property:user-select`
  still covers the pair.
- Every target resolution record gains `data.transformsDigest`, so resolution,
  facts and manifest `targets` digests change once, with no schema change.
- `pandamstyle:default@1` (`profiles/default.v1.json`) is regenerated by
  `tools/targets/measure-floor.mjs`. The floors, binding features and feature
  count are unchanged. The `property:user-select` exception is removed from
  Safari, iOS Safari and `nonBinding`, and the method sentence names
  `transformed-with-proof` as acceptable.
- `alternative-value` enhancement fallbacks are still refused; their emission
  moved to CE-07.3 (#62), and `context.deferredTo` is now `"CE-07.3"`.
- A host's delivered CSS asset is canonical only when it is byte-identical to
  `styles.css`. Vite delivers the canonical bytes. Next 16.3.8 webpack
  production minifies them (known non-canonical host mode, owned by #78).
  Rsbuild delivers a copy processed by its own CSS pipeline, which a host
  browserslist can change
  ([CE-01.2 note §10.3](architecture/ce-01.2-transformation-stage.md#103-host-findings-executed-locally-2026-10-20));
  its disposition is pending.

During migration, record the new declaration as an expected CSS byte change.
Do not add or remove `userSelect` to change a migration result.

## Rollback expectations

Before each batch, preserve the user's existing changes. Use the repository's
existing version-control state as the rollback boundary; do not reset or revert
unrelated work. On a failed batch, revert only that batch's edits, regenerate
outputs through the host, and confirm the prior build state. If source and
generated output disagree, preserve the source and use the host's compiler to
reconcile it. Never delete the only recoverable baseline.

## Completion conditions and report

Migration is complete only when all planned batches are accounted for, every
changed PandamStyle root compiles, required project regression checks pass,
unmigrated/unsupported files are listed, no generated output was hand-edited,
and visible behavior is preserved or user-authorized differences are named.

Report batches/files migrated, vocabulary mappings, exact checks/results,
unmigrated code and risks, remaining styling dependencies, rollback state, and
whether any benchmark was measured. A migration plan alone is not a completed
migration.
