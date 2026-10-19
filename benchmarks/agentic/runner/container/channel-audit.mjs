/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Channel-audit sidecar (DESIGN.md section 4.4). Runs with --pid of the agent
// container and CAP_SYS_PTRACE, no network and no mounts. It reports whether
// the CLI process is non-dumpable and whether any other agent-UID process
// holds the CLI's stdout pipe. It is a sampled audit, never a demonstration:
// a clean result does not attest the stream (section 0.4).
//
// Identification uses facts the agent UID cannot forge: the launcher is the
// `run-cli.mjs` process started by `docker exec` (parent PID 0, which no
// process inside the container can produce), and the CLI is its direct
// child. Dumpability is read from `/proc/<pid>/environ`, whose owner is root
// for a non-dumpable task; `/proc/<pid>` itself always belongs to the task's
// effective UID (observed; `task_dump_owner`).
// Usage: channel-audit.mjs <agent uid>

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const LAUNCHER = '/opt/harness/run-cli.mjs';

/**
 * Pure audit over a process table: `[{ pid, ppid, ruid, cmdline,
 * restrictedOwner, fds: [link] }]`, `restrictedOwner` being the owner of
 * `/proc/<pid>/environ`.
 */
export function auditProcesses(procs, uid) {
  const launcher = procs.find(
    (p) => p.ppid === 0 && p.ruid === uid && p.cmdline[1] === LAUNCHER,
  );
  const cli =
    launcher && procs.find((p) => p.ppid === launcher.pid && p.ruid === uid);
  // A sample that did not see the CLI checked nothing: no count.
  const out = {
    samples: 1,
    cliFound: cli != null,
    cliNonDumpable: null,
    foreignStreamHolders: cli == null ? null : 0,
    controlSocketConnections: null,
  };
  if (!cli) return out;
  out.cliNonDumpable =
    cli.restrictedOwner == null ? null : cli.restrictedOwner === 0;
  const streamPipe = cli.fds?.[1] ?? null;
  if (streamPipe == null) {
    out.foreignStreamHolders = null;
    return out;
  }
  // Per process; the launcher and the CLI legitimately hold the pipe.
  for (const p of procs)
    if (
      p.pid !== cli.pid &&
      p.pid !== launcher.pid &&
      p.ruid === uid &&
      Object.values(p.fds ?? {}).includes(streamPipe)
    )
      out.foreignStreamHolders += 1;
  return out;
}

function readProcesses() {
  const procs = [];
  for (const pid of fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const field = (k) =>
        Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(status)?.[1]);
      const fds = {};
      try {
        for (const fd of fs.readdirSync(`/proc/${pid}/fd`))
          try {
            fds[fd] = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
          } catch {
            // Closed meanwhile.
          }
      } catch {
        // Unreadable descriptor table.
      }
      let restrictedOwner = null;
      try {
        restrictedOwner = fs.statSync(`/proc/${pid}/environ`).uid;
      } catch {
        // Unknown.
      }
      procs.push({
        pid: Number(pid),
        ppid: field('PPid'),
        ruid: field('Uid'),
        cmdline: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'),
        restrictedOwner,
        fds,
      });
    } catch {
      // Process gone.
    }
  }
  return procs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.stdout.write(
    `${JSON.stringify(auditProcesses(readProcesses(), Number(process.argv[2])))}\n`,
  );
