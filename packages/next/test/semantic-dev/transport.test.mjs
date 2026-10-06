/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import filesystem from 'node:fs/promises';
import path from 'node:path';
import {
  createTransportStore,
  assertSnapshotPair,
} from '../../src/transport-snapshot.js';
import {
  fixture,
  source,
  acceptedSnapshots,
  hash,
} from './coordinator-fixture.mjs';

async function setup(changes = []) {
  const item = fixture();
  const accepted = await acceptedSnapshots(item, changes);
  const snapshot = accepted.snapshots[0];
  const hostDir = item.file('transport');
  const store = await createTransportStore({
    hostDir,
    projectId: snapshot.projectId,
    sessionId: snapshot.sessionId,
  });
  return {
    item,
    accepted,
    store,
    hostDir,
    async close() {
      await store.close();
      await accepted.close();
      item.cleanup();
    },
  };
}

test('materialization exposes exactly five compiler byte copies then atomically one descriptor for JS/CSS', async () => {
  const context = await setup();
  try {
    const snapshot = context.accepted.snapshots[0];
    const descriptor = await context.store.materialize(snapshot);
    assert.equal(fs.existsSync(context.store.currentFile), false);
    assert.equal(descriptor.canonicalSetDigest, snapshot.canonicalSetDigest);
    assert.equal(descriptor.artifactDigest, snapshot.artifactDigest);
    assert.equal(descriptor.artifactSetDigest, snapshot.artifactSetDigest);
    for (const member of descriptor.files) {
      assert.equal(
        fs.readFileSync(member.path, 'utf8'),
        snapshot.files.find((file) => file.file === member.file).content,
      );
      assert.equal(hash(fs.readFileSync(member.path)), member.sha256);
    }
    await context.store.offer(descriptor);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(context.store.currentFile, 'utf8')),
      descriptor,
    );
    assert.equal(await context.store.materialize(snapshot), descriptor);
    assertSnapshotPair(descriptor, descriptor.designJS, descriptor.stylesCSS);
  } finally {
    await context.close();
  }
});

test('a mixed pair negative control rejects, while old and new immutable bytes remain separate', async () => {
  const context = await setup([source('accent')]);
  try {
    const [first, second] = await Promise.all(
      context.accepted.snapshots.map((snapshot) =>
        context.store.materialize(snapshot),
      ),
    );
    assert.throws(
      () => assertSnapshotPair(first, first.designJS, second.stylesCSS),
      (error) => error.code === 'PMS_TRANSPORT_MIXED_PAIR',
    );
    assert.notEqual(
      fs.readFileSync(first.stylesCSS, 'utf8'),
      fs.readFileSync(second.stylesCSS, 'utf8'),
    );
    await context.store.offer(second);
    assert.equal(await context.store.verify(first), first);
    assert.equal(context.store.current().snapshotId, second.snapshotId);
  } finally {
    await context.close();
  }
});

