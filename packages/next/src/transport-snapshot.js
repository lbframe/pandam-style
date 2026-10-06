/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const KINDS = [
  'design-module',
  'declarations',
  'manifest',
  'css',
  'artifact-metadata',
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const freeze = (value) => {
  if (value == null || typeof value !== 'object') return value;
  for (const item of Object.values(value)) freeze(item);
  return Object.freeze(value);
};

export function transportError(code, message, details = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.details = details;
  return error;
}

function safeName(file) {
  return (
    typeof file === 'string' &&
    file !== '' &&
    !file.includes('\\') &&
    !path.posix.isAbsolute(file) &&
    file
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

export async function atomicJSON(file, value, filesystem = fs) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await filesystem.writeFile(temporary, JSON.stringify(value) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    await filesystem.rename(temporary, file);
  } finally {
    await filesystem.rm(temporary, { force: true }).catch(() => {});
  }
}

function membersOf(snapshot, accepted) {
  if (
    !Array.isArray(snapshot.files) ||
    snapshot.files.length !== 5 ||
    new Set(snapshot.files.map((member) => member.file)).size !== 5
  ) {
    throw transportError(
      'PMS_TRANSPORT_CORRUPT',
      'Transport requires exactly five distinct compiler members.',
    );
  }
  return KINDS.map((kind) => {
    const members = snapshot.files.filter((member) => member.kind === kind);
    if (
      members.length !== 1 ||
      !safeName(members[0].file) ||
      typeof members[0].content !== 'string'
    ) {
      throw transportError(
        'PMS_TRANSPORT_CORRUPT',
        `Missing, duplicate or unsafe compiler member: ${kind}.`,
      );
    }
    const member = members[0];
    const bytes = Buffer.from(member.content, 'utf8');
    const hash = sha256(bytes);
    if (accepted && (member.sha256 !== hash || member.bytes !== bytes.length)) {
      throw transportError(
        'PMS_TRANSPORT_CORRUPT',
        `Compiler member digest mismatch: ${member.file}.`,
      );
    }
    return { ...member, sha256: hash, bytes: bytes.length };
  });
}

async function inventory(directory, filesystem, relative = '') {
  const files = [];
  for (const entry of await filesystem.readdir(path.join(directory, relative), {
    withFileTypes: true,
  })) {
    const file = relative === '' ? entry.name : relative + '/' + entry.name;
    if (entry.isDirectory())
      files.push(...(await inventory(directory, filesystem, file)));
    else if (entry.isFile()) files.push(file);
    else
      throw transportError(
        'PMS_TRANSPORT_CORRUPT',
        'Immutable transport contains a nonregular member.',
        { file },
      );
  }
  return files.sort();
}

/** Verifies one expected descriptor, including both JS and CSS and its disk metadata. */
export async function verifyTransportDescriptor(descriptor, filesystem = fs) {
  try {
    if (
      !safeName(descriptor.snapshotId) ||
      !Array.isArray(descriptor.files) ||
      descriptor.files.length !== 5 ||
      new Set(descriptor.files.map((member) => member.file)).size !== 5
    ) {
      throw transportError(
        'PMS_TRANSPORT_CORRUPT',
        'Incomplete immutable transport descriptor.',
      );
    }
    const actual = JSON.parse(
      await filesystem.readFile(descriptor.descriptorFile, 'utf8'),
    );
    if (JSON.stringify(actual) !== JSON.stringify(descriptor)) {
      throw transportError(
        'PMS_TRANSPORT_CORRUPT',
        'Immutable descriptor identity was changed.',
      );
    }
    const expectedFiles = [
      'descriptor.json',
      ...descriptor.files.map((member) => member.file),
    ].sort();
    if (
      JSON.stringify(await inventory(descriptor.directory, filesystem)) !==
      JSON.stringify(expectedFiles)
    ) {
      throw transportError(
        'PMS_TRANSPORT_CORRUPT',
        'Immutable transport membership was changed.',
      );
    }
    for (const kind of KINDS) {
      const members = descriptor.files.filter((member) => member.kind === kind);
      if (members.length !== 1 || !safeName(members[0].file))
        throw transportError(
          'PMS_TRANSPORT_CORRUPT',
          `Invalid ${kind} member.`,
        );
      const member = members[0];
      if (member.path !== path.join(descriptor.directory, member.file))
        throw transportError(
          'PMS_TRANSPORT_CORRUPT',
          'Transport member address belongs to another snapshot.',
        );
      const bytes = await filesystem.readFile(member.path);
      if (bytes.length !== member.bytes || sha256(bytes) !== member.sha256)
        throw transportError(
          'PMS_TRANSPORT_CORRUPT',
          `Immutable member was changed: ${member.file}.`,
        );
    }
    assertSnapshotPair(descriptor, descriptor.designJS, descriptor.stylesCSS);
    return descriptor;
  } catch (error) {
    if (error.code === 'PMS_TRANSPORT_CORRUPT') throw error;
    throw transportError(
      'PMS_TRANSPORT_CORRUPT',
      'Immutable transport is missing or unreadable.',
      {
        filesystemCode: error.code ?? null,
        snapshotId: descriptor?.snapshotId ?? null,
      },
    );
  }
}

export function assertSnapshotPair(descriptor, designJS, stylesCSS) {
  const design = descriptor.files.find(
    (member) => member.kind === 'design-module',
  );
  const css = descriptor.files.find((member) => member.kind === 'css');
  if (
    design == null ||
    css == null ||
    designJS !== design.path ||
    stylesCSS !== css.path ||
    design.path !== path.join(descriptor.directory, design.file) ||
    css.path !== path.join(descriptor.directory, css.file)
  ) {
    throw transportError(
      'PMS_TRANSPORT_MIXED_PAIR',
      'Generated JavaScript and CSS must resolve through the same immutable descriptor.',
    );
  }
}

/** Exact byte storage only; semantic identities and membership come from the SDK. */
export async function createTransportStore({
  hostDir,
  projectId,
  sessionId,
  maxSnapshots = 256,
  maxBytes = 128 * 1024 * 1024,
  filesystem = fs,
}) {
  if (!safeName(sessionId))
    throw new TypeError('Transport sessionId must be a safe path component.');
  for (const limit of [maxSnapshots, maxBytes])
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new TypeError('Transport limits must be positive safe integers.');
  const sessionDir = path.join(hostDir, 'sessions', sessionId);
  const currentFile = path.join(hostDir, 'current.json');
  await filesystem.mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const records = new Map();
  const pending = new Map();
  let bytes = 0;
  let reservedBytes = 0;
  let reservedCount = 0;
  let current = null;
  let offerTail = Promise.resolve();
  let closed = false;
  const requireOpen = () => {
    if (closed)
      throw transportError(
        'PMS_TRANSPORT_EXPIRED',
        'Coordinator transport is closed; restart and reload.',
      );
  };
  const identity = (snapshot) => {
    if (
      snapshot.projectId !== projectId ||
      snapshot.sessionId !== sessionId ||
      !safeName(snapshot.snapshotId) ||
      snapshot.associationRevision?.projectId !== projectId ||
      snapshot.associationRevision?.sessionId !== sessionId ||
      !Number.isSafeInteger(snapshot.associationRevision?.revisionId)
    ) {
      throw transportError(
        'PMS_TRANSPORT_FOREIGN_SESSION',
        'Transport snapshot belongs to another project/session.',
      );
    }
  };
  async function materialize(snapshot, { accepted = true } = {}) {
    requireOpen();
    identity(snapshot);
    const members = membersOf(snapshot, accepted);
    if (
      accepted &&
      (!snapshot.canonicalSetDigest ||
        !snapshot.artifactDigest ||
        !snapshot.artifactSetDigest ||
        !Number.isSafeInteger(snapshot.generationId))
    )
      throw transportError(
        'PMS_TRANSPORT_CORRUPT',
        'Accepted transport requires compiler publication identity.',
      );
    const directory = path.join(sessionDir, snapshot.snapshotId);
    const descriptor = freeze({
      schemaVersion: 1,
      protocolVersion: 1,
      accepted,
      projectId,
      sessionId,
      snapshotId: snapshot.snapshotId,
      artifactRevision:
        snapshot.artifactRevision ?? snapshot.associationRevision,
      associationRevision: snapshot.associationRevision,
      ...(accepted
        ? {
            generationId: snapshot.generationId,
            artifactDigest: snapshot.artifactDigest,
            canonicalSetDigest: snapshot.canonicalSetDigest,
            artifactSetDigest: snapshot.artifactSetDigest,
          }
        : {}),
      candidateDigest: snapshot.candidateDigest,
      designSystem: snapshot.designSystem,
      abiVersion: snapshot.abiVersion,
      directory,
      descriptorFile: path.join(directory, 'descriptor.json'),
      designJS: path.join(
        directory,
        members.find((member) => member.kind === 'design-module').file,
      ),
      stylesCSS: path.join(
        directory,
        members.find((member) => member.kind === 'css').file,
      ),
      files: members.map(({ file, kind, sha256: hash, bytes: size }) => ({
        file,
        kind,
        sha256: hash,
        bytes: size,
        path: path.join(directory, file),
      })),
    });
    const known = records.get(snapshot.snapshotId);
    if (known != null) {
      if (JSON.stringify(known.descriptor) !== JSON.stringify(descriptor))
        throw transportError(
          'PMS_TRANSPORT_CORRUPT',
          'One immutable snapshot address cannot hold different identities.',
        );
      return verifyTransportDescriptor(known.descriptor, filesystem);
    }
    if (pending.has(snapshot.snapshotId))
      return pending.get(snapshot.snapshotId);
    const size =
      members.reduce((sum, member) => sum + member.bytes, 0) +
      Buffer.byteLength(JSON.stringify(descriptor), 'utf8');
    if (
      records.size + reservedCount + 1 > maxSnapshots ||
      bytes + reservedBytes + size > maxBytes
    )
      throw transportError(
        'PMS_TRANSPORT_RETENTION_LIMIT',
        'Immutable transport retention is exhausted; restart the coordinator and reload its consumers.',
        { maxSnapshots, maxBytes, requiredBytes: size },
      );
    reservedCount += 1;
    reservedBytes += size;
    const operation = (async () => {
      const temporary = path.join(sessionDir, `.snapshot-${randomUUID()}`);
      try {
        try {
          await filesystem.lstat(directory);
          await verifyTransportDescriptor(descriptor, filesystem);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          await filesystem.mkdir(temporary, { mode: 0o700 });
          for (const member of members) {
            const target = path.join(temporary, member.file);
            await filesystem.mkdir(path.dirname(target), { recursive: true });
            await filesystem.writeFile(target, member.content, {
              flag: 'wx',
              mode: 0o444,
            });
          }
          await filesystem.writeFile(
            path.join(temporary, 'descriptor.json'),
            JSON.stringify(descriptor) + '\n',
            { flag: 'wx', mode: 0o444 },
          );
          // Check the complete temporary bytes against SDK digests before exposing any address.
          for (const member of members) {
            const actual = await filesystem.readFile(
              path.join(temporary, member.file),
            );
            if (
              actual.length !== member.bytes ||
              sha256(actual) !== member.sha256
            )
              throw transportError(
                'PMS_TRANSPORT_CORRUPT',
                'Temporary transport member failed its compiler digest.',
                { file: member.file },
              );
          }
          try {
            await filesystem.rename(temporary, directory);
          } catch (error) {
            if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
          }
          await verifyTransportDescriptor(descriptor, filesystem);
        }
        records.set(snapshot.snapshotId, { descriptor, bytes: size });
        bytes += size;
        return descriptor;
      } finally {
        reservedCount -= 1;
        reservedBytes -= size;
        pending.delete(snapshot.snapshotId);
        await filesystem
          .rm(temporary, { recursive: true, force: true })
          .catch(() => {});
      }
    })();
    pending.set(snapshot.snapshotId, operation);
    return operation;
  }
  function offer(descriptor) {
    const operation = offerTail.then(async () => {
      requireOpen();
      identity(descriptor);
      const known = records.get(descriptor.snapshotId);
      if (known == null || known.descriptor !== descriptor)
        throw transportError(
          'PMS_TRANSPORT_CORRUPT',
          'Only a completed immutable transport can be offered.',
        );
      await verifyTransportDescriptor(descriptor, filesystem);
      if (
        current != null &&
        (descriptor.associationRevision.revisionId <
          current.associationRevision.revisionId ||
          (descriptor.associationRevision.revisionId ===
            current.associationRevision.revisionId &&
            descriptor.snapshotId !== current.snapshotId &&
            current.accepted))
      ) {
        throw transportError(
          'PMS_STALE_REVISION',
          'Delayed transport cannot move the current descriptor backward.',
          {
            currentSnapshotId: current.snapshotId,
            requestedSnapshotId: descriptor.snapshotId,
          },
        );
      }
      if (current?.snapshotId === descriptor.snapshotId) return descriptor;
      await atomicJSON(currentFile, descriptor, filesystem);
      current = descriptor;
      return descriptor;
    });
    offerTail = operation.catch(() => {});
    return operation;
  }
  return Object.freeze({
    sessionDir,
    currentFile,
    materialize,
    offer,
    verify: (descriptor) => verifyTransportDescriptor(descriptor, filesystem),
    current: () => current,
    stats: () => ({
      snapshots: records.size,
      bytes,
      maxSnapshots,
      maxBytes,
      pending: pending.size,
    }),
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...pending.values(), offerTail]);
      let firstError = null;
      for (const { descriptor } of records.values()) {
        try {
          await filesystem.rm(descriptor.directory, {
            recursive: true,
            force: true,
          });
        } catch (error) {
          firstError ??= error;
        }
      }
      records.clear();
      bytes = 0;
      if (firstError != null) throw firstError;
    },
  });
}
