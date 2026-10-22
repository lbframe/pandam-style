/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * AG-01.1 machine protocol: malformed input, capability denial (AC3), the
 * outcome mapping, cancellation, bootstrap failures, one meaning across
 * entry points (AC5) and consultations without effects (AC4).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  compiler,
  declares,
  definitionWith,
  emptyMutation,
  hashTree,
  observedTriple,
  openAgentProject,
  request,
} = require('./agent-helpers');
const { openProject } = require('./session-helpers');

const { createRegistry, createAgentBinding, REGISTRY, REGISTRY_ENTRIES } =
  compiler;

const clone = (value) => JSON.parse(JSON.stringify(value));

/** A registry whose handlers count their calls. */
function spyRegistry() {
  const calls = {};
  const handlers = Object.fromEntries(
    Object.entries(compiler.AGENT_HANDLERS).map(([name, handler]) => [
      name,
      (ctx) => {
        calls[name] = (calls[name] ?? 0) + 1;
        return handler(ctx);
      },
    ]),
  );
  return { registry: createRegistry(clone(REGISTRY_ENTRIES), handlers), calls };
}

async function spyProject() {
  const fixture = openProject('valid');
  const session = fixture.openPublicSession();
  const spy = spyRegistry();
  const binding = await createAgentBinding({
    session,
    initialize: true,
    registry: spy.registry,
  });
  const capability = binding.mintCapability({ grants: ['consult'] });
  const rev = (
    await binding.dispatch(request('session.status', {}), { capability })
  ).identities.revision;
  return { fixture, session, binding, capability, rev, calls: spy.calls };
}

function expectFailure(envelope, outcome, reason) {
  expect({
    outcome: envelope.outcome,
    reason: envelope.failure?.reason,
  }).toEqual({ outcome, reason });
  expect(envelope.result).toBeNull();
}

