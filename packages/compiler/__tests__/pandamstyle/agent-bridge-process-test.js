/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * AG-02.1 owners in other processes: dead owners, restart identity, lease
 * contention and cleanup paths (AC4 and the targeted verification; design
 * note §3.4, §3.10, §5.2).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  cleanup,
  entryPath,
  expectDeclared,
  handshake,
  leaseNames,
  makeRuntimeDir,
  openHost,
  openWorkspace,
  startChildOwner,
} = require('./agent-bridge-support');
const { openProject } = require('./session-helpers');

jest.setTimeout(240000);
afterEach(cleanup);

const failureOf = (envelope) => [envelope.outcome, envelope.failure?.reason];

/** A workspace over a project whose owner lives in another process. */
function workspaceFor(project, runtimeDir) {
  return openWorkspace({ project, runtimeDir });
}

function canonicalOutDir(fixture) {
  return path.join(
    fs.realpathSync(path.dirname(fixture.outDir)),
    path.basename(fixture.outDir),
  );
}

describe('AG-02.1 dead and restarted owners (AC4, targeted verification)', () => {
  test('a SIGKILLed owner leaves entries reported as owner-unreachable; its successor cleans them and reports the new session', async () => {
    const fixture = openProject('valid');
    const runtimeDir = makeRuntimeDir();
    const first = await startChildOwner(fixture.project, runtimeDir);
    expect(first).toEqual(
      expect.objectContaining({ owner: true, started: true }),
    );
    const remote = workspaceFor(fixture.project, runtimeDir);
    const attached = await remote.attach();
    expect(attached.identities.sessionId).toBe(first.sessionId);
    const rev = attached.identities.revision;
    expect((await remote.dispatch('check', { rev })).outcome).toBe('success');

    first.child.kill('SIGKILL');
    await first.exited;
    // A crash leaves the three entries; the lease died with the process.
    expect(fs.readdirSync(runtimeDir).sort()).toEqual(
      ['json', 'key', 'sock'].map((ext) => `${first.name}.${ext}`).sort(),
    );
    expect(leaseNames(canonicalOutDir(fixture))).toBe(0);
    const lost = await remote.dispatch('check', { rev });
    expect(failureOf(lost)).toEqual(['owner-required', 'owner-closed']);
    expectDeclared(lost);
    const dead = await remote.attach();
    expect(failureOf(dead)).toEqual(['owner-required', 'owner-unreachable']);
    expectDeclared(dead);
    // The client deleted nothing.
    expect(fs.readdirSync(runtimeDir).length).toBe(3);

    const second = await startChildOwner(fixture.project, runtimeDir);
    expect(second.name).toBe(first.name);
    const again = await remote.attach();
    expect(again.outcome).toBe('success');
    expect(again.identities.sessionId).toBe(second.sessionId);
    expect(again.result.previousSessionId).toBe(first.sessionId);
    expect(failureOf(await remote.dispatch('check', { rev }))).toEqual([
      'stale-revision',
      'session-changed',
    ]);
    expect(
      (await remote.dispatch('check', { rev: again.identities.revision }))
        .outcome,
    ).toBe('success');

    second.child.kill('SIGTERM');
    await second.exited;
    expect(fs.readdirSync(runtimeDir)).toEqual([]);
  });

  test('process exit without close removes the entries through the exit handler', async () => {
    const fixture = openProject('valid');
    const runtimeDir = makeRuntimeDir();
    const owner = await startChildOwner(fixture.project, runtimeDir);
    expect(fs.readdirSync(runtimeDir).length).toBe(3);
    owner.child.kill('SIGUSR2');
    await owner.exited;
    expect(fs.readdirSync(runtimeDir)).toEqual([]);
  });
});

describe('AG-02.1 lease contention: one writer, one advertised owner', () => {
  test('two owners started together on one output directory (20 rounds): exactly one holds the lease and advertises', async () => {
    const fixture = openProject('valid');
    const runtimeDir = makeRuntimeDir();
    for (let round = 0; round < 20; round += 1) {
      const results = await Promise.all([
        startChildOwner(fixture.project, runtimeDir),
        startChildOwner(fixture.project, runtimeDir),
      ]);
      const winners = results.filter((result) => result.owner);
      const losers = results.filter((result) => !result.owner);
      expect([round, winners.length, losers.length]).toEqual([round, 1, 1]);
      expect(losers[0].reason).toBe('output-owned');
      expect(winners[0].started).toBe(true);
      expect(leaseNames(canonicalOutDir(fixture))).toBe(1);
      expect(
        fs.readdirSync(runtimeDir).filter((name) => name.endsWith('.json')),
      ).toEqual([`${winners[0].name}.json`]);
      const remote = workspaceFor(fixture.project, runtimeDir);
      const attached = await remote.attach();
      expect(attached.identities.sessionId).toBe(winners[0].sessionId);
      remote.workspace.dispose();
      await losers[0].exited;
      winners[0].child.kill('SIGTERM');
      await winners[0].exited;
    }
    expect(fs.readdirSync(runtimeDir)).toEqual([]);
  });

  test('a failed attachment never creates a writer: an in-process owner stays refused while the child owns', async () => {
    const fixture = openProject('valid');
    const runtimeDir = makeRuntimeDir();
    const owner = await startChildOwner(fixture.project, runtimeDir);
    // The workspace fails to attach (forged key), and still creates nothing.
    fs.writeFileSync(
      entryPath(runtimeDir, owner.name, 'key'),
      handshake.newKey().text,
    );
    const remote = workspaceFor(fixture.project, runtimeDir);
    const failed = await remote.attach();
    expect(failed.outcome).toBe('stale-revision');
    expect(leaseNames(canonicalOutDir(fixture))).toBe(1);
    // A second owner in this process meets the child's lease.
    const host = await openHost({ reuse: fixture, bridge: false }).catch(
      (error) => error,
    );
    expect(host.diagnostics?.[0]?.context?.reason).toBe('output-owned');
  });
});
