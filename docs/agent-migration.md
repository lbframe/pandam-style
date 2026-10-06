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