describe('AG-01.1 malformed input (T7)', () => {
  let project;
  beforeAll(async () => {
    project = await spyProject();
  });
  afterAll(() => project.session.close());

  const cases = () => {
    const rev = project.rev;
    let invoked = false;
    const getterRequest = request('check', { rev });
    Object.defineProperty(getterRequest.input, 'page', {
      enumerable: true,
      get() {
        invoked = true;
        return { offset: 0, limit: 1 };
      },
    });
    const cycle = request('check', { rev });
    cycle.input.self = cycle;
    const deep = {};
    let cursor = deep;
    for (let i = 0; i < 20; i += 1) cursor = cursor.next = {};
    return {
      invoked: () => invoked,
      table: [
        ['wrong type', request('check', { rev: 'r1' }), 'schema-type'],
        ['missing required field', request('check', {}), 'schema-required'],
        [
          'unknown field',
          request('check', { rev, role: 'host' }),
          'schema-additional-properties',
        ],
        [
          'enum violation',
          request('check', { rev }, { view: 'full' }),
          'schema-enum',
        ],
        [
          'over-long string',
          request('diagnostics.candidates', {
            rev,
            domain: { kind: 'category', category: 'c'.repeat(300) },
          }),
          'schema-max-length',
        ],
        [
          'over-long string beyond the request limit',
          request('diagnostics.candidates', {
            rev,
            domain: { kind: 'category', category: 'c'.repeat(4097) },
          }),
          'string-too-long',
        ],
        [
          'over-long array',
          request('protocol.operations', {
            protocolVersions: Array.from({ length: 17 }, () => 1),
          }),
          'schema-max-items',
        ],
        [
          'array beyond the request limit',
          request('protocol.operations', {
            names: Array.from({ length: 513 }, () => 'check'),
          }),
          'array-too-long',
        ],
        ['depth beyond the limit', request('check', { rev, deep }), 'too-deep'],
        [
          'serialized size beyond the limit',
          request('check', {
            rev,
            filler: Array.from({ length: 40 }, () => 'x'.repeat(4000)),
          }),
          'request-too-large',
        ],
        ['a cycle', cycle, 'cycle'],
        ['a getter', getterRequest, 'accessor'],
        [
          'a function',
          request('check', { rev, page: () => 1 }),
          'unsupported-value',
        ],
        [
          'a symbol value',
          request('check', { rev, page: Symbol('x') }),
          'unsupported-value',
        ],
        [
          'a symbol key',
          request('check', { rev, [Symbol('x')]: 1 }),
          'symbol-key',
        ],
        [
          'NaN',
          request('check', { rev, page: { offset: NaN, limit: 1 } }),
          'non-finite-number',
        ],
        [
          'a class instance',
          request('check', { rev: new (class Rev {})() }),
          'non-plain-object',
        ],
        ['a proxy', request('check', new Proxy({ rev }, {})), 'proxy'],
        [
          'a sparse array',
          // eslint-disable-next-line no-sparse-arrays
          request('protocol.operations', { protocolVersions: [1, , 1] }),
          'sparse-array',
        ],
        [
          'undefined',
          request('check', { rev, page: undefined }),
          'unsupported-value',
        ],
        [
          'a revision of zero',
          request('check', { rev: { ...rev, revisionId: 0 } }),
          'schema-minimum',
        ],
        [
          'an invalid requestId',
          request('check', { rev }, { requestId: 'has spaces and <tags>' }),
          'schema-format',
        ],
        [
          'a requestId over 128 characters',
          request('check', { rev }, { requestId: 'r'.repeat(129) }),
          'schema-format',
        ],
        [
          'an unknown envelope field',
          { ...request('check', { rev }), capability: {} },
          'schema-additional-properties',
        ],
        [
          'an unknown operation',
          request('admin.grant', {}),
          'unknown-operation',
        ],
        ['a non-object request', 'check', 'schema-type'],
        ['a non-object input', request('check', [rev]), 'schema-type'],
      ],
    };
  };

  test('every malformed request is invalid-input, never echoed, and runs no handler', async () => {
    const { table, invoked } = cases();
    for (const [label, malformed, reason] of table) {
      const response = await project.binding.dispatch(malformed, {
        capability: project.capability,
      });
      expect({
        label,
        outcome: response.outcome,
        reason: response.failure?.reason,
      }).toEqual({
        label,
        outcome: 'invalid-input',
        reason,
      });
      expect(response.failure.stage).toBe('request');
      expect(response.requestId).toBeUndefined();
      const text = JSON.stringify(response);
      expect(text).not.toContain('has spaces');
      expect(text).not.toContain('ccccc');
      expect(text).not.toContain('rrrrr');
      expect(text).not.toContain('"host"');
      expect(text).not.toContain('xxxx');
      expect(response.limits.responseBytes).toBeLessThanOrEqual(
        response.limits.maxResponseBytes,
      );
    }
    expect(invoked()).toBe(false);
    expect(project.calls).toEqual({ 'session.status': 1 });
  });

  test('a valid requestId is echoed; the operation only when registered', async () => {
    const ok = await project.binding.dispatch(
      request('session.status', {}, { requestId: 'r-42.a:b_c' }),
      { capability: project.capability },
    );
    expect(ok.requestId).toBe('r-42.a:b_c');
    expect(ok.operation).toBe('session.status');
    const unknown = await project.binding.dispatch(request('nope', {}), {
      capability: project.capability,
    });
    expect(unknown.operation).toBeUndefined();
  });

  test('maxResponseBytes below the floor or above the host ceiling is invalid-input', async () => {
    const floor = REGISTRY.views.compact.floor;
    const below = await project.binding.dispatch(
      request('check', { rev: project.rev }, { maxResponseBytes: floor - 1 }),
      { capability: project.capability },
    );
    expectFailure(below, 'invalid-input', 'response-floor');
    const above = await project.binding.dispatch(
      request('check', { rev: project.rev }, { maxResponseBytes: 1e9 }),
      { capability: project.capability },
    );
    expectFailure(above, 'invalid-input', 'response-ceiling');
    const atFloor = await project.binding.dispatch(
      request('check', { rev: project.rev }, { maxResponseBytes: floor }),
      { capability: project.capability },
    );
    expect(atFloor.outcome).toBe('success');
  });
});

