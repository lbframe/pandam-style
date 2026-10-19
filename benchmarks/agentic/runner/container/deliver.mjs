/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Writes the credential bytes received on stdin into the agent tmpfs, mode
// 0600 (DESIGN.md section 4.6). Usage: deliver.mjs <absolute path under /run/agent>

import fs from 'node:fs';
import path from 'node:path';

const target = process.argv[2];
if (!target || !path.resolve(target).startsWith('/run/agent/')) {
  process.stderr.write('deliver: target must be under /run/agent\n');
  process.exit(2);
}
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, Buffer.concat(chunks), { mode: 0o600, flag: 'w' });
});
