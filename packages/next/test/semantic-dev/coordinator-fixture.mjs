/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createProjectSession } from '@pandamstyle/compiler';
import { createCoordinator } from '../../src/coordinator.js';

export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const definition = {
  systemId: 'next-transport@1',
  tokens: {
    colors: {
      ink: { value: '#123456', visibility: 'public' },
      accent: { value: '#654321', visibility: 'public' },
    },
  },
  themes: { light: { tokens: {} } },
  conditions: {},
  recipes: {},
};
export const source = (token = 'ink') =>
  `import { create, token, props } from '../generated/design.js';\nconst styles = create({ box: { color: token('colors.${token}') } });\nexport const box = props(styles.box);\n`;

export function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pandamstyle-next-coordinator-'),
  );
  fs.mkdirSync(path.join(root, 'semantic'));
  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(root, 'semantic', 'page.js'), source());
  const options = {
    backend: 'turbopack',
    publicationMode: 'semantic-dev',
    definition,
    roots: ['semantic'],
    outDir: 'generated',
  };
  const file = (relative) => path.join(root, relative);
  return {
    root,
    options,
    file,
    async owner(overrides = {}, launch = {}) {
      return createCoordinator(root, { ...options, ...overrides }, launch);
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export const request = (
  owner,
  item,
  relative = 'semantic/page.js',
  extra = {},
) => ({
  projectId: owner.projectId,
  sessionId: owner.sessionId,
  file: item.file(relative),
  sourceDigest: hash(fs.readFileSync(item.file(relative))),
  snapshotId: null,
  ...extra,
});
export const current = (owner) =>
  JSON.parse(fs.readFileSync(owner.currentFile, 'utf8'));
export const status = (owner) =>
  JSON.parse(fs.readFileSync(owner.statusFile, 'utf8'));
export const canonical = (item) =>
  [
    'design.js',
    'design.d.ts',
    'manifest.json',
    'styles.css',
    'artifacts.json',
  ].map((file) => [
    file,
    hash(fs.readFileSync(item.file('generated/' + file))),
  ]);

export async function acceptedSnapshots(item, changes = []) {
  const project = createProjectSession({
    rootDir: item.root,
    roots: ['semantic'],
    definition,
    outDir: 'generated',
    designSystemFile: 'design.js',
    acceptedSnapshotRetention: { maxSnapshots: 64 },
  });
  const pins = [];
  let revision = (await project.initialize()).revision;
  async function accept() {
    const result = await project.validate(revision);
    if (!result.ok) throw new Error('Snapshot test input must validate.');
    const receipt = await project.commitPrepared(
      await project.preparePublication(revision),
    );
    const pin = await project.pinAcceptedSnapshot(receipt.associationRevision, {
      owner: 'transport-tests',
    });
    pins.push(pin);
    return pin.snapshot;
  }
  const snapshots = [await accept()];
  for (const next of changes) {
    fs.writeFileSync(item.file('semantic/page.js'), next);
    revision = (
      await project.applyChanges({
        baseRevision: revision,
        mode: 'verified-explicit',
        changed: ['semantic/page.js'],
        added: [],
        removed: [],
        renamed: [],
      })
    ).revision;
    snapshots.push(await accept());
  }
  return {
    project,
    snapshots,
    async close() {
      for (const pin of pins) await project.releaseAcceptedSnapshot(pin);
      await project.close();
    },
  };
}
