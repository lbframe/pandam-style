/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * AG-01.2 §5.2: the anchored audit writer and reader under attack, against
 * the real session code. The module-private step hook runs an attack, a
 * content edit or a fault between filesystem steps; each case asserts the
 * outside directory and the sources are untouched, no temporary file remains,
 * the outcome is structured, a failure records nothing, and a read reports
 * `fresh` only for the canonical bytes in the pinned location. A mutant build
 * with one path-based step proves the harness sees the class.
 *
 * Every attack runs under temporary directories this suite creates.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { compiler, request } = require('./agent-helpers');
const { openProject } = require('./session-helpers');
const { evaluateDefinitionText } = require('./pms-helpers');
const {
  auditDirOf,
  hashTree,
  openDescriptors,
  outsideDir,
  sha256,
  tempFilesUnder,
} = require('./agent-audit-support');

jest.setTimeout(600000);

const BUNDLE = path.resolve(
  __dirname,
  '../../../../.pms-test-support/compiler-inspection.cjs',
);

const WRITER_REASONS = [
  'audit-directory-not-directory',
  'audit-temp-exists',
  'audit-file-not-file',
  'audit-directory-moved',
  'audit-file-replaced',
  'audit-content-mismatch',
  'audit-write-failed',
];

/** A bound session of `name` built by `module` (the real or a mutant build). */
async function openWith(module, name = 'valid') {
  const fixture = openProject(name);
  const session = module.createPublicProjectSession({
    definition: evaluateDefinitionText(fixture.definitionPath),
    roots: fixture.roots,
    outDir: fixture.outDir,
    designSystemFile: fixture.config.designSystemFile,
    engineOptions: fixture.config.engineOptions,
    useCSSLayers: fixture.config.useCSSLayers === true,
    projectId: fixture.project,
    rootDir: fixture.project,
  });
  const binding = await module.createAgentBinding({
    session,
    initialize: true,
  });
  const consult = binding.mintCapability({ grants: ['consult'] });
  const write = binding.mintCapability({ grants: ['materialize-audit'] });
  const dispatch = (operation, input, capability = consult) =>
    binding.dispatch(request(operation, input), { capability });
  const rev = (await dispatch('session.status', {})).identities.revision;
  await session.validate(rev);
  await session.compile(rev);
  return {
    module,
    fixture,
    session,
    binding,
    dispatch,
    rev,
    write,
    root: fixture.project,
    auditDir: auditDirOf(fixture),
    final: path.join(
      auditDirOf(fixture),
      `coverage-rev-${rev.revisionId}.json`,
    ),
    close: () => session.close(),
  };
}

/** A writer call, reduced to its structured outcome. */
const WRITERS = {
  'audit.materialize': async (project) => {
    const response = await project.dispatch(
      'audit.materialize',
      { rev: project.rev, expectedGenerationId: 1 },
      project.write,
    );
    if (response.outcome === 'success')
      return { ok: true, receipt: response.result };
    return {
      ok: false,
      outcome: response.outcome,
      code: response.diagnostics[0]?.code ?? null,
      reason: response.diagnostics[0]?.context?.reason ?? null,
      errno: response.diagnostics[0]?.context?.errno ?? null,
      failure: response.failure,
    };
  },
  'SDK requestFullAudit': async (project) => {
    try {
      const result = await project.session.requestFullAudit(project.rev);
      // The SDK result reports no digest: the file is hashed by the case.
      return {
        ok: true,
        receipt: { path: result.path, bytes: result.bytes, sha256: null },
      };
    } catch (error) {
      return {
        ok: false,
        code: error.diagnostics?.[0]?.code ?? null,
        reason: error.diagnostics?.[0]?.context?.reason ?? null,
        errno: error.diagnostics?.[0]?.context?.errno ?? null,
        raw: error.diagnostics == null ? String(error) : null,
      };
    }
  },
};

/**
 * A hook that forces short writes (1,000-byte chunks) and runs `action` at the
 * `occurrence`-th call of `step`.
 */
