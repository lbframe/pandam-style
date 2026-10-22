/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Shared support for the AG-01.2 audit suites: the observable-state snapshot
 * `S` of the design note (§5.1), the audit list reader, the AC2 revision
 * states and the filesystem helpers. Every filesystem change happens under
 * temporary directories the fixtures or these helpers create.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  compiler,
  definitionWith,
  emptyMutation,
  follow,
  openAgentProject,
  readReferenced,
  request,
} = require('./agent-helpers');
const { openExistingProject, openProject } = require('./session-helpers');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/**
 * SHA-256 of every regular file under `dir`, keyed by relative path; a file
 * the test cannot read is recorded by its mode, and a link, FIFO or socket by
 * its kind, so the digest never blocks or follows anything.
 */
function hashTree(dir) {
  const out = {};
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.name === 'node_modules') continue;
      const rel = path.relative(dir, abs);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isSymbolicLink())
        out[rel] = `link:${fs.readlinkSync(abs)}`;
      else if (!entry.isFile()) out[rel] = 'special';
      else {
        try {
          out[rel] = sha256(fs.readFileSync(abs));
        } catch {
          out[rel] = `unreadable:${fs.statSync(abs).mode}`;
        }
      }
    }
  };
  walk(dir);
  return out;
}

function auditDirOf(fixture) {
  return path.join(
    path.dirname(fixture.outDir),
    `.${path.basename(fixture.outDir)}.pms-audit`,
  );
}

/** A perf collector that records every metric name and value it receives. */
function recordingCollector() {
  const durations = {};
  const counts = {};
  return {
    durations,
    counts,
    addDuration(name) {
      durations[name] = (durations[name] ?? 0) + 1;
    },
    addCount(name, value) {
      counts[name] = (counts[name] ?? 0) + value;
    },
    addParse() {
      counts['<parse>'] = (counts['<parse>'] ?? 0) + 1;
    },
    sampleMemory() {},
    reset() {},
    snapshot() {
      return { durations, counts };
    },
  };
}

/**
 * The host perf collector's view of `run`: every count and duration recorded
 * while it runs, except the queue's own per-call instrumentation, which every
 * queued operation records, consultations included (AG-01.1).
 */
async function perfDuring(run) {
  const previous = compiler.perfCollector();
  const collector = recordingCollector();
  compiler.installPerfCollector(collector);
  try {
    await run();
  } finally {
    compiler.installPerfCollector(previous);
  }
  const durations = Object.keys(collector.durations).filter(
    (name) => !name.startsWith('project_service_queue_'),
  );
  return { counts: collector.counts, durations };
}

const without = (value, key) => {
  const { [key]: _drop, ...rest } = value;
  return rest;
};

/**
 * `S(project)` (§5.1): the current generation, the v1 document, the `check`
 * envelope without its request id, the snapshot retention stats, the session
 * identities (the design-system identity among them), and a digest of every
 * file under the project root (sources, `outDir`, the state file and the
 * audit directory). On an unvalidated revision, `check` would validate, so the
 * snapshot records the refusal of `agentResult` instead.
 */
async function observe(project, rev, { validated = true } = {}) {
  const { session, fixture } = project;
  const state = {
    current: await session.current(),
    retention: await session.acceptedSnapshotRetentionStats(),
    identities: (await project.dispatch('session.status', {})).identities,
    files: hashTree(fixture.project),
  };
  if (validated) {
    state.v1 = JSON.stringify(await session.agentResult(rev));
    state.check = without(
      await project.dispatch('check', { rev }),
      'requestId',
    );
  } else {
    state.v1 = await session.agentResult(rev).then(
      () => 'resolved',
      (error) => error.diagnostics?.[0]?.context?.reason ?? 'thrown',
    );
  }
  return state;
}

/** The v1 `audit` block of the current revision. */
async function auditBlock(project, rev) {
  return (await project.session.agentResult(rev)).audit;
}

/**
 * Reads the complete audit list of `rev` by following only returned
 * references, and every withheld record through `records.read`.
 */