describe('AG-01.1 capabilities (AC3, T1, T2)', () => {
  test('every forged, foreign, revoked or insufficient capability is denied', async () => {
    const project = await openAgentProject('valid');
    const other = await openAgentProject('valid');
    try {
      const rev = await project.revision();
      const capability = project.capability;
      const check = (presented) =>
        project.binding.dispatch(request('check', { rev }), {
          capability: presented,
        });
      const proxy = new Proxy(capability, {});
      const cases = [
        [undefined, 'no-capability'],
        [null, 'no-capability'],
        [JSON.parse(JSON.stringify(capability)), 'unknown-capability'],
        [structuredClone(capability), 'unknown-capability'],
        [{ ...capability }, 'unknown-capability'],
        [Object.create(capability), 'unknown-capability'],
        [proxy, 'unknown-capability'],
        ['consult', 'unknown-capability'],
        [{ role: 'host', grants: ['consult'] }, 'unknown-capability'],
        [other.capability, 'foreign-binding'],
        [
          project.binding.mintCapability({ grants: ['publish'] }),
          'missing-grant',
        ],
      ];
      for (const [presented, reason] of cases) {
        const response = await check(presented);
        expectFailure(response, 'denied-access', reason);
        expect(response.failure.capability).toBe('grant:consult');
        expect(response.diagnostics[0].code).toBe('PMS_ACCESS_DENIED');
      }
      expect((await check(capability)).outcome).toBe('success');

      // Authority-shaped request fields are unknown fields, not authority.
      for (const field of ['role', 'grants', 'capability']) {
        const response = await project.binding.dispatch(
          request('check', { rev, [field]: field === 'role' ? 'host' : {} }),
          { capability },
        );
        expectFailure(
          response,
          'invalid-input',
          'schema-additional-properties',
        );
      }

      // A planned operation is unsupported whatever is presented.
      for (const presented of [undefined, capability, other.capability]) {
        const response = await project.binding.dispatch(
          request('publish', { role: 'host' }),
          { capability: presented },
        );
        expectFailure(response, 'unsupported-capability', 'planned');
        expect(response.failure.capability).toBe('op:publish');
      }

      // Closing the session revokes every capability of its binding.
      await project.close();
      expectFailure(await check(capability), 'denied-access', 'revoked');
      // So does disposing the binding.
      other.binding.dispose();
      const disposed = await other.binding.dispatch(
        request('session.status', {}),
        { capability: other.capability },
      );
      expectFailure(disposed, 'denied-access', 'revoked');
      expect(() =>
        other.binding.mintCapability({ grants: ['consult'] }),
      ).toThrow(/disposed/);
    } finally {
      await project.close();
      await other.close();
    }
  });

  test('a definition or config carrying authority-shaped fields grants nothing', async () => {
    const project = await openAgentProject('valid', {
      prepare: (fixture) => {
        const file = fixture.sharedDefinitionPath;
        fs.writeFileSync(
          file,
          fs
            .readFileSync(file, 'utf8')
            .replace(
              "systemId: 'conformance@0.1',",
              "systemId: 'conformance@0.1',\n  role: 'host',\n  grants: ['consult', 'publish'],\n  capability: { grants: ['consult'] },",
            ),
        );
      },
      sessionOptions: { role: 'host', grants: ['consult'] },
    });
    try {
      const rev = await project.revision();
      const response = await project.binding.dispatch(
        request('check', { rev }),
      );
      expectFailure(response, 'denied-access', 'no-capability');
    } finally {
      await project.close();
    }
  });

  test('mintCapability accepts only the closed grant set', async () => {
    const project = await openAgentProject('valid');
    try {
      expect(() =>
        project.binding.mintCapability({ grants: ['root'] }),
      ).toThrow(/unknown grant/);
      expect(() => project.binding.mintCapability({ grants: [] })).toThrow();
      expect(Object.keys(project.capability)).toEqual([]);
      expect(Object.isFrozen(project.capability)).toBe(true);
      expect(JSON.stringify(project.capability)).toBe('{}');
    } finally {
      await project.close();
    }
  });
});