function hookAt(step, occurrence, action) {
  const seen = Object.create(null);
  return (name, at) => {
    seen[name] = (seen[name] ?? 0) + 1;
    if (name === step && seen[name] === occurrence) action(at ?? {});
    if (name === 'write') return 1000;
    return undefined;
  };
}

const WRITER_STEPS = [
  ['anchor', 1],
  ['mkdir', 1],
  ['open-dir', 1],
  ['create', 1],
  ['identity', 1],
  ['write', 1],
  ['write', 2],
  ['fsync', 1],
  ['close', 1],
  ['rename', 1],
  ['nominal-check', 1],
  ['verify-lstat', 1],
  ['verify-open', 1],
  ['verify-fstat', 1],
  ['verify-read', 1],
  ['verify-read', 2],
  ['verify-after', 1],
  ['nominal-final', 1],
];

/** Swaps `target` for a symlink to `to`; returns the undo. */
function swapForLink(target, to) {
  if (!fs.existsSync(target)) {
    fs.symlinkSync(to, target);
    return () => fs.rmSync(target, { force: true });
  }
  const parked = `${target}.parked`;
  fs.renameSync(target, parked);
  fs.symlinkSync(to, target);
  return () => {
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(parked, target);
  };
}

function replaceEntry(file, make) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { recursive: true, force: true });
  make(file);
}

/** The attacks of §5.2 against the writer; each returns its undo, if any. */
function writerAttacks(project, outside) {
  const victim = path.join(outside, 'victim.txt');
  return {
    'audit directory → symlink to outside': () =>
      swapForLink(project.auditDir, outside),
    'outDir → symlink to outside': () =>
      swapForLink(project.fixture.outDir, outside),
    'project directory → symlink to outside': () =>
      swapForLink(project.root, outside),
    'final → symlink to a victim': () =>
      replaceEntry(project.final, (file) => fs.symlinkSync(victim, file)),
    'final → directory': () =>
      replaceEntry(project.final, (file) => fs.mkdirSync(file)),
    'final → FIFO': () =>
      replaceEntry(project.final, (file) => spawnSync('mkfifo', [file])),
    'temporary name → symlink': (at) => {
      if (at.tmp == null) return undefined;
      replaceEntry(path.join(project.auditDir, at.tmp), (file) =>
        fs.symlinkSync(victim, file),
      );
      return () =>
        fs.rmSync(path.join(project.auditDir, at.tmp), { force: true });
    },
    'audit directory moved away': () => {
      if (!fs.existsSync(project.auditDir)) return undefined;
      const moved = `${project.auditDir}.moved`;
      fs.renameSync(project.auditDir, moved);
      return () => {
        fs.rmSync(project.auditDir, { recursive: true, force: true });
        fs.renameSync(moved, project.auditDir);
      };
    },
  };
}

/** Resets the audit directory and the outside directory between cases. */
function reset(project, outside) {
  for (const suffix of ['', '.parked', '.moved'])
    fs.rmSync(`${project.auditDir}${suffix}`, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'victim.txt'), 'victim\n');
}

/**
 * Runs one writer case and returns its violations (empty when it holds). The
 * oracle is the design note's, applied to the real session.
 */
