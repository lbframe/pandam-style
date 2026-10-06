/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
for (const args of [
  [
    'node_modules/jest/bin/jest.js',
    '--runInBand',
    'packages/compiler/__tests__/pandamstyle/source-map-test.js',
    'packages/compiler/__tests__/pandamstyle/project-api-test.js',
    'packages/compiler/__tests__/pandamstyle/accepted-snapshot-test.js',
    'packages/compiler/__tests__/pandamstyle/incremental-coverage-closure-test.js',
    'packages/compiler/__tests__/pandamstyle/incremental-session-test.js',
    'packages/compiler/__tests__/pandamstyle/watcher-provider-test.js',
    'packages/compiler/__tests__/pandamstyle/vite-build-test.js',
  ],
  [
    '--test',
    'packages/next/test/semantic-dev/coordinator.test.mjs',
    'packages/next/test/semantic-dev/transport.test.mjs',
    'packages/next/test/semantic-dev/protocol.test.mjs',
    'packages/next/test/semantic-dev/loader.test.mjs',
    'packages/next/test/semantic-dev/source-map.test.mjs',
    'packages/next/test/phase-13-react-compiler-qualification.test.mjs',
    'packages/vite/test/dx-runtime.test.mjs',
    'packages/rsbuild/test/dx-runtime.test.mjs',
  ],
]) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-dx-types-'));
try {
  const file = path.join(directory, 'maps.mts');
  fs.writeFileSync(
    file,
    `import type { ArtifactResult, AcceptedSnapshot, GeneratedArtifactFile } from ${JSON.stringify(path.join(root, 'packages/compiler/types/index.js'))};
declare const artifact: ArtifactResult;
declare const snapshot: AcceptedSnapshot;
declare const generated: GeneratedArtifactFile;
const moduleMap: string | null = artifact.sourceMap;
const cssMap: string | null | undefined = artifact.css[0].sourceMap;
const acceptedMap: string | null | undefined = snapshot.cssSourceMap;
const generatedMap: string | null | undefined = generated.sourceMap;
void [moduleMap, cssMap, acceptedMap, generatedMap];
`,
  );
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--module',
      'nodenext',
      '--moduleResolution',
      'nodenext',
      file,
    ],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