describe('AG-01.1 outcomes (§3.6)', () => {
  test('success, constraint-violation and stale-revision through check', async () => {
    const valid = await openAgentProject('valid');
    const invalid = await openAgentProject('neg-forbidden-value');
    try {
      const rev = await valid.revision();
      expect((await valid.dispatch('check', { rev })).outcome).toBe('success');
      const next = await valid.session.applyChanges(emptyMutation(rev));
      const stale = await valid.dispatch('check', { rev });
      expectFailure(stale, 'stale-revision', 'revision-mismatch');
      expect(stale.failure.retry).toBe('after-refresh');
      expect(
        (await valid.dispatch('check', { rev: next.revision })).outcome,
      ).toBe('success');
      const foreign = await valid.dispatch('check', {
        rev: {
          ...next.revision,
          sessionId: '00000000-0000-4000-8000-000000000000',
        },
      });
      expectFailure(foreign, 'invalid-input', 'foreign-identity');

      const verdict = await invalid.dispatch('check', {
        rev: await invalid.revision(),
      });
      expect(verdict.outcome).toBe('constraint-violation');
      expect(verdict.failure).toEqual({
        stage: 'execution',
        reason: 'validation-errors',
        precondition: null,
        capability: null,
        retry: 'after-refresh',
      });
      expect(verdict.result.document.ok).toBe(false);
      // The verdict's own diagnostics stay inside the versioned document.
      expect(verdict.diagnostics).toEqual([]);
    } finally {
      await valid.close();
      await invalid.close();
    }
  });

  test('advisory target warnings are success; enforced incompatibility is constraint-violation, never unsupported', async () => {
    const prepare = (fixture) => {
      const file = fixture.sharedDefinitionPath;
      fs.writeFileSync(
        file,
        fs
          .readFileSync(file, 'utf8')
          .replace(
            "reducedMotion: '@media (prefers-reduced-motion: reduce)',",
            "reducedMotion: '@media (prefers-reduced-motion: reduce)',\n    stuck: '@container scroll-state(stuck: top)',",
          ),
      );
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
    };
    const advisory = await openAgentProject('valid', { prepare });
    const enforced = await openAgentProject('valid', {
      prepare,
      sessionOptions: { targets: { profiles: ['pandamstyle:default@1'] } },
    });
    try {
      const warned = await advisory.dispatch('check', {
        rev: await advisory.revision(),
      });
      expect(warned.outcome).toBe('success');
      const codes = warned.result.document.diagnostics.map((d) => d.code);
      expect(codes).toContain('PMS_TARGET_CAPABILITY_INCOMPATIBLE');
      expect(
        warned.result.document.diagnostics.every((d) => d.severity !== 'error'),
      ).toBe(true);

      const refused = await enforced.dispatch('check', {
        rev: await enforced.revision(),
      });
      expect(refused.outcome).toBe('constraint-violation');
      expect(refused.failure.capability).toBeNull();
      expect(
        refused.result.document.diagnostics.some(
          (d) =>
            d.code === 'PMS_TARGET_CAPABILITY_INCOMPATIBLE' &&
            d.severity === 'error',
        ),
      ).toBe(true);
    } finally {
      await advisory.close();
      await enforced.close();
    }
  });

  test('a truncated compact window never hides an error past it (T8)', async () => {
    // The session emits enforced target errors before their warnings, so the
    // order is built directly: 24 advisory warnings, then one error, given
    // to the real `check` handler through its session hook.
    const revision = {
      projectId: 'p',
      sessionId: '00000000-0000-4000-8000-000000000000',
      revisionId: 3,
    };
    const warning = (index) => ({
      schemaVersion: 1,
      code: 'PMS_TARGET_CAPABILITY_INCOMPATIBLE',
      severity: 'warning',
      context: { enforcement: 'advisory', index },
      candidates: [],
      candidatesTruncated: false,
    });
    const document = {
      documentKind: 'pandamstyle-diagnostics-result',
      ok: false,
      diagnostics: [
        ...Array.from({ length: 24 }, (_, index) => warning(index)),
        { ...warning(24), code: 'PMS_FORBIDDEN_VALUE', severity: 'error' },
      ],
      affected: { entries: [], total: 0, truncated: false },
    };
    const identities = {
      revision,
      designSystem: { systemId: 's', registryDigest: 'ab' },
    };
    const handled = await compiler.AGENT_HANDLERS.check({
      input: { rev: revision },
      view: 'compact',
      viewLimits: REGISTRY.views.compact,
      hooks: {
        check: async () => ({ identities, value: { document, affected: [] } }),
      },
      beforeStart: null,
      budget: { remaining: 1e6 },
    });
    const shown = handled.result.document.diagnostics;
    expect(shown.length).toBe(20);
    expect(shown.every((d) => d.severity !== 'error')).toBe(true);
    expect(handled.result.document.diagnosticsTotal).toBe(25);
    expect(handled.result.document.diagnosticsTruncated).toBe(true);
    expect(handled.result.document.ok).toBe(false);
    expect(handled.classified.outcome).toBe('constraint-violation');
    expect(handled.classified.reason).toBe('validation-errors');
    expect(handled.references[0]).toEqual({
      operation: 'check',
      view: 'detail',
      input: { rev: revision, page: { offset: 20, limit: 256 } },
    });
    // A document that is ok:false with no error is never success.
    const incomplete = compiler.classifyVerdict(
      { ok: false, diagnostics: document.diagnostics.slice(0, 3) },
      identities,
    );
    expect(incomplete).toMatchObject({
      outcome: 'constraint-violation',
      reason: 'incomplete-validation',
    });
  });

  test('unsupported capability: protocol version, view, planned operation', async () => {
    const project = await openAgentProject('valid');
    try {
      const versioned = await project.binding.dispatch(
        { protocolVersion: 2, operation: 'check', input: {} },
        { capability: project.capability },
      );
      expectFailure(versioned, 'unsupported-capability', 'protocol-version');
      expect(versioned.failure.capability).toBe('protocol-version');
      const negotiated = await project.dispatch('protocol.operations', {
        protocolVersions: [2, 3],
      });
      expectFailure(negotiated, 'unsupported-capability', 'protocol-version');
      const entries = clone(REGISTRY_ENTRIES);
      entries.find((entry) => entry.name === 'check').views = ['compact'];
      const narrowed = await createAgentBinding({
        session: project.session,
        registry: createRegistry(entries),
      });
      const viewed = await narrowed.dispatch(
        request('check', { rev: await project.revision() }, { view: 'detail' }),
        { capability: narrowed.mintCapability({ grants: ['consult'] }) },
      );
      expectFailure(viewed, 'unsupported-capability', 'view');
      expect(viewed.failure.capability).toBe('view:detail');
      for (const entry of REGISTRY_ENTRIES.filter(
        (e) => e.status === 'planned',
      )) {
        const response = await project.dispatch(entry.name, {});
        expectFailure(response, 'unsupported-capability', 'planned');
        expect(response.failure.capability).toBe(`op:${entry.name}`);
        expect(response.diagnostics[0].context.owner).toBe(entry.owner);
      }
    } finally {
      await project.close();
    }
  });

  test('internal errors: a thrown host fault and an injected session fault', async () => {
    const fixture = openProject('valid');
    const session = fixture.openPublicSession();
    const entries = clone(REGISTRY_ENTRIES);
    const binding = await createAgentBinding({
      session,
      initialize: true,
      registry: createRegistry(entries, {
        ...compiler.AGENT_HANDLERS,
        'session.status': async () => {
          throw new Error('secret host detail /etc/passwd');
        },
      }),
    });
    try {
      const capability = binding.mintCapability({ grants: ['consult'] });
      const response = await binding.dispatch(request('session.status', {}), {
        capability,
      });
      expectFailure(response, 'internal-error', 'unclassified');
      expect(response.diagnostics[0].code).toBe('PMS_INTERNAL');
      expect(JSON.stringify(response)).not.toContain('secret');
    } finally {
      await session.close();
    }

    // A definition the registry cannot walk: the session reports
    // PMS_SESSION_INTERNAL, which stays a compiler fault.
    const faulty = await openAgentProject('valid', {
      definition: { systemId: 'faulty@1', tokens: { spacing: null } },
    });
    try {
      const response = await faulty.dispatch('check', {
        rev: await faulty.revision(),
      });
      expect(response.outcome).toBe('internal-error');
      expect(response.failure.reason).toBe('compiler-fault');
      expect(response.failure.stage).toBe('bootstrap');
      expect(response.result.document.diagnostics[0].code).toBe(
        'PMS_SESSION_INTERNAL',
      );
    } finally {
      await faulty.close();
    }
  });

  test('every PMS_INVALID_REVISION reason maps to its declared outcome', async () => {
    const { INVALID_REVISION_OUTCOMES, classifyError } = compiler;
    const fixture = openProject('valid');
    const session = fixture.openPublicSession();
    const reasons = {};
    const capture = async (promise) => {
      try {
        await promise;
      } catch (error) {
        const reason = error.diagnostics?.[0]?.context?.reason;
        reasons[reason] = classifyError(error).outcome;
        return error;
      }
      throw new Error('expected a lifecycle error');
    };
    await capture(
      session.validate({ projectId: 'x', sessionId: 'y', revisionId: 1 }),
    );
    const initial = await session.initialize();
    const rev = initial.revision;
    await capture(session.initialize());
    await capture(
      session.validate({ projectId: 'x', sessionId: 'y', revisionId: 0 }),
    );
    await capture(session.validate({ ...rev, projectId: 'other' }));
    await capture(session.agentResult(rev));
    await session.validate(rev);
    await capture(session.readArtifact(rev, 'src/missing.js'));
    await capture(
      session.commitPrepared({
        ticketId: 'x',
        projectId: 'other',
        sessionId: 'y',
        revision: rev,
      }),
    );
    await capture(session.pinAcceptedSnapshot(rev));
    const second = openProject('valid');
    const owner = second.openPublicSession({ outDir: fixture.outDir });
    await capture(owner.initialize());
    await session.close();

    const invalidFixture = openProject('neg-forbidden-value');
    const invalid = invalidFixture.openPublicSession();
    const invalidRev = (await invalid.initialize()).revision;
    await invalid.validate(invalidRev);
    await capture(invalid.preparePublication(invalidRev));
    await invalid.close();

    const cyclic = openProject('valid');
    const broken = cyclic.openPublicSession({
      definition: definitionWith(cyclic, (definition) => {
        definition.tokens.spacing.loopA = {
          ref: 'spacing.loopB',
          visibility: 'public',
        };
        definition.tokens.spacing.loopB = {
          ref: 'spacing.loopA',
          visibility: 'public',
        };
      }),
    });
    const brokenRev = (await broken.initialize()).revision;
    await capture(broken.candidateTokens({ revision: brokenRev }));
    await broken.close();

    for (const [reason, outcome] of Object.entries(reasons)) {
      expect(Object.keys(INVALID_REVISION_OUTCOMES)).toContain(reason);
      expect(outcome).toBe(INVALID_REVISION_OUTCOMES[reason]);
    }
    expect(Object.keys(reasons).sort()).toEqual(
      [
        'already-initialized',
        'design-system-unavailable',
        'foreign-identity',
        'foreign-ticket',
        'malformed-identity',
        'not-initialized',
        'not-validated',
        'output-owned',
        'revision-invalid',
        'snapshot-disabled',
        'uncovered-source',
      ].sort(),
    );
    expect(reasons['snapshot-disabled']).toBe('unsupported-capability');
  });

  test('every lifecycle error site in project.js names a closed reason', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/api/project.js'),
      'utf8',
    );
    const sites = source.split('lifecycleError(').slice(2);
    expect(sites.length).toBeGreaterThanOrEqual(20);
    const closed = [
      ...Object.keys(compiler.INVALID_REVISION_OUTCOMES),
      'revision-mismatch',
      'session-closed',
      'ticket-stale',
    ];
    for (const site of sites) {
      const call = site.slice(0, site.indexOf(');'));
      const match = call.match(/reason: '([a-z-]+)'/);
      expect(match).not.toBeNull();
      expect(closed).toContain(match[1]);
    }
  });
});

