/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - the agent-loop benchmark (Spike 4, Phase C).
 *
 * WHAT THIS IS
 *
 * The loop an AI agent actually runs, measured end to end:
 *
 *     agent writes files
 *             ↓
 *     session.applyAgentChanges({ changed: [...] })
 *             ↓
 *     session.validate()        -> complete diagnostics for that revision
 *             ↓
 *     session.compile()         -> generation committed
 *     session.requestFullAudit() -> the full evidence, if wanted
 *
 * It is a SEPARATE harness from `run-campaign.js` on purpose. That matrix is
 * five engines x four cache states x twenty-seven scenarios, and adding two axes
 * to it would make every existing row mean two things. The questions here - how
 * long is the diagnostics path, how much metadata is on it, and what is left
 * once the audit comes off it - need cells with their own names, not a fifth
 * cache state bolted onto a matrix whose comparability was established in
 * Spike 1.
 *
 * WHY ONE PROCESS PER CELL
 *
 * An agent loop is warm by definition. There is no cold variant of the loop a
 * caller would run, and a process that had never compiled the corpus would be
 * measuring `process_cold_cache_empty`, which Spike 1 already measures. So a
 * cell is a warmup revision that establishes the session and publishes a
 * generation, then the measured revisions on top of it, all in ONE process. The
 * warmup's observations are DISCARDED, not averaged away - the same policy
 * Spike 2 used, applied for the same reason.
 *
 * But a CELL is one process, and the campaign is many. The first version ran all
 * 336 cells in a single process and died at cell 44 of the c1000 campaign: a
 * session at a thousand files holds its per-file contributions, and 44 of them
 * in one address space is gigabytes. Two things are wrong with that beyond the
 * crash. It makes a cell's numbers depend on how many cells ran before it, which
 * is the contamination Spike 2's `worker.js` was written to eliminate ("a cache
 * state IS a process"), and a campaign that dies at cell 44 has produced a
 * summary that looks like a short campaign rather than a failed one.
 *
 * So the parent process spawns one child per cell, collects the rows, and the
 * children are cheap: a cell's whole cost is its own warmup, which it has to pay
 * anyway.
 *
 * THE FOUR VARIANTS ARE ONE COMPILER AND FOUR METADATA POLICIES
 *
 *   full_metadata                          the pre-Phase-C artifact: the whole
 *                                          project-wide coverage array inline
 *                                          in `build-report.json`
 *   compact_agent_result                   diagnostics only; nothing published
 *   compact_agent_result_plus_compact_publish_metadata
 *                                          diagnostics, then a publication
 *                                          whose report carries counts and a
 *                                          reference
 *   full_audit_requested                   the above, then the full coverage
 *                                          document, materialized
 *
 * Same tree, same session, same analysis, same compiler. The only difference is
 * what each does with the metadata, so the difference between the rows IS the
 * metadata policy. A `full_metadata` row produced from a DIFFERENT checkout
 * would confound the metadata with every compiler change between the two, which
 * is the mistake the Spike 2 engines were split in order to avoid and the
 * mistake this file exists not to repeat.
 *
 * THE FOUR COMPLETION POINTS ARE FOUR OBSERVATIONS
 *
 *   agent_edit_to_diagnostics_ms          the KPI: mutation transaction
 *                                           accepted -> complete diagnostics
 *   agent_edit_to_generation_ready_ms     every artifact staged
 *   agent_edit_to_generation_committed_ms the commit marker on disk
 *   agent_edit_to_audit_report_ms         the full evidence materialized
 *
 * They are never collapsed. The distance between the first and the last is the
 * cost this phase is about, and averaging them would hide it.
 *
 * USAGE
 *
 *   node src/agent-loop.js --corpus <dir> --out-dir <dir> [--iterations 7]
 *   node src/agent-loop.js --self-test
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const COMPILER_PKG = path.join(
  REPO_ROOT,
  'packages',
  '@pandamstyle',
  'compiler',
);
const HARNESS_VERSION = 'pms-agent-loop-harness/1.0.0';
const SCHEMA_VERSION = 1;

const STATUS = Object.freeze({
  OK: 'ok',
  ERROR: 'error',
  UNSUPPORTED: 'unsupported',
});

/**
 * The four metadata policies, and what each DOES on the measured path.
 *
 * `publishes` and `audits` are the entire definition. A cell that published is
 * measuring a different loop from a cell that did not, so the labels have to
 * say which one ran before any number means anything.
 */
const VARIANTS = Object.freeze({
  full_metadata: {
    auditPolicy: 'inline',
    publishes: true,
    audits: false,
    label:
      'the pre-Phase-C artifact: the whole project-wide coverage array is ' +
      'serialized into build-report.json inside the publication transaction',
  },
  compact_agent_result: {
    auditPolicy: 'reference',
    publishes: false,
    audits: false,
    label:
      'diagnostics only. The agent reads the compact result and the loop ' +
      'stops there; nothing is published',
  },
  compact_agent_result_plus_compact_publish_metadata: {
    auditPolicy: 'reference',
    publishes: true,
    audits: false,
    label:
      'diagnostics, then a publication whose build report carries the ' +
      'coverage counts and a reference to a document that is not written',
  },
  full_audit_requested: {
    auditPolicy: 'reference',
    publishes: true,
    audits: true,
    label:
      'diagnostics, then a publication, then the full coverage document, ' +
      'requested and produced synchronously on this revision',
  },
});

/**
 * The scenarios. Each is a list of REVISIONS with an EXPECTATION per revision.
 *
 * A scenario is a sequence because the interesting agent workloads are
 * sequences: a violation and its repair, an unresolved import and the file that
 * resolves it. The expectation lives with the revision, so a cell that got the
 * wrong answer FAILS instead of reporting a fast wrong one.
 */
