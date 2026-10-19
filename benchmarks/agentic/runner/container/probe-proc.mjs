/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Isolation self-test process probe: starts a long-running process from the
// given binary, then tries same-UID access paths to it from this process.
// Usage: probe-proc.mjs <binary>

import fs from 'node:fs';
import { spawn } from 'node:child_process';

const binary = process.argv[2];
// stdout on a file: the permission checks on /proc are the same as for the
// CLI's pipe, and a file stays openable for the readable control.
const sink = fs.openSync('/tmp/probe-proc.out', 'w');
const child = spawn(binary, ['-e', 'setTimeout(() => {}, 30000)'], {
  stdio: ['ignore', sink, 'ignore'],
});
async function main() {
  await new Promise((r) => setTimeout(r, 1500));
  const pid = child.pid;
  const out = {};
  for (const [k, p, how] of [
    ['fd1Write', `/proc/${pid}/fd/1`, 'w'],
    ['environ', `/proc/${pid}/environ`, 'r'],
    ['fdList', `/proc/${pid}/fd`, 'dir'],
    ['mem', `/proc/${pid}/mem`, 'r'],
  ]) {
    try {
      if (how === 'dir') fs.readdirSync(p);
      else fs.closeSync(fs.openSync(p, how));
      out[k] = 'allowed';
    } catch (e) {
      out[k] = e.code;
    }
  }
  try {
    process.kill(pid, 0);
    out.signal = 'allowed';
  } catch (e) {
    out.signal = e.code;
  }
  child.kill('SIGKILL');
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

main();