describe('AG-01.1 cancellation', () => {
  test('aborted before start: cancelled, the step never runs, nothing changes', async () => {
    const project = await openAgentProject('valid');
    try {
      const rev = await project.revision();
      const next = (await project.session.applyChanges(emptyMutation(rev)))
        .revision;
      const controller = new AbortController();
      // A slow operation ahead in the session queue.
      const slow = project.session.auditMutationSet(next);
      const pending = project.dispatch(
        'check',
        { rev: next },
        {},
        { signal: controller.signal },
      );
      controller.abort();
      await slow;
      const response = await pending;
      expectFailure(response, 'cancelled', 'before-start');
      expect(response.failure.retry).toBe('same-request');
      // The revision was not validated by the cancelled check.
      await expect(project.session.agentResult(next)).rejects.toThrow(
        /requires validation/,
      );
    } finally {
      await project.close();
    }
  });

  test('aborted after the start: the real outcome', async () => {
    const project = await openAgentProject('valid');
    try {
      const rev = await project.revision();
      let reads = 0;
      const signal = {
        get aborted() {
          reads += 1;
          return reads > 2;
        },
      };
      const response = await project.dispatch('check', { rev }, {}, { signal });
      expect(response.outcome).toBe('success');
      expect(reads).toBe(2);
    } finally {
      await project.close();
    }
  });
});

