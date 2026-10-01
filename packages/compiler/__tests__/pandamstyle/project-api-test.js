/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

const fs = require('fs');
const { openProject } = require('./session-helpers');

describe('stable project SDK lifecycle', () => {
  test('results and artifacts require validation and bind to the exact revision', async () => {
    const fixture = openProject('valid');
    const project = fixture.openPublicSession();
    try {
      const initial = await project.initialize();

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
        /exact current project\/session\/revision identity/,
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
});