test('late older transport offer cannot move pointer backward under concurrent completions', async () => {
  const context = await setup([source('accent')]);
  try {
    const [first, second] = await Promise.all(
      context.accepted.snapshots.map((snapshot) =>
        context.store.materialize(snapshot),
      ),
    );
    const results = await Promise.allSettled([
      context.store.offer(second),
      context.store.offer(first),
    ]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    assert.equal(results[1].reason.code, 'PMS_STALE_REVISION');
    assert.equal(
      JSON.parse(fs.readFileSync(context.store.currentFile, 'utf8')).snapshotId,
      second.snapshotId,
    );
  } finally {
    await context.close();
  }
});

test('compiler member corruption or missing membership rejects before any exposure', async () => {
  const context = await setup();
  try {
    const snapshot = context.accepted.snapshots[0];
    const corrupt = {
      ...snapshot,
      files: snapshot.files.map((file) =>
        file.kind === 'css' ? { ...file, content: 'tampered' } : file,
      ),
    };
    await assert.rejects(
      context.store.materialize(corrupt),
      (error) => error.code === 'PMS_TRANSPORT_CORRUPT',
    );
    await assert.rejects(
      context.store.materialize({
        ...snapshot,
        files: snapshot.files.slice(1),
      }),
      (error) => error.code === 'PMS_TRANSPORT_CORRUPT',
    );
    assert.equal(fs.existsSync(context.store.currentFile), false);
    assert.equal(context.store.stats().snapshots, 0);
  } finally {
    await context.close();
  }
});

test('existing immutable address corruption is rejected on reuse without repairing it in place', async () => {
  const context = await setup();
  try {
    const snapshot = context.accepted.snapshots[0];
    const descriptor = await context.store.materialize(snapshot);
    await context.store.offer(descriptor);
    fs.chmodSync(descriptor.descriptorFile, 0o600);
    fs.writeFileSync(
      descriptor.descriptorFile,
      JSON.stringify({ ...descriptor, candidateDigest: 'tampered' }),
    );
    await assert.rejects(
      context.store.materialize(snapshot),
      (error) => error.code === 'PMS_TRANSPORT_CORRUPT',
    );
    await assert.rejects(
      context.store.offer(descriptor),
      (error) => error.code === 'PMS_TRANSPORT_CORRUPT',
    );
    assert.equal(
      JSON.parse(fs.readFileSync(descriptor.descriptorFile, 'utf8'))
        .candidateDigest,
      'tampered',
    );
  } finally {
    await context.close();
  }
});

test('a failed exact-byte write leaves previous pointer and committed canonical generation intact', async () => {
  const context = await setup([source('accent')]);
  let broken;
  try {
    const first = await context.store.materialize(
      context.accepted.snapshots[0],
    );
    await context.store.offer(first);
    const before = fs.readFileSync(context.store.currentFile, 'utf8');
    const canonicalCSS = fs.readFileSync(
      context.item.file('generated/styles.css'),
      'utf8',
    );
    broken = await createTransportStore({
      hostDir: context.hostDir,
      projectId: first.projectId,
      sessionId: first.sessionId,
      filesystem: {
        ...filesystem,
        async writeFile(file, content, options) {
          if (path.basename(file) === 'styles.css') {
            const error = new Error('controlled transport write failure');
            error.code = 'ENOSPC';
            throw error;
          }
          return filesystem.writeFile(file, content, options);
        },
      },
    });
    await assert.rejects(
      broken.materialize(context.accepted.snapshots[1]),
      (error) => error.code === 'ENOSPC',
    );
    assert.equal(fs.readFileSync(context.store.currentFile, 'utf8'), before);
    assert.equal(
      fs.readFileSync(context.item.file('generated/styles.css'), 'utf8'),
      canonicalCSS,
    );
    assert.ok(
      !fs
        .readdirSync(broken.sessionDir)
        .some((file) => file.startsWith('.snapshot-')),
    );
  } finally {
    await broken?.close();
    await context.close();
  }
});

test('partial/corrupt temp bytes cannot be offered and retention uses explicit limits without expiration timers', async () => {
  const context = await setup([source('accent')]);
  let corrupt;
  let bounded;
  try {
    const first = context.accepted.snapshots[0];
    corrupt = await createTransportStore({
      hostDir: context.item.file('corrupt'),
      projectId: first.projectId,
      sessionId: first.sessionId,
      filesystem: {
        ...filesystem,
        async writeFile(file, content, options) {
          return filesystem.writeFile(
            file,
            path.basename(file) === 'styles.css' ? 'bad bytes' : content,
            options,
          );
        },
      },
    });
    await assert.rejects(
      corrupt.materialize(first),
      (error) => error.code === 'PMS_TRANSPORT_CORRUPT',
    );
    assert.equal(fs.existsSync(corrupt.currentFile), false);
    bounded = await createTransportStore({
      hostDir: context.item.file('bounded'),
      projectId: first.projectId,
      sessionId: first.sessionId,
      maxSnapshots: 1,
    });
    const descriptor = await bounded.materialize(first);
    await bounded.offer(descriptor);
    await assert.rejects(
      bounded.materialize(context.accepted.snapshots[1]),
      (error) => error.code === 'PMS_TRANSPORT_RETENTION_LIMIT',
    );
    assert.equal(await bounded.verify(descriptor), descriptor);
    assert.equal(bounded.stats().snapshots, 1);
  } finally {
    await corrupt?.close();
    await bounded?.close();
    await context.close();
  }
});

test('another project/session cannot materialize or offer even identical numeric revisions', async () => {
  const context = await setup();
  try {
    const snapshot = context.accepted.snapshots[0];
    await assert.rejects(
      context.store.materialize({ ...snapshot, sessionId: 'other-session' }),
      (error) => error.code === 'PMS_TRANSPORT_FOREIGN_SESSION',
    );
    await assert.rejects(
      context.store.materialize({ ...snapshot, projectId: 'other-project' }),
      (error) => error.code === 'PMS_TRANSPORT_FOREIGN_SESSION',
    );
    assert.equal(fs.existsSync(context.store.currentFile), false);
  } finally {
    await context.close();
  }
});

test('deliberately delayed old materialization finishes after newer offer without moving its pointer backward', async () => {
  const context = await setup([source('accent')]);
  let raced;
  let release;
  let reached;
  const blocked = new Promise((resolve) => {
    reached = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const oldCSS = context.accepted.snapshots[0].files.find(
    (member) => member.kind === 'css',
  ).content;
  try {
    raced = await createTransportStore({
      hostDir: context.item.file('raced'),
      projectId: context.accepted.snapshots[0].projectId,
      sessionId: context.accepted.snapshots[0].sessionId,
      filesystem: {
        ...filesystem,
        async writeFile(file, content, options) {
          if (path.basename(file) === 'styles.css' && content === oldCSS) {
            reached();
            await gate;
          }
          return filesystem.writeFile(file, content, options);
        },
      },
    });
    const oldOperation = raced.materialize(context.accepted.snapshots[0]);
    await blocked;
    const second = await raced.materialize(context.accepted.snapshots[1]);
    await raced.offer(second);
    release();
    const first = await oldOperation;
    await assert.rejects(
      raced.offer(first),
      (error) => error.code === 'PMS_STALE_REVISION',
    );
    assert.equal(
      JSON.parse(fs.readFileSync(raced.currentFile, 'utf8')).snapshotId,
      second.snapshotId,
    );
    assert.equal(await raced.verify(first), first);
  } finally {
    release();
    await raced?.close();
    await context.close();
  }
});

test('failed atomic descriptor rename keeps the previous complete selection intact', async () => {
  const context = await setup([source('accent')]);
  let selected;
  let interrupt = false;
  try {
    selected = await createTransportStore({
      hostDir: context.item.file('atomic-failure'),
      projectId: context.accepted.snapshots[0].projectId,
      sessionId: context.accepted.snapshots[0].sessionId,
      filesystem: {
        ...filesystem,
        async rename(from, to) {
          if (interrupt && to.endsWith('current.json')) {
            const error = new Error('controlled atomic pointer failure');
            error.code = 'EACCES';
            throw error;
          }
          return filesystem.rename(from, to);
        },
      },
    });
    const first = await selected.materialize(context.accepted.snapshots[0]);
    await selected.offer(first);
    const previous = fs.readFileSync(selected.currentFile, 'utf8');
    const second = await selected.materialize(context.accepted.snapshots[1]);
    interrupt = true;
    await assert.rejects(
      selected.offer(second),
      (error) => error.code === 'EACCES',
    );
    assert.equal(fs.readFileSync(selected.currentFile, 'utf8'), previous);
    assert.equal(selected.current().snapshotId, first.snapshotId);
    assert.equal(await selected.verify(first), first);
    assert.equal(await selected.verify(second), second);
  } finally {
    await selected?.close();
    await context.close();
  }
});