describe('AG-01.1 bootstrap failures (§3.7)', () => {
  test('output-owned: denied-access at bootstrap, replayed by every operation', async () => {
    const owner = openProject('valid');
    const ownerSession = owner.openPublicSession();
    await ownerSession.initialize();
    const second = openProject('valid');
    const session = second.openPublicSession({ outDir: owner.outDir });
    const binding = await createAgentBinding({ session, initialize: true });
    try {
      const capability = binding.mintCapability({ grants: ['consult'] });
      const rev = {
        projectId: session.projectId,
        sessionId: session.sessionId,
        revisionId: 1,
      };
      const operations = [
        request('session.status', {}),
        request('check', { rev }),
        request('diagnostics.affected', { rev }),
        request('diagnostics.candidates', {
          rev,
          domain: { kind: 'category-index', index: 0 },
        }),
        request('records.read', {
          rev,
          address: { kind: 'diagnostic', index: 0 },
          page: { offset: 0, limit: 10 },
        }),
      ];
      for (const operation of operations) {
        const response = await binding.dispatch(operation, { capability });
        expect(response.outcome).toBe('denied-access');
        expect(response.failure).toEqual({
          stage: 'bootstrap',
          reason: 'output-owned',
          precondition: null,
          capability: null,
          retry: 'never',
        });
        expect(response.identities).toEqual({
          projectId: session.projectId,
          sessionId: session.sessionId,
        });
        expect(response.diagnostics[0].code).toBe('PMS_INVALID_REVISION');
        expect(response.diagnostics[0].revision).toBeNull();
        expect(JSON.stringify(response)).not.toContain('PMS_SESSION_CLOSED');
      }
      const record = await binding.dispatch(
        request('records.read', {
          rev: null,
          address: { kind: 'bootstrap', index: 0 },
          page: { offset: 0, limit: 262144 },
        }),
        { capability },
      );
      expect(record.outcome).toBe('success');
      expect(JSON.parse(record.result.chunk).context.reason).toBe(
        'output-owned',
      );
      // protocol.operations needs no binding and still answers.
      const ops = await binding.dispatch(request('protocol.operations', {}));
      expect(ops.outcome).toBe('success');
    } finally {
      await ownerSession.close();
      await session.close();
    }
  });

  test('a definition without a usable systemId is PMS_INVALID_DEFINITION, never PMS_SESSION_INTERNAL', async () => {
    for (const systemId of [undefined, 42, '', 'x'.repeat(129)]) {
      const project = await openAgentProject('valid', {
        definition: (() => {
          const fixture = openProject('valid');
          return definitionWith(fixture, (definition) => {
            if (systemId === undefined) delete definition.systemId;
            else definition.systemId = systemId;
          });
        })(),
      });
      try {
        const response = await project.dispatch('check', {
          rev: await project.revision(),
        });
        expect(response.outcome).toBe('constraint-violation');
        expect(response.failure.stage).toBe('bootstrap');
        const [diagnostic] = response.result.document.diagnostics;
        expect(diagnostic.code).toBe('PMS_INVALID_DEFINITION');
        expect(diagnostic.rule).toBe('definition.system-id');
        expect(diagnostic.context).toEqual({
          field: 'systemId',
          actualType: systemId === undefined ? 'undefined' : typeof systemId,
          bytes:
            typeof systemId === 'string' ? Buffer.byteLength(systemId) : null,
        });
        expect(response.identities.designSystem).toBeUndefined();
        expect(response.result.document.designSystem).toEqual({
          systemId: null,
          registryDigest: null,
        });
      } finally {
        await project.close();
      }
    }
  });
});

