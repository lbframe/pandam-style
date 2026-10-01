/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const HOST_OPERATIONS = [
  'readArtifact',
  'preparePublication',
  'commitPrepared',
  'abortPrepared',
];

export function createHostBridge(project) {
  if (
    project == null ||
    HOST_OPERATIONS.some((name) => typeof project[name] !== 'function')
  ) {
    throw new TypeError(
      'createHostBridge() requires a PandamStyle project session.',
    );
  }
  return Object.freeze(
    Object.fromEntries(
      HOST_OPERATIONS.map((name) => [name, project[name].bind(project)]),
    ),
  );
}
