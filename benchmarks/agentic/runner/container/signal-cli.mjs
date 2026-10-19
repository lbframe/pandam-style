/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Sends a signal to the agent processes (DESIGN.md section 3.8): `cli` to the
// CLI processes only, `all` to every process this UID can signal (kill(-1),
// which never reaches PID 1 or the harness-UID supervisor).
// Usage: signal-cli.mjs <SIGNAL> cli <name>|all

import fs from 'node:fs';

const [signal, scope, name] = process.argv.slice(2);
if (scope === 'all') {
  try {
    process.kill(-1, signal);
  } catch {
    // Nothing left to signal.
  }
  process.exit(0);
}
for (const pid of fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
  if (Number(pid) === process.pid) continue;
  let cmdline = '';
  try {
    cmdline = fs
      .readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      .split('\0')
      .join(' ');
  } catch {
    continue;
  }
  if (
    cmdline.includes(`/${name} `) ||
    cmdline.endsWith(`/${name}`) ||
    cmdline.startsWith(`${name} `)
  ) {
    try {
      process.kill(Number(pid), signal);
    } catch {
      // Not ours or gone.
    }
  }
}