async function writerCase(project, write, outside, hook, undoBox) {
  const violations = [];
  const sources = hashTree(project.fixture.src('src'));
  const outsideBefore = hashTree(outside);
  const blockBefore = JSON.stringify(
    (await project.session.agentResult(project.rev)).audit,
  );
  const canonical = (
    await project.dispatch('audit.compute', { rev: project.rev })
  ).result.audit.canonical;
  project.module.setAuditStepHook(hook);
  let result;
  try {
    result = await write(project);
  } catch (error) {
    // Restore before reporting, so the next case starts clean.
    project.module.setAuditStepHook(null);
    for (const undo of undoBox.splice(0).reverse()) undo();
    throw error;
  }
  project.module.setAuditStepHook(null);
  // The receipt is checked against the filesystem exactly as the call left
  // it, BEFORE any attack is undone: a restored directory must never make a
  // missing or foreign receipt path look right.
  if (result.ok) {
    let bytes = null;
    try {
      const entry = fs.lstatSync(result.receipt.path);
      if (!entry.isFile()) throw new Error('not a regular file');
      bytes = fs.readFileSync(result.receipt.path);
    } catch {
      violations.push('receipt-path-unreadable');
    }
    if (bytes != null && sha256(bytes) !== canonical.sha256)
      violations.push('file-not-canonical');
    if (result.receipt.sha256 != null) {
      if (bytes != null && sha256(bytes) !== result.receipt.sha256)
        violations.push('receipt-digest-differs');
      if (result.receipt.sha256 !== canonical.sha256)
        violations.push('receipt-not-canonical');
    }
    if (result.receipt.path !== project.final)
      violations.push('receipt-path-not-nominal');
  }
  for (const undo of undoBox.splice(0).reverse()) undo();
  if (JSON.stringify(hashTree(outside)) !== JSON.stringify(outsideBefore))
    violations.push('outside-changed');
  if (
    JSON.stringify(hashTree(project.fixture.src('src'))) !==
    JSON.stringify(sources)
  )
    violations.push('sources-changed');
  const temps = [
    ...tempFilesUnder(path.dirname(project.root)),
    ...tempFilesUnder(outside),
  ];
  if (temps.length > 0) violations.push('temp-left');
  if (!result.ok) {
    if (result.raw != null || result.code !== 'PMS_UNSAFE_AUDIT_PATH')
      violations.push(`unstructured:${result.raw ?? result.code}`);
    else if (!WRITER_REASONS.includes(result.reason))
      violations.push(`reason:${result.reason}`);
    const blockAfter = JSON.stringify(
      (await project.session.agentResult(project.rev)).audit,
    );
    if (blockAfter !== blockBefore) violations.push('recorded-on-failure');
  }
  return { result, violations };
}

async function writerMatrix(module, writerName, { steps = WRITER_STEPS } = {}) {
  const project = await openWith(module);
  const outside = outsideDir();
  const report = [];
  let runs = 0;
  try {
    const attacks = writerAttacks(project, outside);
    for (const [attackName, attack] of Object.entries(attacks)) {
      for (const [step, occurrence] of steps) {
        reset(project, outside);
        const undoBox = [];
        const hook = hookAt(step, occurrence, (at) => {
          const undo = attack(at);
          if (typeof undo === 'function') undoBox.push(undo);
        });
        const { result, violations } = await writerCase(
          project,
          WRITERS[writerName],
          outside,
          hook,
          undoBox,
        );
        // A failure leaves no regular file this call created at the final
        // name: an attack never plants one there.
        if (!result.ok) {
          let entry = null;
          try {
            entry = fs.lstatSync(project.final);
          } catch {
            entry = null;
          }
          if (entry?.isFile()) violations.push('final-left-on-failure');
        }
        runs += 1;
        if (violations.length > 0)
          report.push({ attackName, step, occurrence, violations, result });
      }
    }
  } finally {
    reset(project, outside);
    fs.rmSync(outside, { recursive: true, force: true });
    await project.close();
  }
  return { runs, report };
}

describe('§5.2 injection between every writer step', () => {
  test.each(Object.keys(WRITERS))(
    '%s: no violation over the attack matrix',
    async (writerName) => {
      const { runs, report } = await writerMatrix(compiler, writerName);
      expect(runs).toBe(8 * WRITER_STEPS.length);
      expect(report).toEqual([]);
    },
  );
});

// ----------------------------------------------------------- reader ----

