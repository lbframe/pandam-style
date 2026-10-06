/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Copied into the five-tarball external consumer. Adversarial observation wraps
// only the installed public compiler factory, following Phase 11 fault probes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { createProjectSession } from '@pandamstyle/compiler';
import { createHostBridge } from '@pandamstyle/compiler/host';
import { createRsbuild } from '@rsbuild/core';
import { pandamstyle as vite } from '@pandamstyle/vite';
import { pandamstyle as rsbuild } from '@pandamstyle/rsbuild';
import { withPandamStyle } from '@pandamstyle/next';

async function main() {
  const root = process.cwd();
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
  const definition = (value) => ({
    systemId: 'checkpoint-same-system',
    tokens: {
      spacing: {
        md: { value, visibility: 'public' },
        lg: { value: '32px', visibility: 'public' },
      },
    },
  });
  const source = (
    token = 'md',
  ) => `import { create, token, props } from '../generated/design.js';
const styles = create({ box: { padding: token('spacing.${token}') } });
export const box = props(styles.box);
`;
  const write = (base, file, text) => {
    const target = path.join(base, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  const canonical = (base) =>
    Object.fromEntries(
      [
        'design.js',
        'design.d.ts',
        'manifest.json',
        'styles.css',
        'artifacts.json',
      ].map((file) => [
        file,
        sha(fs.readFileSync(path.join(base, 'generated', file))),
      ]),
    );
  const code = (error) => error.code ?? error.diagnostics?.[0]?.code;
  const rejected = (error) => code(error) === 'PMS_UNSUPPORTED_FEATURE';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(check, label) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await sleep(20);
    }
    throw new Error('Timed out: ' + label);
  }
  const nextDir = path.join(root, 'node_modules/@pandamstyle/next');
  const { createCoordinator } = await import(
    pathToFileURL(path.join(nextDir, 'src/coordinator.js')).href
  );
  const { createSupervisor, resolveInstalledNext } = await import(
    pathToFileURL(path.join(nextDir, 'src/supervisor.js')).href
  );
  const shimFile = path.join(root, 'checkpoint-compiler-observer.mjs');
  fs.writeFileSync(
    shimFile,
    `import * as sdk from '@pandamstyle/compiler';
export const { Codes, PmsError } = sdk;
export const sessions = [];
export function createProjectSession(config) {
  const project = sdk.createProjectSession(config);
  sessions.push({ config, project });
  return project;
}
`,
  );
  const adapterFile = path.join(root, 'checkpoint-observed-rsbuild.mjs');
  fs.writeFileSync(
    adapterFile,
    fs
      .readFileSync(
        path.join(root, 'node_modules/@pandamstyle/rsbuild/src/index.js'),
        'utf8',
      )
      .replace(
        "from '@pandamstyle/compiler';",
        "from './checkpoint-compiler-observer.mjs';",
      ),
  );
  const { pandamstyle: observedRsbuild } = await import(
    pathToFileURL(adapterFile).href
  );
  const { sessions } = await import(pathToFileURL(shimFile).href);

  assert.throws(() => vite({ publicationMode: 'semantic-dev' }), rejected);
  assert.throws(() => rsbuild({ publicationMode: 'semantic-dev' }), rejected);
  assert.throws(() => vite({ acceptedSnapshotRetention: {} }), rejected);
  assert.throws(() => rsbuild({ acceptedSnapshotRetention: {} }), rejected);
  assert.throws(
    () =>
      withPandamStyle({
        backend: 'webpack',
        publicationMode: 'semantic-dev',
        definition: definition('16px'),
        roots: ['src'],
      }),
    rejected,
  );
  await assert.rejects(
    withPandamStyle({
      backend: 'turbopack',
      publicationMode: 'semantic-dev',
      definition: definition('16px'),
      roots: ['src'],
    })({})('phase-production-build', {}),
    rejected,
  );
  const negativeScope = {
    pass: true,
    vite: 'rejected',
    rsbuild: 'rejected',
    nextWebpack: 'rejected',
    nextProduction: 'rejected',
    unsupportedNextVersion: 'authoritative Next T40 required independently',
  };

  const a = path.join(root, 'checkpoint-next-a');
  const b = path.join(root, 'checkpoint-rsbuild-b');
  for (const base of [a, b]) {
    write(base, 'package.json', '{"type":"module"}');
    write(base, 'src/page.js', source());
  }
  const nextOptions = {
    backend: 'turbopack',
    publicationMode: 'semantic-dev',
    definition: definition('16px'),
    roots: ['src'],
    outDir: 'generated',
    acceptedSnapshotRetention: {
      maxSnapshots: 2,
      maxBytes: 1024 * 1024,
      maxPins: 8,
    },
  };
  const events = [];
  let owner;
  let server;
  let retired;
  let supervisor;
  let nextChild;
  let nextLog = '';
  async function stopNext() {
    if (
      nextChild &&
      nextChild.exitCode === null &&
      nextChild.signalCode === null
    ) {
      const done = once(nextChild, 'close');
      nextChild.kill('SIGTERM');
      await done;
    }
    nextChild = null;
    await supervisor?.close();
    supervisor = null;
  }
  try {
    write(
      a,
      'app/layout.jsx',
      'export default function Layout({children}) { return <html><body>{children}</body></html>; }',
    );
    write(
      a,
      'app/page.jsx',
      "import { box } from '../src/page.js'; export default function Page() { return <div id='checkpoint-next' {...box}>checkpoint Next</div>; }",
    );
    write(
      a,
      'next.config.mjs',
      `import { withPandamStyle } from '@pandamstyle/next'; export default withPandamStyle(${JSON.stringify(nextOptions)})({});`,
    );
    // Turbopack's qualified root excludes dependencies reached through an
    // outward node_modules symlink. Use independent external installed bytes.
    fs.cpSync(path.join(root, 'node_modules'), path.join(a, 'node_modules'), {
      recursive: true,
      verbatimSymlinks: true,
    });
    const available = net.createServer();
    available.listen(0, '127.0.0.1');
    await once(available, 'listening');
    const port = available.address().port;
    await new Promise((resolve) => available.close(resolve));
    supervisor = await createSupervisor(a, { command: 'dev' });
    const next = await resolveInstalledNext(a);
    const childEnv = {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: '1',
      CI: '1',
      PMS_NEXT_COORDINATOR_FILE: supervisor.credentialFile,
    };
    delete childEnv.NODE_PATH;
    nextChild = spawn(
      process.execPath,
      [
        next.binary,
        'dev',
        '--turbopack',
        '--port',
        String(port),
        '--hostname',
        '127.0.0.1',
      ],
      { cwd: a, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    nextChild.stdout.on('data', (bytes) => {
      nextLog += bytes;
    });
    nextChild.stderr.on('data', (bytes) => {
      nextLog += bytes;
    });
    await until(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}`, {
          signal: AbortSignal.timeout(2000),
        });
        return (
          response.status === 200 &&
          (await response.text()).includes('checkpoint-next')
        );
      } catch {
        return false;
      }
    }, 'real Next Turbopack SSR readiness');
    owner = supervisor.owner;
    assert(owner, 'Real Next config must register the supervisor owner');
    const host = await createRsbuild({
      cwd: b,
      rsbuildConfig: {
        plugins: [
          observedRsbuild({
            definition: definition('24px'),
            roots: ['src'],
            outDir: 'generated',
            designSystemFile: 'design.js',
            onEvent: (event) => events.push(event),
          }),
        ],
        source: { entry: { index: './src/page.js' } },
        server: { port: 0, host: '127.0.0.1' },
        dev: { lazyCompilation: false },
      },
    });
    ({ server } = await host.startDevServer());
    await until(
      () => events.some((event) => event.kind === 'settled'),
      'Rsbuild initial settlement',
    );
    const project = sessions.at(-1).project;
    const bridge = createHostBridge(project);
    assert.equal(sessions.at(-1).config.acceptedSnapshotRetention, undefined);
    const stats = () => project.acceptedSnapshotRetentionStats();
    const assertDisabled = async () => {
      const value = await stats();
      assert.equal(value.enabled, false);
      assert.equal(value.pins, 0);
      assert.equal(value.snapshots, 0);
      assert.equal(value.bytes, 0);
      return value;
    };
    const initialStats = await assertDisabled();
    const firstB = await project.current();
    const initialBBytes = canonical(b);
    const firstA = readJSON(owner.currentFile);
    assert.notEqual(owner.sessionId, project.sessionId);
    assert.notEqual(owner.projectId, project.projectId);
    assert.notEqual(
      firstA.designSystem.registryDigest,
      (await bridge.readGeneratedArtifacts(firstB.revision)).designSystem
        .registryDigest,
    );
    assert.notDeepEqual(canonical(a), canonical(b));
    const initialABytes = canonical(a);
    const initialAPins = await owner.snapshotStats();
    const initialAEvents = owner.events.length;
    const snapshotRoot = path.join(root, 'checkpoint-snapshot-sdk');
    write(snapshotRoot, 'src/page.js', source());
    const snapshotProject = createProjectSession({
      rootDir: snapshotRoot,
      roots: ['src'],
      outDir: 'generated',
      designSystemFile: 'design.js',
      definition: definition('16px'),
      acceptedSnapshotRetention: { maxSnapshots: 2 },
    });
    let acceptedSnapshotSdk;
    try {
      const initial = await snapshotProject.initialize();
      assert.equal((await snapshotProject.validate(initial.revision)).ok, true);
      const snapshotHost = createHostBridge(snapshotProject);
      const receipt = await snapshotHost.commitPrepared(
        await snapshotHost.preparePublication(initial.revision),
      );
      const pin = await snapshotHost.pinAcceptedSnapshot(
        receipt.associationRevision,
        { owner: 'external-snapshot-sdk' },
      );
      const artifact = await snapshotHost.readAcceptedArtifact(
        pin,
        'src/page.js',
        sha(source()),
      );
      assert.equal(artifact.provenance.snapshotId, pin.snapshotId);
      assert.equal(
        artifact.provenance.canonicalSetDigest,
        pin.snapshot.canonicalSetDigest,
      );
      assert.equal(pin.snapshot.files.length, 5);
      assert.equal(
        (await snapshotHost.acceptedSnapshotRetentionStats()).pins,
        1,
      );
      assert.equal(await snapshotHost.releaseAcceptedSnapshot(pin), true);
      assert.equal(await snapshotHost.releaseAcceptedSnapshot(pin), false);
      assert.equal(
        (await snapshotHost.acceptedSnapshotRetentionStats()).pins,
        0,
      );
      await assert.rejects(
        snapshotHost.readAcceptedArtifact(pin, 'src/page.js', sha(source())),
      );
      acceptedSnapshotSdk = {
        pass: true,
        APIs: [
          'pinAcceptedSnapshot',
          'readAcceptedArtifact',
          'releaseAcceptedSnapshot',
          'acceptedSnapshotRetentionStats',
        ],
        exactFiveMembers: true,
        compilerIdentityPreserved: true,
        releasedPin: 'rejected',
      };
    } finally {
      await snapshotProject.close();
    }
    const settledBefore = events.filter(
      (event) => event.kind === 'settled',
    ).length;
    write(b, 'src/page.js', source('lg'));
    await until(async () => {
      if (
        events.filter((event) => event.kind === 'settled').length <=
        settledBefore
      )
        return false;
      const current = await project.current();
      const artifact = await bridge.readArtifact(
        current.revision,
        'src/page.js',
      );
      return (
        artifact.sourceDigest === sha(source('lg')) &&
        canonical(b)['styles.css'] !== initialBBytes['styles.css']
      );
    }, 'Rsbuild edit settlement');
    await until(
      () => events.some((event) => event.kind === 'reload'),
      'explicit full reload',
    );
    const reload = events.filter((event) => event.kind === 'reload').at(-1);
    const afterEdit = await project.current();
    assert.deepEqual(reload.revision, afterEdit.revision);
    const css = await fetch(
      `http://127.0.0.1:${server.port}/pandamstyle/styles.css`,
    );
    assert.equal(css.status, 200);
    assert.equal(
      await css.text(),
      fs.readFileSync(path.join(b, 'generated/styles.css'), 'utf8'),
    );
    await assertDisabled();
    assert.deepEqual(canonical(a), initialABytes);
    assert.deepEqual(await owner.snapshotStats(), initialAPins);
    assert.equal(owner.events.length, initialAEvents);
    const validB = canonical(b);
    const reloadCount = events.filter(
      (event) => event.kind === 'reload',
    ).length;
    write(b, 'src/page.js', source('missing'));
    await until(
      () =>
        events.some(
          (event) =>
            event.kind === 'revision' && event.diagnostics?.ok === false,
        ),
      'invalid diagnostics',
    );
    await until(
      () => events.some((event) => event.kind === 'rejected'),
      'invalid rejected compilation',
    );
    assert.deepEqual(canonical(b), validB);
    assert.equal(
      events.filter((event) => event.kind === 'reload').length,
      reloadCount,
    );
    const bad = await project.current();
    const diagnostics = await project.agentResult(bad.revision);
    assert.equal(diagnostics.revision.sessionId, project.sessionId);
    assert(!JSON.stringify(diagnostics).includes(owner.sessionId));
    const repairedBefore = events.filter(
      (event) => event.kind === 'settled',
    ).length;
    write(b, 'src/page.js', source());
    await until(
      () =>
        events.filter((event) => event.kind === 'settled').length >
        repairedBefore,
      'repair',
    );
    await until(
      () =>
        events.filter((event) => event.kind === 'reload').length > reloadCount,
      'repair reload',
    );
    await assertDisabled();
    const repaired = await project.current();
    assert.deepEqual(
      (await bridge.readArtifact(repaired.revision, 'src/page.js'))
        .generatedImports,
      [],
    );
    await assert.rejects(
      bridge.readGeneratedArtifacts(afterEdit.revision),
      (error) => code(error) === 'PMS_STALE_REVISION',
    );
    await assert.rejects(
      bridge.pinAcceptedSnapshot(repaired.revision, {
        owner: 'must-stay-disabled',
      }),
    );
    await assert.rejects(
      bridge.readAcceptedArtifact(
        {
          projectId: owner.projectId,
          sessionId: owner.sessionId,
          pinId: 'foreign',
          snapshotId: firstA.snapshotId,
          owner: 'foreign',
        },
        'src/page.js',
        sha(source()),
      ),
    );
    await assert.rejects(
      project.applyChanges({
        baseRevision: firstA.associationRevision,
        mode: 'verified-explicit',
        changed: ['src/page.js'],
        added: [],
        removed: [],
        renamed: [],
        sourceOverlays: [{ file: 'src/page.js', source: source('lg') }],
      }),
    );
    await assert.rejects(
      bridge.commitPrepared({
        projectId: owner.projectId,
        sessionId: owner.sessionId,
        revision: firstA.associationRevision,
        ticketId: 'foreign-next-ticket',
        candidateDigest: 'foreign',
        state: 'prepared',
      }),
    );
    await assert.rejects(
      async () =>
        owner.transform({
          projectId: project.projectId,
          sessionId: project.sessionId,
          file: path.join(a, 'src/page.js'),
          sourceDigest: sha(source()),
          snapshotId: null,
        }),
      (error) => error.code === 'PMS_TRANSPORT_FOREIGN_SESSION',
    );
    assert.deepEqual(canonical(a), initialABytes);

    // Actual second processes attempt both live host outputs using only public SDK.
    const conflictScript = path.join(root, 'checkpoint-output-conflict.mjs');
    fs.writeFileSync(
      conflictScript,
      `import assert from 'node:assert/strict';
import { createProjectSession } from '@pandamstyle/compiler';
const project = createProjectSession(JSON.parse(process.argv[2]));
try { await project.initialize(); throw new Error('Lease unexpectedly acquired'); }
catch (error) { assert.equal(error.diagnostics?.[0]?.context?.reason, 'output-owned'); }
finally { await project.close(); }
console.log(JSON.stringify({ pass: true }));
`,
    );
    for (const base of [a, b]) {
      const conflictEnv = { ...process.env };
      delete conflictEnv.NODE_PATH;
      const result = spawnSync(
        process.execPath,
        [
          conflictScript,
          JSON.stringify({
            rootDir: base,
            roots: ['src'],
            outDir: 'generated',
            designSystemFile: 'design.js',
            definition: definition('16px'),
          }),
        ],
        { cwd: root, encoding: 'utf8', env: conflictEnv },
      );
      assert.equal(result.status, 0, result.stderr);
    }
    const processLeaseProof = { platform: process.platform };
    if (process.platform === 'linux') {
      const candidates = new Map();
      let pair;
      for (let i = 0; i <= 20000; i++) {
        const base = path.join(root, 'lease-collision-' + i);
        const output = path.join(base, 'generated');
        const port = 10000 + (parseInt(sha(output).slice(0, 8), 16) % 20000);
        if (candidates.has(port)) {
          pair = [candidates.get(port), base];
          processLeaseProof.formerTcpPort = port;
          break;
        }
        candidates.set(port, base);
      }
      assert(pair, 'The former finite TCP mapping must contain a collision');
      const options = (base) => ({
        rootDir: base,
        roots: ['src'],
        outDir: 'generated',
        designSystemFile: 'design.js',
        definition: definition('16px'),
      });
      const clusterRoot = path.join(root, 'lease-cluster-workers');
      write(clusterRoot, 'src/page.js', 'export const value = 1;');
      const clusterScript = path.join(root, 'checkpoint-output-cluster.mjs');
      fs.writeFileSync(
        clusterScript,
        `import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import { once } from 'node:events';
import { createProjectSession } from '@pandamstyle/compiler';
if (cluster.isPrimary) {
  const workers = [];
  try {
    const first = cluster.fork(); workers.push(first);
    assert.equal((await once(first, 'message'))[0].acquired, true);
    const second = cluster.fork(); workers.push(second);
    const result = (await once(second, 'message'))[0];
    assert.equal(result.acquired, false);
    assert.equal(result.reason, 'output-owned');
    console.log(JSON.stringify({ pass: true, clusterSecondWorker: 'output-owned' }));
  } finally { for (const worker of workers) worker.kill('SIGKILL'); }
} else {
  const project = createProjectSession(JSON.parse(process.argv[2]));
  try { await project.initialize(); process.send({ acquired: true }); }
  catch (error) { process.send({ acquired: false, reason: error.diagnostics?.[0]?.context?.reason }); }
  setInterval(() => {}, 1000);
}
`,
      );
      const clusterEnv = { ...process.env };
      delete clusterEnv.NODE_PATH;
      const clusterResult = spawnSync(
        process.execPath,
        [clusterScript, JSON.stringify(options(clusterRoot))],
        { cwd: root, encoding: 'utf8', env: clusterEnv },
      );
      assert.equal(clusterResult.status, 0, clusterResult.stderr);
      processLeaseProof.clusterSecondWorker = JSON.parse(
        clusterResult.stdout.trim(),
      ).clusterSecondWorker;
      const collisionSessions = [];
      try {
        for (const base of pair) {
          write(base, 'src/page.js', 'export const value = 1;');
          const session = createProjectSession(options(base));
          collisionSessions.push(session);
          await session.initialize();
        }
        assert.notEqual(
          sha(path.join(pair[0], 'generated')),
          sha(path.join(pair[1], 'generated')),
        );
        processLeaseProof.distinctOutputsWithFormerPortCollision =
          'both acquired';
      } finally {
        for (const session of collisionSessions) await session.close();
      }
      const deathRoot = path.join(root, 'lease-process-death');
      write(deathRoot, 'src/page.js', 'export const value = 1;');
      const deathScript = path.join(root, 'checkpoint-output-owner.mjs');
      fs.writeFileSync(
        deathScript,
        `import { createProjectSession } from '@pandamstyle/compiler';
const project = createProjectSession(JSON.parse(process.argv[2]));
await project.initialize();
console.log('LEASE_READY');
setInterval(() => {}, 1000);
`,
      );
      const childEnv = { ...process.env };
      delete childEnv.NODE_PATH;
      const child = spawn(
        process.execPath,
        [deathScript, JSON.stringify(options(deathRoot))],
        {
          cwd: root,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let childLog = '';
      child.stdout.on('data', (data) => {
        childLog += data;
      });
      child.stderr.on('data', (data) => {
        childLog += data;
      });
      const childExit = once(child, 'exit');
      const replacement = createProjectSession(options(deathRoot));
      try {
        await until(
          () => childLog.includes('LEASE_READY'),
          'public output owner ready',
        );
        await assert.rejects(
          replacement.initialize(),
          (error) => error.diagnostics?.[0]?.context?.reason === 'output-owned',
        );
        await replacement.close();
        child.kill('SIGKILL');
        await childExit;
        const successor = createProjectSession(options(deathRoot));
        try {
          await successor.initialize();
        } finally {
          await successor.close();
        }
        processLeaseProof.processDeath = 'kernel released; successor acquired';
      } finally {
        await replacement.close();
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
        await childExit;
      }
    }
    await assert.rejects(
      createCoordinator(b, { ...nextOptions, definition: definition('24px') }),
      (error) => error.code === 'PMS_OUTPUT_OWNED',
    );
    const contender = createProjectSession({
      rootDir: a,
      roots: ['src'],
      outDir: 'generated',
      definition: definition('16px'),
    });
    await assert.rejects(
      contender.initialize(),
      (error) => error.diagnostics?.[0]?.context?.reason === 'output-owned',
    );
    await contender.close();
    const beforeCapacityB = canonical(b);
    const beforeCapacityBEvents = events.length;
    const request = () => ({
      projectId: owner.projectId,
      sessionId: owner.sessionId,
      file: path.join(a, 'src/page.js'),
      sourceDigest: sha(fs.readFileSync(path.join(a, 'src/page.js'))),
      snapshotId: null,
    });
    write(a, 'src/page.js', source('lg'));
    await owner.transform(request());
    const offered = readJSON(owner.currentFile);
    write(
      a,
      'src/page.js',
      source().replace(
        'export const box',
        '// changed association\nexport const box',
      ),
    );
    await assert.rejects(
      owner.transform(request()),
      (error) =>
        error.diagnostics?.[0]?.context?.reason === 'retention-limit' ||
        error.code === 'PMS_TRANSPORT_RETENTION_LIMIT',
    );
    assert.equal(readJSON(owner.currentFile).snapshotId, offered.snapshotId);
    assert.equal(readJSON(owner.statusFile).state, 'transport-error');
    assert.deepEqual(canonical(b), beforeCapacityB);
    assert.equal(events.length, beforeCapacityBEvents);
    const finalStats = await assertDisabled();
    const oldRequest = request();
    retired = { projectId: owner.projectId, sessionId: owner.sessionId };
    await stopNext();
    owner = await createCoordinator(a, nextOptions);
    assert.notEqual(owner.sessionId, retired.sessionId);
    await assert.rejects(
      async () => owner.transform(oldRequest),
      (error) => error.code === 'PMS_TRANSPORT_FOREIGN_SESSION',
    );
    await server.close();
    server = null;
    await assert.rejects(
      project.current(),
      (error) => code(error) === 'PMS_SESSION_CLOSED',
    );
    const reopened = createProjectSession({
      rootDir: b,
      roots: ['src'],
      outDir: 'generated',
      designSystemFile: 'design.js',
      definition: definition('24px'),
    });
    try {
      await reopened.initialize();
    } finally {
      await reopened.close();
    }
    const report = {
      pass: true,
      node: process.version,
      compilerSdkCompatibility: {
        pass: true,
        acceptedSnapshotSdk,
        preSnapshotOperations: [
          'initialize',
          'current',
          'readGeneratedArtifacts',
          'agentResult',
          'close',
        ],
        snapshotCallsRequiredByRsbuild: false,
        expandedHostBridge: 'passed',
      },
      snapshotRsbuildRegression: {
        pass: true,
        initialStats,
        finalStats,
        edits: 'no retention or pins',
        generatedImportParsing: 'disabled, empty metadata',
        invalidGeneration: 'preserved',
        staleReads: 'rejected',
        currentFullReloadCss: 'exact canonical bytes',
        close: 'released',
      },
      crossHostIsolation: {
        pass: true,
        concurrentActualHosts: [
          'Next Turbopack dev with HTTP SSR',
          'Rsbuild dev server',
        ],
        sameRelativeSource: 'src/page.js',
        next: retired,
        rsbuild: { projectId: project.projectId, sessionId: project.sessionId },
        sourceOverlays: 'foreign rejected',
        publicationTickets: 'foreign rejected',
        snapshots: 'foreign rejected',
        pins: 'independent',
        css: 'independent',
        diagnostics: 'independent',
        watchEvents: 'independent',
        transportEvents: 'independent',
        capacityFailureInNext: 'Rsbuild unchanged',
        oldSession: 'rejected',
      },
      outputLeaseConflict: {
        pass: true,
        sameProcessBothDirections: 'rejected',
        separateProcessesBothOutputs: 'rejected',
        closedHost: 'released',
        retiredCoordinator: 'rejected',
        ...processLeaseProof,
      },
      semanticDevScope: negativeScope,
    };
    console.log(JSON.stringify(report));
  } finally {
    fs.writeFileSync(
      path.join(root, 'checkpoint-rsbuild-observed-events.json'),
      JSON.stringify(events, null, 2) + '\n',
    );
    fs.writeFileSync(path.join(root, 'checkpoint-next-host.log'), nextLog);
    await server?.close();
    await stopNext();
    await owner?.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
