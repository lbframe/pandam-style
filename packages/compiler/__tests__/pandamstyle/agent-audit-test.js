/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * AG-01.2 audit read, compute and materialize: the acceptance criteria of #9
 * (design note §5.1) and the targeted verification of preservation (§5.2).
 * The anchored filesystem matrix is `agent-audit-io-test.js`.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  compiler,
  openAgentProject,
  readRecord,
  request,
} = require('./agent-helpers');
const { openProject } = require('./session-helpers');
const {
  FORBIDDEN_PAGE,
  INVALID_STATES,
  auditBlock,
  auditDirOf,
  coldCopy,
  emptyMutation,
  hashTree,
  observe,
  openDescriptors,
  openState,
  perfDuring,
  portable,
  portableList,
  readAuditList,
  sha256,
  tempFilesUnder,
} = require('./agent-audit-support');

jest.setTimeout(300000);

const { REGISTRY, validateSchema } = compiler;

/** Every response of an audit operation matches its declared output. */
function checked(name, response) {
  expect(response.limits.responseBytes).toBe(
    Buffer.byteLength(JSON.stringify(response)),
  );
  expect(response.limits.responseBytes).toBeLessThanOrEqual(
    response.limits.maxResponseBytes,
  );
  expect(response.failure?.reason).not.toBe('output-schema-violation');
  expect(response.failure?.reason).not.toBe('response-over-ceiling');
  if (response.result != null)
    expect(
      validateSchema(REGISTRY.byName[name].output, response.result),
    ).toBeNull();
  return response;
}

function materializer(project) {
  const capability = project.binding.mintCapability({
    grants: ['materialize-audit'],
  });
  return (input, extra = {}, options = {}) =>
    project.binding
      .dispatch(request('audit.materialize', input, extra), {
        capability,
        ...options,
      })
      .then((response) => checked('audit.materialize', response));
}

/** Two `audit.read` calls and every `audit.compute` page twice, interleaved. */
async function auditCalls(project, rev) {
  const outcomes = [];
  for (let round = 0; round < 2; round += 1) {
    outcomes.push(
      checked('audit.read', await project.dispatch('audit.read', { rev }))
        .outcome,
    );
    for (const view of ['compact', 'detail']) {
      let offset = 0;
      for (let guard = 0; guard < 1000; guard += 1) {
        const page = checked(
          'audit.compute',
          await project.dispatch(
            'audit.compute',
            { rev, page: { offset, limit: 3 } },
            { view },
          ),
        );
        outcomes.push(page.outcome);
        if (page.page?.nextOffset == null) break;
        offset = page.page.nextOffset;
        outcomes.push(
          checked('audit.read', await project.dispatch('audit.read', { rev }))
            .outcome,
        );
      }
    }
  }
  return outcomes;
}

/**
 * The generation as content digests, with the project path made portable so
 * two copies of one fixture compare.
 */
function generationOf(fixture) {
  const out = {};
  for (const [file, _digest] of Object.entries(hashTree(fixture.outDir))) {
    if (file === 'build-report.json') continue;
    out[file] = sha256(
      fs
        .readFileSync(path.join(fixture.outDir, file), 'utf8')
        .split(fixture.project)
        .join('<root>'),
    );
  }
  return out;
}

// ---------------------------------------------------------------- AC1 ----

describe('AC1: read and compute preserve the revision, validation, tickets, outputs and publication intent', () => {
  /**
   * Runs `calls` against a revision state and reports, rather than asserts,
   * what changed: so the A1 class case can show the harness sees staging.
   */
  async function preservation(name, setup, calls) {
    const project = await openAgentProject(name);
    const control = await openAgentProject(name);
    try {
      const rev = await project.revision();
      await setup(project, rev);
      const controlRev = await control.revision();
      await setup(control, controlRev);
      const ticket = await project.session.preparePublication(rev);
      const controlTicket =
        await control.session.preparePublication(controlRev);
      const before = await observe(project, rev);
      const perf = await perfDuring(() => calls(project, rev));
      const after = await observe(project, rev);
      let committed = true;
      try {
        await project.session.commitPrepared(ticket);
      } catch (error) {
        committed = error.diagnostics?.[0]?.context?.reason ?? 'thrown';
      }
      await control.session.commitPrepared(controlTicket);
      return {
        state: after,
        before,
        perf,
        committed,
        generation: generationOf(project.fixture),
        control: generationOf(control.fixture),
      };
    } finally {
      await project.close();
      await control.close();
    }
  }

  const VALID_STATES = [
    ['valid, unpublished', async (p, rev) => p.session.validate(rev)],
    [
      'valid, published, coverage.json in the generation',
      async (p, rev) => {
        await p.session.validate(rev);
        await p.session.requestFullAudit(rev);
        await p.session.compile(rev);
      },
    ],
    [
      'valid, published, standalone document',
      async (p, rev) => {
        await p.session.validate(rev);
        await p.session.compile(rev);
        await p.session.requestFullAudit(rev);
      },
    ],
  ];

  test.each(VALID_STATES)('%s', async (_label, setup) => {
    const result = await preservation('valid', setup, async (project, rev) => {
      const outcomes = await auditCalls(project, rev);
      expect(new Set(outcomes)).toEqual(new Set(['success']));
    });
    expect(result.state).toEqual(result.before);
    expect(result.perf).toEqual({ counts: {}, durations: [] });
    expect(result.committed).toBe(true);
    // Publication intent: the committed generation is the control's.
    expect(result.generation).toEqual(result.control);
  });

  test('A1 class case: the same harness sees SDK staging', async () => {
    const result = await preservation(
      'valid',
      async (p, rev) => p.session.validate(rev),
      async (project, rev) => project.session.requestFullAudit(rev),
    );
    expect(result.state).not.toEqual(result.before);
    expect(result.committed).toBe('ticket-stale');
  });

  test.each(INVALID_STATES.map((state) => [state.name, state]))(
    'invalid revision: %s',
    async (_label, state) => {
      const project = await openState(state);
      try {
        const rev = await project.revision();
        await project.session.validate(rev);
        const before = await observe(project, rev);
        const perf = await perfDuring(async () => {
          const outcomes = await auditCalls(project, rev);
          expect(new Set(outcomes)).toEqual(new Set(['success']));
        });
        expect(await observe(project, rev)).toEqual(before);
        expect(perf).toEqual({ counts: {}, durations: [] });
      } finally {
        await project.close();
      }
    },
  );

  test('unvalidated: both refuse with not-validated and a check reference, and validate nothing', async () => {
    const project = await openAgentProject('valid', { initialize: false });
    try {
      await project.session.initialize();
      const rev = await project.revision();
      const before = await observe(project, rev, { validated: false });
      expect(before.v1).toBe('not-validated');
      const perf = await perfDuring(async () => {
        for (const name of ['audit.read', 'audit.compute']) {
          const response = checked(name, await project.dispatch(name, { rev }));
          expect(response.outcome).toBe('invalid-input');
          expect(response.failure.reason).toBe('not-validated');
          expect(response.failure.precondition).toBe('revision-validated');
          expect(response.references).toEqual([
            { operation: 'check', view: 'compact', input: { rev } },
          ]);
        }
      });
      expect(await observe(project, rev, { validated: false })).toEqual(before);
      expect(perf).toEqual({ counts: {}, durations: [] });
    } finally {
      await project.close();
    }
  });
});

