/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const HOST_OPERATIONS = Object.freeze([
  'readArtifact',
  'readGeneratedArtifacts',
  'preparePublication',
  'commitPrepared',
  'abortPrepared',
  'pinAcceptedSnapshot',
  'readAcceptedArtifact',
  'releaseAcceptedSnapshot',
  'acceptedSnapshotRetentionStats',
]);

export function createHostBridge(project) {
  if (
    project == null ||
    HOST_OPERATIONS.slice(0, 5).some(
      (name) => typeof project[name] !== 'function',
    )
  ) {
    throw new TypeError(
      'createHostBridge() requires a PandamStyle project session.',
    );
  }
  return Object.freeze(
    Object.fromEntries(
      HOST_OPERATIONS.filter((name) => typeof project[name] === 'function').map(
        (name) => [name, project[name].bind(project)],
      ),
    ),
  );
}
