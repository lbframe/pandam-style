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
// conflict. It runs `cat` on its standard input, attached (`docker run -i`,
// stdin closed when the client goes) to a pipe of the holder process, with
// `--rm` and no network. Its lease is the holder's liveness, not a timer:
// the holder renews nothing, so a suite blocked in synchronous Docker work
// for any duration keeps it. When the holder dies (SIGKILL, cancelled job),
// the pipe closes, `cat` ends and the daemon removes the container, or the
// attached client is killed with it and the daemon closes stdin: an
// abandoned lock is reclaimed within seconds. A holder checks the lock is
// still its own before each Docker phase (assertDockerLockHeld) and fails
// when it is not, and release removes only its own container, by id.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { docker } from '../src/docker.mjs';
import { BASE_IMAGE } from '../src/images.mjs';

export const SUITE_LOCK = 'pms-agentic-docker-test-lock';
// Bounded wait: 8 CI slots queued behind each other, then a clear failure.
export const LOCK_WAIT_MS = 45 * 60 * 1000;

const CONFLICT = /is already in use|Conflict\./;
const OWNER = 'pms-agentic-test-lock.owner';
const TOKEN = 'pms-agentic-test-lock.token';

function holderOf(name, run) {
  const r = run([
    'container',
    'inspect',
    '-f',
    `{{index .Config.Labels "${OWNER}"}}`,
    name,
  ]);
  return r.status === 0 ? r.stdout.trim() : 'a holder that just released';
}

/** One creation attempt: the held lock, or the failed attempt's output. */
function tryAcquire(name, owner) {
  const token = randomUUID();
  const child = spawn(
    'docker',
    [
      'run',
      '-i',
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
      `${OWNER}=${owner}`,
      '--label',
      `${TOKEN}=${token}`,
      '--entrypoint',
      'sh',
      BASE_IMAGE,
      '-c',
      'echo held && exec cat >/dev/null',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    child.stderr.on('data', (b) => (err += b));
    child.stdout.on('data', (b) => {
      out += b;
      if (done || !out.includes('held\n')) return;
      done = true;
      const id = docker([
        'container',
        'inspect',
        '-f',
        `{{.Id}} {{index .Config.Labels "${TOKEN}"}}`,
        name,
      ]).stdout.trim();
      const [cid, seen] = id.split(' ');
      // The pipe stays open while this process lives; it never keeps the
      // process alive by itself.
      for (const s of [child, child.stdin, child.stdout, child.stderr])
        s.unref();
      if (seen === token) {
        // The client process is not part of the lock's serialized form.
        const lock = Object.defineProperty(
          { name, owner, token, id: cid },
          'child',
          { value: child },
        );
        resolve({ lock });
      } else {
        child.stdin.end();
        resolve({ failure: `attached to a lock owned by ${seen || 'nobody'}` });
      }
    });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      resolve({ failure: `docker could not be started: ${e.message}` });
    });
    // 'close', not 'exit': 'exit' can come before the last stderr data (a
    // name conflict then reads as an empty error).
    child.on('close', (code, signal) => {
      if (done) return;
      done = true;
      const output = err.trim() || out.trim() || '(no output)';
      resolve({
        conflict: CONFLICT.test(err),
        failure: `docker run ${signal ? `killed by ${signal}` : `exited with code ${code}`}: ${output}`,
      });
    });
  });
}

/** Waits for the lock `name`, at most `waitMs`; resolves to the held lock. */
export async function acquireDockerLock({
  owner,
  name = SUITE_LOCK,
  waitMs = LOCK_WAIT_MS,
  pollMs = 2000,
  run = docker,
}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const r = await tryAcquire(name, owner);
    if (r.lock) return r.lock;
    // Held by another: the conflict message, or (whatever the wording) the
    // name existing on the daemon. Any other failure is reported as is.
    const held = r.conflict || run(['container', 'inspect', name]).status === 0;
    if (!held) throw new Error(`docker lock ${name}: ${r.failure}`);
    if (Date.now() >= deadline)
      throw new Error(
        `docker lock ${name}: still held by ${holderOf(name, run)} after ${waitMs} ms (last attempt: ${r.failure})`,
      );
    await delay(pollMs);
  }
}

/** Whether `lock` is still this holder's: its container, running, its token. */
export function dockerLockHeld(lock, run = docker) {
  const r = run([
    'container',
    'inspect',
    '-f',
    `{{.State.Running}} {{index .Config.Labels "${TOKEN}"}}`,
    lock.id,
  ]);
  return r.status === 0 && r.stdout.trim() === `true ${lock.token}`;
}

/** Throws unless `lock` is still held: no Docker work after losing it. */
export function assertDockerLockHeld(lock, run = docker) {
  if (!dockerLockHeld(lock, run))
    throw new Error(
      `lost the docker lock ${lock.name} (owner ${lock.owner}): another suite may be running; stopping Docker work`,
    );
}

/**
 * Releases a held lock: closes its pipe and removes its container by id,
 * never another holder's. Returns whether the lock was still held.
 */
export function releaseDockerLock(lock, run = docker) {
  const held = dockerLockHeld(lock, run);
  lock.child?.stdin.end();
  if (held) run(['rm', '-f', lock.id]);
  return held;
}