const SCENARIOS = Object.freeze({
  no_change: {
    note: 'a declared file written back byte for byte: a no-op that costs a read and a hash',
    revisions: [
      { name: 'declared_unchanged', files: 1, expect: 'ok', kind: 'noop' },
    ],
  },
  one_file_existing_atoms: {
    note: 'the primary agent edit: one file, existing token references',
    revisions: [{ name: 'edit', files: 1, expect: 'ok', kind: 'edit' }],
  },
  one_file_new_atom: {
    note:
      'Phase D: one file gaining a declared property the generation did not ' +
      'contain, so the CSS actually grows. Distinct from ' +
      'one_file_existing_atoms, which re-derives atoms already present.',
    revisions: [{ name: 'new_atom', files: 1, expect: 'ok', kind: 'new_atom' }],
  },
  five_files_batch: {
    note: 'one transaction naming five files: one revision, not five',
    revisions: [{ name: 'edit', files: 5, expect: 'ok', kind: 'edit' }],
  },
  twenty_files_batch: {
    note: 'one transaction naming twenty files',
    revisions: [{ name: 'edit', files: 20, expect: 'ok', kind: 'edit' }],
  },
  forbidden_value: {
    note: 'the invalid hot path: a category property given a raw number',
    revisions: [{ name: 'break', files: 1, expect: 'fail', kind: 'forbid' }],
  },
  repair_forbidden_value: {
    note: 'MANDATORY: introduce the violation, then repair exactly it',
    revisions: [
      { name: 'break', files: 1, expect: 'fail', kind: 'forbid' },
      { name: 'repair', files: 1, expect: 'ok', kind: 'repair' },
    ],
  },
  module_add: {
    note: 'a new page, declared as added',
    revisions: [{ name: 'add', files: 1, expect: 'ok', kind: 'add' }],
  },
  module_remove: {
    note: 'a deleted page, declared as removed',
    revisions: [{ name: 'remove', files: 1, expect: 'ok', kind: 'remove' }],
  },
  file_rename: {
    note: 'a moved page, declared as renamed',
    revisions: [{ name: 'rename', files: 1, expect: 'ok', kind: 'rename' }],
  },
  import_change: {
    note: 'an import specifier that does not resolve: a coverage gap, not a policy refusal',
    revisions: [
      { name: 'import', files: 1, expect: 'fail', kind: 'unresolved' },
    ],
  },
  unresolved_import_then_file_appears: {
    note: 'the negative resolution repaired by the file appearing',
    revisions: [
      { name: 'unresolved', files: 1, expect: 'fail', kind: 'unresolved' },
      { name: 'appears', files: 1, expect: 'ok', kind: 'resolve_unresolved' },
    ],
  },
  reexport_change: {
    note:
      'Phase D: the relay barrel changes what it re-exports. Every page ' +
      'reaches the design system through it, so this is the revision whose ' +
      'design-system-view dependency graph must do real work.',
    revisions: [{ name: 'reexport', files: 1, expect: 'ok', kind: 'reexport' }],
  },
  token_value_full_fallback: {
    note:
      'a design-system edit: the one path where the affected set IS the ' +
      'project, so a metadata policy that only helps the incremental path ' +
      'shows up here as no help at all',
    revisions: [
      { name: 'definition', files: 1, expect: 'ok', kind: 'definition' },
    ],
  },
});

/**
 * The RAW VALUE a forbidden-value edit writes.
 *
 * A category property given a bare number. P0 admits only a token for `color`,
 * so this is PMS_FORBIDDEN_VALUE with the category named - which is the
 * diagnostic the repair half of the invalid->repair loop is built on.
 */
const FORBIDDEN_RAW = '17';

function nowNs() {
  return Number(process.hrtime.bigint());
}

function makeCollector() {
  const durations = new Map();
  const counts = new Map();
  let parses = 0;
  return {
    addDuration(metric, ns) {
      durations.set(metric, (durations.get(metric) ?? 0) + ns);
    },
    addCount(metric, n = 1) {
      counts.set(metric, (counts.get(metric) ?? 0) + n);
    },
    addParse() {
      parses += 1;
    },
    sampleMemory() {},
    reset() {
      durations.clear();
      counts.clear();
      parses = 0;
    },
    snapshot() {
      const dur = {};
      for (const [k, v] of durations) dur[k] = v / 1e6;
      return {
        durations_ms: dur,
        counters: Object.fromEntries(counts),
        parses,
      };
    },
  };
}

function materialiseProject(sourceDir, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const walk = (d, base = sourceDir) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const rel = path.relative(base, abs);
      if (rel.split(path.sep)[0] === 'node_modules') continue;
      if (rel.startsWith('.pandamstyle')) continue;
      if (e.isDirectory()) walk(abs, base);
      else if (e.isFile()) {
        const to = path.join(dir, rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(abs, to);
      }
    }
  };
  walk(sourceDir);
  return dir;
}

function linkCompiler(projectDir) {
  const scope = path.join(projectDir, 'node_modules', '@pandamstyle');
  fs.mkdirSync(scope, { recursive: true });
  const link = path.join(scope, 'compiler');
  if (!fs.existsSync(link)) fs.symlinkSync(COMPILER_PKG, link, 'dir');
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Every module the corpus's own manifest lists, in a stable order. */
function corpusFiles(corpusDir) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(corpusDir, 'corpus-manifest.json'), 'utf8'),
  );
  return manifest.files.map((f) => f.path);
}

// --------------------------------------------------------------- revisions ---

/**
 * Turns a scenario into concrete writes, on a project that is in its PRISTINE
 * state.
 *
 * Everything is computed from the generated corpus, and every edit ASSERTS that
 * the text it is about to change is present. A scenario that did not find its
 * target would apply an empty edit, and an empty edit is a no-op - the single
 * most misleading number this harness could report.
 *
 * A `repair` revision is derived from the `forbid` revision immediately before
 * it, from the same substitution inverted. It cannot drift from the violation
 * it repairs, and the repair is provably the only change: the harness keeps the
 * exact bytes it wrote for the break and puts them back.
 */
