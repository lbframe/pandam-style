/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { openProject } = require('./session-helpers');
const {
  canonicalSetDigestOf,
  captureAcceptedSnapshot,
  createAcceptedSnapshotStore,
  generatedImportsFor,
} = require('../../src/api/accepted-snapshot');

const sha256 = (text) =>
  crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const mutation = (baseRevision, changed = []) => ({
  baseRevision,
  mode: 'verified-explicit',
  changed,
  added: [],
  removed: [],
  renamed: [],
});

async function accepted(project) {
  const initial = await project.initialize();
  const validated = await project.validate(initial.revision);
  expect(validated.ok).toBe(true);
  const generated = await project.readGeneratedArtifacts(validated.revision);
  const receipt = await project.commitPrepared(
    await project.preparePublication(validated.revision),
  );
  return { generated, receipt, revision: receipt.associationRevision };
}

describe('compiler-owned canonical five-file digest', () => {
  const vector = [
    'design-module',
    'declarations',
    'manifest',
    'css',
    'artifact-metadata',
  ].map((kind, index) => ({
    kind,
    file: 'abcde'[index],
    content: ['ab', 'c', 'é', '😀', ''][index],
  }));

  test('matches an independently encoded UTF-8/u64be vector, regardless of input array order', () => {
    // Python hashlib + struct.pack('>Q', byteLength), recorded independently.
    const expected =
      '7089aa585b1341e4138707e4223d7def7348e47a9306f72f9bcecfc9f4ec66cf';
    expect(canonicalSetDigestOf(vector)).toBe(expected);
    expect(canonicalSetDigestOf([...vector].reverse())).toBe(expected);
    expect(
      canonicalSetDigestOf(
        vector.map((member, index) =>
          index === 0
            ? { ...member, content: 'a' }
            : index === 1
              ? { ...member, content: 'bc' }
              : member,
        ),
      ),
    ).not.toBe(expected);
    expect(
      canonicalSetDigestOf(
        vector.map((member, index) =>
          index === 4 ? { ...member, content: '\n' } : member,
        ),
      ),
    ).not.toBe(expected);
  });

  test('rejects missing, duplicate, unsafe, and non-string members', () => {
    expect(() => canonicalSetDigestOf(vector.slice(1))).toThrow(/exactly five/);
    expect(() =>
      canonicalSetDigestOf([...vector.slice(0, 4), vector[0]]),
    ).toThrow(/distinct/);
    expect(() =>
      canonicalSetDigestOf(
        vector.map((member, index) =>
          index === 1 ? { ...member, kind: 'css' } : member,
        ),
      ),
    ).toThrow(/duplicate/);
    expect(() =>
      canonicalSetDigestOf(
        vector.map((member, index) =>
          index === 1 ? { ...member, file: '../x' } : member,
        ),
      ),
    ).toThrow(/safe relative/);
    expect(() =>
      canonicalSetDigestOf(
        vector.map((member, index) =>
          index === 1 ? { ...member, content: null } : member,
        ),
      ),
    ).toThrow(/Missing or duplicate/);
  });
});

describe('compiler generated import provenance', () => {
  test('literal offsets cover import/export/require/dynamic imports and exclude comments and lookalike strings', () => {
    const javascript = `'use client';
// import '../generated/design';
const message = "😀 import '../generated/design'";
import { create } from '../generated/design';
export { token } from '../generated/design.js';
export * from '../generated/design';
const required = require('../generated/design');
const dynamic = import('../generated/design');
import { x } from '../other/design';
function local(require) { return require('../generated/design'); }
`;
    const ranges = generatedImportsFor(
      javascript,
      '/project/src/page.js',
      '/project/generated/design.js',
    );
    expect(ranges).toHaveLength(5);
    expect(
      ranges.map(({ start, end }) => javascript.slice(start, end)),
    ).toEqual([
      "'../generated/design'",
      "'../generated/design.js'",
      "'../generated/design'",
      "'../generated/design'",
      "'../generated/design'",
    ]);
    expect(ranges[0].start).toBe(
      javascript.indexOf(
        "'../generated/design'",
        javascript.indexOf('import { create }'),
      ),
    );
    expect(Object.isFrozen(ranges)).toBe(true);
    expect(ranges.every(Object.isFrozen)).toBe(true);
  });
});

