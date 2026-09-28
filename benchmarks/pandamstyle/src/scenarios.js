/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle benchmark scenarios.
 *
 * A scenario is a REAL CONTENT REVISION, not a replay of a cache.
 *
 * `process_warm_edit` submits bytes that differ from what was there before, and
 * the revision is written and fsynced BEFORE the clock starts. A scenario that
 * rewrote a file with its own content would measure a cache hit and call it an
 * edit; that is the single most misleading number this harness could produce,
 * so `no_change` and `format_only` are the only scenarios that do not change
 * bytes, and both are labelled so they can never be read as edit latency.
 *
 * Every scenario declares:
 *   - `expect`: 'ok' or 'fail' (a negative case that correctly refuses is 'fail'
 *     and its observations are still `ok`)
 *   - `cacheStates`: which cache states are meaningful for it
 *   - `revisions`: how many times the revision is applied in sequence
 *   - `edit(projectDir, ctx)`: produces the new file contents
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** Replaces `before` with `after`, and FAILS LOUDLY if `before` is absent. */
function replaceIn(file, before, after) {
  const abs = path.resolve(file);
  const original = fs.readFileSync(abs, 'utf8');
  if (!original.includes(before)) {
    throw new Error(
      `scenario precondition failed: ${abs} does not contain ${JSON.stringify(
        before,
      )}. An edit that silently did nothing would measure a no-op.`,
    );
  }
  return { path: abs, content: original.replace(before, after) };
}

function read(file) {
  return fs.readFileSync(path.resolve(file), 'utf8');
}

function componentFile(projectDir, i) {
  return path.join(projectDir, 'src', 'components', `Component${i}.tsx`);
}

/**
 * The generated definition, read rather than assumed.
 *
 * Every scenario that needs a token path reads it out of the definition the
 * generator actually produced. A hardcoded path would stop resolving the moment
 * the generator's distribution changed, and the scenario would then fail for a
 * reason unrelated to what it is supposed to measure.
 */
function definitionSource(projectDir) {
  return read(path.join(projectDir, 'design', 'design.pms.config.js'));
}