function planRevisions(projectDir, corpusName, scenarioName, definition) {
  const scenario = SCENARIOS[scenarioName];
  if (scenario == null) {
    throw new Error(
      `agent-loop: unknown scenario ${JSON.stringify(scenarioName)}`,
    );
  }
  const read = (rel) => fs.readFileSync(path.join(projectDir, rel), 'utf8');

  const componentDir = path.join(projectDir, 'src', 'components');
  const components = fs
    .readdirSync(componentDir)
    .filter((f) => /\.[cm]?[jt]sx?$/.test(f))
    .sort()
    .map((f) => `src/components/${f}`);
  // Disjoint sets across the revisions of one scenario, so revision N+1 never
  // touches a file revision N already touched and the "files recompiled"
  // counter means what it says.
  let cursor = 0;
  const take = (n) => {
    const out = components.slice(cursor, cursor + n);
    cursor += n;
    if (out.length < n) {
      throw new Error(
        `agent-loop: ${scenarioName} needs ${n} more component files than the ` +
          `corpus has left (${out.length} of ${n})`,
      );
    }
    return out;
  };

  /**
   * `take(n)`, but skipping component files the predicate rejects.
   *
   * The corpus generates twelve shapes round-robin and they do not all express
   * the same declaration - several bind the spacing token to a local `const`
   * first - so a scenario keyed on a literal `padding: token('…'),` anchor has
   * to look for a file that HAS the anchor rather than take the next one and
   * fail. It still advances the cursor past everything it skipped, so the
   * "files recompiled means what it says" property is preserved.
   */
  const takeWith = (n, acceptable) => {
    const out = [];
    while (out.length < n && cursor < components.length) {
      const rel = components[cursor];
      cursor += 1;
      if (acceptable(rel)) out.push(rel);
    }
    if (out.length < n) {
      throw new Error(
        `agent-loop: ${scenarioName} needs ${n} component files carrying its ` +
          `anchor and the corpus has ${out.length} left`,
      );
    }
    return out;
  };

  // EVERY revision's content is computed here, against the PRISTINE project,
  // and each write carries the complete target text. That is what makes the
  // repair revision exact: it writes back the bytes its predecessor replaced,
  // rather than re-deriving them with a second substitution that could match a
  // different occurrence.
  const revisions = [];
  for (const rev of scenario.revisions) {
    switch (rev.kind) {
      case 'noop': {
        const files = take(rev.files);
        revisions.push({
          ...rev,
          writes: files.map((rel) => ({ path: rel, content: read(rel) })),
          mutation: { changed: files },
        });
        break;
      }
      case 'edit': {
        const files = take(rev.files);
        revisions.push({
          ...rev,
          writes: files.map((rel) => ({
            path: rel,
            content: swapToken(read(rel), definition, rel, rev.name),
          })),
          mutation: { changed: files },
        });
        break;
      }
      case 'new_atom': {
        // A NEW DECLARED PROPERTY on an existing namespace. The compiled rule
        // set gains a class the generation did not contain, so the CSS grows -
        // which is what makes this a different cost from `edit`, and why a
        // harness that measured only `edit` would never see it.
        //
        // `borderColor` requires a colors token: a spacing token on a colour
        // property is refused with PMS_INVALID_TOKEN_CATEGORY and the cell
        // would be measuring a refusal under a row labelled "new atom".
        const files = takeWith(rev.files, (rel) =>
          /padding: token\('[^']+'\),/.test(read(rel)),
        );
        const color = firstPublicTokenOf(definition, 'colors');
        revisions.push({
          ...rev,
          writes: files.map((rel) => {
            const text = read(rel);
            const anchor = paddingAnchor(text, rel, rev.name);
            return {
              path: rel,
              content:
                text.slice(0, anchor.index) +
                `borderColor: token('${color}'),\n    ` +
                text.slice(anchor.index),
            };
          }),
          mutation: { changed: files },
        });
        break;
      }
      case 'reexport': {
        // The relay barrel's re-export LIST changes, without changing anything
        // the pages import. The pages' compiled output must be unaffected and
        // their design-system view must be re-derived, because the relay's
        // export map is one of the things that view is a digest of.
        const barrel = 'bridge/index.ts';
        const text = read(barrel);
        const anchor = '  manifest,\n';
        if (!text.includes(anchor)) {
          throw new Error(
            `agent-loop: ${barrel} (revision ${rev.name}) has no re-export ` +
              'anchor; the scenario cannot find its target and an empty edit ' +
              'would be measured as a no-op',
          );
        }
        revisions.push({
          ...rev,
          writes: [
            {
              path: barrel,
              content: text.replace(
                anchor,
                `${anchor}  phaseDreexportMarker,\n`,
              ),
            },
          ],
          mutation: { changed: [barrel] },
        });
        break;
      }
      case 'forbid': {
        const files = take(rev.files);
        const pristine = files.map((rel) => read(rel));
        revisions.push({
          ...rev,
          writes: files.map((rel, i) => ({
            path: rel,
            content: forbidColorToken(pristine[i], rel, rev.name),
          })),
          mutation: { changed: files },
          // Kept so the repair is the INVERSE of this revision and not a second
          // independent edit that happens to look like one.
          pristine: files.map((rel, i) => ({
            path: rel,
            content: pristine[i],
          })),
        });
        break;
      }
      case 'repair': {
        const previous = revisions[revisions.length - 1];
        if (previous == null || previous.kind !== 'forbid') {
          throw new Error(
            `agent-loop: ${scenarioName}: a repair revision must follow a ` +
              'forbid revision, and there is none',
          );
        }
        revisions.push({
          ...rev,
          writes: previous.pristine,
          mutation: { changed: previous.mutation.changed },
        });
        break;
      }
      case 'add': {
        const template = read(components[0]);
        const writes = [];
        for (let i = 0; i < rev.files; i += 1) {
          const ext = path.extname(components[i % components.length]);
          const base = `AgentAdded${cursor + i}`;
          writes.push({
            path: `src/components/${base}${ext}`,
            // A new page of the same shape, with a name the generator never
            // produces, so a collision with the corpus cannot make this a
            // no-op. Its token references are the template's, which are valid
            // for the same design system: the new page must compile, or the
            // "module added" cell would be measuring a refusal.
            content: template.replace(/Component\d+/g, base),
          });
        }
        revisions.push({
          ...rev,
          writes,
          mutation: { added: writes.map((w) => w.path) },
        });
        break;
      }
      case 'remove': {
        const files = take(rev.files);
        revisions.push({
          ...rev,
          deletes: files,
          mutation: { removed: files },
        });
        break;
      }
      case 'rename': {
        const files = take(rev.files);
        const renames = files.map((rel) => ({
          from: rel,
          to: rel.replace(/(\.[cm]?[jt]sx?)$/, '-moved$1'),
        }));
        revisions.push({
          ...rev,
          writes: renames.map((m) => ({ path: m.to, content: read(m.from) })),
          deletes: renames.map((m) => m.from),
          mutation: { renamed: renames },
        });
        break;
      }
      case 'unresolved': {
        // An IMPORT, not a re-export, and one directory up: the components
        // live in `src/components`, so `'../../agent-pending/Pending'` would
        // resolve to a directory that does not exist and the edge would not be
        // the one the scenario claims. A re-export is also the wrong form: the
        // coverage gap the session reports is about an import the graph cannot
        // resolve, and this is the fixture form the compiler's own negative
        // corpus uses.
        const files = take(rev.files);
        const pendingPath = 'src/agent-pending/Pending.ts';
        const specifier = '../agent-pending/Pending';
        revisions.push({
          ...rev,
          writes: files.map((rel) => ({
            path: rel,
            content:
              `${read(rel)}\nimport { pendingThing } from '${specifier}';\n` +
              'export const pendingValue = pendingThing;\n',
          })),
          mutation: { changed: files },
          pending: {
            path: pendingPath,
            content: 'export const pendingThing = 1;\n',
          },
        });
        break;
      }
      case 'resolve_unresolved': {
        const previous = revisions[revisions.length - 1];
        if (previous == null || previous.pending == null) {
          throw new Error(
            `agent-loop: ${scenarioName}: nothing is unresolved to resolve`,
          );
        }
        revisions.push({
          ...rev,
          writes: [
            { path: previous.pending.path, content: previous.pending.content },
          ],
          mutation: { added: [previous.pending.path] },
        });
        break;
      }
      case 'definition': {
        revisions.push({
          ...rev,
          definitionEdit: true,
          mutation: { changed: [] },
        });
        break;
      }
      default:
        throw new Error(`agent-loop: unknown revision kind ${rev.kind}`);
    }
  }
  return revisions;
}

/**
 * The first token reference in a file, and its category.
 *
 * The corpus generates twelve component shapes round-robin and no single token
 * path appears in all of them - a scenario that hard-coded `spacing.xs` found
 * that out the first time it met a component that did not use it, and the
 * honest failure is a harness error rather than a silently empty edit. So the
 * target is DERIVED from the file, and the replacement is drawn from the design
 * system, which is what makes the edit a real content revision on every shape.
 */
function firstTokenRef(text, rel, revName) {
  const match = /token\('([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)'\)/.exec(text);
  if (match == null) {
    throw new Error(
      `agent-loop: ${rel} (revision ${revName}) has no token reference; the ` +
        'scenario cannot find its target and an empty edit would be measured ' +
        'as a no-op',
    );
  }
  return { index: match.index, whole: match[0], path: match[1] };
}

/** The first PUBLIC token of a category, or a harness error rather than a guess. */
function firstPublicTokenOf(definition, category) {
  const members = definition.tokens?.[category];
  if (members == null) {
    throw new Error(
      `agent-loop: the design system has no token category ${JSON.stringify(category)}`,
    );
  }
  const found = Object.keys(members).find(
    (name) => (members[name]?.visibility ?? 'public') === 'public',
  );
  if (found == null) {
    throw new Error(
      `agent-loop: token category ${category} has no public token to use`,
    );
  }
  return `${category}.${found}`;
}

/**
 * The `padding:` declaration of an existing namespace, as a position.
 *
 * A position rather than a string, so the same anchor works for an insertion
 * as for a replacement and the edit is applied to the PRISTINE text once.
 */