async function readerMatrix(module) {
  const project = await openWith(module);
  const outside = outsideDir();
  const generationFile = path.join(project.fixture.outDir, 'coverage.json');
  try {
    // Both locations hold the canonical document of generation 1.
    await project.dispatch(
      'audit.materialize',
      { rev: project.rev, expectedGenerationId: 1 },
      project.write,
    );
    const canonical = fs.readFileSync(project.final);
    fs.writeFileSync(generationFile, canonical);
    const locations = [
      {
        index: 0,
        dir: project.fixture.outDir,
        name: 'coverage.json',
      },
      {
        index: 1,
        dir: project.auditDir,
        name: path.basename(project.final),
      },
    ];
    const restore = () => {
      for (const location of locations) {
        for (const suffix of ['.parked', '.moved'])
          if (fs.existsSync(`${location.dir}${suffix}`)) {
            fs.rmSync(location.dir, { recursive: true, force: true });
            fs.renameSync(`${location.dir}${suffix}`, location.dir);
          }
        fs.mkdirSync(location.dir, { recursive: true });
        const file = path.join(location.dir, location.name);
        fs.rmSync(file, { recursive: true, force: true });
        fs.writeFileSync(file, canonical);
      }
    };
    const decoy = (location) => {
      // An outside copy that would read as fresh if a link were followed.
      fs.writeFileSync(path.join(outside, location.name), canonical);
      return outside;
    };
    const attacks = {
      'directory → symlink to a fresh copy': (location) =>
        swapForLink(location.dir, decoy(location)),
      'project directory → symlink to a copy': (location) => {
        const copy = `${project.root}.copy`;
        fs.rmSync(copy, { recursive: true, force: true });
        fs.cpSync(project.root, copy, {
          recursive: true,
          verbatimSymlinks: true,
        });
        // The pinned directory loses its document; the copy keeps it.
        fs.rmSync(path.join(location.dir, location.name), { force: true });
        const undo = swapForLink(project.root, copy);
        return () => {
          undo();
          fs.rmSync(copy, { recursive: true, force: true });
        };
      },
      'file → symlink to a fresh copy': (location) =>
        replaceEntry(path.join(location.dir, location.name), (file) =>
          fs.symlinkSync(path.join(decoy(location), location.name), file),
        ),
      'file → directory': (location) =>
        replaceEntry(path.join(location.dir, location.name), (file) =>
          fs.mkdirSync(file),
        ),
      'file → FIFO': (location) =>
        replaceEntry(path.join(location.dir, location.name), (file) =>
          spawnSync('mkfifo', [file]),
        ),
      'file rewritten, same size': (location) => {
        const file = path.join(location.dir, location.name);
        if (fs.existsSync(file))
          fs.writeFileSync(file, Buffer.alloc(canonical.length, 0x20));
      },
      'directory moved away': (location) => {
        fs.renameSync(location.dir, `${location.dir}.moved`);
      },
      // Length and identity races (review round 1, B1).
      'file appended': (location) => {
        const file = path.join(location.dir, location.name);
        if (fs.existsSync(file)) fs.appendFileSync(file, 'noncanonical-append');
      },
      'file truncated': (location) => {
        const file = path.join(location.dir, location.name);
        if (fs.existsSync(file)) fs.truncateSync(file, canonical.length - 1);
      },
      'file replaced by other bytes': (location) => {
        const file = path.join(location.dir, location.name);
        fs.writeFileSync(`${file}.swap`, Buffer.alloc(canonical.length, 0x42));
        fs.renameSync(`${file}.swap`, file);
      },
      'file replaced by the canonical bytes': (location) => {
        const file = path.join(location.dir, location.name);
        fs.writeFileSync(`${file}.swap`, canonical);
        fs.renameSync(`${file}.swap`, file);
      },
    };
    const steps = [
      ['anchor', 1],
      ['read-open-dir', 1],
      ['read-lstat', 1],
      ['read-open', 1],
      ['read', 1],
      ['read', 2],
      ['read-after', 1],
    ];
    const report = [];
    let runs = 0;
    for (const location of locations) {
      for (const [attackName, attack] of Object.entries(attacks)) {
        for (const [step, occurrence] of steps) {
          restore();
          const undoBox = [];
          let seen = 0;
          project.module.setAuditStepHook((name, at) => {
            const here =
              name === 'anchor'
                ? true
                : (at.name ?? at.final) === location.name ||
                  at.name === path.basename(location.dir);
            if (name === step && here && ++seen === occurrence) {
              const undo = attack(location);
              if (typeof undo === 'function') undoBox.push(undo);
            }
          });
          let response;
          const started = Date.now();
          try {
            response = await project.dispatch('audit.read', {
              rev: project.rev,
            });
          } finally {
            project.module.setAuditStepHook(null);
          }
          const elapsed = Date.now() - started;
          // The pinned location: the real directory objects, wherever an
          // attack moved them.
          const pinnedRoot = fs.existsSync(`${project.root}.parked`)
            ? `${project.root}.parked`
            : project.root;
          // After the location's directory was opened, the read holds that
          // directory object, wherever a swap or a move parked it.
          let pinnedDir = path.join(pinnedRoot, path.basename(location.dir));
          if (step !== 'anchor' && step !== 'read-open-dir')
            for (const suffix of ['.parked', '.moved'])
              if (fs.existsSync(`${location.dir}${suffix}`))
                pinnedDir = `${location.dir}${suffix}`;
          let holdsCanonical = false;
          try {
            const dir = fs.lstatSync(pinnedDir);
            const file = fs.lstatSync(path.join(pinnedDir, location.name));
            holdsCanonical =
              dir.isDirectory() &&
              file.isFile() &&
              fs
                .readFileSync(path.join(pinnedDir, location.name))
                .equals(canonical);
          } catch {
            holdsCanonical = false;
          }
          const artifact = response.result?.artifacts?.[location.index];
          const violations = [];
          // A same-size rewrite in place after every byte was read is
          // indistinguishable from one just after the call returns: the
          // verdict attests the bytes read, and the next read sees the edit.
          const afterRead =
            attackName === 'file rewritten, same size' &&
            ((step === 'read' && occurrence === 2) || step === 'read-after');
          if (artifact?.status === 'fresh' && !holdsCanonical) {
            if (!afterRead) violations.push('false-fresh');
            else {
              const again = (
                await project.dispatch('audit.read', { rev: project.rev })
              ).result.artifacts[location.index];
              if (again.status === 'fresh') violations.push('undetected');
            }
          }
          for (const undo of undoBox.splice(0).reverse()) undo();
          runs += 1;
          if (response.outcome !== 'success') violations.push('outcome');
          if (elapsed > 2000) violations.push('slow');
          if ((artifact?.sha256 != null) !== (artifact?.status === 'fresh'))
            violations.push('digest-disclosed');
          if (violations.length > 0)
            report.push({
              location: location.name,
              attackName,
              step,
              occurrence,
              violations,
              artifact,
            });
        }
      }
    }
    return {
      runs,
      report,
      expectedRuns: 2 * Object.keys(attacks).length * steps.length,
    };
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    await project.close();
  }
}