async function readAuditList(
  project,
  rev,
  { view = 'detail', limit = 256 } = {},
) {
  const records = [];
  let reference = {
    operation: 'audit.compute',
    view,
    input: { rev, page: { offset: 0, limit } },
  };
  let first = null;
  for (let guard = 0; guard < 100000 && reference != null; guard += 1) {
    const response = await follow(project.dispatch, reference);
    expect(response.outcome).toBe('success');
    if (first == null) first = response;
    records.push(...response.result.page.records);
    for (const entry of response.withheld) {
      const read = response.references.find(
        (item) =>
          item.operation === 'records.read' &&
          JSON.stringify(item.input.address) === JSON.stringify(entry.address),
      );
      expect(read).toBeDefined();
      const text = await readReferenced(project.dispatch, read);
      expect(text.sha256).toBe(entry.sha256);
      records.push(JSON.parse(text.text));
    }
    reference =
      response.references.find((item) => item.operation === 'audit.compute') ??
      null;
  }
  expect(records).toHaveLength(first.page.total);
  return { audit: first.result.audit, records, first };
}

/** Project paths in records are host paths: compared relative to the root. */
const portable = (value, root) =>
  JSON.parse(JSON.stringify(value).split(root).join('<root>'));

/**
 * A cold session over a byte copy of `fixture`'s inputs, in the same working
 * directory: the copy holds the same sources and shared definition, never the
 * output, its state or the audit directory.
 */
async function coldCopy(fixture, options = {}) {
  const from = path.dirname(fixture.project);
  const to = fs.mkdtempSync(path.join(path.dirname(from), 'cold-'));
  const unreadable = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.name === 'node_modules') continue;
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && (fs.statSync(abs).mode & 0o444) === 0) {
        unreadable.push(abs);
        fs.chmodSync(abs, 0o644);
      }
    }
  };
  walk(fixture.project);
  try {
    fs.cpSync(from, to, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (src) =>
        src !== fixture.outDir &&
        !src.startsWith(`${fixture.outDir}${path.sep}`) &&
        !src.includes('.pms-audit') &&
        !/\.pms-state(?:\.pending)?\.json$/.test(src),
    });
  } finally {
    for (const file of unreadable) {
      fs.chmodSync(file, 0);
      fs.chmodSync(path.join(to, path.relative(from, file)), 0);
    }
  }
  const project = path.join(to, path.basename(fixture.project));
  const copy = openExistingProject(project);
  const session = copy.openPublicSession(options.sessionOptions ?? {});
  const binding = await compiler.createAgentBinding({
    session,
    initialize: true,
  });
  const capability = binding.mintCapability({ grants: ['consult'] });
  const dispatch = (operation, input, extra = {}, dispatchOptions = {}) =>
    binding.dispatch(request(operation, input, extra), {
      capability,
      ...dispatchOptions,
    });
  return {
    fixture: copy,
    session,
    binding,
    dispatch,
    root: project,
    async revision() {
      return (await dispatch('session.status', {})).identities.revision;
    },
    close: () => session.close(),
  };
}

/** The portable audit list of the current revision of `project`. */
async function portableList(project, root) {
  const rev = await project.revision();
  await project.session.validate(rev);
  const { audit, records } = await readAuditList(project, rev);
  return portable({ audit: without(audit, 'canonical'), records }, root);
}

// ------------------------------------------------- AC2 revision states ----

const HEADER =
  "import { create, token } from '../generated/design.pandamstyle';\n";

function cycleDefinition(fixture) {
  return definitionWith(fixture, (definition) => {
    definition.tokens.spacing.loopA = {
      ref: 'spacing.loopB',
      visibility: 'public',
    };
    definition.tokens.spacing.loopB = {
      ref: 'spacing.loopA',
      visibility: 'public',
    };
  });
}

/** The valid fixture with a condition the default profile does not support. */
function unsupportedCondition(fixture) {
  let definition = fs.readFileSync(fixture.sharedDefinitionPath, 'utf8');
  definition = definition.replace(
    "reducedMotion: '@media (prefers-reduced-motion: reduce)',",
    "reducedMotion: '@media (prefers-reduced-motion: reduce)',\n    stuck: '@container scroll-state(stuck: top)',",
  );
  fs.writeFileSync(fixture.sharedDefinitionPath, definition);
  const page = fixture.src('src/page.js');
  fs.writeFileSync(
    page,
    fs
      .readFileSync(page, 'utf8')
      .replace(
        'padding: { base: SPACING.md, wide: SPACING.lg },',
        'padding: { base: SPACING.md, wide: SPACING.lg, stuck: SPACING.xl },',
      ),
  );
}