function paddingAnchor(text, rel, revName) {
  const match = /padding: token\('[^']+'\),/.exec(text);
  if (match == null) {
    throw new Error(
      `agent-loop: ${rel} (revision ${revName}) has no padding declaration; ` +
        'the scenario cannot find its target and an empty edit would be ' +
        'measured as a no-op',
    );
  }
  return { index: match.index, whole: match[0] };
}

/**
 * A VALID revision: swap one token reference for another of the SAME category.
 *
 * Same category is what makes it valid, and validity is not optional here: a
 * scenario that produced an invalid edit would be measuring the refusal path
 * under a row labelled "one file, existing atoms", and the two would be
 * indistinguishable in the summary.
 */
function swapToken(text, definition, rel, revName) {
  const { index, whole, path: tokenPath } = firstTokenRef(text, rel, revName);
  const category = tokenPath.split('.')[0];
  const members = definition.tokens[category];
  if (members == null) {
    throw new Error(
      `agent-loop: ${rel} references ${tokenPath}, whose category ` +
        `${JSON.stringify(category)} is not in the design system`,
    );
  }
  const currentVisibility =
    members[tokenPath.slice(category.length + 1)]?.visibility;
  const replacement = Object.keys(members).find(
    (name) =>
      name !== tokenPath.slice(category.length + 1) &&
      members[name].visibility === (currentVisibility ?? 'public'),
  );
  if (replacement == null) {
    throw new Error(
      `agent-loop: category ${category} has no second token to swap with`,
    );
  }
  return (
    text.slice(0, index) +
    `token('${category}.${replacement}')` +
    text.slice(index + whole.length)
  );
}

/**
 * The invalid revision: a colors token reference replaced by a raw number.
 *
 * The first CATEGORISED token reference in the file is chosen deliberately -
 * the padding token would also be refused, but on a different property, and
 * pinning the choice to a category keeps the diagnostic code and the repair
 * identical on every one of the twelve generated shapes. When a file has no
 * colors reference at all, the first reference of any kind is used, and the
 * scenario's `expect: 'fail'` is what catches it if that was a mistake.
 */
function forbidColorToken(text, rel, revName) {
  const all = [
    ...text.matchAll(/token\('([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)'\)/g),
  ];
  if (all.length === 0) {
    throw new Error(
      `agent-loop: ${rel} (revision ${revName}) has no token reference to ` +
        'refuse; an empty edit would be measured as a no-op',
    );
  }
  const chosen = all.find((m) => m[1].startsWith('colors.')) ?? all[0];
  return (
    text.slice(0, chosen.index) +
    FORBIDDEN_RAW +
    text.slice(chosen.index + chosen[0].length)
  );
}

// ---------------------------------------------------------------- the loop ---

/**
 * One measured cell: one corpus, one variant, one scenario, one iteration.
 */
class AgentLoop {
  constructor({
    corpusDir,
    projectDir,
    variant,
    scenario,
    iteration,
    corpusName,
  }) {
    this.corpusDir = corpusDir;
    this.projectDir = projectDir;
    this.variantName = variant;
    this.variant = VARIANTS[variant];
    this.scenarioName = scenario;
    this.iteration = iteration;
    this.corpusName = corpusName;
    this.collector = makeCollector();
    this.session = null;
    this.config = null;
    this.definition = null;
    this.definitionPath = null;
    this.compiler = null;
    this.observations = [];
  }

  async prepare() {
    materialiseProject(this.corpusDir, this.projectDir);
    linkCompiler(this.projectDir);
    this.compiler = require(path.join(COMPILER_PKG, 'lib', 'index.js'));
    this.compiler.installPerfCollector(this.collector);
    this.config = require(path.join(this.projectDir, 'pandamstyle.config.js'));
    this.definitionPath = path.resolve(
      path.dirname(path.join(this.projectDir, 'pandamstyle.config.js')),
      this.config.definition,
    );
    this.definition = await this.loadDefinition();
    this.revisions = planRevisions(
      this.projectDir,
      this.corpusName,
      this.scenarioName,
      this.definition,
    );
  }

  /**
   * Re-imports the definition, cache-busted.
   *
   * The generated corpus's definition is an ES module, and Node's ES module
   * registry is keyed by full URL with no public invalidation API, so
   * `delete require.cache[...]` is a no-op for it. Without the nonce, a warm
   * edit to the design system would be written to disk and then IGNORED: the
   * `definition` revision would report no fallback and the cell would be
   * measuring a full rebuild that never happened. That is the worst possible
   * direction for this harness to be wrong in, so the nonce is not optional and
   * the loaded module is asserted to be a definition object.
   *
   * The nonce changes the module IDENTITY and nothing else - the bare
   * specifiers it imports still resolve against the same directory - so the
   * definition the compiler receives is the one on disk.
   */
  async loadDefinition() {
    this.definitionNonce = (this.definitionNonce ?? 0) + 1;
    const href = require('url').pathToFileURL(this.definitionPath).href;
    const mod = await import(
      `${href}?pmsAgentRevision=${this.definitionNonce}`
    );
    const value = mod != null && mod.default != null ? mod.default : mod;
    if (value == null || typeof value !== 'object') {
      throw new Error(
        'agent-loop: the design-system definition did not load as an object; ' +
          'a definition revision would be measured against nothing',
      );
    }
    return value;
  }

  openSession() {
    const resolve = (r) =>
      path.isAbsolute(r) ? r : path.join(this.projectDir, r);
    this.session = this.compiler.createProjectSession({
      definition: this.definition,
      roots: (this.config.roots ?? []).map(resolve),
      outDir: resolve(this.config.outDir),
      runtimeModule: this.config.runtimeModule,
      designSystemFile: this.config.designSystemFile,
      engineOptions: this.config.engineOptions,
      useCSSLayers: this.config.useCSSLayers === true,
      publishVariant: 'session_incremental_publish',
      // The ONLY thing that differs between the `full_metadata` row and the
      // compact rows.
      auditPolicy: this.variant.auditPolicy,
    });
  }

  /** The warmup: establish the session and a published generation. */
  warmup() {
    this.openSession();
    this.collector.reset();
    this.session.applyAgentChanges({ changed: [] });
    const validation = this.session.validate();
    if (!validation.ok) {
      throw new Error(
        `agent-loop: the warmup revision failed: ${validation.diagnostics
          .map((d) => d.code)
          .join(', ')}`,
      );
    }
    this.session.compile();
    this.collector.reset();
  }

  /**
   * Applies one revision's writes, exactly as an agent would: to the
   * filesystem, and then declared.
   *
   * The writes are FLUSHED before the clock starts, so the harness's own I/O is
   * never counted as compilation.
   */
  async writeRevision(rev) {
    for (const del of rev.deletes ?? []) {
      fs.rmSync(path.join(this.projectDir, del), { force: true });
    }
    for (const write of rev.writes ?? []) {
      const abs = path.join(this.projectDir, write.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, write.content, 'utf8');
    }
    if (rev.definitionEdit === true) {
      // A real change to the design system: a token's value.
      const text = fs.readFileSync(this.definitionPath, 'utf8');
      // The FIRST hex literal in the definition, changed. Which one it is does
      // not matter - a design system is a design system - and deriving it from
      // the bytes rather than hard-coding a colour is what keeps this working
      // when the generator's palette changes.
      const after = text.replace(/#[0-9a-fA-F]{6}/, (m) =>
        m === '#000000' ? '#010203' : '#000000',
      );
      if (after === text) {
        throw new Error(
          'agent-loop: the design-system definition has no hex token value to ' +
            'change; the definition revision would be a no-op',
        );
      }
      fs.writeFileSync(this.definitionPath, after, 'utf8');
      this.definition = await this.loadDefinition();
    }
    for (const write of rev.writes ?? []) {
      const abs = path.join(this.projectDir, write.path);
      try {
        const fd = fs.openSync(abs, 'r');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
      } catch {
        /* a file that vanished again has nothing to flush */
      }
    }
  }

