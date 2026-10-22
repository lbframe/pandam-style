/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * AG-02.1 owner bridge: attached requests (AC1), lifecycle and identity
 * (AC4), absence of an owner (deliverable 6), no pollution, and the
 * structural invariants I2 and I9 (design note §3.8, §3.9, §4).
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  cleanup,
  compiler,
  descriptorModule,
  entryPath,
  expectDeclared,
  frames,
  hashTree,
  leaseNames,
  makeRuntimeDir,
  openHost,
  openWorkspace,
  readDescriptorFile,
  readKeyFile,
} = require('./agent-bridge-support');

jest.setTimeout(120000);
afterEach(cleanup);

const COMPILER = path.resolve(__dirname, '../..');

/** The session's canonical `outDir`, which need not exist yet. */
const canonicalOutDir = (host) =>
  path.join(
    fs.realpathSync(path.dirname(host.fixture.outDir)),
    path.basename(host.fixture.outDir),
  );

async function hostBinding(host) {
  const binding = await compiler.createAgentBinding({ session: host.session });
  const capability = binding.mintCapability({ grants: ['consult'] });
  return (operation, input, extra = {}) =>
    binding.dispatch(
      { protocolVersion: 1, operation, input, ...extra },
      { capability },
    );
}

function editSource(host, index) {
  const file = host.fixture.src('src', 'page.js');
  fs.appendFileSync(file, `\n// bridge edit ${index}\n`);
  return file;
}

async function applyEdit(host, rev, index) {
  const file = editSource(host, index);
  const value = await host.session.applyChanges({
    baseRevision: rev,
    mode: 'verified-explicit',
    changed: [file],
    added: [],
    removed: [],
    renamed: [],
  });
  return value.revision;
}

describe('AG-02.1 attached requests reach the host session (AC1)', () => {
  test('identities, check document and publication are the host session own', async () => {
    const host = await openHost();
    expect(host.bridge.started).toBe(true);
    const local = await hostBinding(host);
    const remote = openWorkspace(host);

    const attached = await remote.attach();
    expect(attached.outcome).toBe('success');
    const localStatus = await local('session.status', {});
    expect(attached.identities).toEqual(localStatus.identities);
    expect(attached.result).toEqual({
      identities: localStatus.identities,
      granted: ['consult'],
      previousSessionId: null,
    });

    const remoteStatus = await remote.dispatch('session.status', {});
    expect(remoteStatus.identities).toEqual(localStatus.identities);
    expect(remoteStatus.result).toEqual(localStatus.result);

    const rev = localStatus.identities.revision;
    const remoteCheck = await remote.dispatch('check', { rev });
    const localCheck = await local('check', { rev });
    expect(remoteCheck.outcome).toBe('success');
    expect(remoteCheck.result).toEqual(localCheck.result);
    expect(remoteCheck.identities).toEqual(localCheck.identities);

    // The host advances and publishes; the client sees the same authority.
    const next = await applyEdit(host, rev, 1);
    const receipt = await host.session.compile(next);
    expect(receipt.revision).toEqual(next);
    const after = await remote.dispatch('check', { rev: next });
    expect(after.outcome).toBe('success');
    expect(after.identities.revision).toEqual(next);
    const stale = await remote.dispatch('check', { rev });
    expect(stale.outcome).toBe('stale-revision');
    expectDeclared(stale);

    // One session, one lease: the bridge created no second owner.
    expect(compiler.projectServiceResourceStats().activePublisherLeases).toBe(
      1,
    );
    expect(leaseNames(canonicalOutDir(host))).toBe(1);
  });

  test('simultaneous host publication and two clients serialize on one session (N=20)', async () => {
    const host = await openHost();
    const a = openWorkspace(host);
    const b = openWorkspace(host);
    expect((await a.attach()).outcome).toBe('success');
    expect((await b.attach()).outcome).toBe('success');
    let rev = (await a.dispatch('session.status', {})).identities.revision;
    const produced = new Set([rev.revisionId]);
    let commits = 0;
    const outcomes = { success: 0, 'stale-revision': 0, other: [] };
    for (let index = 0; index < 20; index += 1) {
      const old = rev;
      const edit = applyEdit(host, old, index);
      const early = [
        a.dispatch('check', { rev: old }),
        b.dispatch('check', { rev: old }),
      ];
      rev = await edit;
      produced.add(rev.revisionId);
      const ticket = await host.session.preparePublication(rev);
      const late = [a.dispatch('check', { rev }), b.dispatch('check', { rev })];
      const receipt = await host.session.commitPrepared(ticket);
      if (receipt?.revision?.revisionId === rev.revisionId) commits += 1;
      for (const response of await Promise.all([...early, ...late])) {
        if (response.identities.revision != null)
          expect(produced.has(response.identities.revision.revisionId)).toBe(
            true,
          );
        if (response.outcome in outcomes && response.outcome !== 'other')
          outcomes[response.outcome] += 1;
        else outcomes.other.push(response.outcome);
        if (response.outcome !== 'success') expectDeclared(response, 'check');
      }
    }
    // A ticket prepared before agent checks still commits: no reader
    // revoked it (AG-01.1 F1), across the bridge.
    expect(commits).toBe(20);
    expect(outcomes.other).toEqual([]);
    expect(outcomes.success).toBeGreaterThanOrEqual(40);
    expect(outcomes['stale-revision']).toBeGreaterThanOrEqual(1);
    expect(compiler.projectServiceResourceStats().activePublisherLeases).toBe(
      1,
    );
  });
});

