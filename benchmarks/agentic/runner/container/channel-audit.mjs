/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Channel-audit sidecar (DESIGN.md section 4.4). Runs with --pid of the agent
// container and CAP_SYS_PTRACE, no network and no mounts. It reports whether
// the CLI process is non-dumpable (its /proc entries owned by root) and
// whether any other agent-UID process holds the CLI's stdout pipe. It is a
// sampled audit, never a demonstration: a clean result does not attest the
// stream (section 0.4).
// Usage: channel-audit.mjs <agent uid> <cli name>

import fs from 'node:fs';

const [uidArg, name] = process.argv.slice(2);
const uid = Number(uidArg);
const procs = [];
for (const pid of fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const ruid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    procs.push({ pid, ruid, cmdline, owner: fs.statSync(`/proc/${pid}`).uid });
  } catch {
    // Process gone.
  }
}
const cli = procs.find(
  (p) =>
    p.ruid === uid &&
    p.cmdline.some((c) => c === name || c.endsWith(`/${name}`)),
);
const out = {
  samples: 1,
  cliFound: cli != null,
  cliNonDumpable: null,
  foreignStreamHolders: 0,
  controlSocketConnections: null,
};
if (cli) {
  out.cliNonDumpable = cli.owner === 0;
  let streamPipe = null;
  try {
    streamPipe = fs.readlinkSync(`/proc/${cli.pid}/fd/1`);
  } catch {
    // Unreadable.
  }
  for (const p of procs) {
    if (p.pid === cli.pid || p.ruid !== uid || streamPipe == null) continue;
    try {
      for (const fd of fs.readdirSync(`/proc/${p.pid}/fd`))
        if (fs.readlinkSync(`/proc/${p.pid}/fd/${fd}`) === streamPipe) {
          // The parent launcher legitimately shares the pipe.
          if (!p.cmdline.some((c) => c.endsWith('run-cli.mjs')))
            out.foreignStreamHolders += 1;
        }
    } catch {
      // Gone or unreadable.
    }
  }
}
process.stdout.write(`${JSON.stringify(out)}\n`);