describe('AG-01.1 one meaning across entry points (AC5)', () => {
  test('a JSON round trip of the request gives the same envelope, which survives its own round trip', async () => {
    const project = await openAgentProject('neg-forbidden-value');
    try {
      const rev = await project.revision();
      const requests = [
        request('check', { rev }, { requestId: 'rt-1' }),
        request(
          'check',
          { rev, page: { offset: 1, limit: 2 } },
          { view: 'detail' },
        ),
        request('diagnostics.candidates', {
          rev,
          domain: { kind: 'from-diagnostic', index: 0 },
        }),
        request('diagnostics.affected', { rev }),
        request(
          'protocol.operations',
          { names: ['check'] },
          { view: 'detail' },
        ),
        request('publish', {}),
        request('check', { rev, role: 'host' }),
      ];
      for (const original of requests) {
        const direct = await project.binding.dispatch(original, {
          capability: project.capability,
        });
        const viaJson = await project.binding.dispatch(
          JSON.parse(JSON.stringify(original)),
          { capability: project.capability },
        );
        expect(viaJson).toEqual(direct);
        expect(JSON.parse(JSON.stringify(direct))).toEqual(direct);
        expect(JSON.stringify(direct)).not.toContain('undefined');
      }
    } finally {
      await project.close();
    }
  });
});

describe('AG-01.1 consultations have no effect (AC4, I3, F1)', () => {
  test('every consult or grant-free operation leaves files, tickets and config untouched', async () => {
    const project = await openAgentProject('valid', {
      prepare: (fixture) => {
        fs.writeFileSync(
          fixture.src('agent-marker.config.js'),
          "require('fs').writeFileSync(require('path').join(__dirname, 'MARKER'), 'executed');\nmodule.exports = {};\n",
        );
      },
    });
    try {
      const fixture = project.fixture;
      const rev = await project.revision();
      await project.session.validate(rev);
      const ticket = await project.session.preparePublication(rev);
      const auditDir = path.join(
        path.dirname(fixture.outDir),
        `.${path.basename(fixture.outDir)}.pms-audit`,
      );
      const before = {
        project: hashTree(fixture.project),
        audit: hashTree(auditDir),
      };
      const consultations = REGISTRY_ENTRIES.filter(
        (entry) =>
          entry.requires.grant == null || entry.requires.grant === 'consult',
      );
      expect(consultations.length).toBeGreaterThan(10);
      const inputs = {
        'protocol.operations': {},
        'session.status': {},
        check: { rev },
        'diagnostics.candidates': {
          rev,
          domain: { kind: 'category-index', index: 0 },
        },
        'diagnostics.affected': { rev },
        'records.read': {
          rev,
          address: { kind: 'affected', index: 0 },
          page: { offset: 0, limit: 64 },
        },
      };
      for (const entry of consultations) {
        for (const view of ['compact', 'detail']) {
          const response = await project.dispatch(
            entry.name,
            inputs[entry.name] ?? { rev },
            { view },
          );
          expect([entry.name, response.outcome]).toEqual([
            entry.name,
            entry.status === 'planned' ? 'unsupported-capability' : 'success',
          ]);
        }
      }
      expect(hashTree(fixture.project)).toEqual(before.project);
      expect(hashTree(auditDir)).toEqual(before.audit);
      expect(fs.existsSync(fixture.src('MARKER'))).toBe(false);
      // The host's prepared ticket survived every consultation.
      const receipt = await project.session.commitPrepared(ticket);
      expect(receipt.revision).toEqual(rev);
    } finally {
      await project.close();
    }
  });
});

