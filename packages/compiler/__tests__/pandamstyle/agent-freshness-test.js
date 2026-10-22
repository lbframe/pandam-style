/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * AG-01.1 identities and design-system freshness (AC2, I4, I9, F6, T13).
 *
 * A design-system identity or vocabulary is reported for revision R only when
 * it was built from R's definition and configuration. Every transition below
 * runs the same assertions at every step, with `candidateTokens` called before
 * and after validation, and checks that publication is refused while the
 * declared definition or `targets` is invalid.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  compiler,
  definitionWith,
  emptyMutation,
  openAgentProject,
} = require('./agent-helpers');
const { openProject } = require('./session-helpers');

const SRC = path.resolve(__dirname, '../../src');

function cyclicDefinition(fixture) {
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

function renamedDefinition(fixture) {
  return definitionWith(fixture, (definition) => {
    definition.systemId = 'conformance@0.2';
    definition.tokens.spacing.huge = { value: '64px', visibility: 'public' };
  });
}

const INVALID_TARGETS = { profiles: ['pandamstyle:no-such-profile@1'] };
const VALID_TARGETS = { profiles: ['pandamstyle:default@1'] };

/**
 * Advances the revision with `change`, then asserts the freshness contract.
 * `expected` is `{ current: identity | null, failure: code | null,
 * lastValid: identity | null }`.
 */
async function step(project, change, expected) {
  const previous = await project.revision();
  const applied = await project.session.applyChanges({
    ...emptyMutation(previous),
    ...change,
  });
  const rev = applied.revision;
  await assertFreshness(project, rev, expected);
  return rev;
}

async function assertFreshness(project, rev, expected) {
  // candidateTokens and diagnostics.candidates BEFORE validation.
  await assertVocabulary(project, rev, expected);

  const check = await project.dispatch('check', { rev });
  const document = check.result.document;
  expect(check.identities.revision).toEqual(rev);
  if (expected.current == null) {
    expect(check.identities.designSystem).toBeUndefined();
    expect(document.designSystem).toEqual({
      systemId: null,
      registryDigest: null,
    });
    expect(check.outcome).not.toBe('success');
    expect(check.failure.stage).toBe('bootstrap');
    expect(document.ok).toBe(false);
    expect(document.diagnostics.map((d) => d.code)).toContain(expected.failure);
    // Publication is refused while the declared input is invalid.
    await expect(project.session.compile(rev)).rejects.toThrow();
    await expect(project.session.preparePublication(rev)).rejects.toThrow(
      /Invalid revisions cannot prepare publication/,
    );
  } else {
    expect(check.outcome).toBe('success');
    expect(check.identities.designSystem).toEqual(expected.current);
    expect(document.designSystem).toEqual(expected.current);
  }
  if (expected.lastValid == null) {
    expect(check.identities.lastValidDesignSystem).toBeUndefined();
  } else {
    expect(check.identities.lastValidDesignSystem).toEqual({
      ...expected.lastValid,
      derivedFromRevision: expect.objectContaining({
        sessionId: rev.sessionId,
      }),
    });
    expect(
      check.identities.lastValidDesignSystem.derivedFromRevision.revisionId,
    ).toBeLessThan(rev.revisionId);
  }
  // And AFTER validation: nothing changes.
  await assertVocabulary(project, rev, expected);
}

async function assertVocabulary(project, rev, expected) {
  const agent = await project.dispatch('diagnostics.candidates', {
    rev,
    domain: { kind: 'category', category: 'spacing' },
    page: { offset: 0, limit: 256 },
  });
  let sdk = null;
  try {
    sdk = await project.session.candidateTokens({
      revision: rev,
      category: 'spacing',
      limit: 256,
    });
  } catch (error) {
    sdk = error;
  }
  if (expected.current == null) {
    expect(agent.outcome).toBe('constraint-violation');
    expect(agent.failure).toMatchObject({
      stage: 'bootstrap',
      reason: 'design-system-unavailable',
      precondition: 'design-system-current',
    });
    expect(agent.result).toBeNull();
    expect(sdk).toBeInstanceOf(Error);
    expect(sdk.diagnostics[0]).toMatchObject({
      code: 'PMS_INVALID_REVISION',
      context: expect.objectContaining({
        reason: 'design-system-unavailable',
        revision: rev,
      }),
    });
    expect(sdk.diagnostics[0].context.lastValidDesignSystem).toEqual(
      expected.lastValid == null
        ? null
        : expect.objectContaining(expected.lastValid),
    );
  } else {
    expect(agent.outcome).toBe('success');
    expect(agent.identities.revision).toEqual(rev);
    expect(agent.identities.designSystem).toEqual(expected.current);
    const tokenIds = agent.result.page.records.map((record) => record.tokenId);
    expect(sdk.revision).toEqual(rev);
    expect(sdk.candidates.map((entry) => entry.tokenId)).toEqual(tokenIds);
    expect(tokenIds.includes('spacing.huge')).toBe(
      expected.current.systemId === 'conformance@0.2',
    );
    expect(tokenIds.some((id) => id.startsWith('spacing.loop'))).toBe(false);
  }
}

async function identityOf(project) {
  const status = await project.dispatch('session.status', {});
  return status.identities.designSystem;
}

describe('AG-01.1 identities are never invented (AC2, I4)', () => {
  test('check on the valid fixture carries every identity', async () => {
    const project = await openAgentProject('valid');
    try {
      const rev = await project.revision();
      const response = await project.dispatch('check', { rev });
      expect(response.identities).toEqual({
        projectId: project.session.projectId,
        sessionId: project.session.sessionId,
        revision: rev,
        designSystem: {
          systemId: 'conformance@0.1',
          registryDigest: expect.stringMatching(/^[a-f0-9]{16}$/),
        },
      });
      expect(response.result.document.designSystem).toEqual(
        response.identities.designSystem,
      );
    } finally {
      await project.close();
    }
  });

  test('no projectId fallback for systemId remains, and identity is read only by the facade', () => {
    const project = fs.readFileSync(path.join(SRC, 'api/project.js'), 'utf8');
    expect(project).not.toMatch(/systemId[^\n]*\?\?\s*normalized\.projectId/);
    expect(project).not.toMatch(/\?\?\s*normalized\.projectId/);
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (
          file.endsWith('.js') &&
          !file.endsWith(path.join('api', 'project.js')) &&
          !file.endsWith(path.join('session', 'index.js')) &&
          fs.readFileSync(file, 'utf8').includes('_designSystemIdentity(')
        )
          offenders.push(path.relative(SRC, file));
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});

describe('AG-01.1 design-system freshness (I9)', () => {
  test('cold failures: cyclic definition, unusable systemId, invalid targets', async () => {
    const base = openProject('valid');
    const cases = [
      [{ definition: cyclicDefinition(base) }, 'PMS_TOKEN_CYCLE'],
      [
        {
          definition: definitionWith(base, (definition) => {
            delete definition.systemId;
          }),
        },
        'PMS_INVALID_DEFINITION',
      ],
      [
        {
          definition: definitionWith(base, (definition) => {
            definition.systemId = 7;
          }),
        },
        'PMS_INVALID_DEFINITION',
      ],
      [
        {
          definition: definitionWith(base, (definition) => {
            definition.systemId = '';
          }),
        },
        'PMS_INVALID_DEFINITION',
      ],
      [
        { sessionOptions: { targets: INVALID_TARGETS } },
        'PMS_INVALID_TARGET_CONFIG',
      ],
    ];
    for (const [options, failure] of cases) {
      const project = await openAgentProject('valid', options);
      try {
        const expected = { current: null, failure, lastValid: null };
        await assertFreshness(project, await project.revision(), expected);
        // The next unchanged revision still fails (no false acceptance).
        await step(project, {}, expected);
      } finally {
        await project.close();
      }
    }
  });

  test('hot: valid, cyclic, unchanged, valid again, renamed', async () => {
    const project = await openAgentProject('valid');
    try {
      const original = await identityOf(project);
      await assertFreshness(project, await project.revision(), {
        current: original,
      });
      const failed = {
        current: null,
        failure: 'PMS_TOKEN_CYCLE',
        lastValid: original,
      };
      await step(
        project,
        { definition: cyclicDefinition(project.fixture) },
        failed,
      );
      // Probe 6: the revision after the failure, with no change, used to
      // validate ok and publish the previous design system.
      await step(project, {}, failed);
      await step(project, {}, failed);
      await step(
        project,
        { definition: project.definition() },
        { current: original },
      );
      const renamed = renamedDefinition(project.fixture);
      const rev = await step(
        project,
        { definition: renamed },
        {
          current: {
            systemId: 'conformance@0.2',
            registryDigest: expect.stringMatching(/^[a-f0-9]{16}$/),
          },
        },
      );
      const current = await identityOf(project);
      expect(current.registryDigest).not.toBe(original.registryDigest);
      // The recovered revision publishes under its own identity.
      const receipt = await project.session.compile(rev);
      expect(receipt.designSystem).toEqual(current);
    } finally {
      await project.close();
    }
  });

  test('hot: valid, invalid targets, unchanged, valid targets', async () => {
    const project = await openAgentProject('valid');
    try {
      const original = await identityOf(project);
      const failed = {
        current: null,
        failure: 'PMS_INVALID_TARGET_CONFIG',
        lastValid: original,
      };
      await step(project, { config: { targets: INVALID_TARGETS } }, failed);
      await step(project, {}, failed);
      await step(
        project,
        { config: { targets: VALID_TARGETS } },
        {
          current: {
            systemId: 'conformance@0.1',
            registryDigest: expect.stringMatching(/^[a-f0-9]{16}$/),
          },
        },
      );
    } finally {
      await project.close();
    }
  });

  test('a rebuild input outside the definition (engineOptions) rebuilds a current identity', async () => {
    const project = await openAgentProject('valid');
    try {
      const original = await identityOf(project);
      await step(
        project,
        { config: { engineOptions: { dev: false } } },
        {
          current: {
            systemId: original.systemId,
            registryDigest: expect.stringMatching(/^[a-f0-9]{16}$/),
          },
        },
      );
    } finally {
      await project.close();
    }
  });

  // A partial build that succeeds must not become current: a fault at any
  // phase of the rebuild leaves the last good build historical, and the next
  // unchanged revision retries the rebuild.
  for (const faultPhase of [
    'targets_resolve_ms',
    'ds_build_registry_ms',
    'boundary_ms',
    'ds_module_codegen_ms',
    'ds_types_codegen_ms',
  ]) {
    test(`a fault at ${faultPhase} leaves no current design system until a rebuild succeeds`, async () => {
      const project = await openAgentProject('valid');
      let armed = false;
      let fired = 0;
      const teardown = compiler.installPerfCollector({
        addDuration(name) {
          if (armed && name === faultPhase) {
            armed = false;
            fired += 1;
            throw new Error(`injected fault at ${faultPhase}`);
          }
        },
        addCount() {},
        addParse() {},
        sampleMemory() {},
      });
      try {
        const original = await identityOf(project);
        armed = true;
        const rev = await project.revision();
        const applied = await project.session.applyChanges({
          ...emptyMutation(rev),
          definition: renamedDefinition(project.fixture),
        });
        expect(fired).toBe(1);
        const check = await project.dispatch('check', {
          rev: applied.revision,
        });
        expect(check.identities.designSystem).toBeUndefined();
        expect(check.identities.lastValidDesignSystem).toMatchObject(original);
        expect(check.outcome).toBe('internal-error');
        expect(check.failure.stage).toBe('bootstrap');
        await expect(
          project.session.preparePublication(applied.revision),
        ).rejects.toThrow();
        const retried = await project.session.applyChanges(
          emptyMutation(applied.revision),
        );
        const recovered = await project.dispatch('check', {
          rev: retried.revision,
        });
        expect(recovered.outcome).toBe('success');
        expect(recovered.identities.designSystem.systemId).toBe(
          'conformance@0.2',
        );
      } finally {
        teardown();
        await project.close();
      }
    });
  }

  test('the systemId bound: 128 bytes accepted, 129 bytes and 1,200,000 characters refused', async () => {
    const base = openProject('valid');
    const accepted = await openAgentProject('valid', {
      definition: definitionWith(base, (definition) => {
        definition.systemId = 'é'.repeat(64);
      }),
    });
    try {
      const response = await accepted.dispatch('check', {
        rev: await accepted.revision(),
      });
      expect(response.outcome).toBe('success');
      expect(response.identities.designSystem.systemId).toBe('é'.repeat(64));
    } finally {
      await accepted.close();
    }
    for (const systemId of ['é'.repeat(64) + 'x', 'x'.repeat(1200000)]) {
      const refused = await openAgentProject('valid', {
        definition: definitionWith(base, (definition) => {
          definition.systemId = systemId;
        }),
      });
      try {
        const response = await refused.dispatch('check', {
          rev: await refused.revision(),
        });
        expect(response.outcome).toBe('constraint-violation');
        const [diagnostic] = response.result.document.diagnostics;
        expect(diagnostic.code).toBe('PMS_INVALID_DEFINITION');
        expect(diagnostic.context.bytes).toBe(Buffer.byteLength(systemId));
        expect(response.limits.responseBytes).toBeLessThan(16384);
        expect(JSON.stringify(response)).not.toContain('xxxxxxxx');
      } finally {
        await refused.close();
      }
    }
  });
});
