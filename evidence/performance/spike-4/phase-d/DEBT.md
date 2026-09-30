# P0 semantic debt — named re-export forwarding semantics

**Status:** RESOLVED by the semantic forwarding batch. Deliberately not fixed in
the historical Phase D closure batch. The original defect description below is
preserved as history.
**Severity:** P0. **Introduced by:** nothing in Phase D. This predates Phase D
and is inherited. **Owner:** unnamed — this is a backlog item, not an in-flight
change in Phase D.

## Resolution

Fix commit: `1719a0494f3f593cfa052493ef7a28be4c9d448e`, titled
`fix(pandamstyle): preserve binding provenance through design-system relays`
on `fix/pandamstyle-forwarding-semantics-2026-09`.

Semantic contract: [forwarding semantics](../../../../docs/forwarding-semantics-2026-09.md),
MODULE-01–10. Named specifiers carry their source, composed forwarding preserves
original bindings and namespace members, and same-spelling fallback is removed.
Both positive and negative results retain all consulted dependencies, including
downstream resolution candidates. Consumer first-hop resolution now tracks
positive candidate changes as well as negative repair.

Regression tests: `forwarding-semantics-test.js` and the independent
`tools/pms/forwarding-semantic-oracle.js` matrix assert fresh and persistent
incremental behavior against handwritten expectations. The historical
`design-system-view-test.js` named-list debt test is converted, not removed: it
now requires a changed DSV and invalidated consumer. Removal/restoration,
same-spelling remap, mixed sources, namespaces, star ambiguity and deep negative
repair have separate fixtures.

## Historical Phase D record (unchanged below)

## The defect, in one paragraph

`walkToDesignSystem` does not populate `exportsOfRelay` for a relay's **named**
re-export specifiers. It populates it for `export * from`, whose forwarding set
is derived from the target's own exports. So for

```js
export { create, token, props } from './design';
```

`exportsOfRelay` comes out empty, where it should hold the three
`{exported, imported}` mappings.

## The mechanism, precisely

`collectReexports`
(`packages/@stylexjs/babel-plugin/pandamstyle/module-graph.js`) emits a named
re-export as a `kind: 'named'` entry **and** emits the request's source marker
as a separate `kind: 'source'` entry. `walkToDesignSystem` groups re-exports by
request and adds **only** the `source` entries to each group:

```js
for (const r of reexports) {
  if (r.kind !== 'source') continue;   // <- the named specifiers stop here
  ...
}
```

The group for that request therefore holds the source marker alone. The
remapping loop then tests `s.star === true` and `s.kind === 'named'` — and a
`source`-kind marker is neither, so `remapped` stays empty and
`exportsOfRelay: []` is returned.

## Consequence

A relay's **named** re-export list does not change any consumer's design-system
view, so changing that list invalidates nothing. A consumer behind

```js
export { create, token } from './design';
```

keeps its recognition when `token` is removed from the list, because the view
being invalidated is the relay's own forwarding map and that map never included
the named specifiers.

The consequence is bounded and worth stating, because it is why this is debt
rather than a broken build: **incremental behaviour remains equivalent to fresh
behaviour.** A full rebuild computes the same empty `exportsOfRelay` through the
same function. Phase D's oracle asserts exactly that, at every revision of the
`re_export_added`, `re_export_removed` and `relay_restored` traces, on c100 and
c1000 — 19/19 traces clean. There is no divergence between an incremental answer
and a fresh one.

**This is not a Phase D regression and must not be reported as one.** Phase D's
memo keys its views on the inputs a walk actually read, and this walk does not
read the named specifiers — so the memo faithfully caches a faithfully derived
answer. Fixing the walk changes the answer; it does not change the caching.

## Why it was not fixed here

Recognition semantics are not this phase's to revise. Phase D's scope was to
remove the O(total) closure and view rebuilds from the agent's hot path while
keeping fresh-rebuild semantics exactly. Changing what a view **means** would
have changed behaviour that Phase C's 413 tests and its fresh-rebuild oracle
encode, and doing it inside a performance phase would have made the performance
numbers a measurement of two changes at once.

## What fixing it requires

1. Carry the `named` and `namespace` specifiers into the per-request group in
   `walkToDesignSystem`, so `exportsOfRelay` holds the real forwarding map.
2. Re-derive the affected consumers — a named-list change becomes a view change,
   so the memo's invalidation has to reach the consumers the list names.
3. Extend the oracle with a trace that removes a name from a **named** re-export
   list and asserts the consumer's recognition follows. The existing
   `re_export_added` / `re_export_removed` traces use `export { ... } from` on
   the barrel and pass today; they pass _because_ of this limitation, so they
   are not evidence that the limitation is correct behaviour.
4. Extend `design-system-view-test.js`: the test named _"a NAMED re-export list
   is not part of the view, and that is pre-existing"_ asserts the current
   behaviour on purpose and **must be inverted** by the fix. Its comment already
   says the behaviour is inherited, so the fix is a deliberate inversion rather
   than a surprise.

## Where it is pinned today

- `packages/@stylexjs/babel-plugin/__tests__/pandamstyle/design-system-view-test.js`
  — the test named above, which asserts the limitation and says in its own
  comment that it predates Phase D.
- `benchmarks/pandamstyle/src/phase-d-oracle.js` — the `re_export_added`,
  `re_export_removed` and `relay_restored` traces, which prove incremental
  equals fresh rather than proving the limitation is correct.
