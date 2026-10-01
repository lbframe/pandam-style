/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

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
});