// ---------------------------------------------------------------- AC2 ----

describe('AC2: invalid revisions return useful bounded results with limitations', () => {
  test.each(INVALID_STATES.map((state) => [state.name, state]))(
    '%s: stage, completeness and limitations; the hot list equals the cold list',
    async (_label, state) => {
      const project = await openState(state);
      try {
        const rev = await project.revision();
        await project.session.validate(rev);
        const response = checked(
          'audit.compute',
          await project.dispatch('audit.compute', { rev }),
        );
        expect(response.outcome).toBe('success');
        const { audit } = response.result;
        expect(audit.validation.ok).toBe(false);
        expect(audit.coverage.stage).toBe(state.expect.stage);
        expect(audit.coverage.completeness).toBe(state.expect.completeness);
        expect(audit.limitations).toEqual(state.expect.limitations);
        expect(audit.canonical).toBeNull();
        // TA9: the verdict is a field, never the outcome; diagnostics are
        // reached through `check`, never duplicated.
        expect(response.diagnostics).toEqual([]);
        expect(response.references).toContainEqual({
          operation: 'check',
          view: 'compact',
          input: { rev },
        });
        const { records } = await readAuditList(project, rev);
        expect(records).toHaveLength(
          audit.coverage.knownEntries + audit.coverage.unknownEntries,
        );
        if (audit.coverage.stage === 'none') {
          expect(audit.coverage.coveredFiles).toBeNull();
          expect(records).toEqual([]);
        } else {
          expect(records).toHaveLength(audit.coverage.coveredFiles);
        }
        if (audit.coverage.stage !== 'analysed')
          expect(
            records.every(
              (record) =>
                record.analysed === false &&
                record.reason === 'analysis-not-run',
            ),
          ).toBe(true);
        // The differential oracle (TA8): a cold session on the same bytes.
        const options = state.options?.(openProject('valid')) ?? {};
        const cold = await coldCopy(project.fixture, {
          sessionOptions: {
            ...options.sessionOptions,
            ...(options.definition === undefined
              ? {}
              : { definition: options.definition }),
          },
        });
        try {
          expect(await portableList(cold, cold.root)).toEqual(
            portable(
              {
                audit: { ...audit, canonical: undefined },
                records,
              },
              project.fixture.project,
            ),
          );
        } finally {
          await cold.close();
        }
      } finally {
        await project.close();
      }
    },
  );

  test('transitions valid → unresolved import → page failure → valid: each revision equals its cold list', async () => {
    const project = await openAgentProject('valid');
    try {
      const page = project.fixture.src('src/zz-edit.js');
      const steps = [
        null,
        `import { gone } from './does-not-exist';\n${FORBIDDEN_PAGE}`,
        FORBIDDEN_PAGE,
        "import { create, token } from '../generated/design.pandamstyle';\nexport const ok = create({ box: { padding: token('spacing.md') } });\n",
      ];
      let rev = await project.revision();
      const seen = [];
      for (const text of steps) {
        if (text != null) {
          fs.writeFileSync(page, text);
          rev = (await project.session.applyChanges(emptyMutation(rev)))
            .revision;
        }
        const hot = await portableList(project, project.fixture.project);
        const cold = await coldCopy(project.fixture);
        try {
          expect(hot).toEqual(await portableList(cold, cold.root));
        } finally {
          await cold.close();
        }
        seen.push(hot.audit.coverage.stage);
      }
      expect(seen).toEqual([
        'analysed',
        'closure-partial',
        'analysed',
        'analysed',
      ]);
    } finally {
      await project.close();
    }
  });
});