describe('AG-02.1 without an owner (deliverable 6, AC3 for live operations)', () => {
  test('session-bound operations are owner-required after the capability check, before the input', async () => {
    const runtimeDir = makeRuntimeDir();
    const fixtureHost = await openHost({ bridge: false, runtimeDir });
    const remote = openWorkspace(fixtureHost);
    const sessionBound = compiler.REGISTRY.entries.filter(
      (entry) =>
        entry.status === 'implemented' && entry.requires.binding === 'session',
    );
    expect(sessionBound.length).toBeGreaterThan(5);
    for (const entry of sessionBound) {
      // Any input: the request is not executed without an owner. The
      // capability holds the operation's grant, so step (4) passes.
      const capability = remote.workspace.mintCapability({
        grants: [entry.requires.grant],
      });
      const response = await remote.dispatch(
        entry.name,
        { bogus: true },
        {},
        { capability },
      );
      expect([entry.name, response.outcome, response.failure.reason]).toEqual([
        entry.name,
        'owner-required',
        'owner-absent',
      ]);
      expect(response.failure.retry).toBe('after-refresh');
      expectDeclared(response);
    }
    // Step (4) still comes first.
    const denied = await remote.workspace.dispatch({
      protocolVersion: 1,
      operation: 'check',
      input: {},
    });
    expect(denied.outcome).toBe('denied-access');
    // Workspace-local and registry-only operations still answer.
    const operations = await remote.dispatch('protocol.operations', {});
    expect(operations.outcome).toBe('success');
    const attach = await remote.attach();
    expect([attach.outcome, attach.failure.reason]).toEqual([
      'owner-required',
      'owner-absent',
    ]);
    expectDeclared(attach);
    // Attaching created nothing: no runtime directory, no lease.
    expect(fs.existsSync(runtimeDir)).toBe(false);
  });

  test('a host binding refuses session.attach: it already is the owner', async () => {
    const host = await openHost({ bridge: false });
    const local = await hostBinding(host);
    const response = await local('session.attach', { protocolVersions: [1] });
    expect(response.outcome).toBe('unsupported-capability');
    expect(response.failure).toEqual(
      expect.objectContaining({
        reason: 'binding',
        capability: 'binding:workspace',
      }),
    );
    expectDeclared(response);
  });
});