  /**
   * ONE agent step, and every observation it produces.
   *
   * The clock starts immediately before `applyAgentChanges`, so the reported
   * interval contains the session's discovery, hashing, closure, compilation
   * and result building, and not the host's write.
   */
  /**
   * The mutation transaction, with every path ABSOLUTE.
   *
   * The plan speaks in corpus-relative paths, because that is what the corpus
   * manifest uses. The session must not: it resolves a declared path against
   * `process.cwd()`, and this harness runs from the repository root, so a
   * relative path would send it looking for `<repo>/src/components/...`. The
   * transaction would then be a well-formed declaration of a file that does not
   * exist, the session would handle it as a removal, and the cell would report
   * a fast revision that touched nothing - with no error anywhere. Absolute
   * paths are the only honest way to name a file in another directory.
   */
  absoluteMutation(mutation) {
    const abs = (p) => path.resolve(this.projectDir, p);
    return {
      changed: (mutation.changed ?? []).map(abs),
      added: (mutation.added ?? []).map(abs),
      removed: (mutation.removed ?? []).map(abs),
      renamed: (mutation.renamed ?? []).map((r) => ({
        from: abs(r.from),
        to: abs(r.to),
      })),
    };
  }

  async runRevision(rev, index) {
    this.collector.reset();
    await this.writeRevision(rev);
    const out = { rows: [], detail: {} };
    const emit = (metric, value, unit, status, detail) => {
      out.rows.push(
        this.observation(metric, value, unit, status, detail, index, rev),
      );
    };

    // The clock starts here, immediately before the transaction is submitted.
    // The value is NOT the reported interval: the reported one comes from the
    // session's own stamp, taken inside `applyChanges`, which is closer to the
    // work and immune to anything this harness does around the call. This one
    // exists to be the OUTER bound - the harness's own overhead is the gap
    // between the two, and a cell where that gap is large is a cell whose
    // number is mostly harness.
    const t0 = nowNs();
    if (rev.definitionEdit === true) {
      // A design-system change goes through `applyChanges`, not
      // `applyAgentChanges`, because the definition is a separate input from
      // the mutation set. The session takes it as an argument and answers
      // "did the definition change?" by digest - it does not watch the file.
      //
      // This was found by the oracle rather than by inspection: the cell
      // reported `full_fallback: 0` for a revision that was supposed to be one,
      // because the changed definition was written to disk and then never
      // handed to the session. A cell labelled "the one path where the
      // affected set IS the project" that silently measured an ordinary
      // no-fallback edit is worse than no cell at all, and the fix is a
      // different API call rather than a different timer.
      this.session.applyChanges({
        definition: this.definition,
        mutation: this.absoluteMutation(rev.mutation),
      });
    } else {
      this.session.applyAgentChanges(this.absoluteMutation(rev.mutation));
    }
    const validation = this.session.validate();
    const result = validation.agentResult;
    const serialized = this.session.serializeAgentResult();
    const tDiagnostics = nowNs();
    // The wall-clock interval around the diagnostics step, reported as its own
    // observation so the session's stamp can be checked against something an
    // outside clock measured. A drift between the two is a fact about the
    // measurement, and hiding it would be how a number stops being evidence.
    emit('agent_loop_dispatch_ms', (tDiagnostics - t0) / 1e6, 'ms', STATUS.OK, {
      note:
        'outer wall clock around applyAgentChanges + validate + ' +
        'serializeAgentResult; compare with agent_edit_to_diagnostics_ms, ' +
        "which is the session's own stamp",
    });

    const snapshot = this.collector.snapshot();
    const m = result.timings;

    const expectedFailure = rev.expect === 'fail';
    const observedFailure = result.ok === false;
    const verdictOk = expectedFailure === observedFailure;
    if (!verdictOk) {
      emit('verdict', null, 'bool', STATUS.ERROR, {
        harnessFailure: true,
        message: expectedFailure
          ? `revision ${rev.name} was expected to be refused and it was accepted`
          : `revision ${rev.name} was refused: ${result.diagnostics
              .map((d) => d.code)
              .join(', ')}`,
      });
      return out;
    }

    emit('verdict', 1, 'bool', STATUS.OK, {
      revisionId: result.revisionId,
      ok: result.ok,
    });
    emit(
      'agent_edit_to_diagnostics_ms',
      m.agent_edit_to_diagnostics_ms,
      'ms',
      STATUS.OK,
      null,
    );
    emit('agent_result_bytes', serialized.bytes, 'bytes', STATUS.OK, null);
    emit(
      'agent_result_build_ms',
      snapshot.counters.agent_result_build_ms ?? 0,
      'ms',
      STATUS.OK,
      null,
    );
    emit(
      'agent_result_serialize_ms',
      snapshot.counters.agent_result_serialize_ms ?? 0,
      'ms',
      STATUS.OK,
      null,
    );
    // The mutation accounting, so "one file changed" is never reported for a
    // transaction that only read one file.
    for (const [key, metric] of [
      ['declared', 'mutation_declared'],
      ['read', 'mutation_read'],
      ['hashed', 'mutation_hashed'],
      ['contentChanged', 'mutation_content_changed'],
      ['contentUnchanged', 'mutation_content_unchanged'],
    ]) {
      emit(metric, result.mutation[key], 'count', STATUS.OK, {
        noOp: result.mutation.noOp,
      });
    }
    // The work counters: read, hashed, recompiled, reused.
    for (const [key, metric] of [
      ['filesCompiled', 'files_compiled'],
      ['filesRecompiled', 'files_recompiled'],
      ['filesReused', 'files_reused'],
      ['coveredFiles', 'files_covered'],
    ]) {
      emit(metric, result.incremental[key], 'count', STATUS.OK, null);
    }
    emit(
      'dirty_files_read',
      snapshot.counters.dirty_files_read ?? 0,
      'count',
      STATUS.OK,
      null,
    );
    emit(
      'dirty_files_hashed',
      snapshot.counters.dirty_files_hashed ?? 0,
      'count',
      STATUS.OK,
      null,
    );
    // The O(total) loop, split. This is the measurement Phase C was told to
    // take before touching it.
    emit(
      'session_compile_affected_ms',
      snapshot.counters.session_compile_affected_ms ?? 0,
      'ms',
      STATUS.OK,
      null,
    );
    emit(
      'session_reuse_iteration_ms',
      snapshot.counters.session_reuse_iteration_ms ?? 0,
      'ms',
      STATUS.OK,
      null,
    );
    emit(
      'session_coverage_entries_ms',
      snapshot.counters.session_coverage_entries_ms ?? 0,
      'ms',
      STATUS.OK,
      null,
    );
    emit(
      'covered_entries_iterated',
      snapshot.counters.covered_entries_iterated ?? 0,
      'count',
      STATUS.OK,
      null,
    );
    emit(
      'session_incremental_ms',
      snapshot.durations_ms.session_incremental_ms ?? 0,
      'ms',
      STATUS.OK,
      null,
    );
    // EVERY session phase, emitted by name rather than the four the KPI cares
    // about. A profile that lists only the phases somebody expected to matter
    // cannot answer "where did the rest go", and the rest is where the next
    // optimization has to start. `unaccounted_ms` below is the honest headline:
    // it is the diagnostics interval minus everything this harness can name.
    for (const [metric, value] of Object.entries(snapshot.durations_ms)) {
      if (!metric.startsWith('session_')) continue;
      if (metric === 'session_incremental_ms') continue;
      emit(`phase:${metric}`, value, 'ms', STATUS.OK, null);
    }
    // Parse attribution, per pipeline. The closure refresh re-parses module
    // summaries, and a counter cannot say whether a revision that touched one
    // file parsed one thousand modules to rediscover the graph.
    //
    // From Phase D the same is true of the coverage graph and of the
    // design-system views: the counters below are how a reader tells "the
    // closure walked ten thousand nodes" from "the closure examined one", and
    // they are emitted by name for the same reason the phases are.
    const PHASE_D_COUNTERS = [
      'closure_nodes_examined',
      'closure_nodes_reused',
      'closure_nodes_added',
      'closure_nodes_removed',
      'closure_nodes_entering_coverage',
      'closure_nodes_leaving_coverage',
      'closure_nodes_pruned',
      'closure_edges_recomputed',
      'closure_reachability_updates',
      'closure_full_walk',
      'closure_full_fallback',
      'closure_set_divergence',
      'closure_propagation_aborted',
      'closure_update_ms',
      'dsv_files_examined',
      'dsv_files_recomputed',
      'dsv_files_reused',
      'dsv_relay_nodes_touched',
      'dsv_consumers_invalidated',
      'dsv_full_fallback',
      'dsv_relay_hits',
      'dsv_relay_walks',
      'dsv_update_ms',
    ];
    for (const [metric, value] of Object.entries(snapshot.counters)) {
      if (!metric.startsWith('parse_')) continue;
      emit(`counter:${metric}`, value, 'count', STATUS.OK, null);
    }
    for (const name of PHASE_D_COUNTERS) {
      const value = snapshot.counters[name];
      if (value === undefined) continue;
      emit(
        `counter:${name}`,
        value,
        name.endsWith('_ms') ? 'ms' : 'count',
        STATUS.OK,
        null,
      );
    }
    for (const [metric, value] of Object.entries(snapshot.counters)) {
      if (!metric.startsWith('closure_full_fallback_reason_')) continue;
      emit(`counter:${metric}`, value, 'count', STATUS.OK, null);
    }
    // The part of the diagnostics interval no named phase accounts for. The
    // compiler's own `phase()` boundaries are honest but not exhaustive - the
    // module-graph refresh happens inside the closure phase, and the cache it
    // misses is invisible to any boundary - so this is a RESIDUAL, and it is
    // reported as a residual rather than distributed into the phases that
    // happen to be near it.
    const namedMs = Object.entries(snapshot.durations_ms)
      .filter(([k]) => k.startsWith('session_'))
      .reduce((n, [, v]) => n + v, 0);
    emit(
      'unaccounted_diagnostics_ms',
      Math.max(0, m.agent_edit_to_diagnostics_ms - namedMs),
      'ms',
      STATUS.OK,
      {
        note:
          'agent_edit_to_diagnostics_ms minus the sum of every session_* ' +
          'phase the compiler reports; a residual, not a phase',
      },
    );
    emit(
      'full_fallback',
      result.incremental.fullFallback ? 1 : 0,
      'bool',
      STATUS.OK,
      {
        reason: result.incremental.fullFallbackReason,
      },
    );

    // ---- milestone B: the generation, if this variant publishes at all ----
    if (this.variant.publishes) {
      if (result.ok) {
        this.session.compile();
      }
      // A refused revision publishes nothing, so there is no generation
      // milestone to report and none is invented.
      const after = this.session.agentResult();
      const am = after.timings;
      emit(
        'agent_edit_to_generation_ready_ms',
        am.agent_edit_to_generation_ready_ms,
        'ms',
        am.generationReady === true ? STATUS.OK : STATUS.UNSUPPORTED,
        am.generationReady === true
          ? null
          : { reason: 'the revision did not publish' },
      );
      emit(
        'agent_edit_to_generation_committed_ms',
        am.agent_edit_to_generation_committed_ms,
        'ms',
        am.generationCommitted === true ? STATUS.OK : STATUS.UNSUPPORTED,
        am.generationCommitted === true
          ? null
          : { reason: 'the revision did not publish' },
      );
      const afterSnapshot = this.collector.snapshot();
      emit(
        'build_report_bytes',
        afterSnapshot.counters.build_report_bytes ?? 0,
        'bytes',
        STATUS.OK,
        { auditPolicy: this.variant.auditPolicy },
      );
      emit(
        'build_report_build_ms',
        afterSnapshot.counters.build_report_build_ms ?? 0,
        'ms',
        STATUS.OK,
        null,
      );
      emit(
        'build_report_serialize_ms',
        afterSnapshot.counters.build_report_serialize_ms ?? 0,
        'ms',
        STATUS.OK,
        null,
      );
      emit(
        'metadata_bytes_written_hotpath',
        afterSnapshot.counters.metadata_bytes_written ?? 0,
        'bytes',
        STATUS.OK,
        { policy: 'on successful publication' },
      );
    } else {
      // The variant that does not publish. Reported as `unsupported` with a
      // reason, never as 0: a zero would be a fabricated measurement of work
      // that was correctly not done.
      for (const metric of [
        'agent_edit_to_generation_ready_ms',
        'agent_edit_to_generation_committed_ms',
        'build_report_bytes',
        'metadata_bytes_written_hotpath',
      ]) {
        emit(metric, null, 'ms', STATUS.UNSUPPORTED, {
          reason: `${this.variantName} does not publish; the agent loop stops at diagnostics`,
        });
      }
    }

    // ---- milestone C: the audit, only when somebody asks for it ----
    if (this.variant.audits) {
      if (result.ok) {
        const request = this.session.requestFullAudit({});
        out.detail.audit = request;
        const final = this.session.agentResult();
        emit(
          'agent_edit_to_audit_report_ms',
          final.timings.agent_edit_to_audit_report_ms,
          'ms',
          STATUS.OK,
          null,
        );
        emit('coverage_report_bytes', request.bytes, 'bytes', STATUS.OK, {
          inGeneration: request.inGeneration,
        });
        const auditSnapshot = this.collector.snapshot();
        emit(
          'coverage_report_build_ms',
          auditSnapshot.counters.coverage_report_build_ms ?? 0,
          'ms',
          STATUS.OK,
          null,
        );
        emit(
          'coverage_report_serialize_ms',
          auditSnapshot.counters.coverage_report_serialize_ms ?? 0,
          'ms',
          STATUS.OK,
          null,
        );
        emit(
          'metadata_bytes_written_audit',
          auditSnapshot.counters.coverage_report_bytes ?? 0,
          'bytes',
          STATUS.OK,
          null,
        );
      } else {
        for (const metric of [
          'agent_edit_to_audit_report_ms',
          'coverage_report_bytes',
          'metadata_bytes_written_audit',
        ]) {
          emit(metric, null, 'ms', STATUS.UNSUPPORTED, {
            reason:
              'a refused revision has no generation, so it has no project-wide ' +
              'snapshot to materialize',
          });
        }
      }
    } else {
      for (const metric of [
        'agent_edit_to_audit_report_ms',
        'coverage_report_bytes',
        'metadata_bytes_written_audit',
      ]) {
        emit(metric, null, 'ms', STATUS.UNSUPPORTED, {
          reason: `${this.variantName} does not request the audit`,
        });
      }
    }

    out.detail.revisionId = result.revisionId;
    out.detail.ok = result.ok;
    out.detail.diagnostics = result.diagnostics.map((d) => ({
      code: d.code,
      rule: d.rule,
      file: d.source.file,
      line: d.source.line,
      repair: d.repair?.kind ?? null,
    }));
    out.detail.mutation = result.mutation;
    out.detail.incremental = result.incremental;
    return out;
  }