// ---------------------------------------------------------------- AC3 ----

describe('AC3: materialization requires mutation authority and produces a traceable receipt', () => {
  async function denied(project, rev, dispatch, expected) {
    const before = await observe(project, rev);
    const response = checked('audit.materialize', await dispatch());
    expect([response.outcome, response.failure.reason]).toEqual(expected);
    expect(response.result).toBeNull();
    expect(await observe(project, rev)).toEqual(before);
  }

  test('denied: no capability, consult only, copies, a proxy, another binding, extra authority fields', async () => {
    const project = await openAgentProject('valid');
    const other = await openAgentProject('valid');
    try {
      const rev = await project.revision();
      await project.session.validate(rev);
      const valid = project.binding.mintCapability({
        grants: ['materialize-audit'],
      });
      const input = { rev, expectedGenerationId: null };
      const send =
        (capability, body = input) =>
        () =>
          project.binding.dispatch(request('audit.materialize', body), {
            capability,
          });
      await denied(project, rev, send(undefined), [
        'denied-access',
        'no-capability',
      ]);
      await denied(project, rev, send(project.capability), [
        'denied-access',
        'missing-grant',
      ]);
      await denied(project, rev, send(JSON.parse(JSON.stringify(valid))), [
        'denied-access',
        'unknown-capability',
      ]);
      await denied(project, rev, send({ ...valid }), [
        'denied-access',
        'unknown-capability',
      ]);
      await denied(project, rev, send(new Proxy(valid, {})), [
        'denied-access',
        'unknown-capability',
      ]);
      await denied(
        project,
        rev,
        send(other.binding.mintCapability({ grants: ['materialize-audit'] })),
        ['denied-access', 'foreign-binding'],
      );
      for (const extra of [
        { capability: { grants: ['materialize-audit'] } },
        { grants: ['materialize-audit'] },
        { role: 'host' },
      ]) {
        await denied(project, rev, send(valid, { ...input, ...extra }), [
          'invalid-input',
          'schema-additional-properties',
        ]);
      }
    } finally {
      await project.close();
      await other.close();
    }
  });

  test('denied: a capability after close() revokes, and writes nothing', async () => {
    const project = await openAgentProject('valid');
    const rev = await project.revision();
    await project.session.validate(rev);
    const capability = project.binding.mintCapability({
      grants: ['materialize-audit'],
    });
    await project.close();
    const files = hashTree(project.fixture.project);
    const response = await project.binding.dispatch(
      request('audit.materialize', { rev, expectedGenerationId: null }),
      { capability },
    );
    expect([response.outcome, response.failure.reason]).toEqual([
      'denied-access',
      'revoked',
    ]);
    expect(hashTree(project.fixture.project)).toEqual(files);
  });

  test('successful: the receipt binds identities, path, bytes and digest; read is fresh; tickets survive; nothing is staged', async () => {
    const project = await openAgentProject('valid');
    try {
      const materialize = materializer(project);
      const rev = await project.revision();
      await project.session.validate(rev);
      const ticket = await project.session.preparePublication(rev);
      const compute = await project.dispatch('audit.compute', { rev });
      const before = await observe(project, rev);
      const response = await materialize(
        { rev, expectedGenerationId: null },
        { requestId: 'receipt-1' },
      );
      expect(response.outcome).toBe('success');
      const receipt = response.result;
      const identities = response.identities;
      const file = path.join(
        auditDirOf(project.fixture),
        `coverage-rev-${rev.revisionId}.json`,
      );
      const bytes = fs.readFileSync(file);
      expect(receipt).toEqual({
        receiptKind: 'pandamstyle-audit-receipt',
        receiptVersion: 1,
        operation: 'audit.materialize',
        requestId: 'receipt-1',
        revision: rev,
        designSystem: identities.designSystem,
        generationId: null,
        location: 'audit-directory',
        path: file,
        documentKind: 'pandamstyle-coverage-report',
        schemaVersion: 1,
        bytes: fs.lstatSync(file).size,
        sha256: sha256(bytes),
        entryCount: JSON.parse(bytes).entryCount,
      });
      expect(fs.lstatSync(file).isFile()).toBe(true);
      expect(receipt.sha256).toBe(compute.result.audit.canonical.sha256);
      expect(receipt.bytes).toBe(compute.result.audit.canonical.bytes);
      const read = await project.dispatch('audit.read', { rev });
      expect(read.result.artifacts[1]).toEqual({
        location: 'audit-directory',
        path: file,
        status: 'fresh',
        reason: null,
        bytes: receipt.bytes,
        sha256: receipt.sha256,
      });
      // The v1 block names the path; it is not staged.
      const block = await auditBlock(project, rev);
      expect(block).toEqual({
        requested: false,
        materialized: true,
        document: file,
      });
      // Nothing else in S changed: the audit fields, the new file, and the
      // rebuilt cached result are the declared effect.
      const after = await observe(project, rev);
      expect(after.current).toEqual(before.current);
      expect(after.retention).toEqual(before.retention);
      expect(after.identities).toEqual(before.identities);
      const { [path.relative(project.fixture.project, file)]: added, ...rest } =
        after.files;
      expect(added).toBe(receipt.sha256);
      expect(rest).toEqual(before.files);
      const scrub = (text) => {
        const value = JSON.parse(text);
        value.audit = null;
        value.milestones.auditReportReady = null;
        return value;
      };
      expect(scrub(after.v1)).toEqual(scrub(before.v1));
      // A ticket prepared before still commits, and the generation it
      // commits has no coverage document.
      await project.session.commitPrepared(ticket);
      expect(
        fs.existsSync(path.join(project.fixture.outDir, 'coverage.json')),
      ).toBe(false);
      // After publication the null-generation document is stale.
      const stale = await project.dispatch('audit.read', { rev });
      expect(stale.result.artifacts[1].status).toBe('stale');
      expect(stale.result.artifacts[1].sha256).toBeNull();
    } finally {
      await project.close();
    }
  });

  test('refused: revision-invalid, not-validated, generation-changed and cancelled, each writing nothing', async () => {
    const invalid = await openAgentProject('neg-forbidden-value');
    try {
      const rev = await invalid.revision();
      await invalid.session.validate(rev);
      const response = await materializer(invalid)({
        rev,
        expectedGenerationId: null,
      });
      expect([response.outcome, response.failure.reason]).toEqual([
        'constraint-violation',
        'revision-invalid',
      ]);
      expect(fs.existsSync(auditDirOf(invalid.fixture))).toBe(false);
    } finally {
      await invalid.close();
    }
    const project = await openAgentProject('valid', { initialize: false });
    try {
      await project.session.initialize();
      const materialize = materializer(project);
      const rev = await project.revision();
      const unvalidated = await materialize({
        rev,
        expectedGenerationId: null,
      });
      expect([unvalidated.outcome, unvalidated.failure.reason]).toEqual([
        'invalid-input',
        'not-validated',
      ]);
      await project.session.validate(rev);
      expect(fs.existsSync(auditDirOf(project.fixture))).toBe(false);
      const cancelled = await materialize(
        { rev, expectedGenerationId: null },
        {},
        { signal: AbortSignal.abort() },
      );
      expect([cancelled.outcome, cancelled.failure.reason]).toEqual([
        'cancelled',
        'before-start',
      ]);
      expect(fs.existsSync(auditDirOf(project.fixture))).toBe(false);
      // Published: the expected generation is 1, no longer null.
      expect(
        (await materialize({ rev, expectedGenerationId: null })).outcome,
      ).toBe('success');
      await project.session.compile(rev);
      const files = hashTree(project.fixture.project);
      const changed = await materialize({ rev, expectedGenerationId: null });
      expect([changed.outcome, changed.failure.reason]).toEqual([
        'stale-revision',
        'generation-changed',
      ]);
      const ahead = await materialize({ rev, expectedGenerationId: 2 });
      expect(ahead.failure.reason).toBe('generation-changed');
      expect(hashTree(project.fixture.project)).toEqual(files);
      const published = await materialize({ rev, expectedGenerationId: 1 });
      expect(published.outcome).toBe('success');
      expect(published.result.generationId).toBe(1);
      expect(
        (await project.dispatch('audit.read', { rev })).result.artifacts[1]
          .status,
      ).toBe('fresh');
    } finally {
      await project.close();
    }
  });

  test('a stale revision is refused before anything else', async () => {
    const project = await openAgentProject('valid');
    try {
      const rev = await project.revision();
      await project.session.validate(rev);
      const response = await materializer(project)({
        rev: { ...rev, revisionId: rev.revisionId + 1 },
        expectedGenerationId: null,
      });
      expect([response.outcome, response.failure.reason]).toEqual([
        'stale-revision',
        'revision-mismatch',
      ]);
    } finally {
      await project.close();
    }
  });
});