describe('§5.2 injection between every reader step', () => {
  test('audit.read at both locations: fresh only for the canonical bytes in the pinned location, within 2 s', async () => {
    const { runs, report, expectedRuns } = await readerMatrix(compiler);
    expect(runs).toBe(expectedRuns);
    expect(report).toEqual([]);
  });
});

// ------------------------------------------- content at the publication ----

const CONTENT = {};

describe('§5.2 content at the publication point (writer step 8)', () => {
  const EDITS = {
    'rewritten in place, same size': (file) =>
      fs.writeFileSync(
        file,
        Buffer.alloc(Math.max(1, fs.statSync(file).size), 0x41),
      ),
    truncated: (file) =>
      fs.truncateSync(file, Math.max(0, fs.statSync(file).size - 1)),
    extended: (file) => fs.appendFileSync(file, 'x'),
    'replaced by the canonical bytes': (file, canonical) => {
      fs.writeFileSync(`${file}.swap`, canonical);
      fs.renameSync(`${file}.swap`, file);
    },
    'replaced by other bytes': (file, canonical) => {
      fs.writeFileSync(`${file}.swap`, Buffer.alloc(canonical.length, 0x42));
      fs.renameSync(`${file}.swap`, file);
    },
  };
  const AFTER_CREATE = WRITER_STEPS.slice(
    WRITER_STEPS.findIndex(([step]) => step === 'identity'),
  );
  const RENAMED_FROM = AFTER_CREATE.findIndex(
    ([step]) => step === 'nominal-check',
  );

  test.each(Object.keys(WRITERS))(
    '%s: a receipt only for verified bytes; otherwise content-mismatch or file-replaced, nothing left',
    async (writerName) => {
      const { runs, report, receipts } = await contentMatrix(
        compiler,
        writerName,
      );
      expect(runs).toBe(5 * AFTER_CREATE.length);
      expect(report).toEqual([]);
      // Edits before the bytes are written are overwritten: those calls
      // legitimately succeed, with verified receipts.
      expect(receipts).toBeGreaterThan(0);
    },
  );

  async function contentMatrix(module, writerName) {
    const project = await openWith(module);
    const outside = outsideDir();
    try {
      // The canonical bytes, from one unattacked materialization.
      await WRITERS[writerName](project);
      const canonical = fs.readFileSync(project.final);
      const report = [];
      let runs = 0;
      let receipts = 0;
      for (const [editName, edit] of Object.entries(EDITS)) {
        for (const [index, [step, occurrence]] of AFTER_CREATE.entries()) {
          reset(project, outside);
          const target = (at) =>
            index >= RENAMED_FROM
              ? project.final
              : path.join(project.auditDir, at.tmp);
          const hook = hookAt(step, occurrence, (at) => {
            const file = target(at);
            if (fs.existsSync(file)) edit(file, canonical);
          });
          const undoBox = [];
          const { result, violations } = await writerCase(
            project,
            WRITERS[writerName],
            outside,
            hook,
            undoBox,
          );
          // After the read-back has read every byte, a same-size rewrite in
          // place is indistinguishable from one just after the call returns
          // (§3.5, §6): the receipt attests the bytes read, and audit.read
          // detects the later difference.
          const afterRead =
            (step === 'verify-read' && occurrence === 2) ||
            step === 'verify-after' ||
            step === 'nominal-final';
          if (result.ok && afterRead) {
            const hashed = violations.indexOf('file-not-canonical');
            if (hashed >= 0) {
              violations.splice(hashed, 1);
              const differs = violations.indexOf('receipt-digest-differs');
              if (differs >= 0) violations.splice(differs, 1);
              const artifact = (
                await project.dispatch('audit.read', { rev: project.rev })
              ).result.artifacts[1];
              if (artifact.status !== 'stale') violations.push('undetected');
            }
          }
          if (!result.ok) {
            if (
              !['audit-content-mismatch', 'audit-file-replaced'].includes(
                result.reason,
              )
            )
              violations.push(`reason:${result.reason}`);
            // An in-place edit keeps this call's inode: cleanup removed it.
            if (
              !editName.startsWith('replaced') &&
              fs.existsSync(project.final)
            )
              violations.push('final-left-on-failure');
          } else {
            receipts += 1;
          }
          runs += 1;
          if (violations.length > 0)
            report.push({ editName, step, occurrence, violations, result });
        }
      }
      return { runs, report, receipts };
    } finally {
      reset(project, outside);
      fs.rmSync(outside, { recursive: true, force: true });
      await project.close();
    }
  }
  CONTENT.matrix = contentMatrix;

  test('the same edits after the call returns are reported stale by audit.read', async () => {
    const project = await openWith(compiler);
    try {
      for (const [editName, edit] of Object.entries(EDITS)) {
        const response = await project.dispatch(
          'audit.materialize',
          { rev: project.rev, expectedGenerationId: 1 },
          project.write,
        );
        expect(response.outcome).toBe('success');
        const canonical = fs.readFileSync(project.final);
        edit(project.final, canonical);
        const artifact = (
          await project.dispatch('audit.read', { rev: project.rev })
        ).result.artifacts[1];
        expect([editName, artifact.status]).toEqual([
          editName,
          editName === 'replaced by the canonical bytes' ? 'fresh' : 'stale',
        ]);
      }
    } finally {
      await project.close();
    }
  });
});