describe('AG-02.1 descriptor lifecycle and identity (AC4)', () => {
  for (const mask of [0o000, 0o002]) {
    test(`modes and contents under umask ${mask.toString(8).padStart(3, '0')}`, async () => {
      const previous = process.umask(mask);
      try {
        const host = await openHost();
        const { runtimeDir } = host;
        const { name } = host.bridge;
        expect(fs.statSync(runtimeDir).mode & 0o777).toBe(0o700);
        for (const ext of ['json', 'key'])
          expect(
            fs.statSync(entryPath(runtimeDir, name, ext)).mode & 0o777,
          ).toBe(0o600);
        expect(
          fs.lstatSync(entryPath(runtimeDir, name, 'sock')).isSocket(),
        ).toBe(true);
        const descriptor = readDescriptorFile(runtimeDir, name);
        expect(frames.validFrame('descriptor', descriptor)).toBe(true);
        expect(Object.keys(descriptor).sort()).toEqual(
          [
            'bridgeVersions',
            'compilerVersion',
            'createdAt',
            'endpoint',
            'format',
            'formatVersion',
            'keyId',
            'outDir',
            'owner',
            'projectId',
            'protocolVersions',
            'rootDir',
            'sessionId',
          ].sort(),
        );
        expect(descriptor.sessionId).toBe(host.session.sessionId);
        expect(descriptor.endpoint).toBe(`${name}.sock`);
        // The descriptor is discovery data: no key material (I4).
        const key = readKeyFile(runtimeDir, name);
        const text = fs.readFileSync(
          entryPath(runtimeDir, name, 'json'),
          'utf8',
        );
        expect(text.includes(key.text)).toBe(false);
        expect(text.includes(key.bytes.toString('hex'))).toBe(false);
        expect(descriptor.keyId).toBe(descriptorModule.keyIdOf(key.text));
      } finally {
        process.umask(previous);
      }
    });
  }

  test('a clean stop removes every entry; the next owner of a name cleans it; other names are untouched', async () => {
    const runtimeDir = makeRuntimeDir();
    const first = await openHost({ runtimeDir });
    const { name } = first.bridge;
    const firstKey = readKeyFile(runtimeDir, name).text;
    await first.close();
    expect(fs.readdirSync(runtimeDir)).toEqual([]);

    // A crashed owner of this name and an unrelated stale name.
    const other = 'aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb';
    for (const target of [name, other])
      for (const ext of ['json', 'key'])
        fs.writeFileSync(entryPath(runtimeDir, target, ext), 'stale', {
          mode: 0o600,
        });
    const otherBefore = hashTree(runtimeDir);
    const second = await openHost({ reuse: first.fixture, runtimeDir });
    expect(second.bridge.name).toBe(name);
    expect(readKeyFile(runtimeDir, name).text).not.toBe(firstKey);
    expect(readDescriptorFile(runtimeDir, name).sessionId).toBe(
      second.session.sessionId,
    );
    const after = hashTree(runtimeDir);
    for (const ext of ['json', 'key'])
      expect(after[`${other}.${ext}`]).toBe(otherBefore[`${other}.${ext}`]);
    await second.close();
    expect(fs.readdirSync(runtimeDir).sort()).toEqual([
      `${other}.json`,
      `${other}.key`,
    ]);
  });

  test('reconnect after an owner restart reports the new session and refuses old revisions', async () => {
    const runtimeDir = makeRuntimeDir();
    const first = await openHost({ runtimeDir });
    const remote = openWorkspace(first);
    expect((await remote.attach()).outcome).toBe('success');
    const oldRev = (await remote.dispatch('session.status', {})).identities
      .revision;
    await first.close();

    const lost = await remote.dispatch('check', { rev: oldRev });
    expect([lost.outcome, lost.failure.reason]).toEqual([
      'owner-required',
      'owner-closed',
    ]);
    expectDeclared(lost);

    const second = await openHost({ reuse: first.fixture, runtimeDir });
    const again = await remote.attach();
    expect(again.outcome).toBe('success');
    expect(again.result.previousSessionId).toBe(oldRev.sessionId);
    expect(again.identities.sessionId).toBe(second.session.sessionId);
    const old = await remote.dispatch('check', { rev: oldRev });
    expect([old.outcome, old.failure.reason]).toEqual([
      'stale-revision',
      'session-changed',
    ]);
    expectDeclared(old);
    const current = await remote.dispatch('check', {
      rev: again.identities.revision,
    });
    expect(current.outcome).toBe('success');
  });

  test('a bridge restart within one session keeps the session identity', async () => {
    const host = await openHost();
    const remote = openWorkspace(host);
    expect((await remote.attach()).outcome).toBe('success');
    await host.bridge.close();
    host.bridge = await compiler.startOwnerBridge({
      session: host.session,
      host: 'test',
      runtimeDir: host.runtimeDir,
    });
    const again = await remote.attach();
    expect(again.outcome).toBe('success');
    expect(again.result.previousSessionId).toBe(null);
  });

  test('a session closed before its bridge answers owner-closed, never an authority decision', async () => {
    const host = await openHost();
    const remote = openWorkspace(host);
    const attached = await remote.attach();
    const rev = attached.identities.revision;
    await host.session.close();
    const response = await remote.dispatch('check', { rev });
    expect([response.outcome, response.failure.reason]).toEqual([
      'owner-required',
      'owner-closed',
    ]);
    expectDeclared(response);
  });
});