// ---------------------------------------------------------------- AC4 ----

describe('AC4: freshness and identity are verified; stale and missing audits are explicit', () => {
  const read = async (project, rev) => {
    const response = checked(
      'audit.read',
      await project.dispatch('audit.read', { rev }),
    );
    expect(response.outcome).toBe('success');
    for (const artifact of response.result.artifacts)
      expect(artifact.sha256 == null).toBe(artifact.status !== 'fresh');
    return response.result;
  };
  const statuses = (result) =>
    result.artifacts.map((artifact) => [artifact.status, artifact.reason]);

  test('missing, then fresh in the generation, then fresh in the audit directory', async () => {
    const project = await openAgentProject('valid');
    try {
      const rev = await project.revision();
      await project.session.validate(rev);
      expect(statuses(await read(project, rev))).toEqual([
        ['missing', null],
        ['missing', null],
      ]);
      await project.session.requestFullAudit(rev);
      await project.session.compile(rev);
      const staged = await read(project, rev);
      expect(statuses(staged)).toEqual([
        ['fresh', null],
        ['missing', null],
      ]);
      const inGeneration = fs.readFileSync(
        path.join(project.fixture.outDir, 'coverage.json'),
      );
      expect(staged.artifacts[0].sha256).toBe(sha256(inGeneration));
      expect(staged.canonical.sha256).toBe(sha256(inGeneration));
      await materializer(project)({ rev, expectedGenerationId: 1 });
      expect(statuses(await read(project, rev))).toEqual([
        ['fresh', null],
        ['fresh', null],
      ]);
    } finally {
      await project.close();
    }
  });

  test('stale: edited bytes, truncation, an append, another working directory, an invalid revision', async () => {
    const project = await openAgentProject('valid');
    try {
      const rev = await project.revision();
      await project.session.validate(rev);
      await materializer(project)({ rev, expectedGenerationId: null });
      const file = path.join(
        auditDirOf(project.fixture),
        `coverage-rev-${rev.revisionId}.json`,
      );
      const canonical = fs.readFileSync(file);
      const variants = [
        ['content-differs', Buffer.from(canonical).fill(0x20, 10, 11)],
        ['size-differs', canonical.subarray(0, canonical.length - 1)],
        ['size-differs', Buffer.concat([canonical, Buffer.from(' ')])],
        // A4: the same revision written by a process whose working directory
        // is the project: its entry paths are relative.
        [
          'size-differs',
          Buffer.from(
            canonical
              .toString('utf8')
              .split(`${project.fixture.project}${path.sep}`)
              .join(''),
          ),
        ],
      ];
      for (const [reason, bytes] of variants) {
        fs.writeFileSync(file, bytes);
        const result = await read(project, rev);
        expect(statuses(result)[1]).toEqual(['stale', reason]);
      }
      fs.writeFileSync(file, canonical);
      expect(statuses(await read(project, rev))[1]).toEqual(['fresh', null]);
    } finally {
      await project.close();
    }
    const invalid = await openAgentProject('neg-forbidden-value');
    try {
      const rev = await invalid.revision();
      await invalid.session.validate(rev);
      fs.mkdirSync(auditDirOf(invalid.fixture));
      fs.writeFileSync(
        path.join(auditDirOf(invalid.fixture), 'coverage-rev-1.json'),
        '{}\n',
      );
      expect(statuses(await read(invalid, rev))).toEqual([
        ['missing', null],
        ['stale', 'revision-invalid'],
      ]);
    } finally {
      await invalid.close();
    }
  });

  test("stale: another session's coverage-rev-1.json over the same project (A3)", async () => {
    // The first session publishes generation 1 and writes its audit of
    // revision 1, then closes.
    const first = await openAgentProject('valid');
    const firstRev = await first.revision();
    await first.session.validate(firstRev);
    await first.session.compile(firstRev);
    await first.session.requestFullAudit(firstRev);
    const file = path.join(auditDirOf(first.fixture), 'coverage-rev-1.json');
    const written = fs.readFileSync(file);
    await first.close();
    // A second session over the same project is at revision 1 again.
    const session = first.fixture.openPublicSession();
    const binding = await compiler.createAgentBinding({
      session,
      initialize: true,
    });
    try {
      const capability = binding.mintCapability({ grants: ['consult'] });
      const dispatch = (operation, input) =>
        binding.dispatch(request(operation, input), { capability });
      const rev = (await dispatch('session.status', {})).identities.revision;
      expect(rev.revisionId).toBe(1);
      expect((await dispatch('check', { rev })).outcome).toBe('success');
      const result = (await dispatch('audit.read', { rev })).result;
      expect(fs.readFileSync(file)).toEqual(written);
      expect(result.artifacts[1].status).toBe('stale');
      expect(result.artifacts[1].sha256).toBeNull();
    } finally {
      await session.close();
    }
  });

  test('unreadable without opening: a symlink, a directory, a FIFO and a socket at the file name', async () => {
    const project = await openAgentProject('valid');
    try {
      const rev = await project.revision();
      await project.session.validate(rev);
      await materializer(project)({ rev, expectedGenerationId: null });
      const dir = auditDirOf(project.fixture);
      const file = path.join(dir, `coverage-rev-${rev.revisionId}.json`);
      const copy = path.join(dir, 'copy.json');
      fs.renameSync(file, copy);
      const plant = {
        symlink: () => fs.symlinkSync(copy, file),
        directory: () => fs.mkdirSync(file),
        fifo: () => spawnSync('mkfifo', [file]),
        socket: () =>
          spawnSync(process.execPath, [
            '-e',
            `require('net').createServer().listen(${JSON.stringify(file)}, () => process.exit(0))`,
          ]),
      };
      for (const [kind, make] of Object.entries(plant)) {
        make();
        expect([
          kind,
          fs.existsSync(file) || fs.lstatSync(file) != null,
        ]).toEqual([kind, true]);
        const started = Date.now();
        const result = await read(project, rev);
        expect(Date.now() - started).toBeLessThan(2000);
        expect([kind, ...statuses(result)[1]]).toEqual([
          kind,
          'unreadable',
          'not-regular-file',
        ]);
        fs.rmSync(file, { recursive: true, force: true });
      }
    } finally {
      await project.close();
    }
  });

  test('unreadable: a symlink or a file in place of the audit directory or of outDir', async () => {
    const project = await openAgentProject('valid');
    try {
      const rev = await project.revision();
      await project.session.validate(rev);
      await project.session.requestFullAudit(rev);
      await project.session.compile(rev);
      await materializer(project)({ rev, expectedGenerationId: 1 });
      const dir = auditDirOf(project.fixture);
      const out = project.fixture.outDir;
      for (const [index, target] of [
        [1, dir],
        [0, out],
      ]) {
        const parked = `${target}.parked`;
        fs.renameSync(target, parked);
        // A symlink to the real directory, which holds a fresh document.
        fs.symlinkSync(parked, target);
        let result = await read(project, rev);
        expect(statuses(result)[index]).toEqual([
          'unreadable',
          'directory-not-directory',
        ]);
        fs.unlinkSync(target);
        fs.writeFileSync(target, 'not a directory\n');
        result = await read(project, rev);
        expect(statuses(result)[index]).toEqual([
          'unreadable',
          'directory-not-directory',
        ]);
        fs.unlinkSync(target);
        fs.renameSync(parked, target);
        expect(statuses(await read(project, rev))[index]).toEqual([
          'fresh',
          null,
        ]);
      }
    } finally {
      await project.close();
    }
  });

  test('anchoring unavailable (test seam): every location is unreadable, the write fails closed', async () => {
    const project = await openAgentProject('valid');
    try {
      const rev = await project.revision();
      await project.session.validate(rev);
      await project.session.compile(rev);
      compiler.setAuditStepHook((step) => {
        if (step === 'anchor') throw new Error('no /proc');
      });
      try {
        expect(statuses(await read(project, rev))).toEqual([
          ['unreadable', 'anchoring-unavailable'],
          ['unreadable', 'anchoring-unavailable'],
        ]);
        const response = await materializer(project)({
          rev,
          expectedGenerationId: 1,
        });
        expect(response.outcome).toBe('unsupported-capability');
        expect(response.failure.capability).toBe('feature:anchored-audit-io');
        expect(response.failure.reason).toBe('anchoring-unavailable');
        expect(response.diagnostics[0].code).toBe('PMS_UNSAFE_AUDIT_PATH');
        await expect(
          project.session.requestFullAudit(rev),
        ).rejects.toMatchObject({
          diagnostics: [
            expect.objectContaining({
              code: 'PMS_UNSAFE_AUDIT_PATH',
              context: { reason: 'anchoring-unavailable' },
            }),
          ],
        });
      } finally {
        compiler.setAuditStepHook(null);
      }
      expect(fs.existsSync(auditDirOf(project.fixture))).toBe(false);
      // The staging branch and compute touch no audit file: unaffected.
      expect((await project.dispatch('audit.compute', { rev })).outcome).toBe(
        'success',
      );
    } finally {
      await project.close();
    }
  });

  test('a parent of outDir created by the first commit is pinned then: unavailable before, anchored after', async () => {
    // Spread into the session options after `prepare` has run.
    const sessionOptions = {};
    const project = await openAgentProject('valid', {
      // One page, importing the design system from the nested output.
      prepare: (fixture) => {
        fs.rmSync(fixture.src('src'), { recursive: true });
        fs.mkdirSync(fixture.src('src'));
        fs.writeFileSync(
          fixture.src('src/page.js'),
          "import { create, token } from '../not-yet/generated/design.pandamstyle';\nexport const s = create({ a: { padding: token('spacing.md') } });\n",
        );
        sessionOptions.outDir = fixture.src('not-yet', 'generated');
      },
      sessionOptions,
    });
    try {
      const rev = await project.revision();
      await project.session.validate(rev);
      expect(statuses(await read(project, rev))).toEqual([
        ['unreadable', 'anchoring-unavailable'],
        ['unreadable', 'anchoring-unavailable'],
      ]);
      const early = await materializer(project)({
        rev,
        expectedGenerationId: null,
      });
      expect(early.failure.reason).toBe('anchoring-unavailable');
      await project.session.requestFullAudit(rev);
      await project.session.compile(rev);
      const after = await read(project, rev);
      expect(after.artifacts[0].path).toBe(
        path.join(
          project.fixture.project,
          'not-yet',
          'generated',
          'coverage.json',
        ),
      );
      expect(statuses(after)).toEqual([
        ['fresh', null],
        ['missing', null],
      ]);
      expect(
        (await materializer(project)({ rev, expectedGenerationId: 1 })).outcome,
      ).toBe('success');
    } finally {
      await project.close();
    }
  });

  test('ancestor swap after initialize(): the result describes the pinned directory, never the copy', async () => {
    const project = await openAgentProject('valid');
    const root = project.fixture.project;
    const parked = `${root}.parked`;
    try {
      const rev = await project.revision();
      await project.session.validate(rev);
      // A copy of the project holding a fresh document at the nominal path.
      const copy = `${root}.copy`;
      fs.cpSync(root, copy, { recursive: true, verbatimSymlinks: true });
      await materializer(project)({ rev, expectedGenerationId: null });
      const name = `coverage-rev-${rev.revisionId}.json`;
      const fresh = path.join(auditDirOf(project.fixture), name);
      fs.mkdirSync(
        path.join(copy, path.basename(auditDirOf(project.fixture))),
        {
          recursive: true,
        },
      );
      fs.copyFileSync(
        fresh,
        path.join(copy, path.basename(auditDirOf(project.fixture)), name),
      );
      // The pinned directory loses its document.
      fs.unlinkSync(fresh);
      fs.renameSync(root, parked);
      fs.symlinkSync(copy, root);
      try {
        const result = await read(project, rev);
        expect(statuses(result)[1]).toEqual(['missing', null]);
      } finally {
        fs.unlinkSync(root);
        fs.renameSync(parked, root);
      }
    } finally {
      await project.close();
    }
  });
});

