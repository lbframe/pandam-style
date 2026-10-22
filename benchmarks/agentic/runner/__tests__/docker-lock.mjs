/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Daemon-wide mutex of the Docker integration tests. Concurrent suites share
// one Docker daemon (CI slots on the self-hosted runner run in separate
// directories, so no file path is shared; the daemon is), and the runner
// enumerates daemon-wide state: the self-test lists every network and then
// inspects them, so a network another suite removes in between fails it.
// The suite therefore holds this lock for all of its Docker work.
//
// The lock is a container with a fixed name: the daemon reserves container
// names atomically, so one creation succeeds and the others get a name
// conflict. It runs `sleep <hold>` with `--rm` and no network, so it expires
// by itself after the hold (a SIGKILLed holder cannot deadlock the others)
// and adds no network, interface or labelled runner resource. Release
// removes it by container id, never another holder's lock.

import { setTimeout as delay } from 'node:timers/promises';
import { docker } from '../src/docker.mjs';
import { BASE_IMAGE } from '../src/images.mjs';

export const SUITE_LOCK = 'pms-agentic-docker-test-lock';
// A suite holds the lock about 2 minutes alone, 5 under load; the hold is
// the upper bound after which the daemon releases a lost holder's lock.
export const LOCK_HOLD_SECONDS = 20 * 60;
// Bounded wait: 8 CI slots queued behind each other, then a clear failure.
export const LOCK_WAIT_MS = 45 * 60 * 1000;

const CONFLICT = /is already in use|Conflict\./;

function holderOf(name, run) {
  const r = run([
    'container',
    'inspect',
    '-f',
    '{{index .Config.Labels "pms-agentic-test-lock.owner"}} until {{index .Config.Labels "pms-agentic-test-lock.expires"}}',
    name,
  ]);
  return r.status === 0 ? r.stdout.trim() : 'a holder that just released';
}

/** Waits for the lock `name`; resolves to the held lock. */
export async function acquireDockerLock({
  owner,
  name = SUITE_LOCK,
  holdSeconds = LOCK_HOLD_SECONDS,
  waitMs = LOCK_WAIT_MS,
  pollMs = 2000,
  run = docker,
}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const expires = new Date(Date.now() + holdSeconds * 1000).toISOString();
    const r = run([
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--user',
      '65534:65534',
      '--label',
      'pms-agentic-test-lock=1',
      '--label',
      `pms-agentic-test-lock.owner=${owner}`,
      '--label',
      `pms-agentic-test-lock.expires=${expires}`,
      '--entrypoint',
      'sleep',
      BASE_IMAGE,
      String(holdSeconds),
    ]);
    if (r.status === 0) return { name, owner, id: r.stdout.trim() };
    if (!CONFLICT.test(r.stderr))
      throw new Error(`docker lock ${name}: ${r.stderr.trim()}`);
    if (Date.now() >= deadline)
      throw new Error(
        `docker lock ${name}: still held by ${holderOf(name, run)} after ${waitMs} ms`,
      );
    await delay(pollMs);
  }
}

/**
 * Releases a held lock by container id. Returns false when the lock had
 * already expired (the hold was exceeded: another suite may have run).
 */
export function releaseDockerLock(lock, run = docker) {
  // `docker rm -f` also succeeds for a missing container: check first.
  const held = run(['container', 'inspect', lock.id]).status === 0;
  if (held) run(['rm', '-f', lock.id]);
  return held;
}
