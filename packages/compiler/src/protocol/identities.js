/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { randomUUID } from 'node:crypto';

export function createProjectIdentity(config) {
  return Object.freeze({
    projectId: config.projectId,
    rootDir: config.rootDir,
    outDir: config.outDir,
  });
}

export function createSessionIdentity(projectId) {
  return Object.freeze({ projectId, sessionId: randomUUID() });
}

export function makeRevisionIdentity(session, revisionId) {
  return Object.freeze({ ...session, revisionId });
}

export function sameRevisionIdentity(left, right) {
  return (
    left != null &&
    right != null &&
    left.projectId === right.projectId &&
    left.sessionId === right.sessionId &&
    left.revisionId === right.revisionId
  );
}

export function makePublicationReceipt({
  revision,
  artifactRevision,
  artifactDigest,
  generationId,
  designSystem,
  abiVersion = 1,
  publication = null,
}) {
  return Object.freeze({
    projectId: revision.projectId,
    sessionId: revision.sessionId,
    revision,
    artifactRevision,
    artifactDigest,
    associationRevision: revision,
    generationId,
    designSystem,
    abiVersion,
    publication,
  });
}