// ------------------------------------------------- unsafe-path class ----

describe('§5.2 unsafe-path class tests, for audit.materialize and the SDK after publication', () => {
  const PATHS = [
    [
      'audit.materialize',
      async (project, rev) => {
        const response = await materializer(project)({
          rev,
          expectedGenerationId: 1,
        });
        if (response.outcome === 'success') return { ok: true };
        return {
          ok: false,
          code: response.diagnostics[0]?.code,
          reason: response.diagnostics[0]?.context?.reason,
          outcome: response.outcome,
        };
      },
    ],
    [
      'SDK requestFullAudit',
      async (project, rev) => {
        try {
          await project.session.requestFullAudit(rev);
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            code: error.diagnostics?.[0]?.code,
            reason: error.diagnostics?.[0]?.context?.reason,
            errno: error.diagnostics?.[0]?.context?.errno,
          };
        }
      },
    ],
  ];

  async function published() {
    const project = await openAgentProject('valid');
    const rev = await project.revision();
    await project.session.validate(rev);
    await project.session.compile(rev);
    const dir = auditDirOf(project.fixture);
    return {
      project,
      rev,
      dir,
      file: path.join(dir, `coverage-rev-${rev.revisionId}.json`),
    };
  }

  test.each(PATHS)(
    '%s: a symlink at the final name pointing at a source is replaced, the source untouched',
    async (_label, write) => {
      const { project, rev, dir, file } = await published();
      try {
        const source = project.fixture.src('src/page.js');
        const sourceBytes = fs.readFileSync(source);
        fs.mkdirSync(dir);
        fs.symlinkSync(source, file);
        expect((await write(project, rev)).ok).toBe(true);
        expect(fs.lstatSync(file).isFile()).toBe(true);
        expect(fs.readFileSync(source)).toEqual(sourceBytes);
      } finally {
        await project.close();
      }
    },
  );

  test.each(PATHS)(
    '%s: the audit directory as a symlink to src/ is refused, src/ unchanged',
    async (_label, write) => {
      const { project, rev, dir } = await published();
      try {
        const src = project.fixture.src('src');
        const before = hashTree(src);
        fs.symlinkSync(src, dir);
        const result = await write(project, rev);
        expect(result).toMatchObject({
          ok: false,
          code: 'PMS_UNSAFE_AUDIT_PATH',
          reason: 'audit-directory-not-directory',
        });
        expect(hashTree(src)).toEqual(before);
        expect(tempFilesUnder(path.dirname(project.fixture.project))).toEqual(
          [],
        );
      } finally {
        await project.close();
      }
    },
  );

  test.each(PATHS)(
    '%s: a directory at the final name is refused, no temporary file remains',
    async (_label, write) => {
      const { project, rev, file } = await published();
      try {
        fs.mkdirSync(path.join(file, 'inner'), { recursive: true });
        const result = await write(project, rev);
        expect(result).toMatchObject({
          ok: false,
          code: 'PMS_UNSAFE_AUDIT_PATH',
          reason: 'audit-file-not-file',
        });
        expect(tempFilesUnder(path.dirname(project.fixture.project))).toEqual(
          [],
        );
      } finally {
        await project.close();
      }
    },
  );

  test.each(PATHS)(
    '%s: a FIFO at the final name is replaced without blocking',
    async (_label, write) => {
      const { project, rev, dir, file } = await published();
      try {
        fs.mkdirSync(dir);
        spawnSync('mkfifo', [file]);
        expect(fs.lstatSync(file).isFIFO()).toBe(true);
        const started = Date.now();
        expect((await write(project, rev)).ok).toBe(true);
        expect(Date.now() - started).toBeLessThan(2000);
        expect(fs.lstatSync(file).isFile()).toBe(true);
      } finally {
        await project.close();
      }
    },
  );

  test.each(PATHS)(
    '%s: a failed write leaves no temporary file and the earlier document intact',
    async (_label, write) => {
      const { project, rev, dir, file } = await published();
      try {
        expect((await write(project, rev)).ok).toBe(true);
        const earlier = fs.readFileSync(file);
        const block = await auditBlock(project, rev);
        fs.chmodSync(dir, 0o555);
        const fds = openDescriptors();
        try {
          const result = await write(project, rev);
          expect(result).toMatchObject({
            ok: false,
            code: 'PMS_UNSAFE_AUDIT_PATH',
            reason: 'audit-write-failed',
          });
          if (result.outcome != null)
            expect(result.outcome).toBe('internal-error');
          if (result.errno !== undefined) expect(result.errno).toBe('EACCES');
        } finally {
          fs.chmodSync(dir, 0o755);
        }
        expect(openDescriptors()).toBe(fds);
        expect(fs.readFileSync(file)).toEqual(earlier);
        expect(tempFilesUnder(path.dirname(project.fixture.project))).toEqual(
          [],
        );
        expect(await auditBlock(project, rev)).toEqual(block);
      } finally {
        await project.close();
      }
    },
  );

  test('the SDK after close() refuses before any audit step', async () => {
    const { project, rev } = await published();
    await project.close();
    await expect(project.session.requestFullAudit(rev)).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'PMS_SESSION_CLOSED' })],
    });
    expect(fs.existsSync(auditDirOf(project.fixture))).toBe(false);
  });
});

