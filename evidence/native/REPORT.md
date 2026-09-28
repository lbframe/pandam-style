# PandamStyle — native compilation and pilot build (batch report)

**Date : 2026-09-28 · batch: native compilation + reproducible proof**

This report covers the batch that turned the prototype into a working native
chain: real JS/TS/TSX page files → PandamStyle compiler → static CSS and
consumable JavaScript → installed pilot build.

It does **not** declare P0 complete. §7 lists what stays unmet.

---

## 1. Identity of the tested code

| Field | Value |
|---|---|
| Tested commit | `717cdb3c0e72620281ebd64518539763e5bfe46a` |
| Tested tree | `fccf990ae62c439f4852e5a6b69c5ac66838aed9` |
| Working tree at run time | **clean** |
| Branch at run time | detached HEAD at the tested commit |
| Batch base (this branch's fork point) | `71fcc045b18eb215f0c3a815bb8c8d15a9f99489` |
| StyleX upstream merge base | `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2` |
| Panda donor | no Git metadata in this checkout; pinned SHA lives in `docs/pandamstyle-specification-v0.1/specs/01-ARCHITECTURE.md` |
| Delivered commit (this report) | the descendant commits that add `evidence/native/` and `PANDAMSTYLE.md` |

`git diff --name-only 717cdb3c..HEAD` touches only `PANDAMSTYLE.md`,
`evidence/native/**` and `.gitignore`. **No compiler, test, fixture, pilot or
verification code changed after the tested commit**, so the tested code is
byte-identical to the delivered code. No file refers to the commit that
contains it.

The StyleX merge base was **measured** with `git merge-base HEAD upstream/main`,
not copied from a document. It matches the base the specification names, which
is the traceability result hypothesis H-01 was missing.

Two historical evidence defects are repaired:

- `forkCommit: null` came from `path.resolve(__dirname, '../../../../../..')`,
  a fixed number of parent directories that did not reach the Git root. Git
  identity is now resolved with `git rev-parse --show-toplevel` and recorded by
  `verify-pms.sh`. No file ever refers to the commit that contains it.
- `artifacts-test.js` used to catch an exception and then build
  `{ exitCode: 1, diagnostics }` itself. The new negative suites spawn a real
  process and read its true status, stdout and stderr.

## 2. Environment and toolchain

| Field | Value |
|---|---|
| Node | `v22.23.2` (the major pinned by `.nvmrc`) |
| yarn | `1.22.22` (the repository `packageManager`) |
| npm | `10.9.8` |
| Lockfile | `yarn.lock`, sha256 `6e6fb0735f5222f98f03cee369401cd91b239d2f5f661582c9dd02d495507179` |
| Platform | macOS Darwin 24.6.0 (arm64) |
| Run directory | `evidence/native/` |

**The historical workaround is gone.** `evidence/l0/BASELINE.md` recorded that
the install failed on Node 26 (`waku` requires `^24|^22.12|^20.19`) and had to be
relaunched with `--ignore-engines`, with `postinstall` failing on several
packages. On the Node major the repository itself pins, `yarn install
--frozen-lockfile --non-interactive` completes with **exit 0**, postinstall
included. No `--ignore-engines` appears anywhere in the new entry point.

## 3. Commands and real exit codes

`./verify-pms.sh` from a clean checkout, on Node 22.23.2. Every step
propagates its failure; there is no `|| true` and no output filtering.

| Step | Command | Exit | Result |
|---|---|---|---|
| `install` | `yarn install --frozen-lockfile --non-interactive` | 0 | passed |
| `build` | babel/rollup builds of the delivered packages | 0 | passed |
| `upstream-babel-plugin` | `jest --ci --testPathIgnorePatterns '/__tests__/pandamstyle/'` | 0 | **1007 passed**, 64 skipped, 42/43 suites, 887 snapshots |
| `upstream-stylex` | `BABEL_ENV=test jest --ci` | 0 | **99 passed**, 4/4 suites |
| `pandamstyle` | `jest --ci '__tests__/pandamstyle/.*-test.js'` | 0 | **111 passed**, 6/6 suites |
| `pilot` | `tools/pilot/run-pilot.sh` | 0 | passed |
| `artifacts` | digest + collect | 0 | passed |

`verify-pms.sh` exit status: **0**.

### Not double counted

The upstream suites and the PandamStyle suites are separate steps with separate
logs. The `pandamstyle` step excludes the upstream tree and the upstream step
excludes `__tests__/pandamstyle/`, so a suite is never counted twice. The
887 snapshots are identical to the historical baseline, which is the strongest
available signal that no upstream behaviour changed.

### Exclusions and skips, kept visible

- 64 tests and 1 suite are skipped upstream. That is pre-existing and identical
  to the baseline; they were not re-enabled.
- The Panda donor's own suite is **not run**. It is a vendored source copy with
  no Git metadata in this checkout, and the install is yarn-1 while Panda is a
  pnpm workspace. It remains a code-reading reference, exactly as the baseline
  stated.

## 4. What was implemented

### 4.1 Native entry point (JS/TS/TSX)

Recognition and transformation happen in visitors that run **inside the fork's
own Babel pipeline**, reusing its evaluator (`src/utils/evaluate-path`), its
engine (`styleXCreateSet`, `styleXDefineVars`, `styleXCreateTheme`) and its rule
format. There is one CSS circuit: the fork's own `processStylexRules`.

Resolution is by **binding and module**, never by textual name:

| Usage | How it resolves |
|---|---|
| `import { create, token } from './design.pandamstyle'` | generated module carries the marker |
| `import { create as pmsCreate } …` | tracked through `specifier.local` |
| import from a local **barrel** | the relay is followed to the design system |
| `import * as pms` | namespace access resolved to an export path |
| a local `function token()` | **no** trust: refused with `PMS_NON_STATIC_VALUE` |
| `{ [Symbol.for('pandamstyle.tokenRef')]: 'spacing.md' }` | **no** proof: refused as a raw value |
| `'var(--x1a2b3c)'` | refused; only a resolved reference confers token status |

Token references carry a **module-private** compiler mark. A page cannot
manufacture one, so an object imitating the internal shape cannot launder a
forbidden value. `as any`, `satisfies`, `!`, local constants, local aliases,
`SPACING.md` member access, spreads and statically computed keys are all folded
**before** the policy runs, which is why none of them grants a privilege.

### 4.2 Provenance

Every policy diagnostic carries the module, the role, the page location
(`file`, `line`, `column`), the system identity, the token identity, its
category, its visibility and the condition path. For `padding: '17px'` the
diagnostic reports:

- `context.property` = `padding`
- `context.value` = `"17px"`
- `location` = the exact line/column in the page file, `role: "page"`
- `rule` = `category-strict`
- `context.candidates` = the admissible **public** spacing tokens (no private
  primitive is offered)
- `autofix` = `null` — proximity to `spacing.md` is not a proven visual
  equivalence, so no rewrite is authorized

### 4.3 Emitted output

CSS is static and comes from the fork engine: a `:root` variable group, theme
classes that override **the same** variable identities, atomic classes,
`@media (min-width: 768px)` from a named condition, and the Panda-derived
element-state rule `:is(:hover, [data-hover])`.

The shipped consumer runtime (`lib/runtime.mjs`, 4 955 bytes) has **no import
at all** and contains none of: Babel, the design-system loader, the registry,
the CSS validator, or a CSS-object interpreter. It only holds finite data.

A literal recipe selection is validated at build time and emitted as
precompiled branch references. A props-dependent selection keeps the bounded
runtime guard. Branch count is `base + Σ(axis values)` = `1 + 2 + 2`, never a
cartesian product.

### 4.4 Closed profile, no silent exemptions

Every entry below is either controlled or refused. None is skipped quietly.

| Channel | Outcome |
|---|---|
| `@stylexjs/stylex`, private subpaths, `@stylexjs/atoms`, `@pandacss/*` | `PMS_FORBIDDEN_IMPORT` |
| `defineVars` and other engine/author exports, `trusted:` / `role:` | `PMS_ROLE_VIOLATION` |
| `style={…}` attribute, `import './x.css'` | `PMS_FORBIDDEN_STYLE_CHANNEL` |
| JSX spread not provably a `props(…)` result | `PMS_UNVERIFIED_JSX_SPREAD` |
| Unresolvable value, local helper named `token` | `PMS_NON_STATIC_VALUE` |
| Unresolved local import from a covered root | `PMS_COVERAGE_GAP` |

One real bug was found and fixed while building this: an object value with no
statically named key was treated as an *empty condition map*, which silently
dropped the declaration. That is exactly the silent exemption the profile
forbids, and it is why a forged reference now fails loudly.

## 5. Pilot build (Vite + React)

`tools/pilot/run-pilot.sh`, exit 0.

1. `npm pack` produces `pandamstyle-compiler-0.1.0.tgz` and
   `stylexjs-stylex-0.19.1.tgz`.
2. The tarball contents are listed and **every declared export target is checked
   to exist inside the tarball**.
3. The app is copied to a work directory **outside the workspace**.
4. Dependencies are pinned to the local tarballs and installed.
5. The app is asserted to resolve the *installed* package, not monorepo
   sources, and the shipped runtime is asserted self-contained.
6. A real `vite build` runs.

Produced: `dist/index.html` (with the stylesheet linked before the first
render), `dist/pandamstyle.css` (sha256 `fe50d015…`), the application JS
bundle, and the application CSS asset with the PandamStyle rules appended. The
JS bundle contains no compiler, registry or `processStylexRules`.

The pilot was moved out of `examples/*` and into `pilot/vite-react`, and the
compiler was registered under `packages/@pandamstyle/*`. Both were real
installation blockers: as an `examples/*` workspace member the root install
tried to resolve `@pandamstyle/compiler` from the npm registry, and
`packages/@pandamstyle/compiler` is not matched by the `packages/*` glob.

## 6. Invalidation

Removing `spacing.lg` from the design system **without touching any page**:

- the second build exits **1** with `PMS_UNKNOWN_TOKEN` pointing at
  `valid/src/page.js` with `role: "page"`;
- `manifest.json` and the generated design system module still carry the
  **previous** digest: a failing generation publishes nothing and rolls the
  design system module back;
- `styles.css` is byte-identical to the previous valid generation;
- restoring the token reproduces the original `registryDigest`
  (`1d58021beceabbd4`).

Changing a token's **value** (16px → 18px) keeps the build valid, changes the
digest, and preserves the logical variable identity: the CSS still emits
`padding:var(--…)`, never a raw value.

## 7. Case status

`passed` = executed with evidence at the tested commit.
`not_run` = not executed in this batch. `blocked` = cannot be executed yet.

### Executed and passing

| Group | Cases | Status |
|---|---|---|
| Install + suites from a clean checkout | AC-001, AC-002 | passed |
| Valid JS/TS/TSX page compiles; CSS non-empty; runtime imports valid | policies, conditions, recipes | passed |
| `padding:'17px'` without tsc → real non-zero process + `PMS_FORBIDDEN_VALUE` | AC-010–023, AC-047–049 (executed sub-cases) | passed |
| Forbidden value via constant, alias, computed key, spread, `as any` | AC-010–023 | passed (6/6 routes) |
| Unknown / private / wrong-category token, forged `token` helper | registry & provenance | passed |
| Renamed import, barrel, recipe-only page | AC-050–055 (executed sub-cases) | passed |
| Invalid static variant, then props-dependent variant | AC-036–040 | passed |
| Base + hover, then base variant | AC-041 | passed (CSS + `styleq` composition) |
| Engine entry or forbidden style channel in a covered root → build fails | AC-050–055 | passed |
| Token removal, page unchanged, second build | AC-056–060 (executed sub-cases) | passed |
| Install outside the workspace | AC-064 (executed sub-cases) | passed |

### Not run in this batch — stated, not hidden

These are **not** green. A sub-case that passes does not turn its whole range
green.

| Cases | Status | Why |
|---|---|---|
| AC-003–009 (spec/archive consistency) | not_run | no test written this batch |
| AC-024–035 (condition matrix, cascade ordering in a browser) | not_run | no browser run in this batch |
| AC-042–045 (logical/physical property conflicts) | not_run | needs the second fixture set |
| AC-049 (diagnostic order under different traversal orders) | not_run | determinism not yet cross-checked |
| AC-057 (value change, identity preserved) | passed (partial) | the identity and digest assertions run; the full case is not claimed |
| AC-058–063 (keyword removal, parallel projects, forced mid-generation failure) | not_run | not implemented this batch |
| AC-061, AC-062, AC-065, AC-066 (type generation, runtime size, licensing inventory, large-registry ergonomics) | not_run | types are a known gap; licensing inventory still open (H-06) |

### Known gaps, explicitly not delivered

- **Generated types.** `@pandamstyle/compiler` declares **no** `types` export.
  A dangling `./lib/index.d.ts` would be worse than an absent one, so the claim
  was removed rather than faked. P0-06 is unmet.
- **SSR, hydration, TanStack Start.** Not attempted. The pilot is a client
  build only.
- **Advanced HMR.** Not implemented.
- **Multi-bundler compatibility.** Only the Vite/Rollup adapter exists; it is
  not an unplugin-family plugin.
- **Slot recipes, compound variants, patterns, MCP server, visual catalogue,
  general migration, performance campaign.** Unchanged, out of scope.
- **Browser-level cascade proof.** Composition is verified through the fork's
  `styleq` and the emitted CSS, not by a real browser.

## 8. Implementation choices beyond D-15, and divergences

Recorded as the brief requires, in a dated note, without rewriting the
archives.

1. **Diagnostic code names.** The acceptance document names
   `PMS_RAW_DESIGN_VALUE`, `PMS_TOKEN_CATEGORY`, `PMS_PRIVATE_TOKEN`,
   `PMS_RECIPE_VALUE`. The implementation, kept from the previous batch, uses
   `PMS_FORBIDDEN_VALUE`, `PMS_INVALID_TOKEN_CATEGORY`, `PMS_TOKEN_NOT_PUBLIC`,
   `PMS_INVALID_VARIANT_VALUE`. The brief mandates `PMS_FORBIDDEN_VALUE` for
   17px, so the implementation names win. **The two documents disagree; only the
   code is authoritative.**
2. **New codes added this batch**, all documented in
   `pandamstyle/diagnostics.js`: `PMS_NON_STATIC_VALUE`,
   `PMS_FORBIDDEN_IMPORT`, `PMS_FORBIDDEN_STYLE_CHANNEL`,
   `PMS_UNVERIFIED_JSX_SPREAD`, `PMS_ROLE_VIOLATION`, `PMS_COVERAGE_GAP`.
3. **Consumption surface.** D-15's candidate notation is implemented as
   generated: `import { create, token, recipes, themes, props } from
   './design.pandamstyle'`. `props` is forwarded to the fork's composition
   runtime. `create()` and `token()` **throw** if reached at runtime, so an
   uncompiled usage fails loudly.
4. **Page sources are never rewritten.** Compiled JS is written under
   `<outDir>/js/`. An earlier version overwrote the page files, which made the
   build non-repeatable and polluted the sources with a compiler-injected
   import.
5. **Two-pass compilation.** Pass 1 sees real JSX and real TS so the channel
   checks and the TS folding are honest; pass 2 only lowers syntax.
6. **Trailer ordering inside a file.** A `token()` hoisted into a module-level
   constant is lowered in a second pass, after every `create()` has consumed its
   own references. Lowering it earlier would turn a token reference into a bare
   string and the policy would then see a raw value.
7. **Diagnostics no longer short-circuit.** All violations in a file are
   reported, so "each route is refused" is provable from one build.
8. **Lint scope.** The vendored Panda donor and the fixture projects are
   excluded from this repository's ESLint config: they are third-party code.
   Repository-wide `eslint .` is clean.
9. **Jest collection.** `testMatch` is now `**/__tests__/**/*-test.js`, matching
   the repository's existing convention, so shared modules and fixture projects
   are not collected as suites.

## 9. Verdict

Native compilation and the pilot build are demonstrated over the scope
described above: a conforming JS/TS/TSX page compiles to static CSS and
consumable JavaScript, and a copy containing `padding: '17px'` fails a real
build process with `PMS_FORBIDDEN_VALUE` — without TypeScript in the picture.

**P0 is not yet validated.** Generated types, SSR/hydration, browser-level
cascade proof, and the untouched acceptance ranges in §7 remain unmet.
