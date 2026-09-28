# PandamStyle — native compiler consolidation batch

Corrective batch on `feat/pandamstyle-native-compiler`. Four classes of
bypass, two secondary defects and two evidence-integrity defects are closed.
**P0 is not complete**; see [Limitations](#limitations) and the case table.

## Identity of the tested code

Five facts are kept apart on purpose, because a reader has to be able to tell
them apart: what was tested, what is delivered, and which relation the base came
from.

| | |
|---|---|
| **tested commit** | `83371af8e64e7b87553cee75f1e8aff90794e3c6` |
| **tested tree** | `5246e29d4c4d36618e1a7d6546c3839fe202f184` |
| **tested branch** | `fix/pandamstyle-consolidation-2026-09` |
| **working tree at start** | `clean` — measured by the runner **before** it created anything |
| **delivered head** | the one commit that follows the tested commit; it contains only `evidence/consolidation-2026-09/**` |
| **batch base ref** | `feat/pandamstyle-native-compiler` (`PMS_BATCH_BASE_REF`) |
| **batch base** | `e5ff62b4a925405dcf9fb415faa00df4b68aeaa9` = `git merge-base HEAD feat/pandamstyle-native-compiler` |
| StyleX fork merge base | `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2` (`git merge-base HEAD upstream/main`) |
| Panda donor | no Git metadata in this checkout; the pinned SHA lives in `docs/pandamstyle-specification-v0.1/specs/01-ARCHITECTURE.md` |
| Node | `v22.23.2` (the major pinned by `.nvmrc`) |
| yarn | `1.22.22` |
| npm | `10.9.8` |
| lockfile | `yarn.lock`, sha256 `6e6fb0735f5222f98f03cee369401cd91b239d2f5f661582c9dd02d495507179` |

The run directory was verified empty of pending changes immediately before the
run:

```
$ git status --porcelain
$ PMS_OUT_DIR="$PWD/evidence/consolidation-2026-09" ./verify-pms.sh
…
  working tree   : clean (as found, before this run wrote anything)
VERIFICATION OK
```

`env.json` and `summary.json` both record `workingTree: "clean"`, and
`env.json` also records `gitWorkTree: true`, so the claim is "a clean Git work
tree was measured", not "nothing could be observed".

> **Correction to the previous revision of this report.** The previous text read
> `workingTree | clean (recorded in env.json by the runner, before the evidence
> directory existed)`. That was false. `env.json` recorded `"dirty"`, and the
> runner was the reason: it created the run directory and truncated the tracked
> `run.log` *before* running `git status --porcelain`, then reported the state it
> had caused itself. Both defects are fixed here and proven by
> [the runner's own tests](#7-the-runner-no-longer-reports-its-own-writes);
> see criterion 10 and 11.

Commits on this branch, all on top of the base:

```
83371af8 [pandamstyle] Measure the tree before the run writes, and derive the batch base from a merge base
976c82f5 [pandamstyle] State the tested-commit vs delivered-head difference in the report
fd00bae3 [pandamstyle] Record the consolidation batch evidence
9dfb48b7 [pandamstyle] Refuse a bundler build that cannot publish, and collect evidence facts
131ea132 [pandamstyle] Consolidate the native compiler: provenance, bindings, coverage, publication
```

### Tested commit vs delivered branch head — they differ, and only in this report

The tested commit is `83371af8…`. The delivered branch head is one commit ahead
of it, and that commit contains **only this evidence directory**:

```
$ git diff --name-only 83371af8..HEAD -- packages/ tools/ verify-pms.sh .gitignore | wc -l
0
```

No compiler source, no test, no tool, no script and no fixture differs between
the tested commit and the delivered head. The full file list of that one commit
is `evidence/consolidation-2026-09/**`. A reader who needs the tested tree
byte-for-byte should check out `83371af8e64e7b87553cee75f1e8aff90794e3c6`
(tree `5246e29d4c4d36618e1a7d6546c3839fe202f184`); a reader who wants the code
plus its evidence should take the branch head.

Relative to the base, the tested commit is 66 files / 5202 insertions / 371
deletions outside this evidence directory. Two new compiler modules
(`pandamstyle/provenance.js`, `pandamstyle/generation.js`), five new test
files, 15 new negative fixture projects, two new files in the valid fixture.

## Commands and real exit codes

The full run is `./verify-pms.sh`, whose every step propagates its own failure.
There is no `|| true` and no output filtering.

| step | command | exit | result |
|---|---|---|---|
| install | `yarn install --frozen-lockfile --non-interactive` | 0 | passed |
| build | `rollup -c` for stylex (cjs+esm), babel-plugin, `@pandamstyle/compiler`; `babel src --out-dir lib` for style-value-parser and shared | 0 | passed |
| upstream-babel-plugin | `jest --ci --testPathIgnorePatterns '/__tests__/pandamstyle/'` | 0 | **1007 passed**, 64 skipped, 1071 total, 887 snapshots |
| upstream-stylex | `BABEL_ENV=test jest --ci` | 0 | **99 passed**, 74 snapshots |
| pandamstyle | `jest --ci '__tests__/pandamstyle/.*-test.js'` | 0 | **268 passed** (was 253; the 15 new ones are runner tests) |
| pilot | `tools/pilot/run-pilot.sh` | 0 | PILOT OK |
| artifacts | artifact collection + sha256 of every file | 0 | passed |

`summary.json` reports `complete: true`, `skippedSteps: []`,
`failedSteps: []`. The two upstream suites and the PandamStyle suite are
separate steps, so their counts are never conflated or double counted.

The regression table is produced by a second command, which spawns the real
build CLI once per fixture:

| command | exit |
|---|---|
| `node tools/pms/collect-regression-cases.js evidence/consolidation-2026-09/regression-cases.json` | 0 |

## Test counts, before and after

| suite | base `e5ff62b4` | tested `83371af8` |
|---|---|---|
| `@stylexjs/babel-plugin` upstream | 1007 passed / 64 skipped | **1007 passed / 64 skipped** (unchanged) |
| `@stylexjs/stylex` upstream | 99 passed | **99 passed** (unchanged) |
| PandamStyle | 111 passed | **268 passed** |

The PandamStyle figure moved from 253 to 268 because this batch adds 15 runner
tests. No compiler behaviour was touched to obtain it: the two fixes in this
revision are confined to `verify-pms.sh` and its test.

No upstream regression is hidden: both upstream counts are byte-identical to the
baseline, and the PandamStyle suite is excluded from the upstream run by
`--testPathIgnorePatterns` so the two cannot be double counted.

## Batch exit criteria

| # | criterion | verdict | where |
|---|---|---|---|
| 1 | `props()` admits no raw, unvalidated CSS | demonstrated | `provenance.js`, `provenance-props-test.js`, 2 fixtures |
| 2 | provenance bound to real lexical bindings, resisting shadowing/reassignment | demonstrated | `evaluate-usage.js`, `babel-plugin.js`, 6 fixtures |
| 3 | imports AND the relevant re-exports belong to the coverage graph | demonstrated | `module-graph.js`, `build.js`, `coverage-graph-test.js`, 7 fixtures |
| 4 | a bundler cannot finish with covered files unanalysed, without a diagnostic | demonstrated with one stated limit | `assertCoverageConsistency`, `coverage-graph-test.js` — see the limit below |
| 5 | a failed generation publishes no mix of old and new artifacts, CLI and Vite | demonstrated | `generation.js`, `transactional-generation-test.js`, `vite-build-test.js` |
| 6 | ordinary business data containing `role` / `trusted` is not rejected | demonstrated | `babel-plugin.js`, `valid/src/business-data.ts`, `neg-reserved-authority` |
| 7 | an unexecuted runner step appears as `skipped` / `not_run`, never `passed` | demonstrated | `verify-pms.sh`, `runner-status-test.js` |
| 8 | the upstream suites stay green | demonstrated | `summary.json` |
| 9 | every regression case goes through the real compile/build process | demonstrated | `regression-cases.json`, `vite-build-test.js` |
| 10 | the reported working tree is the state found **before** the run wrote anything | demonstrated | `verify-pms.sh`, `runner-status-test.js` — [below](#7-the-runner-no-longer-reports-its-own-writes) |
| 11 | the batch base is a Git relation, never `HEAD~N` | demonstrated | `verify-pms.sh`, `runner-status-test.js` — [below](#the-batch-base-is-a-relation-not-a-commit-count) |

### Limit on criterion 4

The cross-check is `assertCoverageConsistency`, and it is exercised on **both**
sides, but not symmetrically:

- Its **positive** side is proven by a real `vite build`: the pilot publishes a
  report with `coverageConsistency.missing: []` and
  `expectedCount == analysedCount`.
- Its **failure** side is proven by direct invocation of the exported function
  with a covered-but-never-transformed file, asserting `ok: false` and the
  reported `missing` set. It is **not** proven by a real `vite build`, because
  with a correct configuration the condition cannot arise: the plugin's
  `transformInclude` admits exactly the covered set, and every module the
  bundler loads is compiled. Manufacturing it would require a defect in the
  plugin itself. This is stated rather than papered over.

## What each fix actually is

### 1. The `props()` bypass

The fork's `props()` accepts uncompiled objects and turns them into inline
styles, so recognizing the *call* was never sufficient. Arguments now need
demonstrable provenance, checked **before** the rewrite, from a discriminated
representation rather than a boolean:

```
CompiledStyleRef   a namespace of a create() result
ThemeRef           themes.<name> of the generated module
RecipeSelectionRef a recipes.<name>(...) selector result
ConditionalComposition  a composition of those (array, &&, ||, ?:)
CreateContainer    a create() result as a whole - structural, not admitted
PropsResult        a local constant holding a props() result - not admitted
Unknown            everything else, including every object literal
```

Recursion is required: `props([styles.base, active && styles.active])` is
admitted, `props({ padding: '17px' })` is not, and the diagnostic says which and
why (`context.kind`, `context.reason`).

New codes: `PMS_UNVERIFIED_PROPS_SOURCE`, `PMS_UNVERIFIED_PROVENANCE`.

The provenance pass runs in `Program.exit` **before** the transform pass, while
`create()` is still a call. After the transform, `styles.page` is an object
literal and could no longer be told apart from a raw one. `transformPropsCall`
re-checks as defence in depth, so reordering the passes cannot reopen the hole.

### 2. Name tracking → binding tracking

`namedHelpers`, `namespaceBindings` and `derived` were `Map`/`Set` keyed by
identifier. In JavaScript an identifier is not an identity: a parameter can
shadow an import, and a `let` can be reassigned. All three are gone; every map is
keyed by a real Babel `Binding` and resolved through `path.scope.getBinding`.

Beyond shadowing, two further ways to lose a proven value are refused:

- **reassignment** — a binding with `constantViolations` is not recorded as
  holding a props() result at all;
- **mutation and escape** — a write to the value or to one of its members
  (`attrs.style = …`, `delete s.x`, `s++`), and a hand-off to an unrecognized
  function or to `Object.assign` / `defineProperty` / `setPrototypeOf`, all
  produce `PMS_UNVERIFIED_PROVENANCE`.

### 3. The coverage graph

The closure followed `ImportDeclaration` only, so this escaped:

```
covered-root/page.tsx -> bridge/index.ts (export * from "../outside/Unsafe")
                                 -> outside/Unsafe.tsx
```

It now follows `import`, `export … from`, `export *`, `export * as ns`, and
literal `import()` / `require()`, and each edge is recorded with the form that
carried it so the report is auditable. `relayEdges` in the build report names
every hop.

The P0 decision on dynamic requests, made explicit rather than left implicit:

| shape | behaviour |
|---|---|
| literal local `import('./x')` / `require('./x')` | a normal local edge: followed, and the target is analysed |
| non-static specifier | refused with `PMS_COVERAGE_GAP`; the module it would load is unknown and therefore unanalysed |
| literal package request | outside the local coverage contract, but still checked against the forbidden-import table, so `import('@stylexjs/stylex')` cannot reach the engine by the back door |

**Bug found while writing this:** `@babel/parser` 7.29 represents a dynamic
import as `CallExpression` with an `Import` callee, not `ImportExpression`. The
first implementation watched only `ImportExpression` and therefore missed every
dynamic import in the project. Both AST shapes are now handled, in both the
plugin and the module graph. A shape a reader does not recognise is a dynamic
edge nobody checked.

At the end of a build, `expectedCoveredFiles` and `actuallyTransformedFiles` are
compared and a difference is a failure. `transformInclude()` is no longer
accepted as evidence — the modules the bundler demonstrably loaded are recorded
from the `load` hook instead. Two files are exempt by rule, and the rule is
written down: the generated design-system module (it is the generator's own
output, so it is excluded from the covered set rather than silently unanalysed),
and a covered file the entry graph never reaches (the CLI analyses those
directly; the bundler cannot, and the report lists them under
`notInBundlerGraph`).

### 4. Transactional publication

`generation.js` is the single mechanism, used by both `buildProject` and the
Vite adapter. The protocol is the one in the brief: snapshot, prepare in
staging, compile, validate, generate, and only then publish — with `manifest.json`
last, so a reader that trusts the marker never sees an incomplete payload.

Two properties carry the guarantee, and both were false before:

1. **Nothing is written into the output directory until `commit()`.** The
   generated design-system module still has to be resolvable while pages are
   compiled, because that is how a design system is recognized. It used to be
   written to disk first, which is precisely how a failed build became
   observable as a mixed generation: the module on disk was N+1 while the
   manifest beside it was still N. It is now served from an in-memory module
   overlay (`module-graph.js`) and staged with everything else.
2. **A process that dies between snapshot and commit is recovered** by the next
   `beginGeneration`, from the backup directory, before a new snapshot is taken.

**Bug found while writing this, and the reason the publication point is where it
is.** The original plan was to commit in `closeBundle` and roll back from
`buildEnd`. Measured on Vite 7.3.2, that does not work:

| hook | on success | after an output-phase failure |
|---|---|---|
| `buildApp` | runs — but it is a **config-time** hook, not end-of-build | runs |
| `buildStart` | runs | runs |
| `buildEnd(error)` | runs, `error === undefined` | runs, **`error === undefined`** |
| `generateBundle` | runs | runs, then the other plugin throws |
| `writeBundle` | runs | **does not run** |
| `closeBundle` | runs | **runs** |

So `buildEnd` cannot report an output-phase failure, and `closeBundle` runs
either way. `writeBundle` is the only hook that distinguishes them, and it is
the publication point. `build.write: false` never reaches it, so that mode is
refused in `configResolved` with `PMS_UNSUPPORTED_FEATURE` — publishing nothing
is indistinguishable, to a reader, from having no stylesheet.

`closeBundle` discards the generation **without throwing**: the build has already
failed and the caller must see the real cause, not a publishing complaint from a
plugin that was working as designed.

The CLI's rollback is a restore from a snapshot, and the tests digest the whole
output tree before and after each failure rather than trusting a status code.
Five failure shapes are proven through a spawned CLI: policy, coverage,
provenance, parse error, and an internal failure injected into the publication
window. For the last one, a test seam exists (`pms-build
--inject-failure=after-compile`, plus `buildProject`'s `onStage`) because no real
input can make the compiler fail between "everything was generated" and
"something was published"; the test also changes the design system first, so a
partial publish would be visible as a changed `registryDigest` rather than
passing by accident.

### 5. Authority is a build concern, not a vocabulary ban

Any object property named `role`, `trusted` or `__pmsRole` used to be refused
anywhere in a covered file, which rejected `{ role: 'admin' }` in ordinary data.
A violation now requires an actual attempt, and there are exactly two shapes:

1. a **namespaced** reserved field (`__pmsRole`, `__pmsTrusted`, …), which no
   business key can collide with;
2. an authority-looking field **inside a call to a recognized PandamStyle
   export** — `props(x, { role: 'author' })` is a real attempt to configure the
   compiler from a page.

`valid/src/business-data.ts` is a file of `role` / `trusted` business data
(account records, permissions, a session payload) that must compile, and the
build report proves it was covered and analysed. `neg-reserved-authority`
proves the namespaced field is still refused in ordinary data, and
`neg-role-violation` still proves the field inside a recognized call is refused.

### 6. An unexecuted step is not a passed step

`PMS_SKIP_INSTALL=1` and `PMS_SKIP_PILOT=1` recorded exit code 0 through
`record_step`, producing `status: "passed"`. A run with no pilot at all was
indistinguishable, in `summary.json`, from a complete verification.

Now:

- statuses are `passed` / `failed` / `skipped`;
- a skipped step has **`exitCode: null`**, and no log is written — inventing
  either would misreport the run;
- each step also carries an explicit `acceptance` field mapped to the acceptance
  vocabulary: `passed` / `failed` / `not_run`;
- `summary.json` has `complete: boolean`, `skippedSteps` and `failedSteps`;
- the console prints `VERIFICATION INCOMPLETE` and names each skipped step, and
  never prints `VERIFICATION OK`.

`PMS_ONLY_STEPS` was added so the runner's own behaviour can be tested without
paying for an install, a build, four suites and a pilot. A filtered-out step is
`skipped` with a reason that distinguishes it from a `PMS_SKIP_*` skip.

### 7. The runner no longer reports its own writes

The runner used to create the run directory, truncate `run.log`, and only then
run `git status --porcelain`. Since `run.log` is a **tracked** file, truncating
it makes the checkout dirty, and `.gitignore` does not apply to tracked files —
so the runner manufactured the very state it was about to report. The recorded
run was honest about the value and wrong about the cause:

```json
"workingTree": "dirty"
```

The order is now the contract: resolve the repository, capture commit, tree,
branch, status and batch base, and only **then** create the run directory. The
out-of-repository guard was kept and is now applied twice — to the requested
path before any directory exists, and again to the canonical path.

Two things follow:

- a clean checkout records `clean` in `env.json` and `summary.json`;
- a checkout that is genuinely dirty before the run still records `dirty`.

Outside a Git work tree nothing was measured, so the runner now records
`"unknown (not a git work tree)"` and `"gitWorkTree": false` rather than
claiming `clean` about a state it never observed.

### The batch base is a relation, not a commit count

`pandamstyleBatchBase` came from `git rev-parse HEAD~4`. A commit count is not a
contract: the value is only right while the batch stays exactly that long. The
evidence committed in `fd00bae3` was generated at `9dfb48b7`, where `HEAD~4`
resolved to `38b2e459` — three commits before the real base. The report still
named the right base, so the number and the prose disagreed.

The base is now the merge base with the source branch:

```
$ git merge-base HEAD feat/pandamstyle-native-compiler
e5ff62b4a925405dcf9fb415faa00df4b68aeaa9
```

`PMS_BATCH_BASE_REF` selects the ref (default
`feat/pandamstyle-native-compiler`); the ref actually used is recorded next to
the SHA in both `env.json` and `summary.json`, so a reader can re-derive the
value. The ref is resolved against the local branch first, then
`refs/remotes/origin/<ref>`, and it is verified with
`git rev-parse --verify <ref>^{commit}` before use. If the ref does not exist, or
if the two tips share no common ancestor, the runner **exits 2 and writes no
evidence at all**. There is no fallback to an arbitrary parent: a run that
cannot prove its base leaves nothing behind rather than a plausible SHA.

## What the runner tests prove

`runner-status-test.js` runs the real script against a throwaway Git repository
built for the purpose, because both properties are about the state the runner
*finds* — a checkout in which the state is not controlled cannot test them. The
fixture commits every file, including its `evidence/run.log`, because an
untracked run directory is invisible to `git status` until real files land in it
and would hide the very defect under test.

The tests were checked against the code they replace, by re-introducing each
defect and confirming the suite fails:

| re-introduced defect | result |
|---|---|
| measure the tree after truncating `run.log` (the original order) | **3 tests fail** — the two `clean` assertions and the no-evidence assertion |
| derive the base with `rev-parse HEAD~4` | **4 tests fail** — the merge-base, fork-point, ancestor and stability assertions |

The stability test is the one that matters for the batch base: it runs the
runner, adds two more commits, runs it again, and requires the same base. A
`HEAD~N` implementation shifts under that, whichever `N` is chosen; a merge base
does not.

## New regression cases

All 26 rows below come from `regression-cases.json`, generated by spawning the
real build CLI once per fixture. The exit status and the diagnostic codes are
read back from that process. **0 rows are unexpected: every negative exited 1
with its expected code, none reported an internal error, and none left a
published `manifest.json`.**

| criterion | fixture | observed exit | observed code | what it proves |
|---|---|---|---|---|
| BC-1 | neg-props-raw-object | 1 | `PMS_UNVERIFIED_PROPS_SOURCE` | object literal: `padding`, `color`, multi-property |
| BC-1 | neg-props-raw-reference | 1 | `PMS_UNVERIFIED_PROPS_SOURCE` | an arbitrary local object, and a spread of it |
| BC-2 | neg-props-shadowing | 1 | `PMS_UNVERIFIED_JSX_SPREAD` | a parameter shadowing a module-level `props()` result |
| BC-2 | neg-props-reassigned | 1 | `PMS_UNVERIFIED_JSX_SPREAD` | a `props()` result that is then reassigned |
| BC-2 | neg-props-mutated | 1 | `PMS_UNVERIFIED_PROVENANCE` | a member written to after the value was proven |
| BC-2 | neg-props-escaped | 1 | `PMS_UNVERIFIED_PROVENANCE` | passed to an unknown call, and to `Object.assign` |
| BC-2 | neg-helper-shadowed | 1 | `PMS_UNVERIFIED_JSX_SPREAD`, `PMS_UNVERIFIED_PROVENANCE` | an alias of the helper, and a nested shadow of it, are not the helper |
| BC-3 | neg-relay-reexport-star | 1 | `PMS_FORBIDDEN_STYLE_CHANNEL` | module outside every root, via `export *` |
| BC-3 | neg-relay-reexport-named | 1 | `PMS_FORBIDDEN_STYLE_CHANNEL` | module outside every root, via a named re-export |
| BC-3 | neg-relay-barrel-chain | 1 | `PMS_FORBIDDEN_STYLE_CHANNEL` | two barrels deep, both outside every root |
| BC-3 | neg-stylesheet-via-relay | 1 | `PMS_FORBIDDEN_STYLE_CHANNEL` | unapproved stylesheet reached only through a relay |
| BC-3 | neg-dynamic-import | 1 | `PMS_COVERAGE_GAP` | a dynamic request that is not a static string |
| BC-3 | neg-dynamic-import-local | 1 | `PMS_FORBIDDEN_STYLE_CHANNEL` | a literal dynamic import is a normal edge, and is analysed |
| BC-3 | neg-unresolved-import | 1 | `PMS_COVERAGE_GAP` | a local import that resolves to nothing |
| BC-6 | neg-reserved-authority | 1 | `PMS_ROLE_VIOLATION` | a reserved `__pms*` field, even in ordinary data |
| BC-6 | neg-role-violation | 1 | `PMS_ROLE_VIOLATION`, `PMS_FORBIDDEN_IMPORT` | an authority field inside a recognized call; engine entry still refused |
| AC-011 | neg-forbidden-value | 1 | `PMS_FORBIDDEN_VALUE` | raw 17px, forged `var()`, forged ref, alias, computed key, spread |
| AC-012 | neg-unknown-token | 1 | `PMS_UNKNOWN_TOKEN` | token absent from the registry |
| AC-020 | neg-private-token | 1 | `PMS_TOKEN_NOT_PUBLIC` | a private primitive from a consumer page |
| AC-015 | neg-composite-form | 1 | `PMS_UNSUPPORTED_PROPERTY_FORM` | composite border shorthand |
| AC-051 | neg-forbidden-import | 1 | `PMS_FORBIDDEN_IMPORT` | engine entries and the atoms path |
| AC-054 | neg-style-channel | 1 | `PMS_FORBIDDEN_STYLE_CHANNEL` | inline `style` attribute and local stylesheet |
| AC-054 | neg-jsx-spread | 1 | `PMS_UNVERIFIED_JSX_SPREAD` | a spread not provably free of `style`/`className` |
| AC-039 | neg-invalid-variant | 1 | `PMS_INVALID_VARIANT_VALUE` | a literal invalid variant, refused at build |
| AC-023 | neg-non-static | 1 | `PMS_NON_STATIC_VALUE` | a local helper named `token` gains no trust |
| AC-017 | neg-forbidden-value-ts | 1 | `PMS_FORBIDDEN_VALUE` | the same error in TSX, no `tsc` involved |

Positive control: `valid` exits **0** with no diagnostic. It contains
`business-data.ts` (ordinary `role` / `trusted` data) and
`conditional-props.tsx` (every admitted `props()` form).

### Vite cases, through a real `vite build`

`vite-build-test.js` spawns Vite's own CLI 10 times and observes its real exit
status. Highlights:

- a valid app publishes `manifest.json`, `build-report.json`, `styles.css` and
  `design.pandamstyle.js`, all carrying the same `registryDigest`, and the
  stylesheet also lands in `dist/pandamstyle.css`;
- a relay escape (`src/pages/App.jsx` → `src/bridge/index.js` →
  `outside/Unsafe.jsx`, all outside `roots`) **fails the build** and publishes
  nothing;
- a late bundler failure (a fixture plugin throwing in `generateBundle`, after
  the PandamStyle CSS is rendered) exits non-zero and leaves every artifact
  **byte-identical** to the previous generation, with the design system changed
  first so a partial publish would be visible;
- no staging or backup directory is left behind;
- the same project then builds cleanly and does publish;
- `build.write: false` is refused with `PMS_UNSUPPORTED_FEATURE` and leaves no
  generation.

## Coverage report

From the published `build-report.json` of the `valid` fixture
(`artifacts/valid-fixture-generation/build-report.json`):

- 10 covered files, `analysedFileCount: 9` — the tenth is the generated
  design-system module, which is covered and exempt by rule, and is the only
  reason the two numbers differ;
- every covered file is `analysed: true`, none carries `failed`;
- `coveredFileCount == coverage.length` (10);
- `coverageConsistency.missing == []`;
- `relayEdges` has 1 entry and `externalRequests` 0, so the closure is recorded
  rather than merely asserted.

From the pilot's published report (`pilot/app/.pandamstyle/build-report.json`,
in the untracked pilot work tree): 1 covered file, 1 transformed, 25 modules the
bundler loaded, `missing: []`, `notInBundlerGraph: []`.

## Artifact digests

`artifact-digests.txt` holds 24 sha256 digests: the built
`@pandamstyle/compiler` lib (6 files — index cjs/esm, vite cjs/esm, runtime
cjs/esm) with the packed `package.json`; a full `valid`-fixture generation
(13 files — manifest, report, stylesheet, design-system module, and the compiled
JS of every covered source); and the pilot's `dist` (4 files).

## Pilot result

`PILOT OK`, exit 0. The pilot packs the built `@pandamstyle/compiler` and
`@stylexjs/stylex`, installs the **tarballs** into an application outside the
workspace, asserts the app resolves the installed package and not the monorepo
sources, asserts the shipped runtime is self-contained, and runs a real
`vite build`.

```
dist/index.html
dist/assets/index-CdrllhL-.js
dist/assets/index-Ch9eZn3x.css
dist/pandamstyle.css
```

The extracted stylesheet carries the `:root` variable group, the dark theme
overrides on the same variable identities, the `min-width: 768px` media query
from the named `wide` condition, and rule values expressed as
`var(--…)` — one CSS circuit, the fork engine.

## Limitations

**Still unmet, and not claimed.** P0 is not complete.

| item | state |
|---|---|
| generated TypeScript types | `not_run` — out of this batch's scope; no `types` export is declared, on purpose |
| SSR / hydration, TanStack Start | `not_run` — out of scope |
| browser-level proof of the cascade and of condition ordering | `not_run` — not attempted in any batch so far |
| slot recipes, compound variants, patterns | `not_run` — out of scope |
| full MCP, visual catalogue, codemods, perf campaign, npm publication | `not_run` — out of scope |

**Known limits of this batch.**

1. The cross-check's failure branch is proven by direct invocation of
   `assertCoverageConsistency`, not by a real `vite build` — see
   [Limit on criterion 4](#limit-on-criterion-4).
2. The scratch directories are named deterministically
   (`.out-dir.pms-staging`, `.out-dir.pms-backup`), so two concurrent builds
   targeting the same output directory would collide. Concurrent builds into one
   output directory were already unsupported; this makes the collision
   deterministic rather than accumulating per-process directories.
3. `build.write: false` is now refused by the Vite adapter. A consumer that needs
   it must run PandamStyle from the CLI instead. This is a deliberate, documented
   restriction, not an accident.
4. A dynamic import whose specifier is a template literal with **no** expression
   is resolvable and is treated as a literal request; one **with** an expression
   is refused. Both branches are covered.
5. The escape analysis treats "handed to an unrecognized function" as an escape.
   This is the safe direction, but it means an admitted value cannot be passed
   through an ordinary application helper without a diagnostic. That is a
   deliberate cost of not being able to prove absence of mutation.
6. `evidence/consolidation-2026-09/side-effect-artifacts-test/` is not produced
   by `./verify-pms.sh`. `artifacts-test.js` honours `PMS_OUT_DIR`, so running
   it with `PMS_OUT_DIR=…/side-effect-artifacts-test` regenerates those six
   files; that is how the copy in this directory was produced, at the tested
   commit. For the same reason the `pandamstyle` step also wrote
   `styles.css`, `manifest.json`, `diagnostics-17px.json`, `page.example.json`,
   `demo.html` and `build-report.json` at the top of the run directory — those
   are run output, not curated evidence, and they are byte-identical to the
   historical `evidence/demo/` set. `evidence/demo/` itself is untouched.

## Verdict

> Native compiler consolidation batch closed on the tested scope.

**P0 is not complete.** The four bypass classes and both secondary defects named
in the brief are closed on the tested scope, with every build guarantee proven
through a real compile or build process, and the upstream suites unchanged. The
two evidence-integrity defects of the runner are closed too, and the evidence in
this directory is attached to the exact commit that was tested. The P0 items
listed under Limitations were not executed and are not claimed.

No merge and no publication was performed.