// ---------------------------------------------------------- AC2 bounds ----

describe('AC2 bounds: the audit list pages exhaustively and withholds oversized records', () => {
  test('a relay chain over the compact record ceiling is withheld and read back through records.read', async () => {
    const segments = Array.from(
      { length: 3 },
      (_, i) => `${i}${'é'.repeat(120)}`,
    );
    const depth = segments.length;
    const project = await openAgentProject('valid', {
      prepare: (fixture) => {
        const dir = fixture.src('src', ...segments);
        fs.mkdirSync(dir, { recursive: true });
        const up = '../'.repeat(depth + 1);
        for (let i = 0; i < 6; i += 1) {
          fs.writeFileSync(
            path.join(dir, `relay${i}.js`),
            i === 5
              ? `export { create, token } from '${up}generated/design.pandamstyle';\n`
              : `export { create, token } from './relay${i + 1}';\n`,
          );
        }
        fs.writeFileSync(
          path.join(dir, 'deep.js'),
          "import { create, token } from './relay0';\nexport const s = create({ a: { padding: token('spacing.md') } });\n",
        );
      },
    });
    try {
      const rev = await project.revision();
      await project.session.validate(rev);
      const { records } = await readAuditList(project, rev, {
        view: 'compact',
        limit: 20,
      });
      const index = records.findIndex((record) =>
        record.file.endsWith('deep.js'),
      );
      expect(index).toBeGreaterThanOrEqual(0);
      expect(records[index].relayChain.length).toBeGreaterThanOrEqual(6);
      const page = checked(
        'audit.compute',
        await project.dispatch('audit.compute', {
          rev,
          page: { offset: index, limit: 5 },
        }),
      );
      expect(page.withheld[0].address).toEqual({ kind: 'audit-entry', index });
      expect(page.result.page.records).toEqual([]);
      for (const chunk of [1, 4096]) {
        const read = await readRecord(
          project.dispatch,
          rev,
          { kind: 'audit-entry', index },
          chunk,
        );
        expect(read.sha256).toBe(page.withheld[0].sha256);
        expect(JSON.parse(read.text)).toEqual(records[index]);
      }
      const detail = await project.dispatch(
        'audit.compute',
        { rev, page: { offset: index, limit: 1 } },
        { view: 'detail' },
      );
      expect(detail.result.page.records).toEqual([records[index]]);
      const past = await project.dispatch('records.read', {
        rev,
        address: { kind: 'audit-entry', index: records.length },
        page: { offset: 0, limit: 64 },
      });
      expect(past.failure.reason).toBe('index-out-of-range');
    } finally {
      await project.close();
    }
  });

  test('300 failing files: compact and detail page every entry exactly once, each response under its ceiling', async () => {
    const project = await openAgentProject('valid', {
      prepare: (fixture) => {
        for (let i = 0; i < 300; i += 1)
          fs.writeFileSync(
            fixture.src(`src/bad${String(i).padStart(3, '0')}.js`),
            FORBIDDEN_PAGE.replace('bad', `bad${i}`),
          );
      },
    });
    try {
      const rev = await project.revision();
      await project.session.validate(rev);
      const lists = [];
      for (const [view, limit] of [
        ['compact', 1],
        ['compact', 20],
        ['detail', 256],
      ]) {
        const { audit, records } = await readAuditList(project, rev, {
          view,
          limit,
        });
        expect(audit.coverage.knownEntries).toBe(310);
        expect(records).toHaveLength(310);
        expect(new Set(records.map((record) => record.file)).size).toBe(310);
        lists.push(records);
      }
      expect(lists[1]).toEqual(lists[0]);
      expect(lists[2]).toEqual(lists[0]);
      const past = await project.dispatch('audit.compute', {
        rev,
        page: { offset: 400, limit: 4 },
      });
      expect(past.result.page.records).toEqual([]);
      expect(past.page.truncated).toBe(false);
    } finally {
      await project.close();
    }
  });
});

