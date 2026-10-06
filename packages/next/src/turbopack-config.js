/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import transport from './transport-client.cjs';

const loader = fileURLToPath(
  new URL('./turbopack-loader.cjs', import.meta.url),
);
const observers = new Map();
const unsupported = (message) =>
  transport.transportError('PMS_UNSUPPORTED_FEATURE', message);

export async function configureTurbopack(options, config, phase) {
  const command =
    phase === 'phase-development-server'
      ? 'dev'
      : phase === 'phase-production-build'
        ? 'build'
        : null;
  if (options.publicationMode === 'semantic-dev' && command !== 'dev')
    throw unsupported(
      'semantic-dev is development-only; production requires the separately qualified strict mode.',
    );
  if (
    phase === 'phase-production-server' &&
    options.publicationMode === 'strict'
  )
    return config;
  if (
    command == null ||
    (command === 'dev' && options.publicationMode !== 'semantic-dev')
  )
    throw unsupported(
      'This Turbopack phase/publicationMode combination is not qualified.',
    );
  const credentialFile = process.env.PMS_NEXT_COORDINATOR_FILE;
  if (!credentialFile)
    throw unsupported(
      `Run pandamstyle-next ${command} --turbopack so workers share the one coordinator.`,
    );
  const connection = transport.readConnection(credentialFile);
  const root = fs.realpathSync.native(process.cwd());
  if (connection.root !== root || connection.command !== command)
    throw unsupported(
      'The public CLI and Next config project/command disagree.',
    );
  if (config.webpack != null)
    throw unsupported(
      'Custom webpack configuration cannot supply transforms to this explicit Turbopack host.',
    );
  if (
    config.turbopack?.rules != null &&
    Object.keys(config.turbopack.rules).length !== 0
  )
    throw unsupported(
      'Composition with additional Turbopack loaders needs original-source ordering qualification.',
    );
  if (
    config.turbopack?.root != null &&
    fs.realpathSync.native(config.turbopack.root) !== root
  )
    throw unsupported(
      'The qualified Turbopack root must equal the supervised consumer directory.',
    );
  const { onEvent, onDiagnostics, ...plainOptions } = options;
  const description = await transport.request(credentialFile, 'register', {
    root,
    command,
    options: plainOptions,
    distDir: config.distDir ?? '.next',
  });
  if (
    description.protocolVersion !== 1 ||
    description.root !== root ||
    description.command !== command ||
    typeof description.projectId !== 'string' ||
    typeof description.sessionId !== 'string'
  )
    throw transport.transportError(
      'PMS_TRANSPORT_IDENTITY',
      'Config registration returned a different coordinator identity.',
    );
  const identity = {
    projectId: description.projectId,
    sessionId: description.sessionId,
  };
  if (onEvent != null || onDiagnostics != null) {
    const key = `${credentialFile}:${description.sessionId}`;
    let subscription = observers.get(key);
    if (subscription == null) {
      subscription = { callbacks: new Set() };
      subscription.stop = transport.subscribe(
        credentialFile,
        identity,
        (event) => {
          for (const callbacks of subscription.callbacks) {
            try {
              callbacks.onEvent?.(event);
            } catch {
              /* observations are not authority */
            }
            if (event.type === 'diagnostics') {
              try {
                callbacks.onDiagnostics?.(event.result);
              } catch {
                /* preserve compiler ownership */
              }
            }
          }
        },
      );
      observers.set(key, subscription);
    }
    if (
      ![...subscription.callbacks].some(
        (callbacks) =>
          callbacks.onEvent === onEvent &&
          callbacks.onDiagnostics === onDiagnostics,
      )
    )
      subscription.callbacks.add({ onEvent, onDiagnostics });
  }
  const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const excluded = [
    description.hostDir,
    description.outDir,
    path.resolve(root, config.distDir ?? '.next'),
  ]
    .map((file) => path.relative(root, file).split(path.sep).join('/'))
    .filter((file) => file !== '' && !file.startsWith('../'))
    .map((file) => escaped(file) + '(?:/|$)');
  const condition = {
    all: [
      { not: 'foreign' },
      { not: { path: /(?:^|\/)node_modules(?:\/|$)/ } },
      { not: { path: new RegExp('^(?:' + excluded.join('|') + ')') } },
    ],
  };
  const loaderOptions = {
    protocolVersion: 1,
    credentialFile,
    ...identity,
    statusFile: description.statusFile,
    currentFile: description.currentFile,
    definitionPath: description.definitionPath,
    roots: description.roots,
  };
  const rules = Object.fromEntries(
    ['*.js', '*.jsx', '*.mjs', '*.cjs', '*.ts', '*.tsx'].map((pattern) => [
      pattern,
      {
        condition,
        loaders: [{ loader, options: loaderOptions }],
      },
    ]),
  );
  // Preserve each resource extension. `as: '*.js'` changes client reference
  // names for JSX in the measured Next target.
  return { ...config, turbopack: { ...config.turbopack, root, rules } };
}