describe('AG-02.1 no canonical artifact or watcher pollution (targeted verification)', () => {
  test('start, attach, requests and stop leave the project, its state and a roots-[.] watcher unchanged', async () => {
    const host = await openHost({ bridge: false });
    const project = host.project;
    const watched = host.fixture.openPublicSession({
      projectId: `${project}#watched`,
      roots: [project],
      outDir: path.join(path.dirname(project), 'watched-out'),
    });
    await watched.initialize();
    const watcher = await watched.watch({ debounceMs: 20 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const revisionBefore = (await watched.current()).revision;
      const before = hashTree(path.dirname(project));
      host.bridge = await compiler.startOwnerBridge({
        session: host.session,
        host: 'test',
        runtimeDir: host.runtimeDir,
      });
      const remote = openWorkspace(host);
      const attached = await remote.attach();
      await remote.dispatch('check', { rev: attached.identities.revision });
      await remote.dispatch('session.status', {});
      remote.workspace.dispose();
      await host.bridge.close();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const after = hashTree(path.dirname(project));
      // `check` records a verdict in memory only; nothing on disk changed.
      expect(after).toEqual(before);
      expect((await watched.current()).revision).toEqual(revisionBefore);
    } finally {
      watcher.close?.();
      await watched.close();
    }
  });
});

describe('AG-02.1 platform and start contract', () => {
  test('other platforms fail closed with anchoring-unavailable (Linux-only enablement)', async () => {
    const host = await openHost({ bridge: false });
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      const refused = await compiler.startOwnerBridge({
        session: host.session,
        host: 'test',
        runtimeDir: host.runtimeDir,
      });
      expect(refused).toEqual({
        started: false,
        reason: 'anchoring-unavailable',
      });
      const remote = openWorkspace(host);
      const attach = await remote.attach();
      expect(attach.outcome).toBe('unsupported-capability');
      expect(attach.failure).toEqual(
        expect.objectContaining({
          reason: 'anchoring-unavailable',
          capability: 'feature:owner-bridge',
        }),
      );
      expectDeclared(attach);
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
    expect(fs.existsSync(host.runtimeDir)).toBe(false);
  });

  test('host lifecycle grants and an unusable session are refused at start', async () => {
    const host = await openHost({ bridge: false });
    for (const grants of [
      ['consult', 'load-config'],
      ['consult', 'manage-session'],
      ['publish'],
      [],
      ['consult', 'admin'],
    ])
      await expect(
        compiler.startOwnerBridge({
          session: host.session,
          host: 'test',
          grants,
          runtimeDir: host.runtimeDir,
        }),
      ).rejects.toThrow(TypeError);
    await expect(
      compiler.startOwnerBridge({
        session: host.session,
        host: 'nginx',
        runtimeDir: host.runtimeDir,
      }),
    ).rejects.toThrow(TypeError);
    const fresh = host.fixture.openPublicSession({
      outDir: path.join(path.dirname(host.project), 'fresh-out'),
    });
    await expect(
      compiler.startOwnerBridge({
        session: fresh,
        host: 'test',
        runtimeDir: host.runtimeDir,
      }),
    ).rejects.toThrow(/initialized, open session/);
    await host.session.close();
    await expect(
      compiler.startOwnerBridge({
        session: host.session,
        host: 'test',
        runtimeDir: host.runtimeDir,
      }),
    ).rejects.toThrow(/initialized, open session/);
    expect(fs.existsSync(host.runtimeDir)).toBe(false);
  });
});

describe('AG-02.1 structural invariants', () => {
  test('I2: the owner side reaches the session only through binding.dispatch', () => {
    const source = fs.readFileSync(
      path.join(COMPILER, 'src/agent/bridge/server.js'),
      'utf8',
    );
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(
      imports.filter((specifier) => specifier.startsWith('.')).sort(),
    ).toEqual(
      [
        '../../protocol/envelope.js',
        '../binding.js',
        '../registry.js',
        './descriptor.js',
        './frames.js',
        './handshake.js',
        './runtime-dir.js',
      ].sort(),
    );
    expect(source).not.toMatch(/AGENT_SESSION_HOOKS|handlers\//);
    // Every call into the agent layer is `binding.dispatch` or the
    // binding's own capability, paths and revocation state.
    const calls = [...source.matchAll(/binding\.(\w+)\(/g)].map((m) => m[1]);
    expect([...new Set(calls)].sort()).toEqual(
      ['dispatch', 'dispose', 'mintCapability', 'paths', 'revoked'].sort(),
    );
  });

  test('I9: the attach path imports no session code and no lease', () => {
    const script = `
import path from 'node:path';
import { rollup } from 'rollup';
import json from '@rollup/plugin-json';
const [compiler, ...entries] = process.argv.slice(1);
const src = path.join(compiler, 'src') + path.sep;
const out = {};
for (const entry of entries) {
  const bundle = await rollup({ input: path.join(compiler, entry), external: (id) => !id.startsWith('.') && !path.isAbsolute(id), plugins: [json()], onwarn() {} });
  const { output } = await bundle.generate({ format: 'es', inlineDynamicImports: true });
  await bundle.close();
  out[entry] = output.flatMap((chunk) => Object.keys(chunk.modules ?? {})).filter((id) => id.startsWith(src)).map((id) => path.relative(compiler, id));
}
process.stdout.write(JSON.stringify(out));`;
    const graphs = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          script,
          COMPILER,
          'src/agent/workspace.js',
          'src/agent/bridge/client.js',
          'src/agent/handlers/session-attach.js',
        ],
        { cwd: COMPILER, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      ),
    );
    for (const [entry, modules] of Object.entries(graphs)) {
      expect([entry, modules.length > 0]).toEqual([entry, true]);
      for (const module of modules) {
        expect([entry, module]).not.toEqual([entry, 'src/api/project.js']);
        expect([entry, module]).not.toEqual([entry, 'src/api/output-lease.js']);
        expect([entry, module.startsWith('src/project/')]).toEqual([
          entry,
          false,
        ]);
      }
    }
    expect(graphs['src/agent/workspace.js']).toContain(
      'src/agent/bridge/client.js',
    );
  });

  test('I1: the output-lease socket still carries no data', async () => {
    const host = await openHost();
    const net = require('net');
    const crypto = require('crypto');
    const name = `\0pandamstyle-output-${crypto
      .createHash('sha256')
      .update(canonicalOutDir(host))
      .digest('hex')}`;
    const received = await new Promise((resolve) => {
      const socket = net.createConnection({ path: name });
      let bytes = 0;
      socket.on('connect', () =>
        socket.write(
          frames.encodeFrame({ t: 'hello', bridge: [1], cn: 'x'.repeat(44) }),
        ),
      );
      socket.on('data', (chunk) => (bytes += chunk.length));
      socket.on('error', () => {});
      socket.on('close', () => resolve(bytes));
    });
    expect(received).toBe(0);
  });
});