// --------------------------------------------------- registry, protocol ----

describe('registry and protocol', () => {
  test('the three entries are implemented with their amended contracts', () => {
    const byName = REGISTRY.byName;
    expect(byName['audit.compute'].status).toBe('implemented');
    expect(byName['audit.read'].effects).toEqual([
      { kind: 'reads-generated' },
      { kind: 'computes' },
    ]);
    expect(byName['audit.materialize'].requires.grant).toBe(
      'materialize-audit',
    );
    expect(byName['audit.materialize'].retry).toEqual({
      idempotent: false,
      policy: 'never',
    });
    // J2: no entry declares staging.
    for (const entry of REGISTRY.entries)
      for (const effect of entry.effects)
        expect(effect.detail).not.toBe('stages-audit');
    expect(
      validateSchema(byName['audit.materialize'].input, {
        rev: { projectId: 'p', sessionId: 's', revisionId: 1 },
        expectedGenerationId: 0,
      }),
    ).toEqual({ path: ['expectedGenerationId'], keyword: 'minimum' });
  });

  test('PMS_UNSAFE_AUDIT_PATH maps to its declared outcome per reason', () => {
    const { classifyError, Codes, PmsError, diagnostic } = compiler;
    const of = (reason) =>
      classifyError(
        new PmsError([
          diagnostic({
            code: Codes.UNSAFE_AUDIT_PATH,
            phase: 'audit',
            message: 'x',
            context: { reason },
          }),
        ]),
      );
    expect(of('anchoring-unavailable')).toMatchObject({
      outcome: 'unsupported-capability',
      capability: 'feature:anchored-audit-io',
    });
    expect(of('audit-write-failed').outcome).toBe('internal-error');
    for (const reason of [
      'audit-directory-not-directory',
      'audit-temp-exists',
      'audit-file-not-file',
      'audit-directory-moved',
      'audit-file-replaced',
      'audit-content-mismatch',
    ])
      expect(of(reason)).toMatchObject({
        outcome: 'constraint-violation',
        reason: 'unsafe-audit-path',
      });
    expect(Object.keys(Codes).at(-1)).toBe('UNSAFE_AUDIT_PATH');
  });

  test('a receipt is never an input: no entry accepts a receipt field', () => {
    for (const entry of REGISTRY.entries)
      expect(JSON.stringify(entry.input)).not.toContain('receipt');
  });
});