describe('accepted snapshot SDK and retention', () => {
  test('a failed newer capture at the same association never returns an earlier descriptor as its replacement', async () => {
    const fixture = openProject('valid');
    const project = fixture.openPublicSession({
      acceptedSnapshotRetention: {},
    });
    let store;
    try {
      const { revision } = await accepted(project);
      const original = fs.readFileSync(fixture.src('src/page.js'), 'utf8');
      const snapshot = (
        await project.pinAcceptedSnapshot(revision, { owner: 'compiler-test' })
      ).snapshot;
      store = createAcceptedSnapshotStore({
        projectId: project.projectId,
        sessionId: project.sessionId,
        options: { maxSnapshots: 1 },
      });
      store.retain(snapshot);
      const pin = store.pin(revision, { owner: 'already-offered' });
      const replacement = {
        ...snapshot,
        snapshotId: 'replacement-at-same-association',
      };
      let failure;
      try {
        store.retain(replacement);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeDefined();
      store.recordFailure(revision, failure);
      expect(() => store.pin(revision, { owner: 'new-consumer' })).toThrow(
        /retention is exhausted/,
      );
      expect(
        store.read(pin, 'src/page.js', sha256(original)).provenance.snapshotId,
      ).toBe(snapshot.snapshotId);
      // A successful retry of an already retained identity clears a transient
      // availability failure without relabeling the old explicit pin.
      store.retain(snapshot);
      expect(
        store.pin(revision, { owner: 'retried-consumer' }).snapshotId,
      ).toBe(snapshot.snapshotId);
      store.close();
      expect(store.stats()).toEqual(
        expect.objectContaining({ snapshots: 0, pins: 0, bytes: 0 }),
      );
      expect(() => store.read(pin, 'src/page.js', sha256(original))).toThrow(
        /closed/,
      );
    } finally {
      store?.close();
      await project.close();
    }
  });

  test('pins exact actual committed five-file bytes, matching module/CSS provenance and immutable identity', async () => {
    const fixture = openProject('valid');
    const project = fixture.openPublicSession({
      acceptedSnapshotRetention: {},
    });
    try {
      const { receipt, revision } = await accepted(project);
      const pin = await project.pinAcceptedSnapshot(revision, {
        owner: 'coordinator:transport',
      });
      const snapshot = pin.snapshot;
      expect(snapshot.projectId).toBe(project.projectId);
      expect(snapshot.sessionId).toBe(project.sessionId);
      expect(snapshot.artifactRevision).toEqual(receipt.artifactRevision);
      expect(snapshot.associationRevision).toEqual(receipt.associationRevision);
      expect(snapshot.generationId).toBe(receipt.generationId);
      expect(snapshot.artifactDigest).toBe(receipt.artifactDigest);
      expect(snapshot.files.map(({ kind }) => kind)).toEqual([
        'design-module',
        'declarations',
        'manifest',
        'css',
        'artifact-metadata',
      ]);
      for (const member of snapshot.files) {
        const bytes = fs.readFileSync(path.join(fixture.outDir, member.file));
        expect(Buffer.from(member.content, 'utf8')).toEqual(bytes);
        expect(member.bytes).toBe(bytes.length);
        expect(member.sha256).toBe(sha256(bytes));
        expect(Object.isFrozen(member)).toBe(true);
      }
      expect(snapshot.canonicalSetDigest).toBe(
        canonicalSetDigestOf(snapshot.files),
      );
      expect(snapshot.artifactSetDigest).toBe(
        JSON.parse(snapshot.files[4].content).artifactSetDigest,
      );
      expect(
        new Set([
          snapshot.artifactDigest,
          snapshot.artifactSetDigest,
          snapshot.canonicalSetDigest,
          snapshot.candidateDigest,
        ]).size,
      ).toBe(4);
      const original = fs.readFileSync(fixture.src('src/page.js'), 'utf8');
      const artifact = await project.readAcceptedArtifact(
        pin,
        'src/page.js',
        sha256(original),
      );
      expect(artifact.javascript).toContain('__pmsProps');
      // Static design helpers are fully lowered out of this fixture's JS.
      expect(artifact.generatedImports).toEqual([]);
      expect(artifact.css).toEqual([
        {
          file: 'styles.css',
          content: snapshot.files[3].content,
          sourceMap: snapshot.cssSourceMap,
        },
      ]);
      expect(artifact.provenance.snapshotId).toBe(snapshot.snapshotId);
      expect(artifact.provenance.transformedRevision).toEqual(revision);
      expect(Object.isFrozen(snapshot.moduleArtifacts)).toBe(true);
      expect(Object.isFrozen(artifact.provenance)).toBe(true);
      expect(await project.releaseAcceptedSnapshot(pin)).toBe(true);
      expect(await project.releaseAcceptedSnapshot(pin)).toBe(false);
      await expect(
        project.readAcceptedArtifact(pin, 'src/page.js', sha256(original)),
      ).rejects.toThrow(/released, expired/);
    } finally {
      await project.close();
    }
  });

  test('actual artifacts.json bytes include publisher metadata that a preview cannot supply; corruption is rejected', async () => {
    const fixture = openProject('valid');
    const project = fixture.openPublicSession({
      acceptedSnapshotRetention: {},
    });
    try {
      const { generated, receipt } = await accepted(project);
      const metadataFile = path.join(fixture.outDir, 'artifacts.json');
      const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
      // Simulate additional durable publisher receipt metadata: it is outside
      // the existing four-artifact digest and must remain in the five-file one.
      metadata.publicationReceipt = {
        generationId: receipt.generationId,
        artifactRevision: receipt.artifactRevision,
      };
      const actual = `${JSON.stringify(metadata, null, 2)}\n`;
      fs.writeFileSync(metadataFile, actual, 'utf8');
      expect(() =>
        captureAcceptedSnapshot({
          receipt,
          generated,
          candidateDigest: 'candidate',
          modules: [],
          outDir: fixture.outDir,
        }),
      ).toThrow(/bytes differ from durable publication records/);
      // Only the real canonical publisher may accept the additional metadata.
      const generation = fixture.compiler.beginGeneration(fixture.outDir, {
        mode: 'delta',
        generationId: receipt.generationId + 1,
        revisionId: receipt.revision.revisionId,
        revisionIdentity: receipt.associationRevision,
        candidateDigest: 'candidate',
      });
      for (const member of generated.files)
        generation.stageArtifact(
          member.file,
          member.kind === 'artifact-metadata' ? actual : member.content,
        );
      const outcome = generation.commit();
      const publishedReceipt = {
        ...receipt,
        generationId: outcome.generationId,
        artifactDigest: outcome.artifactDigest,
        artifactRevision: outcome.artifactRevisionIdentity,
        associationRevision: outcome.associationRevisionIdentity,
      };
      const captured = captureAcceptedSnapshot({
        receipt: publishedReceipt,
        generated,
        candidateDigest: 'candidate',
        modules: [],
        outDir: fixture.outDir,
      });
      expect(captured.files[4].content).toBe(actual);
      expect(captured.files[4].content).not.toBe(generated.files[4].content);
      expect(captured.artifactSetDigest).toBe(metadata.artifactSetDigest);
      const nextAssociation = {
        ...publishedReceipt.associationRevision,
        revisionId: publishedReceipt.associationRevision.revisionId + 1,
      };
      const reusedGeneration = fixture.compiler.beginGeneration(
        fixture.outDir,
        {
          mode: 'delta',
          generationId: publishedReceipt.generationId + 1,
          revisionId: nextAssociation.revisionId,
          revisionIdentity: nextAssociation,
          candidateDigest: 'reused-candidate',
        },
      );
      for (const member of captured.files)
        reusedGeneration.stageArtifact(member.file, member.content);
      const reused = reusedGeneration.commit();
      expect(reused.generationReused).toBe(true);
      const reusedReceipt = {
        ...publishedReceipt,
        revision: nextAssociation,
        artifactRevision: reused.artifactRevisionIdentity,
        associationRevision: reused.associationRevisionIdentity,
        generationId: reused.generationId,
        artifactDigest: reused.artifactDigest,
      };
      const reusedSnapshot = captureAcceptedSnapshot({
        receipt: reusedReceipt,
        generated,
        candidateDigest: 'reused-candidate',
        modules: [],
        outDir: fixture.outDir,
      });
      expect(reusedSnapshot.generationId).toBe(captured.generationId);
      expect(reusedSnapshot.artifactRevision).toEqual(
        captured.artifactRevision,
      );
      expect(reusedSnapshot.associationRevision).toEqual(nextAssociation);
      expect(reusedSnapshot.canonicalSetDigest).toBe(
        captured.canonicalSetDigest,
      );
      expect(reusedSnapshot.snapshotId).not.toBe(captured.snapshotId);
      fs.writeFileSync(
        path.join(fixture.outDir, 'styles.css'),
        '/* corrupt CSS */',
        'utf8',
      );
      expect(() =>
        captureAcceptedSnapshot({
          receipt: reusedReceipt,
          generated,
          candidateDigest: 'candidate',
          modules: [],
          outDir: fixture.outDir,
        }),
      ).toThrow(/publication mismatch/);
      fs.writeFileSync(
        path.join(fixture.outDir, 'styles.css'),
        generated.files.find(({ kind }) => kind === 'css').content,
        'utf8',
      );
      metadata.artifacts.css.sha256 = '0'.repeat(64);
      fs.writeFileSync(metadataFile, JSON.stringify(metadata), 'utf8');
      expect(() =>
        captureAcceptedSnapshot({
          receipt: reusedReceipt,
          generated,
          candidateDigest: 'candidate',
          modules: [],
          outDir: fixture.outDir,
        }),
      ).toThrow(/bytes differ from durable publication records/);
    } finally {
      await project.close();
    }
  });

  test('historical pins preserve exact source and CSS while a newer source rejects stale input and tickets', async () => {
    const fixture = openProject('valid');
    const project = fixture.openPublicSession({
      acceptedSnapshotRetention: {},
    });
    try {
      const { revision } = await accepted(project);
      const original = fs.readFileSync(fixture.src('src/page.js'), 'utf8');
      const oldPin = await project.pinAcceptedSnapshot(revision, {
        owner: 'old-browser',
      });
      const oldArtifact = await project.readAcceptedArtifact(
        oldPin,
        'src/page.js',
        sha256(original),
      );
      const staleTicket = await project.preparePublication(revision);
      const changed = original.replace(
        "gap: token('spacing.sm')",
        "gap: token('spacing.xl')",
      );
      expect(changed).not.toBe(original);
      fs.writeFileSync(fixture.src('src/page.js'), changed, 'utf8');
      const next = await project.applyChanges(
        mutation(revision, ['src/page.js']),
      );
      await expect(project.commitPrepared(staleTicket)).rejects.toThrow(
        /stale/,
      );
      const receipt = await project.compile(next.revision);
      const newPin = await project.pinAcceptedSnapshot(receipt.revision, {
        owner: 'new-browser',
      });
      const nextArtifact = await project.readAcceptedArtifact(
        newPin,
        'src/page.js',
        sha256(changed),
      );
      expect(nextArtifact.javascript).not.toBe(oldArtifact.javascript);
      expect(nextArtifact.css).not.toEqual(oldArtifact.css);
      expect(
        await project.readAcceptedArtifact(
          oldPin,
          'src/page.js',
          sha256(original),
        ),
      ).toEqual(oldArtifact);
      await expect(
        project.readAcceptedArtifact(newPin, 'src/page.js', sha256(original)),
      ).rejects.toThrow(/source digest differs/);
      expect((await project.current()).revision).toEqual(next.revision);
      expect(
        (await project.readArtifact(next.revision, 'src/page.js')).sourceDigest,
      ).toBe(sha256(changed));
      await expect(
        project.readAcceptedArtifact(
          { ...newPin, owner: 'other-browser' },
          'src/page.js',
          sha256(changed),
        ),
      ).rejects.toThrow(/does not match its owner/);
      // Incoming descriptor bodies never overwrite compiler-owned pin records.
      const forged = { ...newPin, snapshot: { ...oldPin.snapshot } };
      expect(
        await project.readAcceptedArtifact(
          forged,
          'src/page.js',
          sha256(changed),
        ),
      ).toEqual(nextArtifact);
    } finally {
      await project.close();
    }
  });

  test('retention exhaustion preserves pinned bytes and a valid canonical commit; explicit release enables admission', async () => {
    const fixture = openProject('valid');
    const project = fixture.openPublicSession({
      acceptedSnapshotRetention: { maxSnapshots: 1, maxPins: 2 },
    });
    try {
      const { revision } = await accepted(project);
      const original = fs.readFileSync(fixture.src('src/page.js'), 'utf8');
      const oldPin = await project.pinAcceptedSnapshot(revision, {
        owner: 'offered-transport',
      });
      const changed = original.replace(
        "gap: token('spacing.sm')",
        "gap: token('spacing.xl')",
      );
      fs.writeFileSync(fixture.src('src/page.js'), changed, 'utf8');
      const next = await project.applyChanges(
        mutation(revision, ['src/page.js']),
      );
      const receipt = await project.compile(next.revision);
      expect((await project.current()).generation.generationId).toBe(
        receipt.generationId,
      );
      await expect(
        project.pinAcceptedSnapshot(next.revision, { owner: 'new-transport' }),
      ).rejects.toThrow(/retention is exhausted/);
      expect(
        await project.readAcceptedArtifact(
          oldPin,
          'src/page.js',
          sha256(original),
        ),
      ).toEqual(expect.objectContaining({ sourceDigest: sha256(original) }));
      expect(await project.acceptedSnapshotRetentionStats()).toEqual(
        expect.objectContaining({ enabled: true, snapshots: 1, pins: 1 }),
      );
      await project.releaseAcceptedSnapshot(oldPin);
      await project.compile(next.revision);
      const newPin = await project.pinAcceptedSnapshot(next.revision, {
        owner: 'new-transport',
      });
      expect(newPin.snapshot.associationRevision).toEqual(next.revision);
      await expect(
        project.pinAcceptedSnapshot(revision, { owner: 'expired-browser' }),
      ).rejects.toThrow(/No retained accepted snapshot/);
    } finally {
      await project.close();
    }
  });

  test('a byte limit or pin limit is explicit and leaves canonical identity intact', async () => {
    const tinyFixture = openProject('valid');
    const tiny = tinyFixture.openPublicSession({
      acceptedSnapshotRetention: { maxBytes: 1 },
    });
    const fixture = openProject('valid');
    const project = fixture.openPublicSession({
      acceptedSnapshotRetention: { maxPins: 1 },
    });
    try {
      const tinyAccepted = await accepted(tiny);
      expect((await tiny.current()).generation.generationId).toBe(
        tinyAccepted.receipt.generationId,
      );
      await expect(
        tiny.pinAcceptedSnapshot(tinyAccepted.revision, { owner: 'too-large' }),
      ).rejects.toThrow(/retention is exhausted/);
      expect((await tiny.acceptedSnapshotRetentionStats()).bytes).toBe(0);
      const { revision } = await accepted(project);
      const pin = await project.pinAcceptedSnapshot(revision, {
        owner: 'one-owner',
      });
      await expect(
        project.pinAcceptedSnapshot(revision, { owner: 'two-owner' }),
      ).rejects.toThrow(/pin limit/);
      await project.releaseAcceptedSnapshot(pin);
      expect(
        (await project.pinAcceptedSnapshot(revision, { owner: 'two-owner' }))
          .owner,
      ).toBe('two-owner');
    } finally {
      await tiny.close();
      await project.close();
    }
  });

  test('semantic failures cannot create accepted snapshots or return old JS for invalid new bytes', async () => {
    const fixture = openProject('valid');
    const project = fixture.openPublicSession({
      acceptedSnapshotRetention: {},
    });
    try {
      const { revision, receipt } = await accepted(project);
      const pin = await project.pinAcceptedSnapshot(revision, {
        owner: 'retained-valid',
      });
      const original = fs.readFileSync(fixture.src('src/page.js'), 'utf8');
      const invalid = original.replace(
        "gap: token('spacing.sm')",
        "gap: token('spacing.missing')",
      );
      fs.writeFileSync(fixture.src('src/page.js'), invalid, 'utf8');
      const next = await project.applyChanges(
        mutation(revision, ['src/page.js']),
      );
      const validation = await project.validate(next.revision);
      expect(validation.ok).toBe(false);
      await expect(project.compile(next.revision)).rejects.toThrow();
      await expect(
        project.pinAcceptedSnapshot(next.revision, { owner: 'invalid-new' }),
      ).rejects.toThrow(/No retained accepted snapshot/);
      await expect(
        project.readAcceptedArtifact(pin, 'src/page.js', sha256(invalid)),
      ).rejects.toThrow(/source digest differs/);
      expect((await project.current()).generation.generationId).toBe(
        receipt.generationId,
      );
    } finally {
      await project.close();
    }
  });

  test('restart and another project reject old-session pins even when counters match; close releases resources', async () => {
    const fixture = openProject('valid');
    const project = fixture.openPublicSession({
      acceptedSnapshotRetention: {},
    });
    const otherFixture = openProject('valid');
    const other = otherFixture.openPublicSession({
      acceptedSnapshotRetention: {},
    });
    let restarted;
    try {
      const first = await accepted(project);
      const oldPin = await project.pinAcceptedSnapshot(first.revision, {
        owner: 'old-session',
      });
      const sourceDigest = sha256(
        fs.readFileSync(fixture.src('src/page.js'), 'utf8'),
      );
      await accepted(other);
      await expect(
        other.readAcceptedArtifact(oldPin, 'src/page.js', sourceDigest),
      ).rejects.toThrow(/another project or session/);
      await project.close();
      await expect(
        project.readAcceptedArtifact(oldPin, 'src/page.js', sourceDigest),
      ).rejects.toThrow(/closed/);
      restarted = fixture.openPublicSession({ acceptedSnapshotRetention: {} });
      const second = await accepted(restarted);
      expect(second.revision.revisionId).toBe(first.revision.revisionId);
      expect(restarted.sessionId).not.toBe(project.sessionId);
      await expect(
        restarted.pinAcceptedSnapshot(first.revision, { owner: 'old-session' }),
      ).rejects.toThrow(/another project or session/);
      await expect(
        restarted.readAcceptedArtifact(oldPin, 'src/page.js', sourceDigest),
      ).rejects.toThrow(/another project or session/);
      const newPin = await restarted.pinAcceptedSnapshot(second.revision, {
        owner: 'new-session',
      });
      expect(newPin.snapshot.artifactRevision).toEqual(
        second.receipt.artifactRevision,
      );
      expect(newPin.snapshot.associationRevision).toEqual(
        second.receipt.associationRevision,
      );
      expect(newPin.snapshot.snapshotId).not.toBe(oldPin.snapshotId);
    } finally {
      await project.close();
      await other.close();
      await restarted?.close();
    }
  });

  test('strict sessions keep retention disabled and the public snapshot methods refuse explicitly', async () => {
    const fixture = openProject('valid');
    const project = fixture.openPublicSession();
    try {
      const { revision } = await accepted(project);
      expect(await project.acceptedSnapshotRetentionStats()).toEqual(
        expect.objectContaining({
          enabled: false,
          snapshots: 0,
          pins: 0,
          bytes: 0,
        }),
      );
      await expect(
        project.pinAcceptedSnapshot(revision, { owner: 'unconfigured' }),
      ).rejects.toThrow(/requires acceptedSnapshotRetention/);
    } finally {
      await project.close();
    }
  });
});