// ---------------------------------------------------------- faults ----

describe('§5.2 failures at every step: cleanup', () => {
  const FAULT_STEPS = [
    ['create', 1, 'ENOSPC'],
    ['identity', 1, 'ENOSPC'],
    ['write', 1, 'ENOSPC'],
    ['write', 2, 'ENOSPC'],
    ['fsync', 1, 'ENOSPC'],
    ['close', 1, 'EIO'],
    ['rename', 1, 'ENOSPC'],
    ['nominal-check', 1, 'ENOSPC'],
    ['verify-lstat', 1, 'ENOSPC'],
    ['verify-open', 1, 'ENOSPC'],
    ['verify-fstat', 1, 'ENOSPC'],
    ['verify-read', 1, 'ENOSPC'],
    ['verify-after', 1, 'ENOSPC'],
  ];

  test.each(Object.keys(WRITERS))(
    '%s: audit-write-failed with its errno, nothing left, no descriptor leaked, nothing recorded',
    async (writerName) => {
      const project = await openWith(compiler);
      const outside = outsideDir();
      try {
        const report = [];
        for (const [step, occurrence, code] of FAULT_STEPS) {
          reset(project, outside);
          const fds = openDescriptors();
          const hook = hookAt(step, occurrence, () => {
            throw Object.assign(new Error(`${code}: injected`), { code });
          });
          const { result, violations } = await writerCase(
            project,
            WRITERS[writerName],
            outside,
            hook,
            [],
          );
          if (result.ok) violations.push('succeeded');
          else {
            if (result.reason !== 'audit-write-failed')
              violations.push(`reason:${result.reason}`);
            if (result.errno !== code) violations.push(`errno:${result.errno}`);
            if (result.outcome != null && result.outcome !== 'internal-error')
              violations.push(`outcome:${result.outcome}`);
          }
          if (fs.existsSync(project.final)) violations.push('final-left');
          if (openDescriptors() !== fds) violations.push('descriptor-leak');
          if (violations.length > 0)
            report.push({ step, occurrence, code, violations, result });
        }
        expect(report).toEqual([]);
      } finally {
        reset(project, outside);
        fs.rmSync(outside, { recursive: true, force: true });
        await project.close();
      }
    },
  );
});