/** The body of one token category of the generated definition. */
function categoryBlock(src, category) {
  const m = new RegExp(`^  "${category}": \\{$`, 'm').exec(src);
  if (m == null) throw new Error(`no category ${category} in the definition`);
  const next = src.slice(m.index + m[0].length).search(/^ {2}"?[A-Za-z]/m);
  return next === -1
    ? src.slice(m.index)
    : src.slice(m.index, m.index + m[0].length + next);
}

const TOKEN_LINE =
  /^ {4}"([^"]+)": \{ value: "([^"]*)", visibility: "(public|private)" \},$/gm;

/** A real, public token path of `category`. */
function firstTokenOfKind(projectDir, category) {
  const block = categoryBlock(definitionSource(projectDir), category);
  TOKEN_LINE.lastIndex = 0;
  for (let m = TOKEN_LINE.exec(block); m != null; m = TOKEN_LINE.exec(block)) {
    if (m[3] === 'public') return `${category}.${m[1]}`;
  }
  throw new Error(`no public token in category ${category}`);
}

/**
 * Per-scenario run state.
 *
 * A scenario that spans several revisions ("remove a token, then put it back")
 * has to remember what it removed. An arrow-function `edit` cannot use `this` -
 * it has no `this` of its own - so the state is an explicit, named object
 * rather than a hidden field, and the driver resets it before a run. Hidden
 * `this` state across revisions is exactly the kind of thing that makes a
 * replay non-deterministic.
 */
const RUN_STATE = new Map();

function st(name) {
  let s = RUN_STATE.get(name);
  if (s == null) {
    s = {};
    RUN_STATE.set(name, s);
  }
  return s;
}

function resetScenarioState(name) {
  RUN_STATE.delete(name);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A token path that SOMETHING in the corpus actually references.
 *
 * Deterministic: the recipes are scanned in declaration order and the first
 * `t("...")` wins. Removing or restoring a token nothing references would not be
 * a coverage case, and a scenario built on one would report a failure the
 * compiler never produced.
 */
function findReferencedToken(projectDir, definitionSrc) {
  const used = new Set();
  const re = /t\("([^"]+)"\)/g;
  let m;
  while ((m = re.exec(definitionSrc)) !== null) used.add(m[1]);
  const componentsDir = path.join(projectDir, 'src', 'components');
  for (const name of fs.readdirSync(componentsDir).sort()) {
    const src = read(path.join(componentsDir, name));
    const r = /token\('([^']+)'\)/g;
    let x;
    while ((x = r.exec(src)) !== null) used.add(x[1]);
  }
  const ordered = [...used].sort();
  if (ordered.length === 0) {
    throw new Error(
      'the corpus references no token, so no token can be removed',
    );
  }
  for (const chosen of ordered) {
    const dot = chosen.indexOf('.');
    const category = chosen.slice(0, dot);
    const key = chosen.slice(dot + 1);
    // Only a token DECLARED with an inline value can be removed by deleting its
    // line; a semantic alias is declared with a `ref` and removing it would take a
    // whole ref chain with it.
    const declRe = new RegExp(
      `^ {4}"${escapeRegExp(key)}": \\{ value: "[^"]*", visibility: "(public|private)" \\},$`,
      'm',
    );
    if (!declRe.test(definitionSrc)) {
      // A token declared as `{ ref: ... }` is a semantic alias: removing its line
      // would take a reference chain with it, which is a different scenario.
      // The caller falls through to the next referenced token instead.
      return null;
    }
    const categoryStart = new RegExp(
      `^ {2}"${escapeRegExp(category)}": \\{$`,
      'm',
    );
    if (!categoryStart.test(definitionSrc)) {
      continue;
    }
    return { path: chosen, key, category };
  }
  throw new Error(
    'no referenced token is declared as an inline value, so none of them can ' +
      'be removed by deleting a line',
  );
}

/**
 * Finds a component file that actually contains `pattern`.
 *
 * The generator distributes 12 component shapes round-robin, so a scenario that
 * hardcodes "Component0 has a padding token" is asserting something about the
 * generator rather than about the compiler, and it breaks the moment the shape
 * table changes. Every scenario instead LOCATES its target, and fails loudly
 * when there is none: an edit that silently found nothing would measure a
 * no-op and be reported as an edit.
 */
function findComponent(projectDir, pattern, opts = {}) {
  const dir = path.join(projectDir, 'src', 'components');
  const names = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.tsx'))
    .sort();
  const start = opts.startIndex ?? 0;
  // A fresh regex per file: a caller-supplied /g pattern is stateful, and its
  // lastIndex would silently skip matches on the second file.
  const re = new RegExp(pattern.source, pattern.flags.replace('g', ''));
  for (let i = 0; i < names.length; i++) {
    const name = names[(start + i) % names.length];
    const abs = path.join(dir, name);
    const m = re.exec(read(abs));
    if (m != null)
      return { file: abs, match: m[0], capture: m[1] ?? null, name };
  }
  throw new Error(
    `no component matched ${re} in ${dir}. A scenario with no target ` +
      'would measure a no-op and be reported as an edit.',
  );
}

const WARM_ONLY = ['process_warm_no_edit', 'process_warm_edit'];
const COLD_AND_WARM = [
  'process_cold_cache_empty',
  'process_cold_cache_warm',
  'process_warm_edit',
];