  observation(metric, value, unit, status, detail, index, rev) {
    return {
      engine: `agent_loop_${this.variantName}`,
      corpus: this.corpusName,
      scenario: `${this.scenarioName}#${rev.name}`,
      variant: this.variantName,
      audit_policy: this.variant.auditPolicy,
      publishes: this.variant.publishes,
      audits: this.variant.audits,
      cache_state: 'process_warm_agent_loop',
      session_id: `${this.scenarioName}-${this.variantName}-i${this.iteration}`,
      iteration: index,
      metric,
      unit,
      status,
      value,
      schema_version: SCHEMA_VERSION,
      harness_version: HARNESS_VERSION,
      run_kind: 'qualification',
      detail,
    };
  }

  dispose() {
    try {
      this.session?.close();
    } catch {
      /* a session that is already closed is not a measurement problem */
    }
    this.compiler?.installPerfCollector(null);
  }
}

// -------------------------------------------------------------- the runner ---

/**
 * One cell. Every revision is a transaction; the first is a warmup whose
 * observations are discarded.
 */
async function runCell({
  corpusDir,
  corpusName,
  projectDir,
  variant,
  scenario,
  iteration,
}) {
  const loop = new AgentLoop({
    corpusDir,
    projectDir,
    variant,
    scenario,
    iteration,
    corpusName,
  });
  const rows = [];
  try {
    await loop.prepare();
    loop.warmup();
    for (const [index, rev] of loop.revisions.entries()) {
      const out = await loop.runRevision(rev, index);
      rows.push(...out.rows);
    }
  } catch (err) {
    rows.push({
      engine: `agent_loop_${variant}`,
      corpus: corpusName,
      scenario: `${scenario}`,
      variant,
      cache_state: 'process_warm_agent_loop',
      session_id: `${scenario}-${variant}-i${iteration}`,
      iteration: 0,
      metric: 'harness_failure',
      unit: 'none',
      status: STATUS.ERROR,
      value: null,
      schema_version: SCHEMA_VERSION,
      harness_version: HARNESS_VERSION,
      run_kind: 'qualification',
      detail: { message: String(err?.message ?? err).slice(0, 600) },
    });
  } finally {
    loop.dispose();
  }
  return rows;
}

