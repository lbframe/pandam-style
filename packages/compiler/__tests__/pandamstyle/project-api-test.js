/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { openProject } = require('./session-helpers');
const compilerInternals = require(
  path.resolve(
    __dirname,
    '../../../../.pms-test-support/compiler-inspection.cjs',
  ),
);

function emptyMutation(baseRevision, mode = 'full-discovery') {
  return {
    baseRevision,
    mode,
    changed: [],
    added: [],
    removed: [],
    renamed: [],
  };
}

describe('stable project SDK lifecycle', () => {
  test('results and artifacts require validation and bind to the exact revision', async () => {
    const fixture = openProject('valid');
    const project = fixture.openPublicSession();
    try {
      const initial = await project.initialize();
      expect((await project.current()).generation).toBeNull();
      await expect(project.initialize()).rejects.toThrow(
        /only once per session/,
      );

      await expect(project.agentResult(initial.revision)).rejects.toThrow(
        /requires validation of the current revision first/,
      );
      await expect(
        project.readArtifact(initial.revision, 'src/page.js'),
      ).rejects.toThrow(/requires validation of the current revision first/);

      const validated = await project.validate(initial.revision);
      expect(validated.ok).toBe(true);
      const result = await project.agentResult(validated.revision, {
        candidateLimit: 2,
      });
      expect(result.documentKind).toBe('pandamstyle-diagnostics-result');
      expect(result.revision).toEqual(validated.revision);

      const artifact = await project.readArtifact(
        validated.revision,
        'src/page.js',
      );
      expect(artifact.source).toBe('src/page.js');
      expect(artifact.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.javascript).toContain('__pmsProps');
      expect(artifact.css).toEqual([
        expect.objectContaining({
          file: 'styles.css',
          content: expect.any(String),
        }),
      ]);
      expect(artifact.revision).toEqual(validated.revision);

      const ticket = await project.preparePublication(validated.revision);
      expect(ticket.state).toBe('prepared');
      expect(ticket.candidateDigest).toMatch(/^[a-f0-9]{64}$/);
      const publication = await project.commitPrepared(ticket);
      expect(publication.revision).toEqual(validated.revision);
      expect(publication.artifactRevision).toEqual(validated.revision);
      expect(publication.associationRevision).toEqual(validated.revision);
      expect(publication.generationId).toEqual(expect.any(Number));
      expect(publication.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
      expect((await project.current()).generation.generationId).toBe(
        publication.generationId,
      );
    } finally {
      await project.close();
    }
  });

  test('a later accepted revision revokes a prepared publication ticket', async () => {
    const fixture = openProject('valid');
    const project = fixture.openPublicSession();
    try {
      const initial = await project.initialize();
      const validated = await project.validate(initial.revision);
      const ticket = await project.preparePublication(validated.revision);
      const next = await project.applyChanges({
        baseRevision: validated.revision,
        mode: 'full-discovery',
        changed: [],
        added: [],
        removed: [],
        renamed: [],
      });

      expect(next.revision.revisionId).toBe(validated.revision.revisionId + 1);
      await expect(project.commitPrepared(ticket)).rejects.toThrow(/stale/);
    } finally {
      await project.close();
    }
  });

  test('separate project sessions keep identities and artifacts isolated', async () => {
    const leftFixture = openProject('valid');
    const rightFixture = openProject('valid');
    const left = leftFixture.openPublicSession();
    const right = rightFixture.openPublicSession();

    try {
      const leftInitial = await left.initialize();
      const rightInitial = await right.initialize();
      expect(leftInitial.revision.projectId).toBe(leftFixture.project);
      expect(rightInitial.revision.projectId).toBe(rightFixture.project);
      expect(leftInitial.revision.projectId).not.toBe(
        rightInitial.revision.projectId,
      );
      expect(leftInitial.revision.sessionId).not.toBe(
        rightInitial.revision.sessionId,
      );

      const leftValidated = await left.validate(leftInitial.revision);
      const rightValidated = await right.validate(rightInitial.revision);
      const rightArtifactBefore = await right.readArtifact(
        rightValidated.revision,
        'src/page.js',
      );

      await expect(left.agentResult(rightValidated.revision)).rejects.toThrow(
        /foreign project or session revision/,
      );

      const page = leftFixture.src('src/page.js');
      const original = fs.readFileSync(page, 'utf8');
      const changed = original.replace(
        "gap: token('spacing.sm'),",
        "gap: token('spacing.xl'),",
      );
      expect(changed).not.toBe(original);
      fs.writeFileSync(page, changed, 'utf8');

      const next = await left.applyChanges({
        baseRevision: leftValidated.revision,
        mode: 'verified-explicit',
        changed: ['src/page.js'],
        added: [],
        removed: [],
        renamed: [],
      });
      const leftAfterChange = await left.validate(next.revision);
      expect(leftAfterChange.ok).toBe(true);
      const leftArtifactAfter = await left.readArtifact(
        leftAfterChange.revision,
        'src/page.js',
      );
      const rightArtifactAfter = await right.readArtifact(
        rightValidated.revision,
        'src/page.js',
      );

      expect(leftArtifactAfter.javascript).not.toBe(
        rightArtifactBefore.javascript,
      );
      expect(rightArtifactAfter).toEqual(rightArtifactBefore);
      expect((await right.current()).revision).toEqual(rightValidated.revision);
    } finally {
      await left.close();
      await right.close();
    }
  });

  test('the per-session queue gives concurrent operations deterministic order', async () => {
    const fixture = openProject('valid');
    const project = fixture.openPublicSession();
    try {
      const initial = await project.initialize();
      const compilePromise = project.compile(initial.revision);
      const mutationInput = emptyMutation({ ...initial.revision });
      const mutationPromise = project.applyChanges(mutationInput);
      mutationInput.baseRevision.revisionId = 99;
      mutationInput.changed.push('../../outside.js');
      const [publication, mutation] = await Promise.all([
        compilePromise,
        mutationPromise,
      ]);

      expect(publication.revision).toEqual(initial.revision);
      expect(mutation.revision.revisionId).toBe(
        initial.revision.revisionId + 1,
      );
      await expect(project.validate(initial.revision)).rejects.toThrow(
        /exact current project\/session\/revision identity/,
      );

      const validationPromise = project.validate(mutation.revision);
      const nextMutationPromise = project.applyChanges(
        emptyMutation(mutation.revision),
      );
      const [validation, nextMutation] = await Promise.all([
        validationPromise,
        nextMutationPromise,
      ]);
      expect(validation.revision).toEqual(mutation.revision);
      expect(nextMutation.revision.revisionId).toBe(
        mutation.revision.revisionId + 1,
      );
      await expect(project.agentResult(validation.revision)).rejects.toThrow(
        /exact current project\/session\/revision identity/,
      );
      await expect(
        project.readArtifact(validation.revision, 'src/page.js'),
      ).rejects.toThrow(/exact current project\/session\/revision identity/);
      await expect(
        project.candidateTokens({ revision: validation.revision }),
      ).rejects.toThrow(/exact current project\/session\/revision identity/);
      await expect(
        project.requestFullAudit(validation.revision),
      ).rejects.toThrow(/exact current project\/session\/revision identity/);
      await expect(
        project.auditMutationSet(validation.revision),
      ).rejects.toThrow(/exact current project\/session\/revision identity/);

      const candidatePromise = project.candidateTokens({
        revision: nextMutation.revision,
        limit: 2,
      });
      const closePromise = project.close();
      const [candidates] = await Promise.all([candidatePromise, closePromise]);
      expect(candidates.revision).toEqual(nextMutation.revision);
      await expect(
        project.candidateTokens({ revision: nextMutation.revision }),
      ).rejects.toThrow(/session is closed/);
    } finally {
      await project.close();
      fs.rmSync(fixture.project, { recursive: true, force: true });
    }
  });

  test('revisions and tickets reject foreign, stale, aborted, and reused input', async () => {
    const leftFixture = openProject('valid');
    const rightFixture = openProject('valid');
    const left = leftFixture.openPublicSession();
    const right = rightFixture.openPublicSession();
    const leftHost = compilerInternals.createHostBridge(left);
    const rightHost = compilerInternals.createHostBridge(right);
    try {
      const [leftInitial, rightInitial] = await Promise.all([
        left.initialize(),
        right.initialize(),
      ]);
      const [leftValid, rightValid] = await Promise.all([
        left.validate(leftInitial.revision),
        right.validate(rightInitial.revision),
      ]);
      expect(leftValid.ok).toBe(true);
      expect(rightValid.ok).toBe(true);
      expect(
        (await leftHost.readArtifact(leftValid.revision, 'src/page.js'))
          .revision,
      ).toEqual(leftValid.revision);
      expect(
        (await leftHost.readGeneratedArtifacts(leftValid.revision)).revision,
      ).toEqual(leftValid.revision);

      await expect(
        left.applyChanges(emptyMutation(rightValid.revision)),
      ).rejects.toThrow(/foreign project or session revision/);
      await expect(
        left.validate(leftValid.revision.revisionId),
      ).rejects.toThrow(/complete project\/session\/revision identity/);

      const prepared = await leftHost.preparePublication(leftValid.revision);
      await expect(rightHost.commitPrepared(prepared)).rejects.toThrow(
        /another project or session/,
      );
      const committed = await leftHost.commitPrepared(
        JSON.parse(JSON.stringify(prepared)),
      );
      expect(committed.revision).toEqual(leftValid.revision);
      await expect(leftHost.commitPrepared(prepared)).rejects.toThrow(/stale/);

      const invalidated = await leftHost.preparePublication(leftValid.revision);
      await left.validate(leftValid.revision);
      await expect(leftHost.commitPrepared(invalidated)).rejects.toThrow(
        /stale/,
      );

      const aborted = await leftHost.preparePublication(leftValid.revision);
      expect(await leftHost.abortPrepared(aborted)).toBe(true);
      expect(await leftHost.abortPrepared(aborted)).toBe(false);
      await expect(leftHost.commitPrepared(aborted)).rejects.toThrow(/stale/);

      const preparedPromise = leftHost.preparePublication(leftValid.revision);
      const mutationPromise = left.applyChanges(
        emptyMutation(leftValid.revision),
      );
      const [preparedBeforeMutation, stale] = await Promise.all([
        preparedPromise,
        mutationPromise,
      ]);
      await expect(
        leftHost.commitPrepared(preparedBeforeMutation),
      ).rejects.toThrow(/stale/);
      await expect(left.validate(leftValid.revision)).rejects.toThrow(
        /exact current project\/session\/revision identity/,
      );
      expect(stale.revision.revisionId).toBe(leftValid.revision.revisionId + 1);
    } finally {
      await left.close();
      await right.close();
      fs.rmSync(leftFixture.project, { recursive: true, force: true });
      fs.rmSync(rightFixture.project, { recursive: true, force: true });
    }
  });

  test('cold reopen uses a new session identity and recovers generation origin', async () => {
    const fixture = openProject('valid');
    const first = fixture.openPublicSession();
    const blocked = fixture.openPublicSession();
    let second;
    try {
      const initial = await first.initialize();
      await expect(blocked.initialize()).rejects.toThrow(
        /owns this output directory/,
      );
      const validated = await first.validate(initial.revision);
      const firstReceipt = await first.compile(validated.revision);
      const durableOutput = fs.existsSync(`${fixture.outDir}/manifest.json`);
      expect(durableOutput).toBe(true);
      await first.close();

      second = fixture.openPublicSession();
      const reopened = await second.initialize();
      expect(reopened.revision.sessionId).not.toBe(initial.revision.sessionId);
      const recovered = await second.current();
      expect(recovered.revision).toEqual(reopened.revision);
      expect(recovered.generation.generationId).toBe(firstReceipt.generationId);
      expect(recovered.generation.artifactRevision).toEqual(
        firstReceipt.artifactRevision,
      );
      expect(recovered.generation.associationRevision).toEqual(
        firstReceipt.associationRevision,
      );

      const nextValidation = await second.validate(reopened.revision);
      const nextReceipt = await second.compile(nextValidation.revision);
      expect(nextReceipt.generationId).toBe(firstReceipt.generationId);
      expect(nextReceipt.artifactRevision).toEqual(
        firstReceipt.artifactRevision,
      );
      expect(nextReceipt.associationRevision).toEqual(reopened.revision);

      const page = fixture.src('src/page.js');
      const source = fs.readFileSync(page, 'utf8');
      const changed = source.replace(
        "gap: token('spacing.sm'),",
        "gap: token('spacing.xl'),",
      );
      expect(changed).not.toBe(source);
      fs.writeFileSync(page, changed, 'utf8');
      const changedRevision = await second.applyChanges({
        ...emptyMutation(reopened.revision, 'verified-explicit'),
        changed: ['src/page.js'],
      });
      const changedValidation = await second.validate(changedRevision.revision);
      expect(changedValidation.ok).toBe(true);
      const changedReceipt = await second.compile(changedValidation.revision);
      expect(changedReceipt.generationId).toBeGreaterThan(
        nextReceipt.generationId,
      );
      expect(changedReceipt.artifactRevision).toEqual(
        changedValidation.revision,
      );
    } finally {
      await first.close();
      await blocked.close();
      await second?.close();
      fs.rmSync(fixture.project, { recursive: true, force: true });
    }
  });

  test('same relative paths and systemId stay isolated across distinct registries', async () => {
    const leftFixture = openProject('valid');
    const rightFixture = openProject('valid');
    const alternateDefinition = rightFixture.reloadDefinition();
    alternateDefinition.tokens.spacing.sm.value = '9px';
    const left = leftFixture.openPublicSession();
    const right = rightFixture.openPublicSession({
      definition: alternateDefinition,
    });
    try {
      const [leftInitial, rightInitial] = await Promise.all([
        left.initialize(),
        right.initialize(),
      ]);
      const [leftValid, rightValid] = await Promise.all([
        left.validate(leftInitial.revision),
        right.validate(rightInitial.revision),
      ]);
      expect(leftValid.ok).toBe(true);
      expect(rightValid.ok).toBe(true);
      const [leftArtifact, rightArtifact] = await Promise.all([
        left.readArtifact(leftValid.revision, 'src/page.js'),
        right.readArtifact(rightValid.revision, 'src/page.js'),
      ]);
      expect(leftArtifact.designSystem.systemId).toBe(
        rightArtifact.designSystem.systemId,
      );
      expect(leftArtifact.designSystem.registryDigest).not.toBe(
        rightArtifact.designSystem.registryDigest,
      );
      expect(leftArtifact.css).not.toEqual(rightArtifact.css);

      const rightPage = rightFixture.src('src/page.js');
      const rightSource = fs.readFileSync(rightPage, 'utf8');
      fs.writeFileSync(
        rightPage,
        `import { later } from './later-module';\n${rightSource}`,
        'utf8',
      );
      const rightChanged = await right.applyChanges({
        ...emptyMutation(rightValid.revision, 'verified-explicit'),
        changed: ['src/page.js'],
      });
      const rightInvalid = await right.validate(rightChanged.revision);
      expect(rightInvalid.ok).toBe(false);
      expect(rightInvalid.diagnostics.map(({ code }) => code)).toContain(
        'PMS_COVERAGE_GAP',
      );
      await expect(
        right.preparePublication(rightChanged.revision),
      ).rejects.toThrow(/Invalid revisions cannot prepare publication/);

      const leftLater = leftFixture.src('src/later-module.ts');
      fs.writeFileSync(leftLater, "export const later = 'present';\n", 'utf8');
      const leftChanged = await left.applyChanges({
        ...emptyMutation(leftValid.revision, 'verified-explicit'),
        added: ['src/later-module.ts'],
      });
      expect((await left.validate(leftChanged.revision)).ok).toBe(true);

      const rightRescanned = await right.applyChanges(
        emptyMutation(rightChanged.revision, 'full-discovery'),
      );
      const rightStillInvalid = await right.validate(rightRescanned.revision);
      expect(rightStillInvalid.ok).toBe(false);
      expect(rightStillInvalid.diagnostics.map(({ code }) => code)).toContain(
        'PMS_COVERAGE_GAP',
      );

      await left.close();
      expect(
        (await right.agentResult(rightStillInvalid.revision)).diagnostics.map(
          ({ code }) => code,
        ),
      ).toContain('PMS_COVERAGE_GAP');
    } finally {
      await left.close();
      await right.close();
      fs.rmSync(leftFixture.project, { recursive: true, force: true });
      fs.rmSync(rightFixture.project, { recursive: true, force: true });
    }
  });

  test('watcher events enter the same queue and do not revise another project', async () => {
    const fixture = openProject('valid');
    const otherFixture = openProject('valid');
    const project = fixture.openPublicSession();
    const other = otherFixture.openPublicSession();
    const watchCallbacks = [];
    const fsWatchSpy = jest
      .spyOn(fs, 'watch')
      .mockImplementation((root, options, callback) => {
        watchCallbacks.push({ root, callback });
        return {
          on() {
            return this;
          },
          close() {},
        };
      });
    let watcher;
    try {
      const [initial, otherInitial] = await Promise.all([
        project.initialize(),
        other.initialize(),
      ]);
      watcher = await project.watch({ debounceMs: 1000 });
      expect(watcher.established).toBe(true);
      expect(watchCallbacks).toHaveLength(fixture.roots.length);

      const page = fixture.src('src/page.js');
      const source = fs.readFileSync(page, 'utf8');
      fs.writeFileSync(
        page,
        source.replace(
          "gap: token('spacing.sm'),",
          "gap: token('spacing.md'),",
        ),
        'utf8',
      );
      const watchedRoot = watchCallbacks.find(({ root }) =>
        page.startsWith(`${root}${path.sep}`),
      );
      watchedRoot.callback('change', path.relative(watchedRoot.root, page));

      const watchFlush = watcher.flush();
      const explicitMutation = project.applyChanges(
        emptyMutation(initial.revision, 'verified-explicit'),
      );
      const [watchedRevision] = await Promise.all([watchFlush]);
      expect(watchedRevision.revision.revisionId).toBe(2);
      await expect(explicitMutation).rejects.toThrow(
        /exact current project\/session\/revision identity/,
      );
      expect((await other.current()).revision).toEqual(otherInitial.revision);
    } finally {
      watcher?.close();
      fsWatchSpy.mockRestore();
      await project.close();
      await other.close();
      fs.rmSync(fixture.project, { recursive: true, force: true });
      fs.rmSync(otherFixture.project, { recursive: true, force: true });
    }
  });

  test('watcher buffer overflow discards partial events and queues a full resync', async () => {
    const fixture = openProject('valid');
    const project = fixture.openPublicSession();
    const watchCallbacks = [];
    const closedWatchers = [];
    const fsWatchSpy = jest
      .spyOn(fs, 'watch')
      .mockImplementation((root, options, callback) => {
        const watcher = {
          on() {
            return this;
          },
          close() {
            closedWatchers.push(root);
          },
        };
        watchCallbacks.push({ root, callback });
        return watcher;
      });
    let watcher;
    try {
      const initial = await project.initialize();
      watcher = await project.watch({ maxPending: 1, debounceMs: 1000 });
      const files = ['src/page.js', 'src/business-data.ts'];
      for (const relative of files) {
        const absolute = fixture.src(relative);
        fs.appendFileSync(absolute, '\n// watcher mutation\n', 'utf8');
        const backend = watchCallbacks.find(({ root }) =>
          absolute.startsWith(`${root}${path.sep}`),
        );
        backend.callback('change', path.relative(backend.root, absolute));
      }

      const resynced = await watcher.flush();
      const validation = await project.validate(resynced.revision);
      expect(resynced.revision.revisionId).toBe(
        initial.revision.revisionId + 1,
      );
      expect(validation.agentResult.completeness.discovery).toBe(
        'full-discovery',
      );
      expect(watcher.stats()).toMatchObject({
        overflows: 1,
        pending: 0,
        resyncRequired: true,
      });
      expect(closedWatchers).toHaveLength(fixture.roots.length);
    } finally {
      watcher?.close();
      fsWatchSpy.mockRestore();
      await project.close();
      fs.rmSync(fixture.project, { recursive: true, force: true });
    }
  });

  test('watch loss falls back to full discovery and close releases service registrations', async () => {
    const fixture = openProject('valid');
    const baseline = compilerInternals.projectServiceResourceStats();
    const project = fixture.openPublicSession();
    const fsWatchSpy = jest.spyOn(fs, 'watch').mockImplementation(() => {
      const error = new Error('watch unavailable');
      error.code = 'ENOSPC';
      throw error;
    });
    let watcher;
    try {
      const initial = await project.initialize();
      const validated = await project.validate(initial.revision);
      const ticket = await project.preparePublication(validated.revision);
      watcher = await project.watch();
      expect(watcher.established).toBe(false);
      expect(watcher.startFailures).toHaveLength(1);
      const resynced = await watcher.flush();
      expect(resynced.revision.revisionId).toBe(2);
      const resyncedValidation = await project.validate(resynced.revision);
      expect(resyncedValidation.ok).toBe(true);
      expect(resyncedValidation.agentResult.completeness.discovery).toBe(
        'full-discovery',
      );
      await project.close();
      await expect(project.commitPrepared(ticket)).rejects.toThrow(
        /session is closed/,
      );
      expect(await project.abortPrepared(ticket)).toBe(false);
      await expect(
        project.applyChanges(emptyMutation(resynced.revision)),
      ).rejects.toThrow(/session is closed/);
      await expect(project.validate(resynced.revision)).rejects.toThrow(
        /session is closed/,
      );
      await expect(project.compile(resynced.revision)).rejects.toThrow(
        /session is closed/,
      );
      await expect(
        project.readArtifact(resynced.revision, 'src/page.js'),
      ).rejects.toThrow(/session is closed/);
      expect(watcher.stats().pending).toBe(0);
      expect(compilerInternals.projectServiceResourceStats()).toEqual(baseline);

      for (let index = 0; index < 3; index += 1) {
        const next = fixture.openPublicSession();
        await next.initialize();
        await next.close();
        expect(compilerInternals.projectServiceResourceStats()).toEqual(
          baseline,
        );
      }
    } finally {
      watcher?.close();
      fsWatchSpy.mockRestore();
      await project.close();
      fs.rmSync(fixture.project, { recursive: true, force: true });
    }
  });

  test('artifact snapshots are immutable and project paths cannot escape', async () => {
    const fixture = openProject('valid');
    const project = fixture.openPublicSession();
    const outside = path.join(
      path.dirname(fixture.project),
      `${path.basename(fixture.project)}-outside.js`,
    );
    const link = fixture.src('src/outside-link.js');
    try {
      const initial = await project.initialize();
      const validated = await project.validate(initial.revision);
      const artifact = await project.readArtifact(
        validated.revision,
        'src/page.js',
      );
      expect(Object.isFrozen(artifact)).toBe(true);
      expect(Object.isFrozen(artifact.css)).toBe(true);
      expect(Object.isFrozen(artifact.dependencies)).toBe(true);
      expect(() =>
        artifact.css.push({ file: 'bad.css', content: '' }),
      ).toThrow();
      await expect(
        project.readArtifact(validated.revision, '../../outside.js'),
      ).rejects.toThrow(/stay inside rootDir/);
      await expect(
        project.applyChanges({
          ...emptyMutation(validated.revision, 'verified-explicit'),
          changed: ['../../outside.js'],
        }),
      ).rejects.toThrow(/stay inside rootDir/);
      expect(() =>
        fixture.openPublicSession({ roots: ['../outside-root'] }),
      ).toThrow(/Project root must stay inside rootDir/);
      fs.writeFileSync(outside, 'export const outside = true;\n', 'utf8');
      fs.symlinkSync(outside, link);
      await expect(
        project.applyChanges({
          ...emptyMutation(validated.revision, 'verified-explicit'),
          changed: ['src/outside-link.js'],
        }),
      ).rejects.toThrow(/stay inside rootDir/);
    } finally {
      await project.close();
      fs.rmSync(fixture.project, { recursive: true, force: true });
      fs.rmSync(outside, { force: true });
    }
  });

  test('host source overlays are revision-bound and CSS remains compiler-owned', async () => {
    const fixture = openProject('valid');
    const project = fixture.openPublicSession();
    const page = fixture.src('src/page.js');
    try {
      const initial = await project.initialize();
      const validated = await project.validate(initial.revision);
      expect(validated.ok).toBe(true);
      const originalSource = fs.readFileSync(page, 'utf8');
      const originalArtifacts = await project.readGeneratedArtifacts(
        validated.revision,
      );
      const originalCss = originalArtifacts.files.find(
        ({ kind }) => kind === 'css',
      );
      expect(originalArtifacts.files.map(({ kind }) => kind)).toEqual([
        'design-module',
        'declarations',
        'manifest',
        'css',
        'artifact-metadata',
      ]);
      const overlaySource = originalSource.replace(
        "gap: token('spacing.sm')",
        "gap: token('spacing.lg')",
      );
      expect(overlaySource).not.toBe(originalSource);

      const overlaid = await project.applyChanges({
        ...emptyMutation(validated.revision, 'verified-explicit'),
        changed: ['src/page.js'],
        sourceOverlays: [{ file: 'src/page.js', source: overlaySource }],
      });
      const overlayValidation = await project.validate(overlaid.revision);
      expect(overlayValidation.ok).toBe(true);
      const overlayArtifact = await project.readArtifact(
        overlayValidation.revision,
        'src/page.js',
      );
      const overlayArtifacts = await project.readGeneratedArtifacts(
        overlayValidation.revision,
      );
      const overlayCss = overlayArtifacts.files.find(
        ({ kind }) => kind === 'css',
      );
      expect(overlayArtifact.revision).toEqual(overlayValidation.revision);
      expect(overlayArtifacts.revision).toEqual(overlayValidation.revision);
      expect(overlayCss.content).not.toBe(originalCss.content);
      expect(fs.readFileSync(page, 'utf8')).toBe(originalSource);

      const filesystemRevision = await project.applyChanges({
        ...emptyMutation(overlayValidation.revision, 'verified-explicit'),
        changed: ['src/page.js'],
      });
      const filesystemValidation = await project.validate(
        filesystemRevision.revision,
      );
      expect(filesystemValidation.ok).toBe(true);
      const filesystemArtifacts = await project.readGeneratedArtifacts(
        filesystemValidation.revision,
      );
      expect(
        filesystemArtifacts.files.find(({ kind }) => kind === 'css').content,
      ).toBe(originalCss.content);
    } finally {
      await project.close();
      fs.rmSync(fixture.project, { recursive: true, force: true });
    }
  });

  test('invalid host source overlays cannot serve CSS or prepare publication', async () => {
    const fixture = openProject('valid');
    const project = fixture.openPublicSession();
    try {
      const initial = await project.initialize();
      const valid = await project.validate(initial.revision);
      const page = fs.readFileSync(fixture.src('src/page.js'), 'utf8');
      const invalid = page.replace("gap: token('spacing.sm')", "gap: '12px'");
      const changed = await project.applyChanges({
        ...emptyMutation(valid.revision, 'verified-explicit'),
        changed: ['src/page.js'],
        sourceOverlays: [{ file: 'src/page.js', source: invalid }],
      });
      const result = await project.validate(changed.revision);
      expect(result.ok).toBe(false);
      const diagnostics = await project.agentResult(result.revision);
      expect(diagnostics.documentKind).toBe('pandamstyle-diagnostics-result');
      expect(diagnostics.ok).toBe(false);
      await expect(
        project.readGeneratedArtifacts(result.revision),
      ).rejects.toThrow(/requires a valid current revision/);
      await expect(project.preparePublication(result.revision)).rejects.toThrow(
        /Invalid revisions cannot prepare publication/,
      );
    } finally {
      await project.close();
      fs.rmSync(fixture.project, { recursive: true, force: true });
    }
  });

  test('host publication failure leaves the previous generation current', async () => {
    const fixture = openProject('valid');
    let shouldFail = false;
    const project = fixture.openPublicSession({
      publishFailAt(point) {
        if (shouldFail && point === 'before-commit') {
          throw new Error('injected host publication failure');
        }
      },
    });
    const host = compilerInternals.createHostBridge(project);
    try {
      const initial = await project.initialize();
      const valid = await project.validate(initial.revision);
      const first = await host.commitPrepared(
        await host.preparePublication(valid.revision),
      );
      const treeBefore = compilerInternals.digestOfTree(fixture.outDir);
      const next = await project.applyChanges(emptyMutation(valid.revision));
      const nextValid = await project.validate(next.revision);
      const ticket = await host.preparePublication(nextValid.revision);
      shouldFail = true;
      await expect(host.commitPrepared(ticket)).rejects.toThrow(
        /injected host publication failure/,
      );
      expect(compilerInternals.digestOfTree(fixture.outDir)).toEqual(
        treeBefore,
      );
      expect((await project.current()).generation.generationId).toBe(
        first.generationId,
      );
      await expect(host.commitPrepared(ticket)).rejects.toThrow(/stale/);
    } finally {
      await project.close();
      fs.rmSync(fixture.project, { recursive: true, force: true });
    }
  });
});