const SCENARIOS = [
  // ---------------------------------------------------------------- no-ops --
  {
    name: 'no_change',
    // The control. Re-submits identical bytes. Its number is a floor, not a
    // result: it says what the harness costs when nothing changed.
    expect: 'ok',
    cacheStates: ['process_warm_no_edit', 'process_cold_cache_warm'],
    revisions: 1,
    kind: 'no-op',
    edit: () => [],
  },
  {
    name: 'format_only',
    // A real byte change (whitespace) that changes no style. The gap between
    // this and `one_file_existing_atoms` is the cost of doing nothing semantic
    // on a real revision.
    expect: 'ok',
    cacheStates: WARM_ONLY,
    revisions: 1,
    kind: 'edit',
    edit: (projectDir) => {
      const f = componentFile(projectDir, 0);
      return [
        replaceIn(
          f,
          '\nexport default Component0;',
          '\n\nexport default Component0;',
        ),
      ];
    },
  },

  // --------------------------------------------------------- page revisions --
  {
    name: 'one_file_existing_atoms',
    // A real revision whose styles are byte-different but produce atoms the
    // generation already contains: the compiler must still re-derive them.
    expect: 'ok',
    cacheStates: WARM_ONLY,
    revisions: 1,
    kind: 'edit',
    edit: (projectDir) => {
      const token = firstTokenOfKind(projectDir, 'spacing');
      const target = findComponent(projectDir, /padding: token\('[^']+'\),/g);
      return [
        replaceIn(target.file, target.match, `padding: token('${token}'),`),
      ];
    },
  },
  {
    name: 'one_file_new_atom',
    // A real revision producing an atom the generation does NOT contain: the
    // CSS must grow. The difference from the previous scenario is the cost of
    // a genuinely new atomic rule.
    expect: 'ok',
    cacheStates: COLD_AND_WARM,
    revisions: 1,
    kind: 'edit',
    edit: (projectDir) => {
      const color = firstTokenOfKind(projectDir, 'colors');
      // A NEW DECLARED PROPERTY the file did not have, on an existing
      // namespace: the compiled rule set gains a class the generation did not
      // contain, so the CSS must actually grow.
      const target = findComponent(projectDir, /padding: token\('[^']+'\),/g);
      // `borderColor` is a colors-category property, so a colors token is
      // required here. A property whose category does not match the token
      // would fail with PMS_INVALID_TOKEN_CATEGORY and this scenario would stop
      // being about a new atom.
      return [
        replaceIn(
          target.file,
          target.match,
          `borderColor: token('${color}'),\n    ${target.match}`,
        ),
      ];
    },
  },
  {
    name: 'five_files_batch',
    // The realistic agent batch: five files revised in one commit.
    expect: 'ok',
    cacheStates: COLD_AND_WARM,
    revisions: 1,
    kind: 'edit',
    edit: (projectDir) => {
      // `borderColor` is a colors-category property, so the new declaration
      // takes a colors token. Adding a spacing token there would fail with
      // PMS_INVALID_TOKEN_CATEGORY, and this scenario is about a five-file
      // batch, not about category errors.
      const color = firstTokenOfKind(projectDir, 'colors');
      const edits = [];
      const dir = path.join(projectDir, 'src', 'components');
      for (const name of fs
        .readdirSync(dir)
        .filter((n) => n.endsWith('.tsx'))
        .sort()) {
        if (edits.length >= 5) break;
        const f = path.join(dir, name);
        const src = read(f);
        const m = /(padding|marginTop): token\('[^']+'\),/.exec(src);
        if (m == null) continue;
        // A genuinely new declaration in each of five files: five new atoms.
        edits.push(
          replaceIn(f, m[0], `${m[0]}\n    borderColor: token('${color}'),`),
        );
      }
      if (edits.length < 5) {
        throw new Error(
          `five_files_batch found only ${edits.length} editable components; a ` +
            'batch smaller than its name would measure something else',
        );
      }
      return edits;
    },
  },

  // ------------------------------------------------------------- negatives --
  {
    name: 'forbidden_value',
    // A raw literal where a token is required. MUST fail closed.
    expect: 'fail',
    // NOT `process_warm_no_edit`: that state resubmits identical bytes by
    // definition, so the violation is never introduced and the build would
    // correctly succeed. Declaring it there would measure a scenario that
    // cannot fail.
    cacheStates: ['process_warm_edit'],
    revisions: 1,
    kind: 'edit',
    edit: (projectDir) => {
      const target = findComponent(projectDir, /padding: token\('[^']+'\),/g);
      return [replaceIn(target.file, target.match, "padding: '17px',")];
    },
  },
  {
    name: 'repair_forbidden_value',
    // Undoes the forbidden value. MUST succeed again: a repair that stays
    // broken would be a caching defect, and this is where one would show.
    expect: 'ok',
    // The pair is the point: revision 0 INTRODUCES a violation and must be
    // refused; revision 1 repairs it and must be accepted. A per-revision
    // expectation is stated because a scenario whose first revision is a
    // violation is not a scenario whose first revision is expected to pass.
    revisionExpect: ['fail', 'ok'],
    cacheStates: WARM_ONLY,
    revisions: 2,
    kind: 'edit',
    edit: (projectDir, ctx) => {
      // Revision 0 must run on the ORIGINAL source, so the target is located
      // before anything is written. The repair then restores exactly what was
      // there, which is what makes "the repair succeeded" meaningful.
      const state = st('repair_forbidden_value');
      if (ctx?.revision === 0 || state.forbidden == null) {
        const target = findComponent(projectDir, /padding: token\('[^']+'\),/g);
        state.forbidden = { file: target.file, original: target.match };
        return [replaceIn(target.file, target.match, "padding: '17px',")];
      }
      return [
        replaceIn(
          state.forbidden.file,
          "padding: '17px',",
          state.forbidden.original,
        ),
      ];
    },
  },

  // ----------------------------------------------------------------- tokens --
  {
    name: 'token_value',
    // A token VALUE change. The registry digest must change, so the whole
    // design system is a dependency of this edit.
    expect: 'ok',
    cacheStates: COLD_AND_WARM,
    revisions: 1,
    kind: 'edit',
    edit: (projectDir) => {
      const f = path.join(projectDir, 'design', 'design.pms.config.js');
      const src = read(f);
      const m = /"(\w+)": \{ value: "(\d+px)", visibility: "public" \},/.exec(
        src,
      );
      if (m == null) throw new Error('no public px token in the definition');
      const next = String(parseInt(m[2], 10) + 2);
      return [
        replaceIn(
          f,
          m[0],
          `"${m[1]}": { value: "${next}px", visibility: "public" },`,
        ),
      ];
    },
  },
  {
    name: 'token_remove',
    // Removes a token that IS referenced. This must fail closed, because a
    // dangling token reference is not a warning.
    expect: 'fail',
    cacheStates: ['process_warm_edit'],
    revisions: 1,
    kind: 'edit',
    edit: (projectDir) => {
      const f = path.join(projectDir, 'design', 'design.pms.config.js');
      const src = read(f);
      // Removes a token SOMETHING REFERENCES.
      //
      // Removing an unreferenced token is not a coverage case at all: the build
      // would correctly succeed, and this scenario would report a false
      // failure. The token is therefore located by reading the recipes and the
      // components, not by taking the first one in the file.
      const referenced = findReferencedToken(projectDir, src);
      if (referenced == null) {
        throw new Error('token_remove found no removable referenced token');
      }
      const line = new RegExp(
        `^ {4}"${escapeRegExp(referenced.key)}": \\{ value: "[^"]*", visibility: "(public|private)" \\},\\n`,
        'm',
      ).exec(src);
      if (line == null) {
        throw new Error(
          `token_remove could not find the definition line for ${referenced.path}`,
        );
      }
      const state = st('token_remove');
      state.removedLine = line[0];
      state.removedKey = referenced.key;
      state.removedAnchorCategory = referenced.category;
      return [replaceIn(f, line[0], '')];
    },
  },
  {
    name: 'token_restore',
    // Puts it back. MUST succeed: this is the pair that proves a removal was
    // not cached as a permanent absence.
    expect: 'ok',
    // Revision 0 removes the token and must FAIL; revision 1 restores it and
    // must be accepted.
    revisionExpect: ['fail', 'ok'],
    cacheStates: WARM_ONLY,
    revisions: 2,
    kind: 'edit',
    edit: (projectDir, ctx) => {
      const f = path.join(projectDir, 'design', 'design.pms.config.js');
      const src = read(f);
      const state = st('token_restore');
      if (ctx?.revision === 0) {
        const referenced = findReferencedToken(projectDir, src);
        if (referenced == null) {
          throw new Error('token_restore found no restorable referenced token');
        }
        const line = new RegExp(
          `^ {4}"${escapeRegExp(referenced.key)}": \\{ value: "[^"]*", visibility: "(public|private)" \\},\\n`,
          'm',
        ).exec(src);
        if (line == null) {
          throw new Error(
            `token_restore could not find the definition line for ${referenced.path}`,
          );
        }
        state.removedLine = line[0];
        state.removedKey = referenced.key;
        state.removedAnchorCategory = referenced.category;
        return [replaceIn(f, line[0], '')];
      }
      // Restored EXACTLY where it was: at the top of the category it came from.
      // A token restored into a different category, or with a different value,
      // would change the registry digest and this scenario would stop being a
      // remove/restore pair.
      if (state.removedLine == null) {
        throw new Error(
          'token_restore revision 1 ran without revision 0 having removed ' +
            'anything; the pair would prove nothing',
        );
      }
      const anchor = new RegExp(
        `^( {2}"${escapeRegExp(state.removedAnchorCategory)}": {\n)`,
        'm',
      ).exec(src);
      if (anchor == null) {
        throw new Error(
          `token_restore could not find the ${state.removedAnchorCategory} category`,
        );
      }
      return [replaceIn(f, anchor[1], `${anchor[1]}${state.removedLine}`)];
    },
  },

  // -------------------------------------------------------- semantic layer --
  {
    name: 'semantic_alias',
    // Adds a semantic alias. The registry must re-resolve the reference chain.
    expect: 'ok',
    cacheStates: COLD_AND_WARM,
    revisions: 1,
    kind: 'edit',
    edit: (projectDir) => {
      const f = path.join(projectDir, 'design', 'design.pms.config.js');
      const src = read(f);
      const m =
        /^ {4}"(surface\.[^"]+)": \{ ref: "([^"]+)", visibility: "public" \},\n/m.exec(
          src,
        );
      if (m == null) throw new Error('no semantic surface alias to extend');
      return [
        replaceIn(
          f,
          m[0],
          `${m[0]}    "${m[1]}.alt": { ref: "${m[2]}", visibility: "public" },\n`,
        ),
      ];
    },
  },
  {
    name: 'theme_value',
    // A theme override value change: theme compilation, not token compilation.
    expect: 'ok',
    cacheStates: COLD_AND_WARM,
    revisions: 1,
    kind: 'edit',
    edit: (projectDir) => {
      const f = path.join(projectDir, 'design', 'design.pms.config.js');
      const src = read(f);
      const m = /\{ ref: "(colors\.[^"]+)" \}/.exec(src);
      if (m == null) throw new Error('no theme ref in the definition');
      const other = /\{ ref: "(colors\.[^"]+)" \}/g;
      const all = [...src.matchAll(other)].map((x) => x[1]);
      const alt = all.find((p) => p !== m[1]);
      if (alt == null) throw new Error('only one color ref; cannot change it');
      return [replaceIn(f, `{ ref: "${m[1]}" }`, `{ ref: "${alt}" }`)];
    },
  },

  // ------------------------------------------------------------ conditions --
  {
    name: 'condition_value',
    // A named condition's canonical definition changes: condition normalization
    // and rule ordering are both downstream of this.
    expect: 'ok',
    cacheStates: COLD_AND_WARM,
    revisions: 1,
    kind: 'edit',
    edit: (projectDir) => {
      const f = path.join(projectDir, 'design', 'design.pms.config.js');
      const src = read(f);
      const m = /"hover": "([^"]*)",/.exec(src);
      if (m == null) throw new Error('no hover condition in the definition');
      return [replaceIn(f, m[0], `"hover": "${m[1]}[data-hovering]",`)];
    },
  },
  {
    name: 'condition_remove',
    // Removes a condition AND the use sites that depend on it, so the expected
    // outcome is a successful build with one fewer condition. Removing a
    // condition while its uses remain would be a different scenario with a
    // different expected verdict, and conflating them would hide which happened.
    expect: 'ok',
    cacheStates: WARM_ONLY,
    revisions: 1,
    kind: 'edit',
    edit: (projectDir) => {
      const f = path.join(projectDir, 'design', 'design.pms.config.js');
      const src = read(f);
      const m = /^ {2}"hover": "([^"]*)",\n/m.exec(src);
      if (m == null)
        throw new Error('no hover condition line in the definition');
      const edits = [{ path: f, content: src.replace(m[0], '') }];
      // Every `_hover` USE must go with the condition, in BOTH places it can
      // appear: inside a component's `create()`, and inside a recipe's variant
      // in the definition. Removing only the components would leave the recipe
      // referring to a condition that no longer exists, and the build would
      // fail with PMS_UNKNOWN_CONDITION for a reason that has nothing to do with
      // what this scenario measures.
      // The key is quoted in the generated definition (`"_hover"`) and bare in
      // a component (`_hover`), because they are produced by two different
      // renderers. A pattern matching only one of them would strip half the
      // uses and leave a dangling reference.
      const stripHover = (text) =>
        text.replace(/^([ \t]*)"?_hover"?: \{\n(?:[^\n]*\n)*?\1\},\n/gm, '');
      const definitionPath = path.join(
        projectDir,
        'design',
        'design.pms.config.js',
      );
      const strippedDefinition = stripHover(read(definitionPath));
      if (strippedDefinition !== read(definitionPath)) {
        edits.push({ path: definitionPath, content: strippedDefinition });
      }
      for (const name of fs.readdirSync(
        path.join(projectDir, 'src', 'components'),
      )) {
        const abs = path.join(projectDir, 'src', 'components', name);
        const before = read(abs);
        const after = stripHover(before);
        if (after !== before) edits.push({ path: abs, content: after });
      }
      if (edits.length === 1) {
        throw new Error(
          'condition_remove found no _hover use to remove; the scenario would ' +
            'measure a condition removal nothing depends on',
        );
      }
      return edits;
    },
  },

  // --------------------------------------------------------------- recipes --
  {
    name: 'recipe_branch',
    // Adds a recipe branch value. Branch count grows; selection domain grows.
    expect: 'ok',
    cacheStates: COLD_AND_WARM,
    revisions: 1,
    kind: 'edit',
    edit: (projectDir) => {
      const f = path.join(projectDir, 'design', 'design.pms.config.js');
      const src = read(f);
      // `padding` needs a SPACING token. Reusing the branch's own fontSize
      // token would fail with PMS_INVALID_TOKEN_CATEGORY, and this scenario is
      // about branch growth, not about category errors.
      const spacing = firstTokenOfKind(projectDir, 'spacing');
      const m = /^ {8}"sm": \{\n(\s*)"fontSize": (t\("[^"]+"\)),\n/m.exec(src);
      if (m == null) throw new Error('no recipe size branch in the definition');
      return [
        replaceIn(
          f,
          m[0],
          `        "xs": {\n${m[1]}"fontSize": ${m[2]},\n${m[1]}"padding": t("${spacing}"),\n        },\n${m[0]}`,
        ),
      ];
    },
  },
  {
    name: 'recipe_interface',
    // Adds a whole recipe AXIS. This is the interface change: a new key appears
    // in the recipe contract, and a consumer that did not pass it still
    // compiles.
    expect: 'ok',
    cacheStates: COLD_AND_WARM,
    revisions: 1,
    kind: 'edit',
    edit: (projectDir) => {
      const f = path.join(projectDir, 'design', 'design.pms.config.js');
      const src = read(f);
      const m = /^ {6}"emphasis": \{\n/m.exec(src);
      if (m == null) throw new Error('no emphasis axis in the definition');
      const weight = firstTokenOfKind(projectDir, 'fontWeights');
      // The new axis is a SIBLING of `emphasis`, at the same indentation, so it
      // is inserted BEFORE the anchor rather than after its opening brace. A new
      // axis nested inside another one is not an interface change, it is a
      // syntax error the registry reports as an unknown condition.
      return [
        replaceIn(
          f,
          m[0],
          `      "tone2": {\n        plain: { "fontWeight": t("${weight}") },\n        strong: { "fontWeight": t("${weight}") },\n      },\n${m[0]}`,
        ),
      ];
    },
  },

  // ---------------------------------------------------------------- policy --
  {
    name: 'policy_category',
    // A category policy revision: a property that took a token starts taking a
    // DIFFERENT category's token, and the compiler must refuse it.
    expect: 'fail',
    cacheStates: ['process_warm_edit'],
    revisions: 1,
    kind: 'edit',
    edit: (projectDir) => {
      const color = firstTokenOfKind(projectDir, 'colors');
      const target = findComponent(
        projectDir,
        /(padding|marginTop): token\('[^']+'\),/g,
      );
      const prop = target.match.slice(0, target.match.indexOf(':'));
      return [
        replaceIn(target.file, target.match, `${prop}: token('${color}'),`),
      ];
    },
  },
  {
    name: 'policy_global',
    // The same class of violation, introduced across MANY files at once. The
    // question it answers is whether a global failure costs more per file than
    // a local one, which is a real property of the traversal order.
    expect: 'fail',
    cacheStates: ['process_warm_edit'],
    revisions: 1,
    kind: 'edit',
    edit: (projectDir) => {
      const color = firstTokenOfKind(projectDir, 'colors');
      const dir = path.join(projectDir, 'src', 'components');
      const edits = [];
      for (const name of fs.readdirSync(dir).slice(0, 20)) {
        const f = path.join(dir, name);
        const src = read(f);
        const m = /(padding|marginTop|paddingTop): token\('[^']+'\),/.exec(src);
        if (m == null) continue;
        edits.push(replaceIn(f, m[0], `${m[1]}: token('${color}'),`));
      }
      if (edits.length === 0) throw new Error('no spacing declarations found');
      return edits;
    },
  },

  // ---------------------------------------------------------- module graph --
  {
    name: 'import_change',
    // Adds a local import. The module graph must be re-walked and the closure
    // must still cover the new edge.
    expect: 'ok',
    cacheStates: WARM_ONLY,
    revisions: 1,
    kind: 'edit',
    edit: (projectDir) => {
      // The design-system import is multi-line in the generated corpus, so the
      // anchor is its opening line, not a `import { create,` that may not exist.
      const target = findComponent(projectDir, /^import \{$/m);
      return [
        replaceIn(
          target.file,
          target.match,
          `import { fan0Label } from '../fanout/fan0.ts';\n${target.match}`,
        ),
      ];
    },
  },
  {
    name: 'reexport_change',
    // Changes what the barrel re-exports. The relay walk must follow it.
    expect: 'ok',
    cacheStates: WARM_ONLY,
    revisions: 1,
    kind: 'edit',
    edit: (projectDir) => {
      const f = path.join(projectDir, 'bridge', 'index.ts');
      return [replaceIn(f, '  manifest,\n', '  manifest,\n  extra_marker,\n')];
    },
  },
  {
    name: 'module_add',
    // A NEW covered file that nothing imports yet: coverage is by ROOT, so an
    // unimported file is still analysed. Replacing coverage with an import
    // filter would skip this file entirely.
    expect: 'ok',
    cacheStates: COLD_AND_WARM,
    revisions: 1,
    kind: 'edit',
    edit: (projectDir) => {
      const token = firstTokenOfKind(projectDir, 'spacing');
      const f = path.join(projectDir, 'src', 'components', 'Component9999.tsx');
      return [
        {
          path: f,
          content: `import { create, token, props } from '../../.pandamstyle/design.pandamstyle.js';\nconst styles = create({ root: { padding: token('${token}') } });\nexport function Component9999() { return <div {...props(styles.root)} />; }\n`,
        },
      ];
    },
  },
  {
    name: 'module_remove',
    // Removes a covered file. Coverage must shrink by exactly one, and the
    // build must still be coherent.
    expect: 'ok',
    cacheStates: WARM_ONLY,
    revisions: 1,
    kind: 'edit',
    edit: (projectDir) => {
      // Removes the LAST component, so no other scenario's target moves.
      const dir = path.join(projectDir, 'src', 'components');
      const names = fs
        .readdirSync(dir)
        .filter((n) => n.endsWith('.tsx'))
        .sort();
      const victim = path.join(dir, names[names.length - 1]);
      return [{ path: victim, delete: true }];
    },
  },

  // ---------------------------------------------------------------- config --
  {
    name: 'config_change',
    // A build-configuration change (CSS layers on). It changes the emitted CSS
    // without changing a single source file, which is the case that separates
    // "did the compiler run" from "did anything change".
    expect: 'ok',
    cacheStates: WARM_ONLY,
    revisions: 2,
    kind: 'edit',
    edit: (projectDir, ctx) => {
      const f = path.join(projectDir, 'pandamstyle.config.js');
      if (ctx?.revision === 0) {
        return [replaceIn(f, 'useCSSLayers: false,', 'useCSSLayers: true,')];
      }
      return [replaceIn(f, 'useCSSLayers: true,', 'useCSSLayers: false,')];
    },
  },
  {
    name: 'resolution_config_change',
    // Revision 0 adds an import whose target DOES NOT EXIST, which must fail
    // closed with PMS_COVERAGE_GAP. Revision 1 creates the target, in the SAME
    // process, and the build must now succeed. That pair is the proof that a
    // negative resolution was not cached as a permanent absence: a compiler
    // that remembered "missing" would keep refusing.
    expect: 'ok',
    revisionExpect: ['fail', 'ok'],
    cacheStates: WARM_ONLY,
    revisions: 2,
    kind: 'edit',
    edit: (projectDir, ctx) => {
      if (ctx?.revision === 0) {
        const target = findComponent(projectDir, /^import \{$/m);
        st('resolution_config_change').laterHost = target.file;
        return [
          {
            path: target.file,
            content: read(target.file).replace(
              target.match,
              `import { later } from './later-module';\n${target.match}`,
            ),
          },
        ];
      }
      return [
        {
          path: path.join(projectDir, 'src', 'components', 'later-module.ts'),
          content: "export const later = 'present';\n",
        },
      ];
    },
  },

  // ------------------------------------------------------- not implemented --
  {
    name: 'cancel_and_retry',
    expect: 'ok',
    cacheStates: [],
    revisions: 1,
    kind: 'not-implemented',
    edit: () => [],
    notImplementedReason:
      'cancelling an in-flight generation needs a driver that can abort a build ' +
      'mid-publication, which the CLI does not expose and which the bundler ' +
      'path can only reach through a hook the adapter does not provide. Kept in ' +
      'the protocol, marked not_run, rather than approximated by a scenario that ' +
      'does not exercise cancellation.',
  },
  {
    name: 'crash_during_publication',
    expect: 'ok',
    cacheStates: [],
    revisions: 1,
    kind: 'not-implemented',
    edit: () => [],
    notImplementedReason:
      'a crash is not a latency, and the transactional guarantees it exercises ' +
      'are correctness gates rather than performance metrics. The existing ' +
      'transactional-generation tests cover the guarantee; a performance ' +
      'number for it would be meaningless. Kept in the protocol, marked ' +
      'not_run.',
  },
];

const BY_NAME = new Map(SCENARIOS.map((s) => [s.name, s]));

function getScenario(name) {
  const s = BY_NAME.get(name);
  if (s == null) throw new Error(`unknown scenario: ${name}`);
  return s;
}

function allScenarioNames() {
  return SCENARIOS.map((s) => s.name);
}

module.exports = {
  SCENARIOS,
  getScenario,
  allScenarioNames,
  resetScenarioState,
};