function parseArgs(argv) {
  const out = { iterations: 7, variants: Object.keys(VARIANTS) };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--corpus') out.corpus = argv[++i];
    else if (a === '--out-dir') out.outDir = argv[++i];
    else if (a === '--iterations') out.iterations = Number(argv[++i]);
    else if (a === '--scenarios') out.scenarios = argv[++i].split(',');
    else if (a === '--variants') out.variants = argv[++i].split(',');
    else if (a === '--self-test') out.selfTest = true;
    else if (a === '--corpus-name') out.corpusName = argv[++i];
    else if (a === '--cell') out.cell = true;
    else if (a === '--variant') out.cellVariant = argv[++i];
    else if (a === '--scenario') out.cellScenario = argv[++i];
    else if (a === '--iteration') out.cellIteration = Number(argv[++i]);
    else if (a === '--project-dir') out.projectDir = argv[++i];
    else if (a === '--rows-out') out.rowsOut = argv[++i];
  }
  return out;
}

/**
 * ONE cell, in THIS process. The mode a spawned child runs in.
 *
 * The rows go to a FILE rather than to stdout so that a stray log line from the
 * compiler cannot corrupt the observation stream, and so a parent can read
 * them without having to parse anything it did not ask for.
 */
async function runCellProcess(args, corpusName) {
  const rows = await runCell({
    corpusDir: args.corpus,
    corpusName,
    projectDir: args.projectDir,
    variant: args.cellVariant,
    scenario: args.cellScenario,
    iteration: args.cellIteration,
  });
  if (args.rowsOut != null) {
    fs.writeFileSync(
      args.rowsOut,
      rows.map((r) => JSON.stringify(r)).join('\n'),
    );
  }
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    await runSelfTest();
    return;
  }
  if (args.cell === true) {
    const corpusName = args.corpusName ?? path.basename(args.corpus);
    runCellProcess(args, corpusName)
      .then((rows) => {
        process.stderr.write(
          `cell ${args.cellVariant} ${args.cellScenario} i${args.cellIteration}: ` +
            `${rows.length} rows\n`,
        );
      })
      .catch((err) => {
        process.stderr.write(`cell failed: ${err?.stack ?? err}\n`);
        process.exit(1);
      });
    return;
  }
  if (args.corpus == null || args.outDir == null) {
    process.stderr.write(
      'agent-loop: --corpus and --out-dir are required (or --self-test)\n',
    );
    process.exit(2);
  }
  const corpusName = args.corpusName ?? path.basename(args.corpus);
  const scenarios = args.scenarios ?? Object.keys(SCENARIOS);
  // The scratch tree lives UNDER the output directory, not in the system temp
  // directory, for one operational reason: a campaign at c10000 materialises a
  // project of ten thousand files per cell, and a cell that dies leaves its
  // copy behind. Putting the scratch next to the observations means one `rm -rf`
  // of a directory the campaign already owns cleans up after a failed run, and
  // a reader can see how much disk the run is using.
  const scratch = path.join(args.outDir, 'scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const rows = [];
  for (const variant of args.variants) {
    if (VARIANTS[variant] == null) {
      throw new Error(`agent-loop: unknown variant ${JSON.stringify(variant)}`);
    }
    for (const scenario of scenarios) {
      for (let iteration = 0; iteration < args.iterations; iteration += 1) {
        const tag = `${variant}-${scenario}-i${iteration}`;
        const projectDir = path.join(scratch, tag);
        const rowsOut = path.join(scratch, `${tag}.jsonl`);
        // One CHILD per cell. See the note at the top of this file: a session
        // holds its per-file contributions, and many of them in one address
        // space is gigabytes, which is not a benchmark.
        const child = spawnSync(
          process.execPath,
          [
            __filename,
            '--cell',
            '--corpus',
            args.corpus,
            '--corpus-name',
            corpusName,
            '--variant',
            variant,
            '--scenario',
            scenario,
            '--iteration',
            String(iteration),
            '--project-dir',
            projectDir,
            '--rows-out',
            rowsOut,
          ],
          { encoding: 'utf8', timeout: 60 * 60 * 1000 },
        );
        if (child.status !== 0) {
          // A cell that died is a FAILED CELL, recorded as one. Silently
          // dropping it would produce a summary that looks complete and is not.
          rows.push({
            engine: `agent_loop_${variant}`,
            corpus: corpusName,
            scenario,
            variant,
            audit_policy: VARIANTS[variant].auditPolicy,
            cache_state: 'process_warm_agent_loop',
            session_id: `cell-${tag}`,
            iteration: 0,
            metric: 'cell_process',
            unit: 'none',
            status: STATUS.ERROR,
            value: null,
            schema_version: SCHEMA_VERSION,
            harness_version: HARNESS_VERSION,
            run_kind: 'qualification',
            detail: {
              message: `the cell process exited ${child.status}: ${String(child.stderr ?? '').slice(0, 600)}`,
            },
          });
          process.stderr.write(
            `${variant} ${scenario} i${iteration}: CELL PROCESS FAILED (${child.status})\n`,
          );
          continue;
        }
        const produced = fs
          .readFileSync(rowsOut, 'utf8')
          .split('\n')
          .filter((l) => l.trim() !== '')
          .map((l) => JSON.parse(l));
        rows.push(...produced);
        const failures = produced.filter((r) => r.status === STATUS.ERROR);
        process.stderr.write(
          `${variant} ${scenario} i${iteration}: ${produced.length} rows, ` +
            `${failures.length} error\n`,
        );
        for (const f of failures) {
          process.stderr.write(`  ${f.metric}: ${f.detail?.message}\n`);
        }
        // Each cell gets a clean project, so no cell can see another's edit.
        fs.rmSync(projectDir, { recursive: true, force: true });
        fs.rmSync(rowsOut, { force: true });
      }
    }
  }
  fs.mkdirSync(args.outDir, { recursive: true });
  fs.rmSync(scratch, { recursive: true, force: true });
  const out = path.join(args.outDir, `${corpusName}-agent-loop.jsonl`);
  fs.writeFileSync(
    out,
    rows.map((r) => JSON.stringify(r)).join('\n') +
      (rows.length > 0 ? '\n' : ''),
    'utf8',
  );
  process.stderr.write(
    `agent-loop: wrote ${rows.length} observations to ${out}\n`,
  );
  if (rows.some((r) => r.status === STATUS.ERROR)) process.exitCode = 1;
}