const FORBIDDEN_PAGE = `${HEADER}export const bad = create({ box: { padding: '13px' } });\n`;

/**
 * The invalid revision states of AC2, one per stage of §1.4. `expect` is the
 * observed stage, completeness and limitations. A scan error has no external
 * trigger in this build: discovery reports unreadable paths instead of
 * throwing, and the design-system build, which runs first, is the only
 * failure that reaches the same field (the token cycle and invalid targets).
 */
const INVALID_STATES = [
  {
    name: 'token cycle',
    fixture: 'valid',
    options: (base) => ({ definition: cycleDefinition(base) }),
    expect: {
      stage: 'none',
      completeness: 'unknown',
      limitations: [
        'validation-failed',
        'design-system-unavailable',
        'closure-not-computed',
      ],
    },
  },
  {
    name: 'invalid targets',
    fixture: 'valid',
    options: () => ({
      sessionOptions: { targets: { profiles: ['nope'] } },
    }),
    expect: {
      stage: 'none',
      completeness: 'unknown',
      limitations: [
        'validation-failed',
        'design-system-unavailable',
        'closure-not-computed',
      ],
    },
  },
  {
    name: 'unresolved import',
    fixture: 'neg-unresolved-import',
    expect: {
      stage: 'closure-partial',
      completeness: 'partial',
      limitations: [
        'validation-failed',
        'closure-incomplete',
        'analysis-not-run',
      ],
    },
  },
  {
    // Observed: an unreadable covered file fails while the closure is parsed,
    // before the analysis, so it is a partial closure, not an analysed one.
    name: 'unreadable file',
    fixture: 'valid',
    options: () => ({
      prepare: (fixture) => fs.chmodSync(fixture.src('src/renamed.js'), 0),
    }),
    expect: {
      stage: 'closure-partial',
      completeness: 'partial',
      limitations: [
        'validation-failed',
        'closure-incomplete',
        'analysis-not-run',
      ],
    },
  },
  {
    name: 'page failure',
    fixture: 'neg-forbidden-value',
    expect: {
      stage: 'analysed',
      completeness: 'complete',
      limitations: ['validation-failed', 'failed-files-without-rules'],
    },
  },
  {
    name: 'mixed project',
    fixture: 'valid',
    options: () => ({
      prepare: (fixture) =>
        fs.writeFileSync(fixture.src('src/zz-bad.js'), FORBIDDEN_PAGE),
    }),
    expect: {
      stage: 'analysed',
      completeness: 'complete',
      limitations: ['validation-failed', 'failed-files-without-rules'],
    },
  },
  {
    name: 'target evaluation',
    fixture: 'valid',
    options: () => ({
      prepare: unsupportedCondition,
      sessionOptions: { targets: { profiles: ['pandamstyle:default@1'] } },
    }),
    expect: {
      stage: 'analysed',
      completeness: 'complete',
      limitations: ['validation-failed'],
    },
  },
];

async function openState(state) {
  const base = openProject('valid');
  return openAgentProject(state.fixture, state.options?.(base) ?? {});
}

// --------------------------------------------------------- filesystem ----

/** Every regular `*.tmp` file under `dir`. */
function tempFilesUnder(dir) {
  const out = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.name === 'node_modules') continue;
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.endsWith('.tmp')) out.push(abs);
    }
  };
  walk(dir);
  return out;
}

function openDescriptors() {
  return fs.readdirSync('/proc/self/fd').length;
}

/** A fresh directory outside every fixture, holding one victim file. */
function outsideDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-ag012-outside-'));
  fs.writeFileSync(path.join(dir, 'victim.txt'), 'victim\n');
  return dir;
}

module.exports = {
  FORBIDDEN_PAGE,
  HEADER,
  INVALID_STATES,
  auditBlock,
  auditDirOf,
  coldCopy,
  emptyMutation,
  hashTree,
  observe,
  openDescriptors,
  openState,
  outsideDir,
  perfDuring,
  portable,
  portableList,
  readAuditList,
  sha256,
  tempFilesUnder,
  without,
};