// --------------------------------------------------------- mutations ----

/** A build of the inspection bundle with one textual mutation. */
function mutantBuild(label, from, to, ...more) {
  let source = fs.readFileSync(BUNDLE, 'utf8');
  for (const [a, b] of [
    [from, to],
    ...more.reduce((pairs, value, index) => {
      if (index % 2 === 0) pairs.push([value]);
      else pairs[pairs.length - 1].push(value);
      return pairs;
    }, []),
  ]) {
    expect(source.split(a).length).toBe(2);
    source = source.replace(a, b);
  }
  const file = path.join(
    path.dirname(BUNDLE),
    `compiler-inspection.${label}.${process.pid}.cjs`,
  );
  fs.writeFileSync(file, source);
  try {
    // eslint-disable-next-line
    return require(file);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

describe('mutation checks: the harnesses see their class', () => {
  test('a path-based exclusive creation (writer step 4) fails the outside-directory assertion', async () => {
    const mutant = mutantBuild(
      'path-based-create',
      'T = fs__namespace.openSync(anchoredPath(D, tmpName),',
      'T = fs__namespace.openSync(path__namespace.join(names.parent, names.audit, tmpName),',
    );
    const { report } = await writerMatrix(mutant, 'SDK requestFullAudit', {
      steps: [
        ['open-dir', 1],
        ['create', 1],
      ],
    });
    const outside = report.filter((item) =>
      item.violations.includes('outside-changed'),
    );
    expect(outside.length).toBeGreaterThan(0);
  });

  test('skipping the content comparison at the publication point fails the content assertion', async () => {
    const mutant = mutantBuild(
      'no-content-check',
      'if (got !== buffer.length || sha256$1(read.subarray(0, got)) !== digest) throw',
      'if (false) throw',
    );
    const { report } = await CONTENT.matrix(mutant, 'audit.materialize');
    expect(
      report.filter((item) =>
        item.violations.some((violation) =>
          [
            'receipt-digest-differs',
            'file-not-canonical',
            'undetected',
          ].includes(violation),
        ),
      ).length,
    ).toBeGreaterThan(0);
  });

  test('a reader that follows a link at the location directory fails the fresh assertion', async () => {
    const mutant = mutantBuild(
      'reader-follows-directory',
      'O = fs__namespace.openSync(anchoredPath(P, dirName), C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);',
      'O = fs__namespace.openSync(anchoredPath(P, dirName), C.O_RDONLY | C.O_DIRECTORY);',
    );
    const { report } = await readerMatrix(mutant);
    expect(
      report.filter((item) => item.violations.includes('false-fresh')).length,
    ).toBeGreaterThan(0);
  });

  // Review round 1, B2: the writer without the final nominal re-check
  // succeeds with a receipt path that no longer names the written file; the
  // oracle checks the receipt before undoing the attack, so it sees it.
  test.each(Object.keys(WRITERS))(
    '%s: without the final nominal re-check, a late relocation is caught by the oracle',
    async (writerName) => {
      const mutant = mutantBuild(
        'no-final-nominal-check',
        "auditStep('nominal-final', at);\n      nominalCheck();\n      ok = true;",
        'ok = true;',
      );
      const { report } = await writerMatrix(mutant, writerName, {
        steps: [
          ['verify-lstat', 1],
          ['verify-after', 1],
        ],
      });
      const caught = report.filter((item) =>
        item.violations.includes('receipt-path-unreadable'),
      );
      expect(caught.length).toBeGreaterThan(0);
      expect(
        caught.some(
          (item) =>
            item.attackName === 'audit directory → symlink to outside' &&
            item.step === 'verify-lstat',
        ),
      ).toBe(true);
    },
  );

  // Review round 1, B1: the reader bounded at the expected size and without
  // the post-read length and identity check reports growth as fresh.
  test('a reader without the end-of-file read and the post-read check fails the fresh assertion', async () => {
    const mutant = mutantBuild(
      'reader-bounded-read',
      'while (got <= bytes) {',
      'while (got < bytes) {',
      "if (after.size !== bytes || named.size !== bytes) return result('stale', 'size-differs', bytes);",
      '',
      "if (!named.isFile() || after.dev !== entry.dev || after.ino !== entry.ino || named.dev !== entry.dev || named.ino !== entry.ino) return result('stale', 'content-differs', bytes);",
      '',
    );
    const { report } = await readerMatrix(mutant);
    const growth = report.filter(
      (item) =>
        item.attackName === 'file appended' &&
        item.violations.includes('false-fresh'),
    );
    expect(growth.length).toBeGreaterThan(0);
  });

  test('a non-PmsError thrown inside the analysis loop leaves stage closure and every file unknown (fault injection)', async () => {
    const mutant = mutantBuild(
      'analysis-fault',
      "bump('files_recompiled');",
      "bump('files_recompiled'); if (globalThis.__pmsAg012AnalysisFault === true) throw new TypeError('injected analysis fault');",
    );
    globalThis.__pmsAg012AnalysisFault = true;
    try {
      const fixture = openProject('valid');
      const session = mutant.createPublicProjectSession({
        definition: evaluateDefinitionText(fixture.definitionPath),
        roots: fixture.roots,
        outDir: fixture.outDir,
        designSystemFile: fixture.config.designSystemFile,
        projectId: fixture.project,
        rootDir: fixture.project,
      });
      const binding = await mutant.createAgentBinding({
        session,
        initialize: true,
      });
      const capability = binding.mintCapability({ grants: ['consult'] });
      const dispatch = (operation, input) =>
        binding.dispatch(request(operation, input), { capability });
      try {
        const rev = (await dispatch('session.status', {})).identities.revision;
        const validation = await session.validate(rev);
        expect(validation.ok).toBe(false);
        const response = await dispatch('audit.compute', {
          rev,
          page: { offset: 0, limit: 256 },
        });
        expect(response.outcome).toBe('success');
        const { audit, page } = response.result;
        expect(audit.coverage.stage).toBe('closure');
        expect(audit.limitations).toEqual([
          'validation-failed',
          'analysis-not-run',
        ]);
        expect(page.records.length).toBe(audit.coverage.coveredFiles);
        expect(
          page.records.every(
            (record) =>
              record.analysed === false && record.reason === 'analysis-not-run',
          ),
        ).toBe(true);
      } finally {
        await session.close();
      }
    } finally {
      delete globalThis.__pmsAg012AnalysisFault;
    }
  });
});