/**
 * The harness's own test, and it is a REAL one.
 *
 * It runs the smallest corpus cell of the smallest variant end to end and
 * asserts the four things a harness like this can get wrong: that a no-op is
 * reported as a no-op, that a violation is reported as a violation, that the
 * repair publishes, and that every reported milestone is present. A harness
 * whose own test asserted only that it "ran" would be asserting nothing.
 */
async function runSelfTest() {
  const corpusDir = process.env.PMS_AGENT_LOOP_CORPUS;
  if (corpusDir == null) {
    process.stderr.write(
      'agent-loop: --self-test needs PMS_AGENT_LOOP_CORPUS pointing at a ' +
        'generated corpus (benchmarks/pandamstyle/src/generate-corpus.js)\n',
    );
    process.exit(2);
  }
  const failures = [];
  const check = (name, condition, detail) => {
    if (condition) process.stdout.write(`  ok   ${name}\n`);
    else {
      failures.push(name);
      process.stdout.write(`  FAIL ${name}${detail ? ` (${detail})` : ''}\n`);
    }
  };
  const scratch = path.join(os.tmpdir(), 'pms-agent-loop-selftest');

  for (const [scenario, metric] of [
    ['one_file_existing_atoms', 'agent_edit_to_diagnostics_ms'],
    ['forbidden_value', 'agent_edit_to_diagnostics_ms'],
    ['repair_forbidden_value', 'agent_edit_to_diagnostics_ms'],
    ['no_change', 'agent_edit_to_diagnostics_ms'],
    ['token_value_full_fallback', 'agent_edit_to_diagnostics_ms'],
  ]) {
    const rows = await runCell({
      corpusDir,
      corpusName: path.basename(corpusDir),
      projectDir: path.join(scratch, scenario),
      variant: 'compact_agent_result',
      scenario,
      iteration: 0,
    });
    const errors = rows.filter((r) => r.status === STATUS.ERROR);
    check(
      `${scenario}: no harness or verdict failure`,
      errors.length === 0,
      errors[0]?.detail?.message,
    );
    const value = rows.find((r) => r.metric === metric);
    check(
      `${scenario}: ${metric} is present and positive`,
      value != null && value.status === STATUS.OK && value.value > 0,
      String(value?.value),
    );
    if (scenario === 'no_change') {
      const noOp = rows.find((r) => r.metric === 'mutation_content_unchanged');
      const changed = rows.find((r) => r.metric === 'mutation_content_changed');
      check(
        'no_change: reported as a no-op, not as an edit',
        noOp?.value === 1 && changed?.value === 0,
      );
    }
    if (scenario === 'token_value_full_fallback') {
      const fallback = rows.find((r) => r.metric === 'full_fallback');
      check(
        'token_value_full_fallback: the design-system change IS a counted fallback',
        fallback?.value === 1 &&
          fallback?.detail?.reason === 'design-system-definition',
        `${fallback?.value} / ${fallback?.detail?.reason}`,
      );
      // And it really recompiled the project: a fallback that only dropped a
      // counter would be a fallback in name only.
      const compiled = rows.find((r) => r.metric === 'files_compiled');
      check(
        'token_value_full_fallback: the project was recompiled, not just recounted',
        (compiled?.value ?? 0) > 100,
        String(compiled?.value),
      );
    }
    if (scenario === 'forbidden_value') {
      const gen = rows.find(
        (r) => r.metric === 'agent_edit_to_generation_committed_ms',
      );
      check(
        'forbidden_value: no generation milestone is invented',
        gen?.status === STATUS.UNSUPPORTED,
      );
    }
    fs.rmSync(path.join(scratch, scenario), { recursive: true, force: true });
  }

  // The variants differ, and they differ for the stated reason.
  const published = await runCell({
    corpusDir,
    corpusName: path.basename(corpusDir),
    projectDir: path.join(scratch, 'published'),
    variant: 'compact_agent_result_plus_compact_publish_metadata',
    scenario: 'one_file_existing_atoms',
    iteration: 0,
  });
  const report = published.find((r) => r.metric === 'build_report_bytes');
  check('compact publication writes a build report', report?.value > 0);

  const inline = await runCell({
    corpusDir,
    corpusName: path.basename(corpusDir),
    projectDir: path.join(scratch, 'inline'),
    variant: 'full_metadata',
    scenario: 'one_file_existing_atoms',
    iteration: 0,
  });
  const inlineReport = inline.find((r) => r.metric === 'build_report_bytes');
  check(
    'the inline policy writes a LARGER report than the compact one',
    inlineReport?.value > report.value,
    `inline=${inlineReport?.value} compact=${report.value}`,
  );
  fs.rmSync(scratch, { recursive: true, force: true });

  process.stdout.write(
    `\nagent-loop self-test: ${failures.length === 0 ? 'pass' : `${failures.length} FAILED`}\n`,
  );
  if (failures.length > 0) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  AgentLoop,
  SCENARIOS,
  STATUS,
  VARIANTS,
  HARNESS_VERSION,
  SCHEMA_VERSION,
  corpusFiles,
  linkCompiler,
  makeCollector,
  materialiseProject,
  nowNs,
  planRevisions,
  runCell,
  sha256,
};