describe('AG-01.1 declared error contracts (fault-injection matrix, AC1)', () => {
  test('every observed (outcome, code, reason) of an implemented operation is declared', async () => {
    const valid = await openAgentProject('valid');
    const invalid = await openAgentProject('neg-forbidden-value');
    const cyclicFixture = openProject('valid');
    const cyclic = await openAgentProject('valid', {
      definition: definitionWith(cyclicFixture, (definition) => {
        definition.tokens.spacing.loopA = {
          ref: 'spacing.loopB',
          visibility: 'public',
        };
        definition.tokens.spacing.loopB = {
          ref: 'spacing.loopA',
          visibility: 'public',
        };
      }),
    });
    const observed = [];
    const run = async (project, name, input, extra, options) => {
      const response = await project.dispatch(name, input, extra, options);
      observed.push([name, response]);
      return response;
    };
    try {
      const rev = await valid.revision();
      const stale = { ...rev, revisionId: rev.revisionId + 5 };
      const foreign = { ...rev, projectId: 'elsewhere' };
      const aborted = { signal: AbortSignal.abort() };
      const domain = { kind: 'category-index', index: 0 };
      const read = (address) => ({
        rev,
        address,
        page: { offset: 0, limit: 8 },
      });
      // Before validation.
      await run(valid, 'diagnostics.affected', { rev });
      await run(valid, 'records.read', read({ kind: 'diagnostic', index: 0 }));
      await run(valid, 'diagnostics.candidates', {
        rev,
        domain: { kind: 'from-diagnostic', index: 0 },
      });
      for (const name of [
        'check',
        'diagnostics.affected',
        'diagnostics.candidates',
        'records.read',
      ]) {
        const input =
          name === 'records.read'
            ? read({ kind: 'affected', index: 0 })
            : name === 'diagnostics.candidates'
              ? { rev, domain }
              : { rev };
        await run(valid, name, input);
        await run(valid, name, { ...input, rev: stale });
        await run(valid, name, { ...input, rev: foreign });
        await run(valid, name, input, {}, aborted);
        await run(valid, name, input, { view: 'detail' });
      }
      await run(valid, 'session.status', {}, {}, aborted);
      await run(valid, 'diagnostics.candidates', {
        rev,
        domain: { kind: 'category-index', index: 999 },
      });
      await run(valid, 'records.read', read({ kind: 'affected', index: 999 }));
      await run(valid, 'records.read', read({ kind: 'diagnostic', index: 0 }));
      await run(valid, 'records.read', read({ kind: 'bootstrap', index: 0 }));
      await run(valid, 'records.read', {
        rev: null,
        address: { kind: 'bootstrap', index: 0 },
        page: { offset: 0, limit: 8 },
      });
      await run(valid, 'records.read', {
        rev: null,
        address: { kind: 'diagnostic', index: 0 },
        page: { offset: 0, limit: 8 },
      });
      await run(valid, 'protocol.operations', { names: ['nope'] });
      await run(valid, 'protocol.operations', { protocolVersions: [7] });
      const invalidRev = await invalid.revision();
      await run(invalid, 'check', { rev: invalidRev });
      await run(invalid, 'diagnostics.candidates', {
        rev: invalidRev,
        domain: { kind: 'from-diagnostic', index: 0 },
      });
      await run(invalid, 'diagnostics.candidates', {
        rev: invalidRev,
        domain: { kind: 'from-diagnostic', index: 99 },
      });
      const cyclicRev = await cyclic.revision();
      await run(cyclic, 'check', { rev: cyclicRev });
      await run(cyclic, 'diagnostics.candidates', { rev: cyclicRev, domain });
      await run(cyclic, 'records.read', {
        rev: cyclicRev,
        address: { kind: 'candidate', domain, index: 0 },
        page: { offset: 0, limit: 8 },
      });
      await valid.close();
      await run(valid, 'check', { rev });
      for (const [name, response] of observed) {
        if (response.outcome === 'success') continue;
        const triple = observedTriple(response);
        expect({
          name,
          triple,
          declared: declares(REGISTRY.byName[name], triple),
        }).toEqual({
          name,
          triple,
          declared: true,
        });
      }
      const outcomes = new Set(
        observed.map(([, response]) => response.outcome),
      );
      for (const outcome of [
        'success',
        'invalid-input',
        'constraint-violation',
        'unsupported-capability',
        'denied-access',
        'stale-revision',
        'cancelled',
      ])
        expect(outcomes).toContain(outcome);
    } finally {
      await valid.close();
      await invalid.close();
      await cyclic.close();
    }
  });

  test('a close racing a queued request is stale-revision (session-closed)', async () => {
    const project = await openAgentProject('valid');
    const rev = await project.revision();
    const pending = project.dispatch('check', { rev });
    const closing = project.session.close();
    // The request was queued before close; it is served first, so it succeeds.
    expect((await pending).outcome).toBe('success');
    await closing;
    // A hook reached after close fails with the lifecycle code, mapped.
    const hooks = project.session[compiler.AGENT_SESSION_HOOKS];
    await expect(hooks.check(rev, {}, null)).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'PMS_SESSION_CLOSED' })],
    });
    const error = await hooks.check(rev, {}, null).catch((caught) => caught);
    expect(compiler.classifyError(error)).toMatchObject({
      outcome: 'stale-revision',
      reason: 'session-closed',
    });
    expect(
      declares(REGISTRY.byName.check, {
        outcome: 'stale-revision',
        code: 'PMS_SESSION_CLOSED',
        reason: 'session-closed',
      }),
    ).toBe(true);
  });
});
