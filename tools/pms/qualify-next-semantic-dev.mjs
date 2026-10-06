/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Independent packed-package qualification. API-independent helpers and
 * fixtures are prepared first; runtime wiring is gated on loader acceptance.
 * Nothing in this file treats a deadline, framework overlay, or callback as
 * permission to publish compiler artifacts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import nextBrowserProfile from './next-browser-profile.js';

const { createNextBrowserProfile, launchWithNextBrowserProfile } =
  nextBrowserProfile;

export const CANONICAL_FILES = Object.freeze([
  'design.js',
  'design.d.ts',
  'manifest.json',
  'styles.css',
  'artifacts.json',
]);

export const QUALIFICATION_MATRIX = Object.freeze(
  [
    ['T01', 'Clean first start'],
    ['T02', 'Valid local style edit'],
    ['T03', 'Byte-identical generated output'],
    ['T04', 'Invalid semantic edit'],
    ['T05', 'Repair semantic edit'],
    ['T06', 'Valid style with unrelated missing import'],
    ['T07', 'Repair only unrelated Next error'],
    ['T08', 'Error in Service-owned dependency'],
    ['T09', 'Prepared revision superseded before commit'],
    ['T10', 'Historical accepted snapshot'],
    ['T11', 'Burst edits across two modules'],
    ['T12', 'Delayed old source request'],
    ['T13', 'Add, delete, and rename source'],
    ['T14', 'Re-export and transitive edit'],
    ['T15', 'Definition-only edit'],
    ['T16', 'Invalid definition and repair'],
    ['T17', 'Server Component-only style'],
    ['T18', 'Client edit and measured refresh behavior'],
    ['T19', 'Shared RSC and client module'],
    ['T20', 'First lazy route navigation'],
    ['T21', 'First dynamic client import'],
    ['T22', 'Token edit with historical client'],
    ['T23', 'Semantic edit while Next overlay is open'],
    ['T24', 'Empty, error, and not-found routes'],
    ['T25', 'Unchanged restart with retained Next cache'],
    ['T26', 'Source edit while stopped'],
    ['T27', 'Delete, rename, and definition edit while stopped'],
    ['T28', 'Duplicate process requests'],
    ['T29', 'Crash, new session, and stale worker rejection'],
    ['T30', 'Two independent projects'],
    ['T31', 'Conflicting output owners'],
    ['T32', 'Transport interruption and corrupt member'],
    ['T33', 'Bounded snapshot retention'],
    ['T34', 'Incremental versus fresh oracle'],
    ['T35', 'Unauthorized author CSS import'],
    ['T36', 'Directive and source-map provenance'],
    ['T37', 'Next-only source edit'],
    ['T38', 'Tarball, dependency, and browser closure'],
    ['T39', 'Exact current strict webpack regression'],
    ['T40', 'Unsupported mode, backend, and version'],
  ].map(([id, scenario]) => Object.freeze({ id, scenario })),
);

export const sha256 = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');

/** Independent implementation of the documented five-file digest framing. */
export function fiveFileDigest(members) {
  assert.deepEqual(
    members.map((member) => member.file),
    CANONICAL_FILES,
  );
  const hash = createHash('sha256').update(
    'pandamstyle-canonical-five-file-set-v1\0',
  );
  const length = (size) => {
    const frame = Buffer.alloc(8);
    frame.writeBigUInt64BE(BigInt(size));
    hash.update(frame);
  };
  length(members.length);
  for (const member of members) {
    for (const value of [member.file, member.content]) {
      const bytes = Buffer.from(value);
      length(bytes.length);
      hash.update(bytes);
    }
  }
  return hash.digest('hex');
}

export async function readJSON(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export function hasOpacityDeclaration(css, value) {
  return [
    ...css.matchAll(/(?:^|[;{])\s*opacity\s*:\s*([\d.]+)\s*(?=[;}])/g),
  ].some((match) => Number(match[1]) === value);
}

function expectedDefinitionStyle(definition) {
  const rgb = (hex) =>
    'rgb(' +
    [1, 3, 5]
      .map((index) => parseInt(hex.slice(index, index + 2), 16))
      .join(', ') +
    ')';
  return {
    padding: definition.tokens.spacing.md.value,
    color: rgb(definition.tokens.colors.ink.value),
    background: rgb(definition.tokens.colors.paper.value),
  };
}

export async function readEvents(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    // Ignore only a not-yet-complete trailing line, never a malformed full one.
    return text
      .slice(0, text.lastIndexOf('\n') + 1)
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function until(predicate, description, timeoutMs = 45000) {
  const start = performance.now();
  let last;
  while (performance.now() - start < timeoutMs) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) {
      last = { error: error.message, code: error.code };
    }
    // Polling schedules observations. The observed predicate authorizes success.
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(
    `Unobserved condition: ${description}; last=${JSON.stringify(last)}`,
  );
}

export async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function fileInventory(root, relative = '') {
  const result = [];
  for (const entry of await fs.readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const file = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...(await fileInventory(root, file)));
    else if (entry.isFile()) {
      const bytes = await fs.readFile(path.join(root, file));
      result.push({ file, sha256: sha256(bytes), bytes: bytes.length });
    } else throw new Error(`Nonregular evidence member: ${file}`);
  }
  return result.sort((a, b) => a.file.localeCompare(b.file));
}

export async function canonicalSet(root) {
  const contents = [];
  const members = await Promise.all(
    CANONICAL_FILES.map(async (file) => {
      const bytes = await fs.readFile(path.join(root, '.pandamstyle', file));
      contents.push({ file, content: bytes });
      return { file, sha256: sha256(bytes), bytes: bytes.length };
    }),
  );
  const artifacts = await readJSON(
    path.join(root, '.pandamstyle/artifacts.json'),
  );
  const manifest = await readJSON(
    path.join(root, '.pandamstyle/manifest.json'),
  );
  for (const record of Object.values(artifacts.artifacts)) {
    const actual = members.find((member) => member.file === record.file);
    assert(actual, record.file);
    assert.equal(actual.sha256, record.sha256, record.file);
    assert.equal(actual.bytes, record.bytes, record.file);
  }
  for (const key of [
    'systemId',
    'registryDigest',
    'abiVersion',
    'compilerContractVersion',
    'manifestSchemaVersion',
  ])
    assert.equal(manifest[key], artifacts[key], key);
  return {
    members,
    artifacts,
    manifest,
    identity: sha256(JSON.stringify(members)),
    canonicalSetDigest: fiveFileDigest(
      CANONICAL_FILES.map((file) =>
        contents.find((member) => member.file === file),
      ),
    ),
  };
}

export async function assertDescriptor(descriptor, expectedCanonical = null) {
  assert.equal(descriptor.schemaVersion, 1);
  assert.equal(descriptor.protocolVersion, 1);
  assert.equal(descriptor.accepted, true);
  assert(descriptor.projectId && descriptor.sessionId && descriptor.snapshotId);
  assert.equal(new Set(descriptor.files.map((member) => member.file)).size, 5);
  assert.deepEqual(
    descriptor.files.map((member) => member.file).sort(),
    [...CANONICAL_FILES].sort(),
  );
  assert.equal(
    descriptor.designJS,
    descriptor.files.find((member) => member.kind === 'design-module').path,
  );
  assert.equal(
    descriptor.stylesCSS,
    descriptor.files.find((member) => member.kind === 'css').path,
  );
  const inventory = await fileInventory(descriptor.directory);
  assert.deepEqual(
    inventory.map((member) => member.file).sort(),
    [...CANONICAL_FILES, 'descriptor.json'].sort(),
  );
  assert.deepEqual(await readJSON(descriptor.descriptorFile), descriptor);
  for (const member of descriptor.files) {
    assert.equal(member.path, path.join(descriptor.directory, member.file));
    const bytes = await fs.readFile(member.path);
    assert.equal(sha256(bytes), member.sha256, member.file);
    assert.equal(bytes.length, member.bytes, member.file);
    if (expectedCanonical != null) {
      const expected = expectedCanonical.members.find(
        (value) => value.file === member.file,
      );
      assert.equal(member.sha256, expected.sha256, member.file);
      assert.equal(member.bytes, expected.bytes, member.file);
    }
  }
  if (expectedCanonical != null) {
    assert.equal(
      descriptor.canonicalSetDigest,
      expectedCanonical.canonicalSetDigest,
    );
    assert.equal(
      descriptor.artifactSetDigest,
      expectedCanonical.artifacts.artifactSetDigest,
    );
    assert.equal(
      descriptor.designSystem.registryDigest,
      expectedCanonical.artifacts.registryDigest,
    );
  }
  return inventory;
}

export async function captureDescriptor(run, descriptor) {
  const members = [];
  for (const member of descriptor.files) {
    const bytes = await fs.readFile(member.path);
    assert.equal(sha256(bytes), member.sha256, member.file);
    assert.equal(bytes.length, member.bytes, member.file);
    members.push({
      file: member.file,
      kind: member.kind,
      ...(await run.archiveBytes(bytes)),
    });
  }
  const key = sha256(JSON.stringify(descriptor));
  const evidence = 'snapshot-descriptors/' + key + '.json';
  await fs.mkdir(path.dirname(path.join(run.output, evidence)), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(run.output, evidence),
    JSON.stringify(descriptor, null, 2) + '\n',
  );
  const record = {
    snapshotId: descriptor.snapshotId,
    accepted: descriptor.accepted,
    projectId: descriptor.projectId,
    sessionId: descriptor.sessionId,
    associationRevision: descriptor.associationRevision,
    generationId: descriptor.generationId,
    descriptorEvidence: evidence,
    members,
    capturedAt: Date.now(),
  };
  run.report.snapshots ??= [];
  if (
    !run.report.snapshots.some(
      (snapshot) => snapshot.descriptorEvidence === evidence,
    )
  )
    run.report.snapshots.push(record);
  return record;
}

export async function captureCanonical(run) {
  const canonical = await canonicalSet(run.root);
  const memberEvidence = [];
  for (const member of canonical.members) {
    const bytes = await fs.readFile(
      path.join(run.root, '.pandamstyle', member.file),
    );
    assert.equal(sha256(bytes), member.sha256, member.file);
    memberEvidence.push({
      file: member.file,
      ...(await run.archiveBytes(bytes)),
    });
  }
  return { ...canonical, memberEvidence };
}

export function relativeImport(from, target) {
  assert(path.isAbsolute(from) && path.isAbsolute(target));
  const relative = path
    .relative(path.dirname(from), target)
    .split(path.sep)
    .join('/');
  return relative.startsWith('.') ? relative : './' + relative;
}

export function assertPairedImports(javascript, descriptor, moduleFile) {
  const designImport = relativeImport(moduleFile, descriptor.designJS);
  const cssImport = relativeImport(moduleFile, descriptor.stylesCSS);
  const snapshots = [
    ...javascript.matchAll(
      /(?:"|')([^"'\n]*\.pandamstyle-next-host[^"'\n]*\/sessions\/[^"'\n]+)(?:"|')/g,
    ),
  ].map((match) => path.resolve(path.dirname(moduleFile), match[1]));
  assert(
    snapshots.includes(descriptor.designJS),
    'Retained real design reference does not resolve to descriptor JS',
  );
  assert(
    snapshots.includes(descriptor.stylesCSS),
    'Real CSS import does not resolve to descriptor CSS',
  );
  assert(
    snapshots.length >= 2,
    'Both immutable module and CSS addresses must appear',
  );
  for (const file of snapshots)
    assert(
      file.startsWith(descriptor.directory + path.sep),
      'Transformed source refers to a different immutable snapshot',
    );
  return {
    designJS: descriptor.designJS,
    stylesCSS: descriptor.stylesCSS,
    designImport,
    cssImport,
    snapshots,
  };
}

export async function descriptorFromLoader(run, file, loader) {
  assert.equal(loader.ok, true);
  const moduleFile = path.join(run.root, file);
  const addresses = [
    ...loader.javascript.matchAll(
      /(?:"|')([^"'\n]*\.pandamstyle-next-host[^"'\n]*\/sessions\/[^"'\n]+)(?:"|')/g,
    ),
  ].map((match) => path.resolve(path.dirname(moduleFile), match[1]));
  const directories = [
    ...new Set(addresses.map((address) => path.dirname(address))),
  ];
  assert.equal(
    directories.length,
    1,
    'Loader selected more than one immutable snapshot',
  );
  const descriptor = await readJSON(
    path.join(directories[0], 'descriptor.json'),
  );
  const inventory = await assertDescriptor(descriptor);
  const pair = assertPairedImports(loader.javascript, descriptor, moduleFile);
  const snapshot = await captureDescriptor(run, descriptor);
  return { descriptor, inventory, pair, snapshot };
}

export async function descriptorFromCSSLoader(run, file, loader) {
  assert.equal(loader.ok, true);
  const moduleFile = path.join(run.root, file);
  const addresses = [
    ...loader.javascript.matchAll(
      /(?:"|')([^"'\n]*\.pandamstyle-next-host[^"'\n]*\/sessions\/[^"'\n]+)(?:"|')/g,
    ),
  ].map((match) => path.resolve(path.dirname(moduleFile), match[1]));
  assert.equal(addresses.length, 1, 'Expected one immutable CSS import');
  const descriptor = await readJSON(
    path.join(path.dirname(addresses[0]), 'descriptor.json'),
  );
  const inventory = await assertDescriptor(descriptor);
  assert.deepEqual(addresses, [descriptor.stylesCSS]);
  const snapshot = await captureDescriptor(run, descriptor);
  return { descriptor, inventory, addresses, snapshot };
}

export function assertOneOwner(events, { projectId, sessionId }) {
  const scoped = events.filter(
    (event) => event.projectId === projectId && event.sessionId === sessionId,
  );
  const initial = scoped.filter(
    (event) => event.type === 'revision-accepted' && event.initial === true,
  );
  assert.equal(
    initial.length,
    1,
    'Session must initialize exactly one Service owner',
  );
  const pids = [...new Set(scoped.map((event) => event.pid))];
  assert.equal(pids.length, 1, 'Session has more than one coordinator owner');
  return {
    projectId,
    sessionId,
    pid: pids[0],
    initialRevision: initial[0].revision,
  };
}

export function assertProductionOrder(events, sessionId) {
  const scoped = events.filter((event) => event.sessionId === sessionId);
  const boundary = scoped.find(
    (event) => event.type === 'framework-build-complete',
  );
  const exited = scoped.find((event) => event.type === 'installed-next-exited');
  const committed = scoped.find((event) => event.type === 'semantic-committed');
  assert(
    boundary && exited && committed,
    'Missing real production boundary evidence',
  );
  assert.equal(boundary.authority, 'public-next-onBuildComplete');
  assert.equal(exited.exitCode, 0);
  assert.equal(exited.signal, null);
  assert.equal(
    committed.authority,
    'supervisor-next-exit-zero-after-public-completion',
  );
  assert(
    boundary.sequence < exited.sequence && exited.sequence < committed.sequence,
    'Canonical commit preceded public completion or successful Next exit',
  );
  assert.deepEqual(
    boundary.preparedRevision,
    committed.receipt.associationRevision,
  );
  return { boundary, exited, committed };
}

export function assertLocatedDiagnostic(result, { file, line, column, code }) {
  assert.equal(result.documentKind, 'pandamstyle-diagnostics-result');
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.ok, false);
  const diagnostic = result.diagnostics.find(
    (value) => value.code === code && value.source?.file === file,
  );
  assert(diagnostic, 'Expected original-source diagnostic was not observed');
  assert.equal(diagnostic.source.line, line);
  assert.equal(diagnostic.source.column, column);
  assert.deepEqual(diagnostic.revision, result.revision);
  return diagnostic;
}

export class MatrixRun {
  constructor(output, label, root) {
    this.output = path.resolve(output);
    this.root = root;
    this.environment = {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: '1',
      CI: '1',
    };
    delete this.environment.NODE_PATH;
    delete this.environment.PMS_NEXT_COORDINATOR_FILE;
    this.processes = new Set();
    this.report = {
      scope: 'pandamstyle-packed-next-semantic-dev',
      label,
      root,
      node: process.version,
      osRelease: os.release(),
      osVersion: os.version(),
      startedAt: new Date().toISOString(),
      inputMutations: [],
      commands: [],
      rows: QUALIFICATION_MATRIX.map((row) => ({ ...row, status: 'NOT RUN' })),
      production: [],
      pass: false,
    };
  }

  async initialize() {
    await fs.mkdir(this.output, { recursive: true });
    await fs.mkdir(this.root, { recursive: true });
    await this.save();
  }

  async save() {
    await fs.writeFile(
      path.join(this.output, 'report.json'),
      JSON.stringify(this.report, null, 2) + '\n',
    );
  }

  async archiveBytes(bytes) {
    const digest = sha256(bytes);
    await fs.mkdir(path.join(this.output, 'input-bytes'), { recursive: true });
    await fs.writeFile(path.join(this.output, 'input-bytes', digest), bytes);
    return {
      sha256: digest,
      evidence: 'input-bytes/' + digest,
      bytes: Buffer.byteLength(bytes),
    };
  }

  async write(file, bytes, { atomic = false } = {}) {
    const target = path.join(this.root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const operationStartedAt = Date.now();
    if (atomic) {
      const temporary = target + '.' + randomUUID() + '.tmp';
      await fs.writeFile(temporary, bytes);
      await fs.rename(temporary, target);
    } else await fs.writeFile(target, bytes);
    const writtenAt = Date.now();
    const evidence = await this.archiveBytes(bytes);
    this.report.inputMutations.push({
      operation: 'write',
      file,
      ...evidence,
      operationStartedAt,
      writtenAt,
      observedAt: Date.now(),
      at: Date.now(),
    });
    return evidence;
  }

  async remove(file) {
    const previous = await this.archiveBytes(
      await fs.readFile(path.join(this.root, file)),
    );
    const operationStartedAt = Date.now();
    await fs.rm(path.join(this.root, file));
    const writtenAt = Date.now();
    this.report.inputMutations.push({
      operation: 'remove',
      file,
      previous,
      operationStartedAt,
      writtenAt,
      at: Date.now(),
    });
  }

  async rename(from, to) {
    await fs.mkdir(path.dirname(path.join(this.root, to)), { recursive: true });
    const content = await this.archiveBytes(
      await fs.readFile(path.join(this.root, from)),
    );
    const operationStartedAt = Date.now();
    await fs.rename(path.join(this.root, from), path.join(this.root, to));
    const writtenAt = Date.now();
    this.report.inputMutations.push({
      operation: 'rename',
      from,
      to,
      ...content,
      operationStartedAt,
      writtenAt,
      at: Date.now(),
    });
  }

  async recordExternalWrite(file, details) {
    const content = await this.archiveBytes(
      await fs.readFile(path.join(this.root, file)),
    );
    const record = {
      operation: 'external-write',
      file,
      ...content,
      details,
      observedAt: Date.now(),
    };
    this.report.inputMutations.push(record);
    return record;
  }

  start(command, args, label, { cwd = this.root, environment = {} } = {}) {
    const child = spawn(command, args, {
      cwd,
      env: { ...this.environment, ...environment },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const started = performance.now();
    const observation = {
      label,
      command: [command, ...args],
      cwd,
      pid: child.pid,
      startedAt: new Date().toISOString(),
      log: label + '.log',
    };
    this.report.commands.push(observation);
    let text = '';
    let writes = Promise.resolve();
    const logFile = fs.open(path.join(this.output, observation.log), 'w');
    const append = (bytes) => {
      text += bytes;
      if (
        observation.nextReadyObservedAt == null &&
        /Ready in [0-9]+ms/.test(text)
      )
        observation.nextReadyObservedAt = Date.now();
      writes = writes.then(async () => (await logFile).write(bytes));
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', async (code, signal) => {
        await writes;
        await (await logFile).close();
        Object.assign(observation, {
          code,
          signal,
          elapsedMs: performance.now() - started,
        });
        this.processes.delete(handle);
        resolve({ code, signal, text, ...observation });
      });
    });
    const handle = { child, closed, observation, text: () => text };
    this.processes.add(handle);
    return handle;
  }

  async run(command, args, label, options = {}) {
    const handle = this.start(command, args, label, options);
    const timeoutMs = options.timeoutMs ?? 240000;
    let timer;
    try {
      return await Promise.race([
        handle.closed,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            try {
              process.kill(-handle.child.pid, 'SIGKILL');
            } catch (error) {
              if (error.code !== 'ESRCH') {
                reject(error);
                return;
              }
            }
            reject(new Error(`Command failed to finish: ${label}`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async stop(handle, signal = 'SIGTERM') {
    if (
      handle == null ||
      handle.child.pid == null ||
      handle.child.exitCode !== null ||
      handle.child.signalCode !== null
    )
      return;
    try {
      process.kill(-handle.child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    let timer;
    try {
      await Promise.race([
        handle.closed,
        new Promise((resolve) => {
          timer = setTimeout(() => {
            try {
              process.kill(-handle.child.pid, 'SIGKILL');
            } catch (error) {
              if (error.code !== 'ESRCH') throw error;
            }
            resolve();
          }, 10000);
        }),
      ]);
      await handle.closed;
    } finally {
      clearTimeout(timer);
    }
  }

  async row(id, operation) {
    const row = this.report.rows.find((value) => value.id === id);
    assert(
      row && row.status === 'NOT RUN',
      `Unknown or duplicate matrix row: ${id}`,
    );
    const started = performance.now();
    row.startedAt = Date.now();
    const mutationStart = this.report.inputMutations.length;
    try {
      row.observations = await operation();
      assert(row.observations != null, `${id} has no empirical observations`);
      row.status = 'PASS';
    } catch (error) {
      row.status = 'FAIL';
      row.error = {
        code: error.code,
        message: error.message,
        stack: error.stack,
        details: error.details,
      };
    }
    row.elapsedMs = performance.now() - started;
    row.finishedAt = Date.now();
    row.mutations = this.report.inputMutations.slice(mutationStart);
    process.stdout.write(`${this.report.label} ${id} ${row.status}\n`);
    await this.save();
    return row;
  }

  async captureSources() {
    const manifest = [];
    const capture = async (logicalFile) => {
      const bytes = await fs.readFile(path.join(this.root, logicalFile));
      const physicalFile = 'fixture-source/' + logicalFile + '.txt';
      await fs.mkdir(path.dirname(path.join(this.output, physicalFile)), {
        recursive: true,
      });
      await fs.writeFile(path.join(this.output, physicalFile), bytes);
      manifest.push({
        logicalFile,
        evidence: physicalFile,
        sha256: sha256(bytes),
        bytes: bytes.length,
      });
    };
    for (const file of [
      'package.json',
      'next.config.mjs',
      'definition.mjs',
      'package-lock.json',
      'host-events.jsonl',
    ]) {
      await capture(file).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    for (const directory of ['app', 'semantic', '.next/static']) {
      const inventory = await fileInventory(this.root + '/' + directory).catch(
        (error) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        },
      );
      for (const member of inventory)
        await capture(directory + '/' + member.file);
    }
    await fs.writeFile(
      path.join(this.output, 'source-manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
    );
    const hostRoot = path.join(this.root, '.pandamstyle-next-host');
    for (const member of await fileInventory(hostRoot)) {
      if (!member.file.endsWith('/events.jsonl')) continue;
      const bytes = await fs.readFile(path.join(hostRoot, member.file));
      const destination = path.join(
        this.output,
        'coordinator-events',
        member.file,
      );
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, bytes);
    }
    return manifest;
  }

  async close() {
    for (const handle of [...this.processes]) await this.stop(handle);
    await this.captureSources();
    this.report.finishedAt = new Date().toISOString();
    this.report.pass =
      this.report.rows.every((row) => row.status === 'PASS') &&
      this.report.production.length > 0 &&
      this.report.production.every((row) => row.pass);
    await this.save();
  }
}

export class BrowserProbe {
  constructor(run, origin) {
    this.run = run;
    this.origin = origin;
    this.events = [];
    this.stylesheets = new Map();
    this.pendingCSS = new Set();
    this.captureClosed = new Promise((resolve) => {
      this.finishCaptures = resolve;
    });
    this.automationRetries = [];
    this.sessionId = randomUUID();
    this.browserProfile = null;
    this.browserProfileReport = null;
  }

  async launch() {
    const require = createRequire(path.join(this.run.root, 'package.json'));
    const puppeteer = await import(
      pathToFileURL(require.resolve('puppeteer-core')).href
    );
    this.browserProfile = await createNextBrowserProfile(
      this.run.output,
      this.sessionId,
    );
    this.browserProfileReport = {
      runId: this.browserProfile.runId,
      userDataDir: this.browserProfile.userDataDir,
      launchAttempted: true,
      browserProcess: { pid: null, status: 'launching' },
      cleanup: { browserClosed: null, userDataDirRemoved: null },
    };
    try {
      this.browser = await launchWithNextBrowserProfile(
        puppeteer.default,
        this.browserProfile,
        {
          executablePath:
            process.env.PMS_NEXT_CHROMIUM ??
            process.env.PMS_CHROMIUM ??
            '/usr/local/bin/chromium',
          protocolTimeout: 60_000,
          args: ['--no-sandbox', '--disable-dev-shm-usage'],
        },
      );
      this.browserProfileReport.browserProcess = {
        pid: this.browser.process()?.pid ?? null,
        status: 'running',
      };
      this.browser.once('disconnected', () => this.finishCaptures());
      this.run.report.browser = {
        version: await this.browser.version(),
        executable:
          process.env.PMS_NEXT_CHROMIUM ??
          process.env.PMS_CHROMIUM ??
          '/usr/local/bin/chromium',
      };
      this.page = await this.newPage();
      this.run.report.firstBrowserConsumptionStartedAt ??= Date.now();
      await this.navigate(this.origin);
      return this.page;
    } catch (error) {
      this.browserProfileReport.browserProcess.status = this.browser
        ? 'initialization-failed'
        : 'launch-failed';
      this.browserProfileReport.launchError = error.message;
      throw error;
    }
  }

  async newPage() {
    const page = await this.browser.newPage();
    await page.evaluateOnNewDocument(() => {
      window.__pmsQualificationBoot = crypto.randomUUID();
    });
    page.on('pageerror', (error) =>
      this.events.push({
        type: 'pageerror',
        at: Date.now(),
        message:
          typeof error?.message === 'string' ? error.message : String(error),
        thrownValueType: error === null ? 'null' : typeof error,
        url: page.url(),
      }),
    );
    page.on('console', (message) => {
      if (message.type() === 'error')
        this.events.push({
          type: 'console-error',
          at: Date.now(),
          message: message.text(),
          url: page.url(),
        });
    });
    page.on('requestfailed', (request) => {
      if (request.resourceType() !== 'stylesheet') return;
      this.events.push({
        type: 'css-request-failed',
        at: Date.now(),
        message: request.failure()?.errorText ?? 'Stylesheet request failed',
        url: request.url(),
      });
    });
    page.on('requestfinished', (request) => {
      if (request.resourceType() !== 'stylesheet') return;
      const response = request.response();
      if (response == null) return;
      const operation = Promise.race([
        response.text(),
        this.captureClosed.then(() => {
          throw new Error(
            'Browser disconnected before stylesheet body capture completed',
          );
        }),
      ])
        .then(async (text) => {
          const digest = sha256(text);
          const evidence = 'css-resource-' + digest + '.css';
          await fs.writeFile(path.join(this.run.output, evidence), text);
          this.stylesheets.set(response.url(), {
            url: response.url(),
            status: response.status(),
            sha256: digest,
            bytes: Buffer.byteLength(text),
            evidence,
          });
        })
        .catch((error) =>
          this.events.push({
            type: 'css-capture-error',
            at: Date.now(),
            message: error.message,
            url: response.url(),
          }),
        )
        .finally(() => this.pendingCSS.delete(operation));
      this.pendingCSS.add(operation);
    });
    return page;
  }

  async observe(selector = '#server-style', page = this.page) {
    return page.evaluate((target) => {
      const node = document.querySelector(target);
      if (node == null) return null;
      const style = getComputedStyle(node);
      const rootStyle = getComputedStyle(document.documentElement);
      return {
        observedAt: Date.now(),
        selector: target,
        text: node.textContent,
        className: node.className,
        color: style.color,
        background: style.backgroundColor,
        padding: style.paddingTop,
        margin: style.marginTop,
        opacity: style.opacity,
        borderTopWidth: style.borderTopWidth,
        borderTopColor: style.borderTopColor,
        boot: window.__pmsQualificationBoot,
        dataset: { ...node.dataset },
        href: location.href,
        cssVariables: Object.fromEntries(
          [...rootStyle]
            .filter((key) => key.startsWith('--'))
            .map((key) => [key, rootStyle.getPropertyValue(key).trim()]),
        ),
        stylesheets: [...document.styleSheets].map((sheet) => sheet.href),
      };
    }, selector);
  }

  async expect(expected, selector = '#server-style', page = this.page) {
    let lastObserved;
    try {
      return await until(
        async () => {
          const seen = await this.observe(selector, page);
          lastObserved = seen;
          return seen != null &&
            Object.entries(expected).every(([key, value]) =>
              typeof value === 'string' && key === 'text'
                ? seen.text.includes(value)
                : seen[key] === value,
            )
            ? seen
            : false;
        },
        `browser ${selector} ${JSON.stringify(expected)}`,
      );
    } catch (error) {
      const document = await page.evaluate(() => ({
        href: location.href,
        readyState: document.readyState,
        bodyText: document.body?.innerText.slice(0, 1500),
        boot: window.__pmsQualificationBoot,
      }));
      error.details = {
        expected,
        selector,
        lastObserved,
        document,
        observedAt: Date.now(),
      };
      this.run.report.browserMismatches ??= [];
      this.run.report.browserMismatches.push(error.details);
      throw error;
    }
  }

  async click(selector, page = this.page) {
    await page.bringToFront();
    await page.waitForFunction(
      () =>
        document.querySelector('#counter') == null ||
        document.documentElement.dataset.pmsQualificationHydrated === 'true',
    );
    await page.click(selector);
  }

  async expectBoundSnapshot(
    descriptor,
    expected,
    selector = '#server-style',
    page = this.page,
  ) {
    await this.expect(expected, selector, page);
    return until(async () => {
      const observation = await this.observe(selector, page);
      const matches =
        observation != null &&
        Object.entries(expected).every(([key, value]) =>
          key === 'text' && typeof value === 'string'
            ? observation.text.includes(value)
            : observation[key] === value,
        );
      return matches &&
        observation.stylesheets.some(
          (url) =>
            typeof url === 'string' && url.includes(descriptor.snapshotId),
        )
        ? observation
        : false;
    }, 'actual browser stylesheet for exact accepted snapshot ' + descriptor.snapshotId);
  }

  async reloadHealthy(route = '/', page = this.page) {
    const url = new URL(route, this.origin).href;
    await until(async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      return response.status === 200;
    }, `HTTP 200 before intentional reload ${route}`);
    return this.navigate(url, page, { reload: page.url() === url });
  }

  async navigate(url, page = this.page, { reload = false } = {}) {
    await page.bringToFront();
    for (let attempt = 0; attempt < 4; attempt++) {
      const operation = attempt === 0 && reload ? 'reload' : 'goto';
      try {
        if (operation === 'reload')
          await page.reload({ waitUntil: 'domcontentloaded' });
        else await page.goto(url, { waitUntil: 'domcontentloaded' });
        return;
      } catch (error) {
        if (
          attempt === 3 ||
          !/Not attached to an active page|net::ERR_ABORTED|Navigating frame was detached/.test(
            error.message,
          )
        )
          throw error;
        this.automationRetries.push({
          at: Date.now(),
          operation,
          url,
          error: error.message,
          retry:
            'public page.goto same URL after concurrent document navigation',
        });
      }
    }
  }

  async overlayText(page = this.page) {
    return page.evaluate(() => {
      const texts = [];
      const visit = (root) => {
        for (const portal of root.querySelectorAll('nextjs-portal')) {
          if (portal.shadowRoot) {
            texts.push(portal.shadowRoot.textContent);
            visit(portal.shadowRoot);
          }
        }
      };
      visit(document);
      return texts.join('\n');
    });
  }

  async close() {
    let closeError;
    let browserClosed = null;
    try {
      if (this.browser != null) {
        await this.browser.close();
        browserClosed = true;
        if (this.browserProfileReport)
          this.browserProfileReport.browserProcess.status = 'closed';
      }
    } catch (error) {
      browserClosed = false;
      closeError = error;
      if (this.browserProfileReport) {
        this.browserProfileReport.browserProcess.status = 'close-failed';
        this.browserProfileReport.closeError = error.message;
      }
    }
    this.finishCaptures();
    await Promise.allSettled([...this.pendingCSS]);
    let userDataDirRemoved = null;
    try {
      if (this.browserProfile != null) {
        const cleanup = await this.browserProfile.cleanup();
        userDataDirRemoved = cleanup.userDataDirRemoved;
      }
    } catch (error) {
      closeError ??= error;
      if (this.browserProfileReport)
        this.browserProfileReport.profileCleanupError = error.message;
    }
    if (this.browserProfileReport) {
      this.browserProfileReport.cleanup = {
        browserClosed,
        userDataDirRemoved,
      };
    }
    this.run.report.browserSessions ??= [];
    this.run.report.browserSessions.push({
      sessionId: this.sessionId,
      origin: this.origin,
      browserProfile: this.browserProfileReport,
      events: this.events,
      cssResources: [...this.stylesheets.values()],
      automationRetries: this.automationRetries,
    });
    this.run.report.browserEvents = this.run.report.browserSessions.flatMap(
      (session) => session.events,
    );
    this.run.report.cssResources = this.run.report.browserSessions.flatMap(
      (session) => session.cssResources,
    );
    this.run.report.browserAutomationRetries =
      this.run.report.browserSessions.flatMap(
        (session) => session.automationRetries,
      );
    if (closeError) throw closeError;
  }
}

export function fixtureDefinition({
  padding = '16px',
  color = '#112233',
  background = '#fefefe',
  systemId = 'semantic-dev-ui',
} = {}) {
  return {
    systemId,
    tokens: {
      spacing: {
        sm: { value: '8px', visibility: 'public' },
        md: { value: padding, visibility: 'public' },
        added31: { value: '31px', visibility: 'public' },
        shared13: { value: '13px', visibility: 'public' },
        external17: { value: '17px', visibility: 'public' },
      },
      colors: {
        ink: { value: color, visibility: 'private' },
        paper: { value: background, visibility: 'private' },
        text: { ref: 'colors.ink', visibility: 'public' },
        surface: { ref: 'colors.paper', visibility: 'public' },
      },
    },
    themes: {
      light: { tokens: {} },
      dark: {
        tokens: {
          colors: {
            text: { value: '#ffffff' },
            surface: { value: '#112233' },
          },
        },
      },
    },
    recipes: {
      button: {
        base: { display: 'inline-flex', color: { $token: 'colors.text' } },
        variants: {
          tone: {
            quiet: { opacity: 0.5 },
            loud: { opacity: 1 },
          },
        },
        defaultVariants: { tone: 'quiet' },
      },
    },
  };
}

export function definitionSource(definition) {
  return `import { token } from '@pandamstyle/compiler/config';
const raw = ${JSON.stringify(definition, null, 2)};
const refs = value => Array.isArray(value) ? value.map(refs) : value && typeof value === 'object'
  ? Object.keys(value).length === 1 && typeof value.$token === 'string' ? token(value.$token)
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, refs(item)])) : value;
export default refs(raw);
`;
}

export function serverSource({
  opacity = 0.61,
  label = 'server-initial',
  padding = "token('spacing.md')",
  extra = '',
} = {}) {
  return `import { create, token, props } from '../.pandamstyle/design.js';
import Shared from './Broker.jsx';
export * from '../.pandamstyle/design.js';
const styles = create({ panel: { display: 'block', padding: ${padding}, color: token('colors.text'), backgroundColor: token('colors.surface'), opacity: ${opacity} } });
${extra}
export default function Server() { return <section><p id="server-style" {...props(styles.panel)}>${label}</p><Shared id="shared-server" /></section>; }
`;
}

export function sharedSource({
  margin = "token('spacing.sm')",
  label = '',
} = {}) {
  return `import { create, token, props } from '../.pandamstyle/design.js';
const sharedStyles = create({ shared: { display: 'block', margin: ${margin}, color: token('colors.text') } });
export default function Shared({ id }) { return <p id={id} {...props(sharedStyles.shared)}>shared component</p>; }
${label}
`;
}

export function clientSource({
  opacity = 0.73,
  label = 'client-initial',
  extra = '',
} = {}) {
  return `'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { create, props, recipes, token } from '../.pandamstyle/design.js';
import Shared from './Shared.jsx';
const styles = create({ panel: { padding: token('spacing.md'), backgroundColor: token('colors.surface'), opacity: ${opacity} } });
${extra}
export default function Client() {
  useEffect(() => { document.documentElement.dataset.pmsQualificationHydrated = 'true'; return () => { delete document.documentElement.dataset.pmsQualificationHydrated; }; }, []);
  const [count, setCount] = useState(0);
  const [tone, setTone] = useState('quiet');
  const [Dynamic, setDynamic] = useState(null);
  return <section><button id="counter" {...props(styles.panel)} onClick={() => setCount(count + 1)}>${label} {count}</button>
    <button id="client-recipe" {...props(recipes.button({ tone }))} onClick={() => setTone(tone === 'quiet' ? 'loud' : 'quiet')}>recipe {tone}</button>
    <Shared id="shared-client" />
    <button id="show-dynamic" onClick={async () => { const loaded = await import('./Dynamic.jsx'); setDynamic(() => loaded.default); }}>show dynamic</button>{Dynamic && <Dynamic />}
    <Link id="lazy-link" href="/lazy" prefetch={false}>lazy route</Link>
    <Link id="empty-link" href="/empty" prefetch={false}>empty route</Link></section>;
}
`;
}

export function lazySource({ label = 'lazy-initial', opacity = 0.84 } = {}) {
  return `import { create, token, props } from '../.pandamstyle/design.js';
export * from '../.pandamstyle/design.js';
const styles = create({ lazy: { color: token('colors.text'), padding: token('spacing.md'), opacity: ${opacity} } });
export default function Lazy() { return <p id="lazy-style" {...props(styles.lazy)}>${label}</p>; }
`;
}

export async function writeFixture(run, definition = fixtureDefinition()) {
  try {
    await fs.access(path.join(run.root, 'package.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await run.write(
      'package.json',
      JSON.stringify({ private: true, type: 'module' }) + '\n',
    );
  }
  await run.write('definition.mjs', definitionSource(definition));
  await run.write(
    'semantic/RootShell.jsx',
    `import { props, themes } from '../.pandamstyle/design.js';
export default function RootShell({ children }) { return <html lang="en" {...props(themes.light)}><body>{children}</body></html>; }
`,
  );
  await run.write('semantic/Server.jsx', serverSource());
  await run.write('semantic/Client.jsx', clientSource());
  await run.write('semantic/Shared.jsx', sharedSource());
  await run.write(
    'semantic/Broker.jsx',
    "export { default } from './Shared.jsx';\n",
  );
  await run.write('semantic/Lazy.jsx', lazySource());
  await run.write(
    'semantic/Dynamic.jsx',
    `'use client';
import { create, props, token } from '../.pandamstyle/design.js';
export * from '../.pandamstyle/design.js';
const styles = create({ dynamic: { color: token('colors.text'), padding: token('spacing.md'), opacity: 0.93 } });
export default function Dynamic() { return <p id="dynamic-style" {...props(styles.dynamic)}>dynamic component</p>; }
`,
  );
  await run.write(
    'app/layout.jsx',
    `import RootShell from '../semantic/RootShell.jsx';
export default function Layout({ children }) { return <RootShell>{children}</RootShell>; }
`,
  );
  await run.write(
    'app/page.jsx',
    `import Server from '../semantic/Server.jsx';
import Client from '../semantic/Client.jsx';
export default function Page() { return <main><h1 id="next-only">next-initial</h1><Server /><Client /></main>; }
`,
  );
  await run.write(
    'app/lazy/page.jsx',
    `import Lazy from '../../semantic/Lazy.jsx';
export default function Page() { return <main><Lazy /></main>; }
`,
  );
  await run.write(
    'app/empty/page.jsx',
    `export default function Empty() { return <p id="empty-route">empty route</p>; }
`,
  );
  await run.write(
    'app/error.jsx',
    `'use client';
export default function Boundary({ reset }) { return <button id="error-boundary" onClick={reset}>controlled error boundary</button>; }
`,
  );
  await run.write(
    'app/not-found.jsx',
    `export default function Missing() { return <p id="not-found-route">controlled not found</p>; }
`,
  );
}

/** Inspect actual installed packages and executable browser bundles. */
export async function auditClosure(root, { secrets = [] } = {}) {
  const packages = {};
  for (const slug of ['core', 'compiler', 'vite', 'next']) {
    const installed = await fs.realpath(
      path.join(root, 'node_modules/@pandamstyle', slug),
    );
    assert(
      installed.startsWith(root + path.sep),
      `Package escaped consumer: ${slug}`,
    );
    const metadata = await readJSON(path.join(installed, 'package.json'));
    packages[metadata.name] = {
      version: metadata.version,
      realpath: installed,
      dependencies: metadata.dependencies ?? {},
      exports: metadata.exports,
    };
    assert((await fs.readFile(path.join(installed, 'LICENSE'))).length > 0);
    assert(
      (await fs.readFile(path.join(installed, 'ATTRIBUTIONS.md'))).length > 0,
    );
  }
  const require = createRequire(
    path.join(root, 'node_modules/@pandamstyle/compiler/package.json'),
  );
  // This is a public third-party parser dependency, never a private compiler module.
  const { parse } = require('@babel/parser');
  const leakage = [];
  const secretMatches = [];
  const files = [];
  const forbidden =
    /@pandamstyle\/(?:compiler|vite|next|rsbuild)(?:\/|$)|@babel\/|@stylexjs\/|@pandacss\//;
  const scan = (code, file, depth = 0) => {
    assert(depth < 8, 'Unexpected nested executable eval');
    const ast = parse(code, { sourceType: 'unambiguous' });
    const visit = (node) => {
      if (node == null || typeof node !== 'object') return;
      if (
        node.type === 'Identifier' &&
        [
          'createProjectSession',
          'pinAcceptedSnapshot',
          'preparePublication',
          'commitPrepared',
          'createCoordinator',
          'finishSuccessfulProduction',
        ].includes(node.name)
      )
        leakage.push({ file, identifier: node.name });
      if (
        [
          'ImportDeclaration',
          'ExportNamedDeclaration',
          'ExportAllDeclaration',
          'ImportExpression',
        ].includes(node.type) &&
        typeof node.source?.value === 'string' &&
        (forbidden.test(node.source.value) || isBuiltin(node.source.value))
      )
        leakage.push({ file, import: node.source.value });
      if (
        node.type === 'ObjectProperty' &&
        typeof node.key?.value === 'string' &&
        node.key.value.includes('/node_modules/') &&
        forbidden.test(node.key.value)
      )
        leakage.push({ file, runtimeModule: node.key.value });
      if (node.type === 'CallExpression') {
        const name =
          node.callee.type === 'Identifier'
            ? node.callee.name
            : node.callee.type === 'MemberExpression'
              ? node.callee.property.name
              : null;
        if (name === 'eval' && node.arguments[0]?.type === 'StringLiteral')
          scan(node.arguments[0].value, file, depth + 1);
        const argument = node.arguments[0]?.value;
        if (
          ['require', '__webpack_require__', 'r', 'i'].includes(name) &&
          typeof argument === 'string' &&
          (forbidden.test(argument) || isBuiltin(argument))
        )
          leakage.push({ file, runtimeImport: argument });
      }
      for (const [key, value] of Object.entries(node)) {
        if (
          [
            'comments',
            'leadingComments',
            'trailingComments',
            'innerComments',
            'loc',
            'extra',
          ].includes(key)
        )
          continue;
        if (Array.isArray(value)) value.forEach(visit);
        else if (value != null && typeof value === 'object') visit(value);
      }
    };
    visit(ast.program);
  };
  for (const directory of ['.next/static', '.next/dev/static']) {
    let inventory;
    try {
      inventory = await fileInventory(path.join(root, directory));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const member of inventory.filter((value) =>
      /\.js$/.test(value.file),
    )) {
      const file = directory + '/' + member.file;
      const code = await fs.readFile(path.join(root, file), 'utf8');
      scan(code, file);
      // Never serialize credentials, including in assertion error output.
      const count = secrets.filter(
        (secret) =>
          typeof secret === 'string' &&
          secret.length > 8 &&
          code.includes(secret),
      ).length;
      if (count > 0) secretMatches.push({ file, count });
      files.push({ file, sha256: member.sha256, bytes: member.bytes });
    }
  }
  assert(files.length > 0, 'No executable browser bundles were inspected');
  assert.deepEqual(leakage, []);
  assert.deepEqual(secretMatches, []);
  return {
    packages,
    files,
    leakage,
    secretMatches,
    method:
      'Executable AST, nested eval bodies, import/require/module resources and exact secret absence; diagnostic strings and comments have no import authority.',
  };
}

export function nextConfigSource({ retention = null } = {}) {
  return `import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { withPandamStyle } from '@pandamstyle/next';
const root = process.cwd();
const log = event => fs.appendFileSync(path.join(root, 'host-events.jsonl'), JSON.stringify({ ...event, observedAt: Date.now(), observerPid: process.pid }) + '\\n');
const observe = event => {
  log(event);
  if (event.type === 'semantic-prepared') {
    const arm = path.join(root, '.qualification', 'prepared-race.json');
    if (fs.existsSync(arm)) {
      const claim = arm + '.claimed-' + process.pid;
      try {
        const pending = JSON.parse(fs.readFileSync(arm, 'utf8'));
        if (event.ticket.revision.revisionId <= (pending.afterRevisionId ?? -1)) return;
        fs.renameSync(arm, claim);
        const mutation = JSON.parse(fs.readFileSync(claim, 'utf8'));
        for (const input of mutation.additionalWrites ?? []) fs.writeFileSync(path.join(root, input.file), input.source);
        fs.writeFileSync(path.join(root, mutation.file), mutation.source);
        log({ type: 'fixture-prepared-race-write', owner: 'fixture-observer', ticketId: event.ticket.ticketId,
          preparedRevision: event.ticket.revision, file: mutation.file,
          sourceDigest: createHash('sha256').update(mutation.source).digest('hex'),
          additionalWrites: (mutation.additionalWrites ?? []).map(input => ({ file: input.file, sourceDigest: createHash('sha256').update(input.source).digest('hex') })) });
      } catch (error) { if (error.code !== 'ENOENT') log({ type: 'fixture-race-observer-error', message: error.message }); }
    }
  }
  if (event.type === 'framework-build-complete' && process.env.PMS_QUALIFICATION_EXIT_AFTER_BOUNDARY === '1') {
    log({ type: 'fixture-process-failure-after-public-boundary', exitCode: 89 });
    process.exit(89);
  }
};
const wrapped = withPandamStyle({ backend: 'turbopack', publicationMode: process.env.PMS_QUALIFICATION_MODE ?? 'semantic-dev',
  definition: './definition.mjs', roots: ['semantic'], outDir: './.pandamstyle',
  ${retention ? 'acceptedSnapshotRetention: ' + JSON.stringify(retention) + ',' : ''}
  onEvent: observe, onDiagnostics: result => log({ type: 'fixture-diagnostics-observed', result }) })({
    experimental: { cpus: 2 }, images: { unoptimized: true }, reactCompiler: false,
    async headers() { return [{ source: '/:path*', headers: [{ key: 'x-semantic-config-composed', value: 'yes' }] }]; }
  });
export default async (phase, context) => {
  const config = await wrapped(phase, context);
  const options = config.turbopack?.rules?.['*.jsx']?.loaders?.[0]?.options;
  if (options) fs.writeFileSync(path.join(root, 'observed-loader-options.json'), JSON.stringify(options) + '\\n');
  return config;
};
`;
}

export const PUBLIC_LOADER_DRIVER = `import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const loader = require('@pandamstyle/next/turbopack-loader');
const [optionsFile, sourceFile, resourcePath, resultFile, mapFile] = process.argv.slice(2);
const options = JSON.parse(await fs.readFile(optionsFile, 'utf8'));
const source = await fs.readFile(sourceFile, 'utf8');
const inputMap = mapFile ? JSON.parse(await fs.readFile(mapFile, 'utf8')) : null;
const dependencies = [], contexts = [];
const result = await new Promise(resolve => loader.call({ resourcePath,
  getOptions() { return options; }, addDependency(file) { dependencies.push(file); },
  addContextDependency(file) { contexts.push(file); }, async() { return (error, javascript, sourceMap) => resolve(error
    ? { ok: false, error: { code: error.code, message: error.message, diagnostics: error.diagnostics ?? [] }, dependencies, contexts }
    : { ok: true, javascript, sourceMap: sourceMap ?? null, dependencies, contexts }); }
}, source, inputMap));
await fs.writeFile(resultFile, JSON.stringify({ ...result, workerPid: process.pid, node: process.version, finishedAt: Date.now() }) + '\\n');
`;

export const DURABLE_PREPARED_OBSERVER = `import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const [eventsFile, root, readyFile] = process.argv.slice(2);
const digest = source => createHash('sha256').update(source).digest('hex');
const readEvents = () => {const text = fs.readFileSync(eventsFile, 'utf8'); return text.slice(0, text.lastIndexOf('\\n') + 1).split('\\n').filter(Boolean).map(line => JSON.parse(line));};
let sequence = readEvents().at(-1)?.sequence ?? 0;
const observe = () => {
  for (const event of readEvents().filter(item => item.sequence > sequence)) {
    sequence = event.sequence;
    if (event.type !== 'semantic-prepared') continue;
    const arm = path.join(root, '.qualification/prepared-race.json');
    try {
      const mutation = JSON.parse(fs.readFileSync(arm, 'utf8'));
      if (event.ticket.revision.revisionId <= (mutation.afterRevisionId ?? -1)) continue;
      fs.renameSync(arm, arm + '.claimed-durable-' + process.pid);
      for (const input of mutation.additionalWrites ?? []) fs.writeFileSync(path.join(root, input.file), input.source);
      fs.writeFileSync(path.join(root, mutation.file), mutation.source);
      fs.appendFileSync(path.join(root, 'host-events.jsonl'), JSON.stringify({type: 'fixture-prepared-race-write',
        owner: 'fixture-durable-event-observer', observerPid: process.pid, observedAt: Date.now(),
        ticketId: event.ticket.ticketId, preparedRevision: event.ticket.revision,
        file: mutation.file, sourceDigest: digest(mutation.source),
        additionalWrites: (mutation.additionalWrites ?? []).map(input => ({file: input.file, sourceDigest: digest(input.source)}))}) + '\\n');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
};
fs.watch(eventsFile, observe);
fs.writeFileSync(readyFile, JSON.stringify({observerPid: process.pid, readyObservedAt: Date.now(), eventsFile}) + '\\n');
`;

export async function packedInstall(run, tarballs) {
  const installed = await run.run(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      ...tarballs,
      'next@16.3.8',
      'react@19.2.8',
      'react-dom@19.2.8',
      'puppeteer-core@25.9.0',
      'node24-semantic@npm:node@24.21.0',
    ],
    'install',
  );
  assert.equal(installed.code, 0, installed.text);
  const lock = await fs.readFile(path.join(run.root, 'package-lock.json'));
  await fs.writeFile(path.join(run.output, 'package-lock.json'), lock);
  run.report.installLockSha256 = sha256(lock);
  for (const name of [
    'next',
    'react',
    'react-dom',
    'puppeteer-core',
    'node24-semantic',
  ]) {
    const metadata = await readJSON(
      path.join(run.root, 'node_modules', name, 'package.json'),
    );
    run.report.dependencies ??= {};
    run.report.dependencies[name] = metadata.version;
  }
  assert.equal(run.report.dependencies.next, '16.3.8');
  assert.equal(run.report.dependencies.react, '19.2.8');
  assert.equal(run.report.dependencies['react-dom'], '19.2.8');
  for (const slug of ['core', 'compiler', 'vite', 'next']) {
    const realpath = await fs.realpath(
      path.join(run.root, 'node_modules/@pandamstyle', slug),
    );
    assert(realpath.startsWith(run.root + path.sep));
  }
}

export class DevLane {
  constructor(run, runtime) {
    this.run = run;
    this.runtime = runtime;
    this.calls = 0;
    this.starts = 0;
  }

  async initialize() {
    const metadata = await readJSON(
      path.join(this.run.root, 'node_modules/@pandamstyle/next/package.json'),
    );
    this.cli = path.resolve(
      this.run.root,
      'node_modules/@pandamstyle/next',
      metadata.bin['pandamstyle-next'],
    );
    const next = await readJSON(
      path.join(this.run.root, 'node_modules/next/package.json'),
    );
    this.nextCLI = path.resolve(
      this.run.root,
      'node_modules/next',
      next.bin.next,
    );
    const version = await this.run.run(
      this.runtime,
      ['--version'],
      'selected-runtime',
    );
    assert.equal(version.code, 0);
    this.run.report.runtimeNode = version.text.trim();
    this.run.report.orchestratorNode = process.version;
    await this.run.write(
      '.qualification/public-loader-driver.mjs',
      PUBLIC_LOADER_DRIVER,
    );
    this.port = await unusedPort();
    this.origin = 'http://127.0.0.1:' + this.port;
  }

  async start(label = 'dev') {
    assert(this.server == null, 'A dev owner is already running');
    const previousSessionId = this.options?.sessionId;
    this.server = this.run.start(
      this.runtime,
      [
        this.cli,
        'dev',
        '--turbopack',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(this.port),
      ],
      label,
      { environment: { PMS_QUALIFICATION_MODE: 'semantic-dev' } },
    );
    this.run.report.devLaunches ??= [];
    this.run.report.devLaunches.push({
      label,
      cacheRetained: this.starts++ > 0,
      pid: this.server.child.pid,
      at: Date.now(),
    });
    await until(
      async () => {
        assert(
          this.server.child.exitCode === null,
          'Supervised dev exited: ' + this.server.text().slice(-3000),
        );
        const options = await readJSON(
          path.join(this.run.root, 'observed-loader-options.json'),
        );
        const status = await readJSON(options.statusFile);
        if (
          status.state !== 'ready' ||
          status.sessionId !== options.sessionId ||
          options.sessionId === previousSessionId
        )
          return false;
        const response = await fetch(this.origin, {
          signal: AbortSignal.timeout(3000),
        });
        if (response.status !== 200) return false;
        this.run.report.devLaunches.at(-1).httpReadyObservedAt = Date.now();
        this.run.report.devLaunches.at(-1).nextReadyObservedAt =
          this.server.observation.nextReadyObservedAt;
        this.options = options;
        this.secrets ??= [];
        const connection = await readJSON(options.credentialFile);
        this.secrets.push(connection.authToken);
        return true;
      },
      'supervised semantic-dev ready with matching session and HTTP200',
      90000,
    );
    if (this.browser == null) {
      this.browser = new BrowserProbe(this.run, this.origin);
      await this.browser.launch();
    } else await this.browser.reloadHealthy();
    return this.state();
  }

  async stop(signal = 'SIGTERM') {
    if (this.server == null) return;
    await this.run.stop(this.server, signal);
    this.server = null;
  }

  async events() {
    const status = await readJSON(this.options.statusFile);
    return readEvents(
      path.join(
        path.dirname(this.options.currentFile),
        'sessions',
        status.sessionId,
        'events.jsonl',
      ),
    );
  }

  async state() {
    // Semantic publication and transport settle separately. Read one coherent
    // observation, retaining every identity/member assertion, and verify that
    // neither publication advanced while its bytes were being captured.
    return until(async () => {
      const status = await readJSON(this.options.statusFile);
      const descriptor = await readJSON(this.options.currentFile);
      assert.equal(status.state, 'ready');
      assert.equal(status.sessionId, this.options.sessionId);
      assert.equal(descriptor.sessionId, this.options.sessionId);
      assert.deepEqual(
        status.receipt.associationRevision,
        descriptor.associationRevision,
      );
      assert.equal(status.receipt.generationId, descriptor.generationId);
      assert.equal(status.receipt.artifactDigest, descriptor.artifactDigest);
      assert.deepEqual(status.receipt.designSystem, descriptor.designSystem);
      const canonical = await captureCanonical(this.run);
      await assertDescriptor(descriptor, canonical);
      const snapshot = await captureDescriptor(this.run, descriptor);
      const afterStatus = await readJSON(this.options.statusFile);
      const afterDescriptor = await readJSON(this.options.currentFile);
      assert.equal(afterStatus.state, 'ready');
      assert.equal(afterStatus.sessionId, status.sessionId);
      assert.deepEqual(afterStatus.revision, status.revision);
      assert.deepEqual(afterStatus.receipt, status.receipt);
      assert.deepEqual(afterDescriptor, descriptor);
      return { status, descriptor, canonical, snapshot };
    }, 'stable exact accepted receipt, transport and canonical member capture');
  }

  async acceptedAfter(previous, expected = null) {
    return until(
      async () => {
        const status = await readJSON(this.options.statusFile);
        if (
          status.state !== 'ready' ||
          status.revision.revisionId <= previous.status.revision.revisionId
        )
          return false;
        const state = await this.state();
        if (expected != null) await this.browser.expect(expected);
        return state;
      },
      'new exact accepted semantic revision',
      60000,
    );
  }

  async invalid(previous, expectedCode = null) {
    return until(async () => {
      const status = await readJSON(this.options.statusFile);
      if (
        status.state !== 'semantic-invalid' &&
        status.state !== 'transport-error'
      )
        return false;
      const canonical = await captureCanonical(this.run);
      assert.equal(
        canonical.identity,
        previous.canonical.identity,
        'Invalid source changed canonical files',
      );
      if (expectedCode != null) {
        const diagnostics = status.error?.diagnostics ?? [];
        assert(
          diagnostics.some((diagnostic) => diagnostic.code === expectedCode) ||
            status.error?.code === expectedCode,
          'Expected error code was not observed',
        );
      }
      return { status, canonical, events: await this.events() };
    }, 'semantic failure and retained canonical set');
  }

  async load(
    file,
    { source = null, options = this.options, inputMap = null } = {},
  ) {
    const result = await this.loadProcess(file, { source, options, inputMap });
    await result.handle.closed;
    return readJSON(result.resultFile);
  }

  async loadProcess(
    file,
    { source = null, options = this.options, inputMap = null } = {},
  ) {
    const id = String(++this.calls).padStart(4, '0');
    const sourceFile = '.qualification/input-' + id + '.txt';
    const optionsFile = '.qualification/options-' + id + '.json';
    const resultFile = path.join(
      this.run.output,
      'public-loader-' + id + '.json',
    );
    const mapFile = '.qualification/map-' + id + '.json';
    await this.run.write(
      sourceFile,
      source ?? (await fs.readFile(path.join(this.run.root, file), 'utf8')),
    );
    await this.run.write(optionsFile, JSON.stringify(options));
    await this.run.write(mapFile, JSON.stringify(inputMap));
    const handle = this.run.start(
      this.runtime,
      [
        path.join(this.run.root, '.qualification/public-loader-driver.mjs'),
        path.join(this.run.root, optionsFile),
        path.join(this.run.root, sourceFile),
        path.join(this.run.root, file),
        resultFile,
        path.join(this.run.root, mapFile),
      ],
      'public-loader-' + id,
    );
    return { handle, resultFile };
  }

  async observe(expected, selector = '#server-style') {
    const browser = await this.browser.expect(expected, selector);
    const response = await fetch(this.origin, {
      signal: AbortSignal.timeout(5000),
    });
    const html = await response.text();
    const evidence = 'http-' + sha256(html) + '.html';
    await fs.writeFile(path.join(this.run.output, evidence), html);
    return {
      browser,
      http: {
        status: response.status,
        evidence,
        sha256: sha256(html),
        configHeader: response.headers.get('x-semantic-config-composed'),
      },
    };
  }

  async observeServerSSR({
    text,
    javascript,
    sourceDigest,
    selector = '#server-style',
    file = 'semantic/Server.jsx',
    descriptor = null,
  }) {
    const expectedClasses = [
      ...javascript.matchAll(/\["[^"\n]+", "([^"\n]+)"\]/g),
    ].map((match) => match[1]);
    assert(
      expectedClasses.length > 0,
      'Public Server transform has no style classes',
    );
    const observations = [];
    this.run.report.serverHTTPObservations ??= [];
    try {
      return await until(
        async () => {
          const requestedAt = Date.now();
          const response = await fetch(this.origin, {
            signal: AbortSignal.timeout(10000),
          });
          const html = await response.text();
          const evidence = 'http-' + sha256(html) + '.html';
          await fs.writeFile(path.join(this.run.output, evidence), html);
          const { node, stylesheetURLs } = await this.browser.page.evaluate(
            ({ source, selector }) => {
              const document = new DOMParser().parseFromString(
                source,
                'text/html',
              );
              const node = document.querySelector(selector);
              return {
                node:
                  node == null
                    ? null
                    : { text: node.textContent, className: node.className },
                stylesheetURLs: Array.from(
                  document.querySelectorAll('link[rel="stylesheet"]'),
                  (link) => link.getAttribute('href'),
                ),
              };
            },
            { source: html, selector },
          );
          const physicalSourceDigest = sha256(
            await fs.readFile(path.join(this.run.root, file)),
          );
          const observation = {
            requestedAt,
            observedAt: Date.now(),
            status: response.status,
            evidence,
            sha256: sha256(html),
            node,
            file,
            selector,
            stylesheetURLs,
            expectedSnapshotId: descriptor?.snapshotId ?? null,
            expectedText: text,
            expectedClasses,
            sourceDigest,
            physicalSourceDigest,
          };
          observations.push(observation);
          this.run.report.serverHTTPObservations.push(observation);
          return response.status === 200 &&
            node?.text === text &&
            expectedClasses.every((name) =>
              node.className.split(/\s+/).includes(name),
            ) &&
            physicalSourceDigest === sourceDigest &&
            (descriptor === null ||
              stylesheetURLs.some((url) =>
                url?.includes(descriptor.snapshotId),
              ))
            ? observation
            : false;
        },
        'public SSR exact ' +
          selector +
          ' text/classes and physical source digest',
      );
    } catch (error) {
      error.details = {
        text,
        sourceDigest,
        expectedClasses,
        file,
        selector,
        expectedSnapshotId: descriptor?.snapshotId ?? null,
        observations,
      };
      throw error;
    }
  }

  async close() {
    await this.stop();
    await this.browser?.close();
  }
}

export async function frameworkFailure(lane, needle) {
  const response = await until(async () => {
    const result = await fetch(lane.origin, {
      signal: AbortSignal.timeout(10000),
    });
    if (result.status === 500) return result;
    await result.arrayBuffer();
    return false;
  }, 'actual Next HTTP500 for ' + needle);
  const html = await response.text();
  assert.equal(response.status, 500, 'Broken Next route returned success');
  const evidence = 'next-error-' + sha256(html) + '.html';
  await fs.writeFile(path.join(lane.run.output, evidence), html);
  await lane.browser.navigate(lane.origin);
  const overlay = await until(async () => {
    const text = await lane.browser.overlayText();
    return text.includes(needle) ? text : false;
  }, 'actual Next browser error overlay: ' + needle);
  return { status: response.status, evidence, overlay };
}

export async function sourceWatcherObservation(
  lane,
  file,
  writtenAt,
  eventBaseline,
) {
  const expectedDigest = sha256(
    await fs.readFile(path.join(lane.run.root, file)),
  );
  return until(async () => {
    const loader = await lane.load(file);
    if (!loader.ok) return false;
    const current = await lane.state();
    const events = await lane.events();
    const sameRevision = (value) =>
      JSON.stringify(value) === JSON.stringify(current.status.revision);
    const diagnostic = events.find(
      (event) =>
        event.type === 'diagnostics' &&
        event.sequence > eventBaseline &&
        event.projectId === current.descriptor.projectId &&
        event.sessionId === current.descriptor.sessionId &&
        event.result?.ok === true &&
        event.result.completeness?.evidence === 'watcher-journal' &&
        event.result.completeness?.discovery === 'watcher' &&
        sameRevision(event.result.revision) &&
        event.result.affected?.entries?.some((entry) => entry.file === file),
    );
    const committed = events.find(
      (event) =>
        event.type === 'semantic-committed' &&
        sameRevision(event.receipt?.associationRevision) &&
        event.receipt.generationId === current.descriptor.generationId,
    );
    const offered = events.find(
      (event) =>
        event.type === 'transport-complete' &&
        event.descriptor?.accepted === true &&
        sameRevision(event.descriptor.associationRevision) &&
        event.descriptor.snapshotId === current.descriptor.snapshotId &&
        event.descriptor.generationId === current.descriptor.generationId,
    );
    const transformed = events.find(
      (event) =>
        event.type === 'module-transformed' &&
        event.file === file &&
        event.sourceDigest === expectedDigest &&
        event.snapshotId === current.descriptor.snapshotId &&
        event.historical !== true &&
        sameRevision(event.revision),
    );
    const admitted = events.findLast(
      (event) => event.type === 'revision-accepted',
    );
    if (
      !diagnostic ||
      !committed ||
      !offered ||
      !transformed ||
      !sameRevision(admitted?.revision) ||
      !(
        diagnostic.sequence < committed.sequence &&
        committed.sequence < offered.sequence &&
        offered.sequence < transformed.sequence
      )
    )
      return false;
    assert.deepEqual(committed.receipt, current.status.receipt);
    assert.equal(
      sha256(await fs.readFile(path.join(lane.run.root, file))),
      expectedDigest,
    );
    assertPairedImports(
      loader.javascript,
      current.descriptor,
      path.join(lane.run.root, file),
    );
    return {
      file,
      sourceDigest: expectedDigest,
      writtenAt,
      eventBaseline,
      observedAt: Date.now(),
      diagnostic,
      committed,
      offered,
      admitted,
      transformed,
      loader,
      current,
    };
  }, 'actual watcher-journal acceptance and exact transformed source for ' + file);
}

export async function copySourceTree(from, to) {
  for (const directory of ['app', 'semantic']) {
    await fs.rm(path.join(to.root, directory), {
      recursive: true,
      force: true,
    });
    for (const member of await fileInventory(path.join(from.root, directory)))
      await to.write(
        directory + '/' + member.file,
        await fs.readFile(path.join(from.root, directory, member.file)),
      );
  }
  await to.write(
    'definition.mjs',
    await fs.readFile(path.join(from.root, 'definition.mjs')),
  );
}

export async function freshOracle(primary, secondary, label) {
  await secondary.stop();
  await copySourceTree(primary.run, secondary.run);
  await secondary.run.write('next.config.mjs', nextConfigSource());
  await fs.rm(path.join(secondary.run.root, '.next'), {
    recursive: true,
    force: true,
  });
  await fs.rm(path.join(secondary.run.root, '.pandamstyle'), {
    recursive: true,
    force: true,
  });
  const incremental = await primary.state();
  const fresh = await secondary.start(label);
  assert.deepEqual(
    fresh.canonical.members,
    incremental.canonical.members,
    'Fresh and incremental canonical five-file bytes differ',
  );
  const observed = await primary.browser.observe();
  const expected = Object.fromEntries(
    ['color', 'background', 'padding', 'opacity'].map((key) => [
      key,
      observed[key],
    ]),
  );
  const browser = await secondary.browser.expect(expected);
  await secondary.stop();
  return {
    incremental,
    fresh,
    primaryBrowser: observed,
    freshBrowser: browser,
  };
}

export async function runDevMatrix(lane, secondary, strictProof) {
  const run = lane.run;
  const row = async (id, operation) => {
    const baseline = {
      server: structuredClone(server),
      client: structuredClone(client),
      shared: structuredClone(shared),
      definition: structuredClone(definition),
    };
    const saved = new Map();
    for (const directory of ['app', 'semantic', 'external']) {
      const inventory = await fileInventory(
        path.join(run.root, directory),
      ).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const member of inventory) {
        const file = directory + '/' + member.file;
        saved.set(file, await fs.readFile(path.join(run.root, file)));
      }
    }
    for (const file of ['definition.mjs', 'next.config.mjs'])
      saved.set(file, await fs.readFile(path.join(run.root, file)));
    const result = await run.row(id, operation);
    if (result.status === 'FAIL') {
      const recoveryStartedAt = Date.now();
      try {
        await fs.rm(path.join(run.root, '.qualification/prepared-race.json'), {
          force: true,
        });
        for (const handle of [...run.processes])
          if (handle.observation.label === 'durable-prepared-observer')
            await run.stop(handle);
        await lane.stop();
        if (lane.browser != null) {
          await lane.browser.close();
          lane.browser = null;
        }
        for (const directory of ['app', 'semantic', 'external']) {
          const inventory = await fileInventory(
            path.join(run.root, directory),
          ).catch((error) => {
            if (error.code === 'ENOENT') return [];
            throw error;
          });
          for (const member of inventory) {
            const file = directory + '/' + member.file;
            if (!saved.has(file)) await run.remove(file);
          }
        }
        for (const [file, bytes] of saved) {
          const actual = await fs
            .readFile(path.join(run.root, file))
            .catch((error) => {
              if (error.code === 'ENOENT') return null;
              throw error;
            });
          if (actual == null || sha256(actual) !== sha256(bytes))
            await run.write(file, bytes, { atomic: true });
        }
        const priorAppOnlyError =
          saved.get('app/page.jsx')?.toString() === nextBrokenSource;
        if (priorAppOnlyError) await run.write('app/page.jsx', home);
        ({ server, client, shared, definition } = baseline);
        current = await lane.start('failed-row-' + id + '-fixture-restored');
        result.failureRecovery = {
          pass: true,
          startedAt: recoveryStartedAt,
          finishedAt: Date.now(),
          current,
          priorAppOnlyErrorRepaired: priorAppOnlyError,
          operation:
            'restore pre-row semantic fixture bytes, repair prior intentional App-only missing import when present, and start independent real dev session; original row remains FAIL',
        };
      } catch (error) {
        result.failureRecovery = {
          pass: false,
          startedAt: recoveryStartedAt,
          finishedAt: Date.now(),
          error: error.message,
        };
      }
      await run.save();
    }
    return result;
  };
  let server = { opacity: 0.61, label: 'server-initial' };
  let client = { opacity: 0.73, label: 'client-initial' };
  let shared = {};
  let definition = fixtureDefinition();
  let current;
  let semanticFailure;
  let nextBrokenSource;
  const home = await fs.readFile(path.join(run.root, 'app/page.jsx'), 'utf8');
  const writeServer = async (patch) => {
    server = { ...server, ...patch };
    await run.write('semantic/Server.jsx', serverSource(server));
  };
  const writeClient = async (patch) => {
    client = { ...client, ...patch };
    await run.write('semantic/Client.jsx', clientSource(client));
  };
  const writeDefinition = async (next) => {
    definition = next;
    await run.write('definition.mjs', definitionSource(definition));
  };

  await row('T01', async () => {
    current = await lane.start('dev-clean');
    const owner = assertOneOwner(await lane.events(), current.descriptor);
    const rendered = await lane.observe({
      opacity: '0.61',
      color: 'rgb(17, 34, 51)',
      padding: '16px',
      background: 'rgb(254, 254, 254)',
    });
    assert.equal(rendered.http.status, 200);
    assert.equal(rendered.http.configHeader, 'yes');
    const transformed = await lane.load('semantic/Server.jsx');
    assert.equal(transformed.ok, true);
    const pair = assertPairedImports(
      transformed.javascript,
      current.descriptor,
      path.join(run.root, 'semantic/Server.jsx'),
    );
    const closure = await auditClosure(run.root, { secrets: lane.secrets });
    return { ...current, owner, rendered, transformed, pair, closure };
  });

  await row('T02', async () => {
    const previous = await lane.state();
    await writeServer({ opacity: 0.63, label: 'server-style-edit' });
    current = await lane.acceptedAfter(previous, {
      opacity: '0.63',
      text: server.label,
    });
    assert.notEqual(current.canonical.identity, previous.canonical.identity);
    return {
      previous,
      current,
      rendered: await lane.observe({ opacity: '0.63' }),
    };
  });

  await row('T03', async () => {
    const previous = await lane.state();
    await writeServer({ label: 'server-byte-identical-generation' });
    current = await lane.acceptedAfter(previous, { text: server.label });
    assert.equal(current.canonical.identity, previous.canonical.identity);
    assert.equal(
      current.descriptor.generationId,
      current.status.receipt.generationId,
    );
    const event = (await lane.events()).find(
      (value) =>
        value.type === 'semantic-committed' &&
        JSON.stringify(value.receipt.associationRevision) ===
          JSON.stringify(current.descriptor.associationRevision),
    );
    assert(event);
    assert.equal(event.receipt.generationId, current.descriptor.generationId);
    assert.notDeepEqual(
      current.descriptor.associationRevision,
      previous.descriptor.associationRevision,
    );
    assert.notEqual(
      current.descriptor.snapshotId,
      previous.descriptor.snapshotId,
    );
    const replaySourceEventBaseline =
      (await lane.events()).at(-1)?.sequence ?? 0;
    await run.write('semantic/Server.jsx', serverSource(server));
    const replayLoader = await lane.load('semantic/Server.jsx');
    assert.equal(replayLoader.ok, true);
    const initialReplay = await lane.state();
    const replayWrite = run.report.inputMutations.findLast(
      (mutation) => mutation.file === 'semantic/Server.jsx',
    );
    const replayWatcherObservation = await sourceWatcherObservation(
      lane,
      'semantic/Server.jsx',
      replayWrite.writtenAt,
      replaySourceEventBaseline,
    );
    const replay = replayWatcherObservation.current;
    assert.equal(replay.canonical.identity, initialReplay.canonical.identity);
    assert.equal(replay.canonical.identity, current.canonical.identity);
    assert.equal(
      replay.descriptor.generationId,
      replay.status.receipt.generationId,
    );
    const noWriteLoader = await lane.load('semantic/Server.jsx');
    assert.equal(noWriteLoader.ok, true);
    const noWrite = await lane.state();
    assert.deepEqual(noWrite.status.revision, replay.status.revision);
    assert.deepEqual(noWrite.status.receipt, replay.status.receipt);
    assert.equal(noWrite.descriptor.snapshotId, replay.descriptor.snapshotId);
    assert.equal(noWrite.canonical.identity, replay.canonical.identity);
    return {
      previous,
      current,
      identicalSourceReplay: {
        replayLoader,
        initialReplay,
        replay,
        replayWatcherObservation,
        barrier:
          'actual watcher-journal acceptance and exact source/receipt/descriptor/transform chain',
      },
      noDiskWriteReplay: {
        noWriteLoader,
        noWrite,
        unchangedAuthoritativeIdentities: true,
      },
      reusedGeneration:
        current.descriptor.generationId === previous.descriptor.generationId,
      authoritativeReceiptEvent: event,
      rendered: await lane.observe({ text: server.label }),
    };
  });

  await row('T04', async () => {
    const previous = await lane.state();
    await run.write(
      'semantic/Server.jsx',
      serverSource({ ...server, padding: "token('missing.semantic-probe')" }),
    );
    semanticFailure = await lane.invalid(previous, 'PMS_UNKNOWN_TOKEN');
    const loader = await lane.load('semantic/Server.jsx');
    assert.equal(loader.ok, false);
    assert(loader.dependencies.includes(lane.options.statusFile));
    assert(loader.contexts.includes(path.join(run.root, 'semantic')));
    const browser = await frameworkFailure(lane, 'missing.semantic-probe');
    return { previous, failure: semanticFailure, loader, browser };
  });

  await row('T05', async () => {
    const previous = { status: semanticFailure.status };
    await writeServer({ opacity: 0.65, label: 'server-repaired' });
    current = await lane.acceptedAfter(previous);
    await lane.browser.reloadHealthy();
    const rendered = await lane.observe({
      opacity: '0.65',
      text: server.label,
    });
    return {
      failedRevision: semanticFailure.status.revision,
      current,
      rendered,
    };
  });

  await row('T06', async () => {
    const previous = await lane.state();
    nextBrokenSource =
      "import Missing from './missing-next-only.jsx';\n" + home;
    await run.write('app/page.jsx', nextBrokenSource);
    const sourceEventBaseline = (await lane.events()).at(-1)?.sequence ?? 0;
    await writeServer({
      opacity: 0.66,
      label: 'semantic-accepted-with-next-error',
    });
    current = await lane.acceptedAfter(previous);
    assert.notEqual(current.canonical.identity, previous.canonical.identity);
    const browser = await frameworkFailure(lane, 'missing-next-only');
    const initialCurrent = current;
    const write = run.report.inputMutations.findLast(
      (mutation) => mutation.file === 'semantic/Server.jsx',
    );
    const watcherObservation = await sourceWatcherObservation(
      lane,
      'semantic/Server.jsx',
      write.writtenAt,
      sourceEventBaseline,
    );
    current = watcherObservation.current;
    assert.equal(current.canonical.identity, initialCurrent.canonical.identity);
    const diagnostics = (await lane.events()).filter(
      (event) => event.type === 'diagnostics',
    );
    assert.equal(diagnostics.at(-1).result.ok, true);
    return {
      previous,
      initialCurrent,
      current,
      browser,
      watcherObservation,
      semanticDiagnostics: diagnostics.at(-1),
    };
  });

  await row('T07', async () => {
    const previous = await lane.state();
    await run.write('app/page.jsx', home);
    await lane.browser.reloadHealthy();
    current = await lane.state();
    assert.equal(current.canonical.identity, previous.canonical.identity);
    assert.deepEqual(current.status.revision, previous.status.revision);
    assert.deepEqual(current.status.receipt, previous.status.receipt);
    assert.deepEqual(current.descriptor, previous.descriptor);
    const rendered = await lane.observe({
      opacity: '0.66',
      text: server.label,
    });
    return { previous, current, rendered, appOnlyRepair: true };
  });

  await row('T08', async () => {
    const previous = await lane.state();
    await run.write(
      'semantic/Shared.jsx',
      sharedSource({ margin: "token('missing.owned-dependency')" }),
    );
    const failure = await lane.invalid(previous, 'PMS_UNKNOWN_TOKEN');
    const loader = await lane.load('semantic/Server.jsx');
    assert.equal(loader.ok, false);
    assert(
      loader.error.diagnostics.some(
        (diagnostic) => diagnostic.source?.file === 'semantic/Shared.jsx',
      ),
    );
    const browser = await frameworkFailure(lane, 'missing.owned-dependency');
    await run.write('semantic/Shared.jsx', sharedSource(shared));
    current = await lane.acceptedAfter({ status: failure.status });
    await lane.browser.reloadHealthy();
    return {
      previous,
      failure,
      loader,
      browser,
      repaired: current,
      rendered: await lane.observe({ opacity: '0.66' }),
    };
  });

  await row('T09', async () => {
    const attempts = [];
    const beforePadding = await lane.state();
    const externalInputs = [];
    await run.write(
      'external/race-padding/zz-late.js',
      'export const lateDiskInput = 0;\n',
    );
    for (let index = 0; index < 512; index++) {
      const file =
        'external/race-padding/' + String(index).padStart(3, '0') + '.js';
      externalInputs.push(file);
      await run.write(
        file,
        'export const qualificationRacePadding' +
          index +
          ' = ' +
          index +
          ';\n/*' +
          ' actual public imported disk input '.repeat(128) +
          '*/\n',
      );
    }
    await run.write(
      'external/race-padding/index.js',
      externalInputs
        .map((file) => "export * from './" + path.basename(file) + "';")
        .join('\n') + "\nexport * from './zz-late.js';\n",
    );
    await run.write(
      'external/RaceShared.jsx',
      sharedSource(shared)
        .replace("'../.pandamstyle/design.js'", "'../.pandamstyle/design.js'")
        .replace(
          'const sharedStyles',
          "import * as raceInputs from './race-padding/index.js';\nconst sharedStyles",
        )
        .replace(
          'shared component</p>',
          'shared component {Object.keys(raceInputs).length}</p>',
        ),
    );
    await run.write(
      'semantic/Broker.jsx',
      "export { default } from '../external/RaceShared.jsx';\n",
    );
    await lane.acceptedAfter(beforePadding);
    assert.equal((await lane.load('semantic/Server.jsx')).ok, true);
    await run.write(
      '.qualification/durable-prepared-observer.mjs',
      DURABLE_PREPARED_OBSERVER,
    );
    const eventsFile = path.join(
      path.dirname(lane.options.currentFile),
      'sessions',
      lane.options.sessionId,
      'events.jsonl',
    );
    const observerReadyFile = path.join(
      run.root,
      '.qualification/durable-observer-ready.json',
    );
    const durableObserver = run.start(
      lane.runtime,
      [
        '.qualification/durable-prepared-observer.mjs',
        eventsFile,
        run.root,
        observerReadyFile,
      ],
      'durable-prepared-observer',
    );
    const observerReady = await until(
      () => readJSON(observerReadyFile),
      'real durable-event watcher established',
    );
    let rejection;
    for (let attempt = 0; attempt < 12 && !rejection; attempt++) {
      const previous = await lane.state();
      const sequence = (await lane.events()).at(-1).sequence;
      const r2 = {
        ...server,
        opacity: 0.301 + attempt / 1000,
        label: 'prepared-r2-' + attempt,
      };
      const r3 = {
        ...server,
        opacity: 0.351 + attempt / 1000,
        label: 'accepted-r3-' + attempt,
      };
      const r2Source = serverSource(r2);
      const r3Source = serverSource(r3);
      await run.archiveBytes(r3Source);
      await run.write(
        '.qualification/prepared-race.json',
        JSON.stringify({
          file: 'semantic/Server.jsx',
          source: r3Source,
          afterRevisionId: previous.status.revision.revisionId,
          additionalWrites: [
            {
              file: 'external/race-padding/zz-late.js',
              source: 'export const lateDiskInput = ' + (attempt + 1) + ';\n',
            },
          ],
        }),
      );
      await run.write('semantic/Server.jsx', r2Source);
      await until(async () => {
        const source = await fs.readFile(
          path.join(run.root, 'semantic/Server.jsx'),
          'utf8',
        );
        return source === r3Source;
      }, 'actual public prepared observer wrote superseding R3');
      const external = await run.recordExternalWrite('semantic/Server.jsx', {
        mechanism:
          'real prepared-event observer disk write; exact observer owner retained in fixture event',
      });
      await run.recordExternalWrite('external/race-padding/zz-late.js', {
        mechanism:
          'same real public prepared observer writes imported external input',
      });
      server = r3;
      current = await lane.acceptedAfter(previous);
      let currentLoader = await lane.load('semantic/Server.jsx');
      assert.equal(currentLoader.ok, true);
      const watcherObservation = await sourceWatcherObservation(
        lane,
        'semantic/Server.jsx',
        external.observedAt,
        sequence,
      );
      current = watcherObservation.current;
      currentLoader = watcherObservation.loader;
      const serverHTTP = await lane.observeServerSSR({
        text: r3.label,
        javascript: currentLoader.javascript,
        sourceDigest: sha256(r3Source),
      });
      const fullReloadStartedAt = Date.now();
      await lane.browser.reloadHealthy();
      const currentBrowser = await lane.browser.expectBoundSnapshot(
        current.descriptor,
        { text: r3.label, opacity: String(r3.opacity) },
      );
      const events = (await lane.events()).filter(
        (event) => event.sequence > sequence,
      );
      const observed = (
        await readEvents(path.join(run.root, 'host-events.jsonl'))
      ).filter(
        (event) =>
          event.type === 'fixture-prepared-race-write' &&
          event.sourceDigest === sha256(r3Source),
      );
      assert(observed.length > 0);
      const prepared = events.find(
        (event) =>
          event.type === 'semantic-prepared' &&
          event.ticket.ticketId === observed.at(-1).ticketId,
      );
      const rejected = events.find(
        (event) =>
          event.type === 'semantic-rejected' &&
          event.sequence > prepared.sequence,
      );
      const r2Committed = events.some(
        (event) =>
          event.type === 'semantic-committed' &&
          JSON.stringify(event.receipt.associationRevision) ===
            JSON.stringify(prepared.ticket.revision),
      );
      const externalRevision =
        rejected &&
        events.find(
          (event) =>
            event.type === 'revision-accepted' &&
            event.inputOwner === 'compiler-declared-external-source' &&
            event.sequence > prepared.sequence &&
            event.sequence < rejected.sequence &&
            event.changed?.includes('external/race-padding/zz-late.js'),
        );
      attempts.push({
        attempt,
        previous,
        prepared,
        observed,
        rejected,
        r2Committed,
        externalRevision,
        external,
        final: current,
        currentLoader,
        currentBrowser,
        watcherObservation,
        serverHTTP,
        fullReloadStartedAt,
        intentionalReloadAfterControlledRace: true,
        events,
      });
      server = r3;
      if (rejected && externalRevision && !r2Committed) {
        const late = await lane.load('semantic/Server.jsx', {
          source: r2Source,
        });
        assert.equal(late.ok, false);
        assert.equal(late.error.code, 'PMS_STALE_REVISION');
        const afterLate = await lane.state();
        assert.equal(
          afterLate.descriptor.snapshotId,
          current.descriptor.snapshotId,
        );
        rejection = {
          rejected,
          late,
          afterLate,
          browser: await lane.browser.expect({
            text: r3.label,
            opacity: String(r3.opacity),
          }),
        };
      }
    }
    await run.stop(durableObserver);
    const cleanupEventBaseline = (await lane.events()).at(-1)?.sequence ?? 0;
    await run.write(
      'semantic/Broker.jsx',
      "export { default } from './Shared.jsx';\n",
    );
    const brokerWrite = run.report.inputMutations.findLast(
      (mutation) => mutation.file === 'semantic/Broker.jsx',
    );
    const restoredServerDigest = sha256(
      await fs.readFile(path.join(run.root, 'semantic/Server.jsx')),
    );
    const restoredBroker = await until(async () => {
      const brokerLoader = await lane.load('semantic/Broker.jsx');
      if (!brokerLoader.ok) return false;
      const serverLoader = await lane.load('semantic/Server.jsx');
      if (!serverLoader.ok) return false;
      const brokerSnapshotImports = [
        ...brokerLoader.javascript.matchAll(
          /(?:"|')([^"'\n]*\.pandamstyle-next-host[^"'\n]*\/sessions\/[^"'\n]+)(?:"|')/g,
        ),
      ].map((match) => path.resolve(path.join(run.root, 'semantic'), match[1]));
      assert.equal(brokerSnapshotImports.length, 1);
      const brokerDescriptor = await readJSON(
        path.join(path.dirname(brokerSnapshotImports[0]), 'descriptor.json'),
      );
      const brokerInventory = await assertDescriptor(brokerDescriptor);
      assert.deepEqual(brokerSnapshotImports, [brokerDescriptor.stylesCSS]);
      const brokerSnapshot = await captureDescriptor(run, brokerDescriptor);
      const serverSelected = await descriptorFromLoader(
        run,
        'semantic/Server.jsx',
        serverLoader,
      );
      const state = await lane.state();
      if (
        brokerDescriptor.snapshotId !== state.descriptor.snapshotId ||
        serverSelected.descriptor.snapshotId !== state.descriptor.snapshotId
      )
        return false;
      assert.deepEqual(brokerDescriptor, state.descriptor);
      assert.deepEqual(serverSelected.descriptor, state.descriptor);
      const events = await lane.events();
      const sameRevision = (value) =>
        JSON.stringify(value) === JSON.stringify(state.status.revision);
      const admitted = events.findLast(
        (event) => event.type === 'revision-accepted',
      );
      const brokerTransformed = events.findLast(
        (event) =>
          event.type === 'module-transformed' &&
          event.sequence > cleanupEventBaseline &&
          event.file === 'semantic/Broker.jsx' &&
          event.sourceDigest === brokerWrite.sha256 &&
          event.snapshotId === state.descriptor.snapshotId &&
          event.historical !== true &&
          sameRevision(event.revision),
      );
      const serverTransformed = events.findLast(
        (event) =>
          event.type === 'module-transformed' &&
          event.sequence > cleanupEventBaseline &&
          event.file === 'semantic/Server.jsx' &&
          event.sourceDigest === restoredServerDigest &&
          event.snapshotId === state.descriptor.snapshotId &&
          event.historical !== true &&
          sameRevision(event.revision),
      );
      if (
        !brokerTransformed ||
        !serverTransformed ||
        !sameRevision(admitted?.revision)
      )
        return false;
      assert.equal(
        sha256(await fs.readFile(path.join(run.root, 'semantic/Broker.jsx'))),
        brokerWrite.sha256,
      );
      assert.equal(
        sha256(await fs.readFile(path.join(run.root, 'semantic/Server.jsx'))),
        restoredServerDigest,
      );
      return {
        observedAt: Date.now(),
        writtenAt: brokerWrite.writtenAt,
        eventBaseline: cleanupEventBaseline,
        sourceDigest: brokerWrite.sha256,
        serverSourceDigest: restoredServerDigest,
        current: state,
        admitted,
        brokerTransformed,
        serverTransformed,
        brokerLoader,
        serverLoader,
        brokerDescriptor,
        brokerInventory,
        brokerSnapshot,
        brokerSnapshotImports,
        serverSelected,
        pair: serverSelected.pair,
      };
    }, 'actual restored Broker source and same current Server descriptor before race graph deletion');
    current = restoredBroker.current;
    for (const file of [
      ...externalInputs,
      'external/race-padding/index.js',
      'external/race-padding/zz-late.js',
      'external/RaceShared.jsx',
    ])
      await run.remove(file);
    const cleanup = await until(async () => {
      const loader = await lane.load('semantic/Server.jsx');
      if (!loader.ok) return false;
      const selected = await descriptorFromLoader(
        run,
        'semantic/Server.jsx',
        loader,
      );
      const state = await lane.state();
      if (selected.descriptor.snapshotId !== state.descriptor.snapshotId)
        return false;
      assert.deepEqual(selected.descriptor, state.descriptor);
      const events = await lane.events();
      const admitted = events.findLast(
        (event) => event.type === 'revision-accepted',
      );
      if (
        JSON.stringify(admitted?.revision) !==
        JSON.stringify(state.status.revision)
      )
        return false;
      return {
        observedAt: Date.now(),
        loader,
        selected,
        current: state,
        admitted,
        pair: selected.pair,
      };
    }, 'ready actual current Server pair after disconnected race graph deletion');
    current = cleanup.current;
    assert(
      rejection,
      'No actual prepared stale-ticket race obtained within bounded attempts',
    );
    return { attempts, rejection, observerReady, restoredBroker, cleanup };
  });

  await row('T10', async () => {
    let oldPage;
    try {
      const historical = await lane.state();
      const oldLoader = await lane.load('semantic/Server.jsx');
      assert.equal(oldLoader.ok, true);
      const oldBrowser = await lane.browser.observe();
      oldPage = await lane.browser.newPage();
      await lane.browser.navigate(lane.origin, oldPage);
      await lane.browser.expect(
        { opacity: String(server.opacity) },
        '#server-style',
        oldPage,
      );
      await oldPage.setOfflineMode(true);
      await writeServer({ opacity: 0.71, label: 'current-after-historical' });
      current = await lane.acceptedAfter(historical, { opacity: '0.71' });
      await assertDescriptor(historical.descriptor, historical.canonical);
      const routeFile = path.join(run.root, 'app/historical/page.jsx');
      await run.write(
        'app/historical/page.jsx',
        `import { __pandamstyle } from ${JSON.stringify(relativeImport(routeFile, historical.descriptor.designJS))};
import ${JSON.stringify(relativeImport(routeFile, historical.descriptor.stylesCSS))};
export default function Historical() { return <p id="historical-style" className=${JSON.stringify(oldBrowser.className)} data-registry={__pandamstyle.designSystem.registryDigest}>historical accepted consumer</p>; }
`,
      );
      await lane.browser.reloadHealthy('/historical');
      const lazyHistorical = await lane.browser.expect(
        {
          opacity: oldBrowser.opacity,
          padding: oldBrowser.padding,
          color: oldBrowser.color,
        },
        '#historical-style',
      );
      assert.equal(
        lazyHistorical.dataset.registry,
        historical.descriptor.designSystem.registryDigest,
      );
      const offlineHistorical = await lane.browser.observe(
        '#server-style',
        oldPage,
      );
      assert.equal(offlineHistorical.opacity, oldBrowser.opacity);
      return {
        historical,
        oldLoader,
        oldBrowser,
        lazyHistorical,
        offlineHistorical,
        current,
        scope:
          'exact old immutable pair in a first-navigation route; disconnected old tab separately',
      };
    } finally {
      if (oldPage != null && !oldPage.isClosed()) await oldPage.close();
      await run.remove('app/historical/page.jsx').catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await lane.browser.reloadHealthy();
    }
  });

  await row('T11', async () => {
    const previous = await lane.state();
    const samples = [];
    for (let index = 0; index < 16; index++) {
      await writeServer({
        opacity: 0.4 + index / 100,
        label: 'burst-server-' + index,
      });
      await writeClient({
        opacity: 0.6 + index / 100,
        label: 'burst-client-' + index,
      });
      samples.push({
        index,
        server: server.opacity,
        client: client.opacity,
        at: Date.now(),
      });
    }
    current = await lane.acceptedAfter(previous, {
      opacity: String(server.opacity),
      text: server.label,
    });
    const clientBrowser = await lane.browser.expect(
      { opacity: String(client.opacity), text: client.label },
      '#counter',
    );
    const oracle = await freshOracle(lane, secondary, 'burst-fresh-oracle');
    return { previous, current, samples, clientBrowser, oracle };
  });

  await row('T12', async () => {
    const previous = await lane.state();
    const source = await fs.readFile(
      path.join(run.root, 'semantic/Server.jsx'),
      'utf8',
    );
    const capturedAt = Date.now();
    await run.archiveBytes(source);
    const sourceEventBaseline = (await lane.events()).at(-1)?.sequence ?? 0;
    await writeServer({ opacity: 0.57, label: 'new-after-delayed-input' });
    current = await lane.acceptedAfter(previous);
    const initialCurrent = current;
    const write = run.report.inputMutations.findLast(
      (mutation) => mutation.file === 'semantic/Server.jsx',
    );
    const watcherObservation = await sourceWatcherObservation(
      lane,
      'semantic/Server.jsx',
      write.writtenAt,
      sourceEventBaseline,
    );
    current = watcherObservation.current;
    assert.equal(current.canonical.identity, initialCurrent.canonical.identity);
    await lane.browser.reloadHealthy();
    const deliveryBrowserBarrier = await lane.browser.expect({
      opacity: '0.57',
      text: server.label,
    });
    const invokedAt = Date.now();
    const late = await lane.load('semantic/Server.jsx', { source });
    assert.equal(late.ok, false);
    assert.equal(late.error.code, 'PMS_STALE_REVISION');
    const after = await lane.state();
    assert.equal(after.descriptor.snapshotId, current.descriptor.snapshotId);
    return {
      previous,
      initialCurrent,
      watcherObservation,
      capturedAt,
      invokedAt,
      deliveryBrowserBarrier,
      intentionalReload: true,
      sourceDigest: sha256(source),
      deliveryBarrier:
        'new accepted descriptor and matching browser observed before original source delivery',
      current,
      late,
      after,
      browser: await lane.browser.expect({ text: server.label }),
    };
  });

  await row('T13', async () => {
    const previous = await lane.state();
    const source = `import { create, props, token } from '../.pandamstyle/design.js';
const styles = create({ added: { opacity: 0.4213, padding: token('spacing.added31') } });
export default function Added() { return <p id="added-style" {...props(styles.added)}>added semantic module</p>; }
`;
    await run.write('semantic/Added.jsx', source);
    await run.write(
      'app/added/page.jsx',
      `import Added from '../../semantic/Added.jsx';
export default function Page() { return <Added />; }
`,
    );
    current = await lane.acceptedAfter(previous);
    const addedCSS = await fs.readFile(current.descriptor.stylesCSS, 'utf8');
    assert(hasOpacityDeclaration(addedCSS, 0.4213));
    await lane.browser.reloadHealthy('/added');
    const added = await lane.browser.expect(
      { opacity: '0.4213', padding: '31px' },
      '#added-style',
    );
    await run.rename('semantic/Added.jsx', 'semantic/Renamed.jsx');
    await run.write(
      'app/added/page.jsx',
      `import Added from '../../semantic/Renamed.jsx';
export default function Page() { return <Added />; }
`,
    );
    const renamed = await lane.acceptedAfter(current);
    await lane.browser.reloadHealthy('/added');
    const renamedBrowser = await lane.browser.expect(
      { opacity: '0.4213' },
      '#added-style',
    );
    // Leave the temporary route before deleting it. Next can otherwise finish
    // a pending reload of the removed route after our navigation to '/',
    // replacing that new document with its controlled not-found response.
    await lane.browser.reloadHealthy();
    const beforeRemovalBrowser = await lane.browser.expect({
      text: server.label,
    });
    const removalEventBaseline = (await lane.events()).at(-1)?.sequence ?? 0;
    await run.remove('app/added/page.jsx');
    await run.remove('semantic/Renamed.jsx');
    const removalObservation = await until(async () => {
      const status = await readJSON(lane.options.statusFile);
      if (status.state !== 'ready') return false;
      const sameRevision = (value) =>
        JSON.stringify(value) === JSON.stringify(status.revision);
      const events = await lane.events();
      const diagnostic = events.find(
        (event) =>
          event.type === 'diagnostics' &&
          event.sequence > removalEventBaseline &&
          event.result?.ok === true &&
          event.result.completeness?.evidence === 'watcher-journal' &&
          event.result.completeness?.discovery === 'watcher' &&
          sameRevision(event.result.revision) &&
          event.result.affected?.entries?.some(
            (entry) =>
              entry.file === 'semantic/Renamed.jsx' && entry.role == null,
          ),
      );
      const committed = events.find(
        (event) =>
          event.type === 'semantic-committed' &&
          sameRevision(event.receipt?.associationRevision),
      );
      const offered = events.find(
        (event) =>
          event.type === 'transport-complete' &&
          sameRevision(event.descriptor?.associationRevision),
      );
      if (
        !diagnostic ||
        !committed ||
        !offered ||
        !(
          diagnostic.sequence < committed.sequence &&
          committed.sequence < offered.sequence
        )
      )
        return false;
      const accepted = await lane.state();
      if (!sameRevision(accepted.status.revision)) return false;
      assert.deepEqual(committed.receipt, accepted.status.receipt);
      assert.deepEqual(offered.descriptor, accepted.descriptor);
      return {
        current: accepted,
        diagnostic,
        committed,
        offered,
        removalEventBaseline,
      };
    }, 'exact watcher deletion revision for semantic/Renamed.jsx');
    current = removalObservation.current;
    const css = await fs.readFile(
      path.join(run.root, '.pandamstyle/styles.css'),
      'utf8',
    );
    assert(!hasOpacityDeclaration(css, 0.4213));
    await lane.browser.reloadHealthy();
    return {
      previous,
      addedRevision: renamed,
      added,
      renamedBrowser,
      beforeRemovalBrowser,
      removalObservation,
      removed: current,
      removedRuleAbsent: true,
      browser: await lane.browser.expect({ text: server.label }),
    };
  });

  await row('T14', async () => {
    const previous = await lane.state();
    shared = { margin: "token('spacing.shared13')" };
    await run.write('semantic/Shared.jsx', sharedSource(shared));
    current = await lane.acceptedAfter(previous);
    const rsc = await lane.browser.expect({ margin: '13px' }, '#shared-server');
    const clientBrowser = await lane.browser.expect(
      { margin: '13px' },
      '#shared-client',
    );
    const brokerSource = await fs.readFile(
      path.join(run.root, 'semantic/Server.jsx'),
      'utf8',
    );
    const importEventBaseline = (await lane.events()).at(-1)?.sequence ?? 0;
    await run.write(
      'semantic/Server.jsx',
      brokerSource.replace("from './Broker.jsx'", "from './Shared.jsx'"),
    );
    const importChangedInitial = await lane.acceptedAfter(current);
    const importWrite = run.report.inputMutations.findLast(
      (mutation) => mutation.file === 'semantic/Server.jsx',
    );
    const importWatcher = await sourceWatcherObservation(
      lane,
      'semantic/Server.jsx',
      importWrite.writtenAt,
      importEventBaseline,
    );
    const importChanged = importWatcher.current;
    const importLoader = importWatcher.loader;
    const importSelected = await descriptorFromLoader(
      run,
      'semantic/Server.jsx',
      importLoader,
    );
    assert.deepEqual(importSelected.descriptor, importChanged.descriptor);
    const importBrowser = await lane.browser.expectBoundSnapshot(
      importChanged.descriptor,
      { margin: '13px' },
      '#shared-server',
    );
    const restoreEventBaseline = (await lane.events()).at(-1)?.sequence ?? 0;
    await run.write('semantic/Server.jsx', brokerSource);
    const importRestoredInitial = await lane.acceptedAfter(importChanged);
    const restoreWrite = run.report.inputMutations.findLast(
      (mutation) => mutation.file === 'semantic/Server.jsx',
    );
    const restoreWatcher = await sourceWatcherObservation(
      lane,
      'semantic/Server.jsx',
      restoreWrite.writtenAt,
      restoreEventBaseline,
    );
    const importRestored = restoreWatcher.current;
    const restoreSelected = await descriptorFromLoader(
      run,
      'semantic/Server.jsx',
      restoreWatcher.loader,
    );
    assert.deepEqual(restoreSelected.descriptor, importRestored.descriptor);
    const importRestoredBrowser = await lane.browser.expectBoundSnapshot(
      importRestored.descriptor,
      { margin: '13px' },
      '#shared-server',
    );
    current = importRestored;
    const transformed = await lane.load('semantic/Server.jsx');
    assert.equal(transformed.ok, true);
    const consumerBytes = await fs.readFile(
      path.join(run.root, 'semantic/Server.jsx'),
    );
    await run.write('external/Shared.jsx', sharedSource(shared));
    await run.write(
      'semantic/Broker.jsx',
      "export { default } from '../external/Shared.jsx';\n",
    );
    const externalAccepted = await lane.acceptedAfter(current);
    await run.write(
      'external/Shared.jsx',
      sharedSource({ margin: "token('spacing.external-missing')" }),
    );
    const externalFailure = await lane.invalid(externalAccepted);
    const failedExternalLoader = await lane.load('semantic/Server.jsx');
    assert.equal(failedExternalLoader.ok, false);
    assert(
      failedExternalLoader.dependencies.includes(
        path.join(run.root, 'external/Shared.jsx'),
      ),
    );
    await frameworkFailure(lane, 'spacing.external-missing');
    await run.write(
      'external/Shared.jsx',
      sharedSource({ margin: "token('spacing.external17')" }),
    );
    const externalRepaired = await lane.acceptedAfter({
      status: externalFailure.status,
    });
    const externalBrowser = await lane.browser.expect(
      { margin: '17px' },
      '#shared-server',
    );
    assert.equal(
      sha256(await fs.readFile(path.join(run.root, 'semantic/Server.jsx'))),
      sha256(consumerBytes),
    );
    const cleanupEventBaseline = (await lane.events()).at(-1)?.sequence ?? 0;
    await run.write(
      'semantic/Broker.jsx',
      "export { default } from './Shared.jsx';\n",
    );
    const brokerWrite = run.report.inputMutations.findLast(
      (mutation) => mutation.file === 'semantic/Broker.jsx',
    );
    const sharedDigest = sha256(
      await fs.readFile(path.join(run.root, 'semantic/Shared.jsx')),
    );
    const serverDigest = sha256(consumerBytes);
    const observeRestoredGraph = async () => {
      const brokerLoader = await lane.load('semantic/Broker.jsx');
      if (!brokerLoader.ok) return false;
      const sharedLoader = await lane.load('semantic/Shared.jsx');
      if (!sharedLoader.ok) return false;
      const serverLoader = await lane.load('semantic/Server.jsx');
      if (!serverLoader.ok) return false;
      const brokerSelected = await descriptorFromCSSLoader(
        run,
        'semantic/Broker.jsx',
        brokerLoader,
      );
      const sharedSelected = await descriptorFromCSSLoader(
        run,
        'semantic/Shared.jsx',
        sharedLoader,
      );
      const serverSelected = await descriptorFromLoader(
        run,
        'semantic/Server.jsx',
        serverLoader,
      );
      const state = await lane.state();
      for (const selected of [brokerSelected, sharedSelected, serverSelected]) {
        if (selected.descriptor.snapshotId !== state.descriptor.snapshotId)
          return false;
        assert.deepEqual(selected.descriptor, state.descriptor);
      }
      const events = await lane.events();
      const sameRevision = (value) =>
        JSON.stringify(value) === JSON.stringify(state.status.revision);
      const admitted = events.findLast(
        (event) => event.type === 'revision-accepted',
      );
      if (!sameRevision(admitted?.revision)) return false;
      const sources = [
        { file: 'semantic/Broker.jsx', digest: brokerWrite.sha256 },
        { file: 'semantic/Shared.jsx', digest: sharedDigest },
        { file: 'semantic/Server.jsx', digest: serverDigest },
      ];
      const transformed = [];
      for (const source of sources) {
        const event = events.findLast(
          (event) =>
            event.type === 'module-transformed' &&
            event.sequence > cleanupEventBaseline &&
            event.file === source.file &&
            event.sourceDigest === source.digest &&
            event.snapshotId === state.descriptor.snapshotId &&
            event.historical !== true &&
            sameRevision(event.revision),
        );
        if (!event) return false;
        assert.equal(
          sha256(await fs.readFile(path.join(run.root, source.file))),
          source.digest,
        );
        transformed.push(event);
      }
      return {
        observedAt: Date.now(),
        eventBaseline: cleanupEventBaseline,
        current: state,
        admitted,
        sources,
        transformed,
        brokerLoader,
        sharedLoader,
        serverLoader,
        brokerSelected,
        sharedSelected,
        serverSelected,
      };
    };
    const restoredBeforeDeletion = await until(
      observeRestoredGraph,
      'actual restored Broker and local Shared current source/descriptor before cleanup deletion',
    );
    await run.remove('external/Shared.jsx');
    const restoredAfterDeletion = await until(
      observeRestoredGraph,
      'actual current restored graph after external cleanup deletion',
    );
    current = restoredAfterDeletion.current;
    const cleanupSSR = await lane.observeServerSSR({
      text: 'shared component',
      javascript: restoredAfterDeletion.sharedLoader.javascript,
      sourceDigest: sharedDigest,
      selector: '#shared-server',
      file: 'semantic/Shared.jsx',
      descriptor: current.descriptor,
    });
    assert.equal(
      sha256(await fs.readFile(path.join(run.root, 'semantic/Broker.jsx'))),
      brokerWrite.sha256,
    );
    const cleanupReloadStartedAt = Date.now();
    await lane.browser.reloadHealthy();
    const restoredAfterReload = await until(
      observeRestoredGraph,
      'actual current restored graph after recorded cleanup reload',
    );
    current = restoredAfterReload.current;
    const finalBrowser = await lane.browser.expectBoundSnapshot(
      current.descriptor,
      { margin: '13px' },
      '#shared-server',
    );
    return {
      previous,
      current,
      rsc,
      clientBrowser,
      transformed,
      importEdit: {
        initialChanged: importChangedInitial,
        watcher: importWatcher,
        changed: importChanged,
        loader: importLoader,
        selected: importSelected,
        browser: importBrowser,
        initialRestored: importRestoredInitial,
        restoredWatcher: restoreWatcher,
        restoredSelected: restoreSelected,
        restored: importRestored,
        restoredBrowser: importRestoredBrowser,
      },
      finalBrowser,
      cleanup: {
        restoredBeforeDeletion,
        restoredAfterDeletion,
        serverHTTP: cleanupSSR,
        reloadStartedAt: cleanupReloadStartedAt,
        restoredAfterReload,
        intentionalReload: true,
        scope:
          'structural fixture cleanup after unchanged-consumer live invalid/repair; exact SSR precedes deliberate full reload',
      },
      externalDependency: {
        externalAccepted,
        externalFailure,
        failedExternalLoader,
        externalRepaired,
        externalBrowser,
        consumerDigestUnchanged: true,
      },
      importedThroughReexport: 'semantic/Broker.jsx -> semantic/Shared.jsx',
    };
  });

  await row('T15', async () => {
    const previous = await lane.state();
    const sourceBefore = sha256(
      await fs.readFile(path.join(run.root, 'semantic/Server.jsx')),
    );
    await writeDefinition(
      fixtureDefinition({
        padding: '23px',
        color: '#225577',
        background: '#ddeeff',
      }),
    );
    current = await lane.acceptedAfter(previous, {
      padding: '23px',
      color: 'rgb(34, 85, 119)',
      background: 'rgb(221, 238, 255)',
    });
    assert.notEqual(
      current.descriptor.designSystem.registryDigest,
      previous.descriptor.designSystem.registryDigest,
    );
    assert.equal(
      sha256(await fs.readFile(path.join(run.root, 'semantic/Server.jsx'))),
      sourceBefore,
    );
    return {
      previous,
      current,
      sourceBefore,
      definitionOnly: true,
      browser: await lane.browser.observe(),
      transformed: await lane.load('semantic/Server.jsx'),
    };
  });

  await row('T16', async () => {
    const previous = await lane.state();
    const invalid = structuredClone(definition);
    invalid.tokens.colors.text = {
      ref: 'colors.missing-definition',
      visibility: 'public',
    };
    await run.write('definition.mjs', definitionSource(invalid));
    const failure = await lane.invalid(previous);
    const loader = await lane.load('semantic/Server.jsx');
    assert.equal(loader.ok, false);
    assert(loader.dependencies.includes(lane.options.definitionPath));
    await run.write('definition.mjs', definitionSource(definition));
    current = await lane.acceptedAfter({ status: failure.status });
    await lane.browser.reloadHealthy();
    return {
      previous,
      failure,
      loader,
      repaired: current,
      browser: await lane.browser.expect({
        padding: '23px',
        color: 'rgb(34, 85, 119)',
      }),
    };
  });

  await row('T17', async () => {
    const previous = await lane.state();
    const clientDigest = sha256(
      await fs.readFile(path.join(run.root, 'semantic/Client.jsx')),
    );
    const sourceEventBaseline = (await lane.events()).at(-1)?.sequence ?? 0;
    await writeServer({ opacity: 0.67, label: 'server-only-authored' });
    current = await lane.acceptedAfter(previous, {
      opacity: '0.67',
      text: server.label,
    });
    assert.equal(
      sha256(await fs.readFile(path.join(run.root, 'semantic/Client.jsx'))),
      clientDigest,
    );
    const rendered = await lane.observe({ opacity: '0.67' });
    assert(
      (
        await fs.readFile(path.join(run.output, rendered.http.evidence), 'utf8')
      ).includes(server.label),
    );
    const initialCurrent = current;
    const write = run.report.inputMutations.findLast(
      (mutation) => mutation.file === 'semantic/Server.jsx',
    );
    const watcherObservation = await sourceWatcherObservation(
      lane,
      'semantic/Server.jsx',
      write.writtenAt,
      sourceEventBaseline,
    );
    current = watcherObservation.current;
    assert.equal(current.canonical.identity, initialCurrent.canonical.identity);
    return {
      previous,
      initialCurrent,
      current,
      clientDigest,
      rendered,
      watcherObservation,
    };
  });

  await row('T18', async () => {
    const previous = await lane.state();
    await lane.browser.click('#counter');
    const before = await lane.browser.expect(
      { text: client.label + ' 1' },
      '#counter',
    );
    const startedAt = Date.now();
    const sourceEventBaseline = (await lane.events()).at(-1)?.sequence ?? 0;
    await writeClient({ opacity: 0.79, label: 'client-refresh-edit' });
    current = await lane.acceptedAfter(previous);
    const after = await lane.browser.expect(
      { opacity: '0.79', text: client.label },
      '#counter',
    );
    const behavior =
      before.boot === after.boot && after.text.endsWith(' 1')
        ? 'state-preserving-fast-refresh'
        : 'full-reload';
    const hydrationErrors = lane.browser.events.filter(
      (event) =>
        event.at >= startedAt &&
        /hydration|did not match|server rendered/i.test(event.message),
    );
    assert.deepEqual(hydrationErrors, []);
    const initialCurrent = current;
    const write = run.report.inputMutations.findLast(
      (mutation) => mutation.file === 'semantic/Client.jsx',
    );
    const watcherObservation = await sourceWatcherObservation(
      lane,
      'semantic/Client.jsx',
      write.writtenAt,
      sourceEventBaseline,
    );
    current = watcherObservation.current;
    assert.equal(current.canonical.identity, initialCurrent.canonical.identity);
    return {
      previous,
      initialCurrent,
      current,
      before,
      after,
      behavior,
      hydrationErrors,
      watcherObservation,
      transformed: await lane.load('semantic/Client.jsx'),
    };
  });

  await row('T19', async () => {
    const currentState = await lane.state();
    const [rsc, clientLoader] = await Promise.all([
      lane.load('semantic/Server.jsx'),
      lane.load('semantic/Client.jsx'),
    ]);
    assert(rsc.ok && clientLoader.ok);
    const pairs = [
      assertPairedImports(
        rsc.javascript,
        currentState.descriptor,
        path.join(run.root, 'semantic/Server.jsx'),
      ),
      assertPairedImports(
        clientLoader.javascript,
        currentState.descriptor,
        path.join(run.root, 'semantic/Client.jsx'),
      ),
    ];
    const serverBrowser = await lane.browser.observe('#shared-server');
    const clientBrowser = await lane.browser.observe('#shared-client');
    for (const key of ['color', 'margin', 'borderTopWidth'])
      assert.equal(serverBrowser[key], clientBrowser[key], key);
    return {
      current: currentState,
      rsc,
      clientLoader,
      pairs,
      serverBrowser,
      clientBrowser,
    };
  });

  await row('T20', async () => {
    const previous = await lane.state();
    const consumptionStartedAt = Date.now();
    await lane.browser.click('#lazy-link');
    const browser = await lane.browser.expect(
      {
        text: 'lazy-initial',
        padding: '23px',
        color: 'rgb(34, 85, 119)',
        opacity: '0.84',
      },
      '#lazy-style',
    );
    const currentState = await lane.state();
    const loader = await lane.load('semantic/Lazy.jsx');
    assert.equal(loader.ok, true);
    const pair = assertPairedImports(
      loader.javascript,
      currentState.descriptor,
      path.join(run.root, 'semantic/Lazy.jsx'),
    );
    await lane.browser.reloadHealthy();
    return {
      previous,
      consumptionStartedAt,
      current: currentState,
      browser,
      loader,
      pair,
      firstBrowserNavigation: true,
    };
  });

  await row('T21', async () => {
    await lane.browser.click('#show-dynamic');
    const browser = await lane.browser.expect(
      {
        text: 'dynamic component',
        opacity: '0.93',
        padding: '23px',
        color: 'rgb(34, 85, 119)',
      },
      '#dynamic-style',
    );
    const pointerBeforeLoader = await lane.state();
    const loader = await lane.load('semantic/Dynamic.jsx');
    assert.equal(loader.ok, true);
    const selected = await descriptorFromLoader(
      run,
      'semantic/Dynamic.jsx',
      loader,
    );
    assert.equal(selected.descriptor.projectId, lane.options.projectId);
    assert.equal(selected.descriptor.sessionId, lane.options.sessionId);
    const currentState = await lane.state();
    return {
      current: currentState,
      pointerBeforeLoader,
      selected,
      browser,
      loader,
      pair: selected.pair,
      firstDynamicAppearance: true,
    };
  });

  await row('T22', async () => {
    const previous = await lane.state();
    const oldPage = await lane.browser.newPage();
    await lane.browser.navigate(lane.origin, oldPage);
    const old = await lane.browser.expect(
      { color: 'rgb(34, 85, 119)', padding: '23px' },
      '#server-style',
      oldPage,
    );
    await oldPage.setOfflineMode(true);
    await writeDefinition(
      fixtureDefinition({
        padding: '27px',
        color: '#117744',
        background: '#ccddee',
      }),
    );
    current = await lane.acceptedAfter(previous, {
      color: 'rgb(17, 119, 68)',
      padding: '27px',
      background: 'rgb(204, 221, 238)',
    });
    await assertDescriptor(previous.descriptor, previous.canonical);
    const retained = await lane.browser.observe('#server-style', oldPage);
    assert.equal(retained.color, old.color);
    assert.equal(retained.padding, old.padding);
    await lane.browser.click('#lazy-link');
    const navigated = await lane.browser.expect(
      { padding: '27px', color: 'rgb(17, 119, 68)' },
      '#lazy-style',
    );
    await oldPage.setOfflineMode(false);
    await lane.browser.reloadHealthy('/', oldPage);
    const reloaded = await lane.browser.expect(
      { padding: '27px', color: 'rgb(17, 119, 68)' },
      '#server-style',
      oldPage,
    );
    await oldPage.close();
    await lane.browser.reloadHealthy();
    return {
      previous,
      current,
      old,
      retained,
      navigated,
      reloaded,
      oldClientScope:
        'disconnected historical tab; deliberate reload adopts current snapshot',
    };
  });

  await row('T23', async () => {
    const previous = await lane.state();
    await run.write('app/page.jsx', nextBrokenSource);
    const overlayBefore = await frameworkFailure(lane, 'missing-next-only');
    const sourceEventBaseline = (await lane.events()).at(-1)?.sequence ?? 0;
    await writeServer({
      opacity: 0.82,
      label: 'semantic-edit-with-overlay-open',
    });
    current = await lane.acceptedAfter(previous);
    assert.notEqual(current.canonical.identity, previous.canonical.identity);
    const overlayAfter = await lane.browser.overlayText();
    assert(overlayAfter.includes('missing-next-only'));
    const initialCurrent = current;
    const write = run.report.inputMutations.findLast(
      (mutation) => mutation.file === 'semantic/Server.jsx',
    );
    const watcherObservation = await sourceWatcherObservation(
      lane,
      'semantic/Server.jsx',
      write.writtenAt,
      sourceEventBaseline,
    );
    current = watcherObservation.current;
    assert.equal(current.canonical.identity, initialCurrent.canonical.identity);
    await run.write('app/page.jsx', home);
    await lane.browser.reloadHealthy();
    return {
      previous,
      initialCurrent,
      current,
      overlayBefore,
      overlayAfter,
      watcherObservation,
      final: await lane.observe({ opacity: '0.82', text: server.label }),
    };
  });

  await row('T24', async () => {
    const previous = await lane.state();
    await lane.browser.navigate(lane.origin + '/empty');
    const empty = await lane.browser.expect(
      { text: 'empty route' },
      '#empty-route',
    );
    assert(Object.values(empty.cssVariables).includes('27px'));
    await lane.browser.navigate(lane.origin + '/does-not-exist');
    const missing = await lane.browser.expect(
      { text: 'controlled not found' },
      '#not-found-route',
    );
    assert(Object.values(missing.cssVariables).includes('27px'));
    await run.write(
      'app/fail/page.jsx',
      `export default function Fail() { throw new Error('PMS_CONTROLLED_NEXT_ROUTE_FAILURE'); }
`,
    );
    const failed = await until(async () => {
      const result = await fetch(lane.origin + '/fail', {
        signal: AbortSignal.timeout(10000),
      });
      if (result.status === 500) return result;
      await result.arrayBuffer();
      return false;
    }, 'actual new runtime-error route discovery and HTTP500');
    assert.equal(failed.status, 500);
    await lane.browser.navigate(lane.origin + '/fail');
    const boundary = await lane.browser.expect(
      { text: 'controlled error boundary' },
      '#error-boundary',
    );
    assert(Object.values(boundary.cssVariables).includes('27px'));
    await run.remove('app/fail/page.jsx');
    await lane.browser.reloadHealthy();
    current = await lane.state();
    assert.equal(current.canonical.identity, previous.canonical.identity);
    assert.deepEqual(current.status.revision, previous.status.revision);
    return {
      previous,
      current,
      empty,
      missing,
      failedRouteStatus: failed.status,
      boundary,
    };
  });

  await row('T25', async () => {
    const previous = await lane.state();
    const options = lane.options;
    await lane.stop();
    assert((await fs.stat(path.join(run.root, '.next'))).isDirectory());
    current = await lane.start('dev-unchanged-restart');
    assert.notEqual(
      current.descriptor.sessionId,
      previous.descriptor.sessionId,
    );
    assert.equal(current.canonical.identity, previous.canonical.identity);
    const stale = await lane.load('semantic/Server.jsx', { options });
    assert.equal(stale.ok, false);
    return {
      previous,
      current,
      stale,
      cacheRetained: true,
      browser: await lane.browser.expect({
        opacity: String(server.opacity),
        text: server.label,
      }),
    };
  });

  await row('T26', async () => {
    const previous = await lane.state();
    await lane.stop();
    await writeServer({ opacity: 0.44, label: 'edited-while-stopped' });
    current = await lane.start('dev-stopped-source-edit');
    assert.notEqual(current.canonical.identity, previous.canonical.identity);
    return {
      previous,
      current,
      cacheRetained: true,
      browser: await lane.browser.expect({
        opacity: '0.44',
        text: server.label,
      }),
    };
  });

  await row('T27', async () => {
    const previous = await lane.state();
    await run.write(
      'semantic/StoppedOrphan.jsx',
      `import { create } from '../.pandamstyle/design.js';
export const orphan = create({ orphan: { opacity: 0.1234 } });
`,
    );
    const beforeStop = await lane.acceptedAfter(previous);
    assert(
      hasOpacityDeclaration(
        await fs.readFile(beforeStop.descriptor.stylesCSS, 'utf8'),
        0.1234,
      ),
    );
    await lane.stop();
    await run.remove('semantic/StoppedOrphan.jsx');
    await run.rename('semantic/Lazy.jsx', 'semantic/LazyStopped.jsx');
    await run.write(
      'app/lazy/page.jsx',
      `import Lazy from '../../semantic/LazyStopped.jsx';
export default function Page() { return <main><Lazy /></main>; }
`,
    );
    await writeDefinition(
      fixtureDefinition({
        padding: '29px',
        color: '#334455',
        background: '#eeddcc',
      }),
    );
    current = await lane.start('dev-stopped-membership-definition');
    const css = await fs.readFile(
      path.join(run.root, '.pandamstyle/styles.css'),
      'utf8',
    );
    assert(!hasOpacityDeclaration(css, 0.1234));
    await lane.browser.click('#lazy-link');
    const browser = await lane.browser.expect(
      { padding: '29px', color: 'rgb(51, 68, 85)', text: 'lazy-initial' },
      '#lazy-style',
    );
    const loader = await lane.load('semantic/LazyStopped.jsx');
    assert.equal(loader.ok, true);
    await lane.browser.reloadHealthy();
    return {
      previous,
      beforeStop,
      current,
      browser,
      loader,
      removedRuleAbsent: true,
      cacheRetained: true,
    };
  });

  await row('T28', async () => {
    const previous = await lane.state();
    const workers = await Promise.all(
      Array.from({ length: 12 }, () => lane.loadProcess('semantic/Server.jsx')),
    );
    const results = await Promise.all(
      workers.map(async (worker) => {
        const outcome = await worker.handle.closed;
        assert.equal(outcome.code, 0);
        return readJSON(worker.resultFile);
      }),
    );
    assert.equal(new Set(results.map((result) => result.workerPid)).size, 12);
    assert(results.every((result) => result.ok));
    assert.equal(
      new Set(results.map((result) => sha256(result.javascript))).size,
      1,
    );
    for (const result of results)
      assertPairedImports(
        result.javascript,
        previous.descriptor,
        path.join(run.root, 'semantic/Server.jsx'),
      );
    current = await lane.state();
    assert.equal(current.canonical.identity, previous.canonical.identity);
    assert.equal(current.descriptor.snapshotId, previous.descriptor.snapshotId);
    const owner = assertOneOwner(await lane.events(), current.descriptor);
    return {
      previous,
      current,
      owner,
      results,
      browser: await lane.browser.expect({ opacity: String(server.opacity) }),
    };
  });

  await row('T29', async () => {
    const previous = await lane.state();
    const oldOptions = lane.options;
    await lane.stop('SIGKILL');
    const afterCrash = await captureCanonical(run);
    assert.equal(afterCrash.identity, previous.canonical.identity);
    await writeServer({ opacity: 0.46, label: 'crash-recovery-actual-source' });
    current = await lane.start('dev-crash-recovery');
    assert.notEqual(
      current.descriptor.sessionId,
      previous.descriptor.sessionId,
    );
    const unavailable = await lane.load('semantic/Server.jsx', {
      options: oldOptions,
    });
    const foreign = await lane.load('semantic/Server.jsx', {
      options: {
        ...oldOptions,
        credentialFile: lane.options.credentialFile,
      },
    });
    assert.equal(unavailable.ok, false);
    assert.equal(foreign.ok, false);
    assert.equal(foreign.error.code, 'PMS_TRANSPORT_IDENTITY');
    return {
      previous,
      afterCrash,
      current,
      unavailable,
      foreign,
      cacheRetained: true,
      browser: await lane.browser.expect({
        opacity: '0.46',
        text: server.label,
      }),
    };
  });

  await row('T30', async () => {
    const primary = await lane.state();
    await secondary.stop();
    await writeFixture(
      secondary.run,
      fixtureDefinition({
        systemId: 'isolated-project-b',
        padding: '37px',
        color: '#aa2244',
        background: '#abcabc',
      }),
    );
    await secondary.run.write('next.config.mjs', nextConfigSource());
    const other = await secondary.start('two-project-b');
    assert.notEqual(other.descriptor.projectId, primary.descriptor.projectId);
    assert.notEqual(other.descriptor.sessionId, primary.descriptor.sessionId);
    const otherBrowser = await secondary.browser.expect({
      padding: '37px',
      color: 'rgb(170, 34, 68)',
    });
    const primaryExpected = {
      ...expectedDefinitionStyle(definition),
      opacity: String(server.opacity),
    };
    const primaryBrowser = await lane.browser.expect(primaryExpected);
    await secondary.run.write(
      'semantic/Shared.jsx',
      sharedSource({ margin: "token('missing.project-b')" }),
    );
    const isolatedFailure = await secondary.invalid(other, 'PMS_UNKNOWN_TOKEN');
    const cross = await lane.load('semantic/Server.jsx', {
      options: {
        ...secondary.options,
        credentialFile: lane.options.credentialFile,
      },
    });
    assert.equal(cross.ok, false);
    assert.equal(cross.error.code, 'PMS_TRANSPORT_IDENTITY');
    const primaryAfter = await lane.state();
    assert.equal(primaryAfter.canonical.identity, primary.canonical.identity);
    await secondary.run.write('semantic/Shared.jsx', sharedSource());
    await secondary.acceptedAfter({ status: isolatedFailure.status });
    await secondary.browser.reloadHealthy();
    await secondary.stop();
    return {
      primary,
      other,
      otherBrowser,
      primaryExpected,
      primaryBrowser,
      isolatedFailure,
      cross,
      primaryAfter,
      finalPrimaryBrowser: await lane.browser.observe(),
    };
  });

  await row('T31', async () => {
    const previous = await lane.state();
    const port = await unusedPort();
    const conflict = await run.run(
      lane.runtime,
      [
        lane.cli,
        'dev',
        '--turbopack',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(port),
      ],
      'conflicting-owner',
      {
        environment: { PMS_QUALIFICATION_MODE: 'semantic-dev' },
        timeoutMs: 60000,
      },
    );
    assert.notEqual(conflict.code, 0);
    assert(conflict.text.includes('PMS_OUTPUT_OWNED'));
    current = await lane.state();
    assert.equal(current.canonical.identity, previous.canonical.identity);
    assert.equal(current.descriptor.snapshotId, previous.descriptor.snapshotId);
    return {
      previous,
      current,
      conflict,
      browser: await lane.browser.expect({ opacity: String(server.opacity) }),
    };
  });

  await row('T32', async () => {
    const previous = await lane.state();
    const sourceEventBaseline = (await lane.events()).at(-1)?.sequence ?? 0;
    const sessionDirectory = path.dirname(previous.descriptor.directory);
    await fs.chmod(sessionDirectory, 0o500);
    let interrupted;
    try {
      await writeServer({
        opacity: 0.48,
        label: 'canonical-accepted-before-transport-failure',
      });
      interrupted = await until(async () => {
        const status = await readJSON(lane.options.statusFile);
        if (
          status.state !== 'transport-error' ||
          status.receipt?.generationId <= previous.descriptor.generationId
        )
          return false;
        const canonical = await captureCanonical(run);
        assert.notEqual(canonical.identity, previous.canonical.identity);
        const descriptor = await readJSON(lane.options.currentFile);
        assert.equal(descriptor.snapshotId, previous.descriptor.snapshotId);
        const loader = await lane.load('semantic/Server.jsx');
        assert.equal(loader.ok, false);
        return {
          status,
          canonical,
          descriptor,
          loader,
          operation: {
            kind: 'chmod',
            directory: sessionDirectory,
            mode: '0500',
          },
        };
      }, 'canonical commit succeeded but real transport filesystem write failed');
    } finally {
      await fs.chmod(sessionDirectory, 0o700);
    }
    const recoveredLoader = await lane.load('semantic/Server.jsx');
    assert.equal(recoveredLoader.ok, true);
    const initialCurrent = await lane.state();
    const write = run.report.inputMutations.findLast(
      (mutation) => mutation.file === 'semantic/Server.jsx',
    );
    // Target the member the current loader actually consumes. The source
    // watcher can supersede the explicit transport-recovery revision even
    // when the canonical bytes are identical.
    const watcherObservation = await sourceWatcherObservation(
      lane,
      'semantic/Server.jsx',
      write.writtenAt,
      sourceEventBaseline,
    );
    current = watcherObservation.current;
    assert.notEqual(
      current.descriptor.snapshotId,
      previous.descriptor.snapshotId,
    );
    await lane.browser.reloadHealthy();
    await lane.browser.expect({ opacity: '0.48', text: server.label });
    const cssFile = current.descriptor.stylesCSS;
    const exactCSS = await fs.readFile(cssFile);
    let corrupt;
    try {
      await fs.chmod(cssFile, 0o644);
      const negative =
        '/* intentional corrupt immutable member negative control */\n';
      await fs.writeFile(cssFile, negative);
      const loader = await lane.load('semantic/Server.jsx');
      assert.equal(loader.ok, false);
      assert.equal(loader.error.code, 'PMS_TRANSPORT_CORRUPT');
      const canonical = await captureCanonical(run);
      assert.equal(canonical.identity, current.canonical.identity);
      corrupt = {
        loader,
        canonical,
        file: cssFile,
        originalSha256: sha256(exactCSS),
        corruptBytes: await run.archiveBytes(negative),
      };
    } finally {
      await fs.writeFile(cssFile, exactCSS);
      await fs.chmod(cssFile, 0o444);
    }
    const repairedLoader = await lane.load('semantic/Server.jsx');
    assert.equal(repairedLoader.ok, true);
    await lane.browser.reloadHealthy();
    const final = await lane.state();
    return {
      previous,
      interrupted,
      recoveredLoader,
      initialCurrent,
      watcherObservation,
      current,
      corrupt,
      repairedLoader,
      final,
      browser: await lane.browser.expect({
        opacity: '0.48',
        ...expectedDefinitionStyle(definition),
      }),
    };
  });

  await row('T33', async () => {
    await lane.stop();
    await run.write(
      'next.config.mjs',
      nextConfigSource({
        retention: {
          maxSnapshots: 2,
          maxBytes: 128 * 1024 * 1024,
          maxPins: 16,
        },
      }),
    );
    const first = await lane.start('retention-capacity-two');
    const oldOptions = lane.options;
    await writeServer({ opacity: 0.5, label: 'retention-second-snapshot' });
    const second = await lane.acceptedAfter(first, { opacity: '0.5' });
    await assertDescriptor(first.descriptor, first.canonical);
    await writeServer({ opacity: 0.52, label: 'retention-limit-disk-source' });
    const failure = await until(async () => {
      const status = await readJSON(lane.options.statusFile);
      if (
        status.state !== 'transport-error' ||
        !/retention/i.test(JSON.stringify(status.error))
      )
        return false;
      const canonical = await captureCanonical(run);
      assert.notEqual(canonical.identity, second.canonical.identity);
      assert.deepEqual(status.receipt.associationRevision, status.revision);
      assert(status.receipt.generationId > second.descriptor.generationId);
      assert.notEqual(
        canonical.canonicalSetDigest,
        second.canonical.canonicalSetDigest,
      );
      assert.deepEqual(status.receipt.artifactRevision, status.revision);
      assert.equal(
        status.receipt.designSystem.registryDigest,
        canonical.artifacts.registryDigest,
      );
      const events = await lane.events();
      assert(
        events.some(
          (event) =>
            event.type === 'semantic-committed' &&
            event.generationId === status.receipt.generationId,
        ),
      );
      return { status, canonical, events };
    }, 'valid new canonical receipt with retention transport failure');
    assert(/retention/i.test(JSON.stringify(failure.status.error)));
    const pointer = await readJSON(lane.options.currentFile);
    assert.equal(pointer.snapshotId, second.descriptor.snapshotId);
    await assertDescriptor(first.descriptor, first.canonical);
    await assertDescriptor(second.descriptor, second.canonical);
    const refusedInput = await lane.load('semantic/Server.jsx');
    assert.equal(refusedInput.ok, false);
    await lane.stop();
    const restarted = await lane.start('retention-expiration-restart');
    assert.notEqual(
      restarted.descriptor.sessionId,
      second.descriptor.sessionId,
    );
    const oldSession = await lane.load('semantic/Server.jsx', {
      options: {
        ...oldOptions,
        credentialFile: lane.options.credentialFile,
      },
    });
    assert.equal(oldSession.ok, false);
    const browser = await lane.browser.expect({
      opacity: '0.52',
      text: server.label,
    });
    await lane.stop();
    await run.write('next.config.mjs', nextConfigSource());
    current = await lane.start('retention-default-restored');
    return {
      first,
      second,
      failure,
      refusedInput,
      pointer,
      restarted,
      oldSession,
      browser,
      current,
      expirationPolicy:
        'session close releases old pins; new session requires reload',
    };
  });

  await row('T34', async () =>
    freshOracle(lane, secondary, 'final-fresh-oracle'),
  );

  await row('T35', async () => {
    const previous = await lane.state();
    await run.write(
      'semantic/unauthorized-author.css',
      '.unauthorized { color: red; }\n',
    );
    await run.write(
      'semantic/Server.jsx',
      "import './unauthorized-author.css';\n" + serverSource(server),
    );
    const failure = await lane.invalid(previous);
    assert(failure.events.some((event) => event.type === 'semantic-invalid'));
    const loader = await lane.load('semantic/Server.jsx');
    assert.equal(loader.ok, false);
    const browser = await frameworkFailure(lane, 'unauthorized-author.css');
    // Keep the now-unimported CSS fixture until development has stopped. Its
    // independent deletion can supersede the repaired source's observation,
    // and rejected CSS is not guaranteed to be an admitted watched module.
    const sourceEventBaseline = (await lane.events()).at(-1)?.sequence ?? 0;
    await run.write('semantic/Server.jsx', serverSource(server));
    current = await lane.acceptedAfter({ status: failure.status });
    const initialCurrent = current;
    const write = run.report.inputMutations.findLast(
      (mutation) => mutation.file === 'semantic/Server.jsx',
    );
    const watcherObservation = await sourceWatcherObservation(
      lane,
      'semantic/Server.jsx',
      write.writtenAt,
      sourceEventBaseline,
    );
    current = watcherObservation.current;
    assert.equal(current.canonical.identity, initialCurrent.canonical.identity);
    await lane.browser.reloadHealthy();
    return {
      previous,
      initialCurrent,
      failure,
      loader,
      browser,
      current,
      watcherObservation,
      repairedBrowser: await lane.browser.expect({
        opacity: String(server.opacity),
      }),
    };
  });

  await row('T36', async () => {
    const previous = await lane.state();
    const original =
      "'use client';\n// original provenance café 🐼\n" +
      clientSource(client).replace("'use client';\n", '');
    await run.write('semantic/Client.jsx', original);
    current = await lane.acceptedAfter(previous);
    const inputMap = {
      version: 3,
      sources: ['intentional-original-map.jsx'],
      sourcesContent: [original],
      names: [],
      mappings: 'AAAA',
    };
    const loader = await lane.load('semantic/Client.jsx', { inputMap });
    assert.equal(loader.ok, true);
    assert.equal(loader.sourceMap?.version, 3);
    assert.deepEqual(
      loader.sourceMap?.sources,
      [path.resolve(run.root, 'semantic/Client.jsx')],
      'The transformed module map must point to its authored source, not the supplied misleading map',
    );
    assert.deepEqual(
      loader.sourceMap?.sourcesContent,
      [original],
      'The transformed module map must retain the authored source text',
    );
    assert.equal(typeof loader.sourceMap?.mappings, 'string');
    assert.notEqual(loader.sourceMap.mappings, 'AAAA');
    const require = createRequire(
      path.join(run.root, 'node_modules/@pandamstyle/compiler/package.json'),
    );
    const { parse } = require('@babel/parser');
    const ast = parse(loader.javascript, {
      sourceType: 'module',
      plugins: ['jsx'],
    });
    assert(
      ast.program.directives.some(
        (directive) => directive.value.value === 'use client',
      ),
    );
    await lane.browser.reloadHealthy();
    await lane.browser.click('#client-recipe');
    const hydrated = await lane.browser.expect(
      { text: 'recipe loud', opacity: '1' },
      '#client-recipe',
    );
    const invalid = original.replace(
      "token('colors.surface')",
      "token('colors.ink')",
    );
    const index = invalid.indexOf("'colors.ink'");
    const line = invalid.slice(0, index).split('\n').length;
    const column = invalid.slice(0, index).split('\n').at(-1).length + 1;
    await run.write('semantic/Client.jsx', invalid);
    const failure = await lane.invalid(current, 'PMS_TOKEN_NOT_PUBLIC');
    const protocol = failure.events
      .filter((event) => event.type === 'semantic-invalid')
      .at(-1).result;
    const diagnostic = assertLocatedDiagnostic(protocol, {
      file: 'semantic/Client.jsx',
      line,
      column,
      code: 'PMS_TOKEN_NOT_PUBLIC',
    });
    const sourceEventBaseline = (await lane.events()).at(-1)?.sequence ?? 0;
    await run.write('semantic/Client.jsx', original);
    current = await lane.acceptedAfter({ status: failure.status });
    const initialCurrent = current;
    const write = run.report.inputMutations.findLast(
      (mutation) => mutation.file === 'semantic/Client.jsx',
    );
    const watcherObservation = await sourceWatcherObservation(
      lane,
      'semantic/Client.jsx',
      write.writtenAt,
      sourceEventBaseline,
    );
    current = watcherObservation.current;
    assert.equal(current.canonical.identity, initialCurrent.canonical.identity);
    await lane.browser.reloadHealthy();
    return {
      previous,
      initialCurrent,
      current,
      loader,
      hydrated,
      failure,
      diagnostic,
      watcherObservation,
      sourceDigest: sha256(original),
      sourceMapPolicy: 'SDK null preserved; no runtime stack remapping claimed',
    };
  });

  await row('T37', async () => {
    const previous = await lane.state();
    const source = home.replace('next-initial', 'next-only-final');
    await run.write('app/page.jsx', source);
    const browser = await lane.browser.expect(
      { text: 'next-only-final' },
      '#next-only',
    );
    const loader = await lane.load('app/page.jsx', { source });
    assert.equal(loader.ok, true);
    assert.equal(loader.javascript, source);
    current = await lane.state();
    assert.equal(current.canonical.identity, previous.canonical.identity);
    assert.deepEqual(current.status.revision, previous.status.revision);
    assert.equal(current.descriptor.snapshotId, previous.descriptor.snapshotId);
    return { previous, current, loader, browser, appOnlyPassthrough: true };
  });

  await row('T38', async () => ({
    closure: await auditClosure(run.root, {
      secrets: [...lane.secrets, ...secondary.secrets],
    }),
    packages: run.report.packedPackages,
    lockSha256: run.report.installLockSha256,
  }));

  await row('T39', async () => {
    const proofBytes = await fs.readFile(strictProof.file);
    const proof = JSON.parse(proofBytes);
    assert.equal(proof.pass, true);
    assert.equal(proof.runId, strictProof.runId);
    assert.equal(proof.scope, 'pandamstyle-next-external-qualification');
    const bytes = await fs.readFile(proof.sourceReport.path);
    assert.equal(sha256(bytes), proof.sourceReport.sha256);
    const result = JSON.parse(bytes);
    assert.equal(result.pass, true);
    assert(result.production.length >= 5 && result.dev.length >= 20);
    assert(proof.negativeCases >= 10);
    assert.equal(proof.nodeBoundary.minimum, '22.12.0');
    assert.equal(proof.nodeBoundary.production, 'passed');
    assert(/passed/.test(proof.nodeBoundary.dev));
    const packageComparison = Object.fromEntries(
      Object.entries(run.report.packedPackages).map(([name, metadata]) => [
        name,
        {
          current: metadata.sha256,
          strict: result.packages[name]?.sha256,
          identical: metadata.sha256 === result.packages[name]?.sha256,
        },
      ]),
    );
    assert(
      Object.values(packageComparison).every((value) => value.identical),
      'Strict webpack proof and semantic-dev lanes use different packed candidates',
    );
    return {
      proofFile: strictProof.file,
      proofSha256: sha256(proofBytes),
      proof,
      packageComparison,
      exactCurrentRun: true,
    };
  });

  await row('T40', async () => unsupportedCases(lane, run.report.tarballs));
  return { server, client, shared, definition, current: await lane.state() };
}

export async function unsupportedCases(lane, tarballs) {
  const run = lane.run;
  const previous = await lane.state();
  const contract = `import assert from 'node:assert/strict';
import { withPandamStyle } from '@pandamstyle/next';
const base = { definition: './definition.mjs', roots: ['semantic'], backend: 'turbopack', publicationMode: 'semantic-dev' };
const rejected = error => error.code === 'PMS_UNSUPPORTED_FEATURE';
for (const options of [ { ...base, backend: undefined }, { ...base, backend: 'other' },
  { ...base, backend: 'webpack' }, { ...base, publicationMode: undefined }, { ...base, publicationMode: 'unknown' } ])
  assert.throws(() => withPandamStyle(options), rejected);
await assert.rejects(withPandamStyle(base)({})('phase-production-build', {}), rejected);
await assert.rejects(withPandamStyle({ ...base, publicationMode: 'strict' })({})('phase-development-server', {}), rejected);
await assert.rejects(withPandamStyle(base)({})('phase-development-server', {}), rejected);
for (const config of [{ output: 'standalone' }, { output: 'export' }, { reactCompiler: true }, { adapterPath: './other.mjs' }])
  await assert.rejects(withPandamStyle(base)(config)('phase-development-server', {}), rejected);
await assert.rejects(import('@pandamstyle/next/src/coordinator.js'), error => error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
await assert.rejects(import('@pandamstyle/compiler/src/api/accepted-snapshot.js'), error => error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
console.log(JSON.stringify({ pass: true, synchronous: 5, phaseAndSupervisor: 3, configuration: 4, privatePaths: 2 }));
`;
  await run.write('.qualification/unsupported-contract.mjs', contract);
  const publicContract = await run.run(
    lane.runtime,
    ['.qualification/unsupported-contract.mjs'],
    'unsupported-public-contract',
  );
  assert.equal(publicContract.code, 0, publicContract.text);
  const commands = [];
  for (const args of [
    ['dev', '--webpack'],
    ['dev', '--turbo'],
    ['build', '--turbopack', '--webpack'],
    ['dev', '--turbopack', './other-root'],
  ]) {
    const command = await run.run(
      lane.runtime,
      [lane.cli, ...args],
      'unsupported-cli-' + commands.length,
      { timeoutMs: 45000 },
    );
    assert.notEqual(command.code, 0);
    assert(command.text.includes('PMS_UNSUPPORTED_FEATURE'));
    commands.push(command);
  }
  for (const [command, mode] of [
    ['build', 'semantic-dev'],
    ['dev', 'strict'],
  ]) {
    const args = [lane.cli, command, '--turbopack'];
    if (command === 'dev') args.push('--port', String(await unusedPort()));
    const outcome = await run.run(
      lane.runtime,
      args,
      'unsupported-mode-' + mode,
      { environment: { PMS_QUALIFICATION_MODE: mode }, timeoutMs: 45000 },
    );
    assert.notEqual(outcome.code, 0);
    assert(outcome.text.includes('PMS_UNSUPPORTED_FEATURE'));
    commands.push(outcome);
  }
  const negativeRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'pms-next-unsupported-'),
  );
  const negative = new MatrixRun(
    path.join(run.output, 'unsupported-version'),
    run.report.label + '-unsupported-version',
    negativeRoot,
  );
  await negative.initialize();
  await negative.write(
    'package.json',
    JSON.stringify({ private: true, type: 'module' }),
  );
  const peerFailure = await negative.run(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      ...tarballs,
      'next@16.3.7',
      'react@19.2.8',
      'react-dom@19.2.8',
    ],
    'peer-refusal',
  );
  assert.notEqual(peerFailure.code, 0);
  assert(
    peerFailure.text.includes('ERESOLVE') &&
      peerFailure.text.includes('16.3.8'),
  );
  const hostTarball = tarballs.find((file) =>
    path.basename(file).startsWith('pandamstyle-next-'),
  );
  assert(hostTarball);
  const installed = await negative.run(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      ...tarballs.filter((file) => file !== hostTarball),
      'next@16.3.7',
      'react@19.2.8',
      'react-dom@19.2.8',
    ],
    'actual-unsupported-next-install',
  );
  assert.equal(installed.code, 0, installed.text);
  const hostDirectory = path.join(
    negativeRoot,
    'node_modules/@pandamstyle/next',
  );
  await fs.mkdir(hostDirectory, { recursive: true });
  const extracted = await negative.run(
    'tar',
    [
      '--extract',
      '--gzip',
      '--file',
      hostTarball,
      '--directory',
      hostDirectory,
      '--strip-components=1',
    ],
    'extract-unchanged-host-tarball',
  );
  assert.equal(extracted.code, 0);
  assert.equal(
    (await readJSON(path.join(negativeRoot, 'node_modules/next/package.json')))
      .version,
    '16.3.7',
  );
  await negative.write(
    'negative.mjs',
    `import assert from 'node:assert/strict';
import { withPandamStyle } from '@pandamstyle/next';
assert.throws(() => withPandamStyle({ backend: 'turbopack', publicationMode: 'semantic-dev', definition: { systemId: 'negative' }, roots: ['semantic'] }),
  error => error.code === 'PMS_UNSUPPORTED_FEATURE' && error.message.includes('16.3.7'));
console.log(JSON.stringify({ pass: true, installedNext: '16.3.7', hostTarballUnchanged: true }));
`,
  );
  const versionRefusal = await negative.run(
    lane.runtime,
    ['negative.mjs'],
    'runtime-version-refusal',
  );
  assert.equal(versionRefusal.code, 0, versionRefusal.text);
  const lock = await fs.readFile(path.join(negativeRoot, 'package-lock.json'));
  await fs.writeFile(path.join(negative.output, 'package-lock.json'), lock);
  await negative.save();
  const after = await lane.state();
  assert.equal(after.canonical.identity, previous.canonical.identity);
  return {
    previous,
    after,
    publicContract,
    commands,
    peerFailure,
    unsupportedVersion: {
      root: negativeRoot,
      installed,
      extracted,
      versionRefusal,
      lockSha256: sha256(lock),
      hostTarballSha256: sha256(await fs.readFile(hostTarball)),
      note: 'Real unsupported Next install plus extraction of unchanged host tarball exercises runtime refusal after genuine npm peer rejection; no framework/package metadata patch.',
    },
  };
}

export async function runStrictProduction(lane, context) {
  const run = lane.run;
  await lane.stop();
  await lane.browser.close();
  lane.browser = null;
  await run.remove('semantic/unauthorized-author.css').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await run.write('next.config.mjs', nextConfigSource());
  const hostDir = path.dirname(lane.options.currentFile);
  const sessionsDir = path.join(hostDir, 'sessions');
  const cases = [];
  let source = { ...context.server };
  let definition = context.definition;
  const node = run.report.runtimeNode.replace(/^v/, '');

  const build = async (name, extraEnvironment = {}) => {
    const beforeSessions = new Set(await fs.readdir(sessionsDir));
    const snapshots = [];
    const captureErrors = [];
    let active = Promise.resolve();
    let busy = false;
    const capture = () => {
      if (busy) return;
      busy = true;
      active = (async () => {
        const descriptor = await readJSON(lane.options.currentFile);
        if (
          beforeSessions.has(descriptor.sessionId) ||
          snapshots.some((value) => value.snapshotId === descriptor.snapshotId)
        )
          return;
        const snapshot = await captureDescriptor(run, descriptor);
        snapshots.push({ ...snapshot, descriptor });
      })()
        .catch((error) => {
          if (error.code !== 'ENOENT')
            captureErrors.push({ code: error.code, message: error.message });
        })
        .finally(() => {
          busy = false;
        });
    };
    const timer = setInterval(capture, 20);
    let outcome;
    try {
      outcome = await run.run(
        lane.runtime,
        [lane.cli, 'build', '--turbopack'],
        name,
        {
          environment: {
            PMS_QUALIFICATION_MODE: 'strict',
            ...extraEnvironment,
          },
          timeoutMs: 300000,
        },
      );
    } finally {
      clearInterval(timer);
      await active;
    }
    const newSessions = (await fs.readdir(sessionsDir)).filter(
      (session) => !beforeSessions.has(session),
    );
    const events = (
      await Promise.all(
        newSessions.map((session) =>
          readEvents(path.join(sessionsDir, session, 'events.jsonl')),
        ),
      )
    ).flat();
    const eventsEvidence = name + '-events.json';
    await fs.writeFile(
      path.join(run.output, eventsEvidence),
      JSON.stringify(events, null, 2) + '\n',
    );
    return {
      outcome,
      snapshots,
      captureErrors,
      newSessions,
      events,
      eventsEvidence,
      canonical: await captureCanonical(run),
    };
  };

  const render = async (name, expected) => {
    const port = await unusedPort();
    const origin = 'http://127.0.0.1:' + port;
    const server = run.start(
      lane.runtime,
      [
        lane.nextCLI,
        'start',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(port),
      ],
      name + '-server',
      { environment: { PMS_QUALIFICATION_MODE: 'strict' } },
    );
    const browser = new BrowserProbe(run, origin);
    try {
      const http = await until(
        async () => {
          const response = await fetch(origin, {
            signal: AbortSignal.timeout(3000),
          });
          return response.status === 200 ? response : false;
        },
        'strict production HTTP200',
        45000,
      );
      const html = await http.text();
      const htmlEvidence = name + '-ssr.html';
      await fs.writeFile(path.join(run.output, htmlEvidence), html);
      assert(html.includes(source.label));
      await browser.launch();
      const serverBrowser = await browser.expect(expected);
      await browser.click('#counter');
      const counter = await browser.expect(
        { text: context.client.label + ' 1' },
        '#counter',
      );
      await browser.click('#client-recipe');
      const recipe = await browser.expect(
        { text: 'recipe loud', opacity: '1' },
        '#client-recipe',
      );
      await browser.click('#lazy-link');
      const lazy = await browser.expect(
        { padding: expected.padding, color: expected.color },
        '#lazy-style',
      );
      await browser.navigate(origin + '/production-not-found');
      const missing = await browser.expect(
        { text: 'controlled not found' },
        '#not-found-route',
      );
      assert(Object.values(missing.cssVariables).includes(expected.padding));
      const hydrationErrors = browser.events.filter((event) =>
        /hydration|did not match|server rendered/i.test(event.message),
      );
      assert.deepEqual(hydrationErrors, []);
      return {
        httpStatus: http.status,
        htmlEvidence,
        serverBrowser,
        counter,
        recipe,
        lazy,
        missing,
        hydrationErrors,
      };
    } finally {
      await browser.close();
      await run.stop(server);
    }
  };

  const positive = async (name, expected) => {
    const previous = await captureCanonical(run);
    const result = await build(name);
    assert.equal(result.outcome.code, 0, result.outcome.text);
    assert.equal(result.newSessions.length, 1);
    const order = assertProductionOrder(result.events, result.newSessions[0]);
    const prepared = result.snapshots.find(
      (snapshot) => snapshot.descriptor.accepted === false,
    );
    assert(
      prepared,
      'No actual complete candidate bytes captured while Next consumed them',
    );
    for (const member of prepared.members) {
      const canonical = result.canonical.members.find(
        (value) => value.file === member.file,
      );
      assert.equal(member.sha256, canonical.sha256, member.file);
      assert.equal(member.bytes, canonical.bytes, member.file);
    }
    const browser = await render(name, expected);
    return { name, pass: true, previous, result, order, browser };
  };

  const negative = async (name, expectedText) => {
    const previous = await captureCanonical(run);
    const result = await build(name);
    assert.notEqual(
      result.outcome.code,
      0,
      'Failed strict build reported success',
    );
    assert(
      result.outcome.text.includes(expectedText),
      'Expected framework/semantic error absent',
    );
    assert.equal(result.canonical.identity, previous.identity);
    assert(!result.events.some((event) => event.type === 'semantic-committed'));
    return { name, pass: true, previous, result, canonicalRetained: true };
  };

  const productionCase = async (name, operation) => {
    const startedAt = Date.now();
    try {
      cases.push({
        ...(await operation()),
        name,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error) {
      cases.push({
        name,
        pass: false,
        elapsedMs: Date.now() - startedAt,
        error: { code: error.code, message: error.message, stack: error.stack },
      });
    }
    run.report.production = cases;
    process.stdout.write(
      `${run.report.label} production ${name} ${cases.at(-1).pass ? 'PASS' : 'FAIL'}\n`,
    );
    await run.save();
  };
  const rgb = (hex) =>
    'rgb(' +
    [1, 3, 5]
      .map((index) => parseInt(hex.slice(index, index + 2), 16))
      .join(', ') +
    ')';
  const expectedCurrent = {
    padding: definition.tokens.spacing.md.value,
    color: rgb(definition.tokens.colors.ink.value),
    background: rgb(definition.tokens.colors.paper.value),
    opacity: String(source.opacity),
  };
  await fs.rm(path.join(run.root, '.next'), { recursive: true, force: true });
  await productionCase('strict-clean', () =>
    positive('strict-clean', expectedCurrent),
  );
  await productionCase('strict-repeat-1', () =>
    positive('strict-repeat-1', expectedCurrent),
  );
  await productionCase('strict-repeat-2', () =>
    positive('strict-repeat-2', expectedCurrent),
  );
  source = {
    ...source,
    opacity: 0.69,
    label: 'strict-source-and-definition-edit',
  };
  definition = fixtureDefinition({
    padding: '41px',
    color: '#556677',
    background: '#ffeecc',
  });
  await run.write('semantic/Server.jsx', serverSource(source));
  await run.write('definition.mjs', definitionSource(definition));
  const expected = {
    padding: '41px',
    color: 'rgb(85, 102, 119)',
    background: 'rgb(255, 238, 204)',
    opacity: '0.69',
  };
  await productionCase('strict-source-definition', () =>
    positive('strict-source-definition', expected),
  );

  const badDefinition = structuredClone(definition);
  badDefinition.tokens.colors.text = {
    ref: 'colors.strict-missing',
    visibility: 'public',
  };
  await run.write('definition.mjs', definitionSource(badDefinition));
  await productionCase('strict-semantic-failure', () =>
    negative('strict-semantic-failure', 'colors.strict-missing'),
  );
  await run.write('definition.mjs', definitionSource(definition));

  source = { ...source, opacity: 0.71, label: 'strict-rsc-failed-candidate' };
  await run.write('semantic/Server.jsx', serverSource(source));
  await run.write(
    'app/rsc-failure/page.jsx',
    `import { useState } from 'react';
export default function InvalidServer() { const [value] = useState(0); return <p>{value}</p>; }
`,
  );
  await productionCase('strict-rsc-failure', () =>
    negative('strict-rsc-failure', 'useState'),
  );
  await run.remove('app/rsc-failure/page.jsx');

  source = {
    ...source,
    opacity: 0.72,
    label: 'strict-missing-import-candidate',
  };
  await run.write('semantic/Server.jsx', serverSource(source));
  await run.write(
    'app/missing/page.jsx',
    `import Missing from './unresolved-next-only.jsx';
export default function MissingRoute() { return <Missing />; }
`,
  );
  await productionCase('strict-missing-import', () =>
    negative('strict-missing-import', 'unresolved-next-only'),
  );
  await run.remove('app/missing/page.jsx');

  source = {
    ...source,
    opacity: 0.74,
    label: 'strict-prerender-failed-candidate',
  };
  await run.write('semantic/Server.jsx', serverSource(source));
  await run.write(
    'app/fail/page.jsx',
    `export default function Fail() { throw new Error('PMS_STRICT_CONTROLLED_PRERENDER'); }
`,
  );
  await productionCase('strict-prerender-failure', () =>
    negative('strict-prerender-failure', 'PMS_STRICT_CONTROLLED_PRERENDER'),
  );
  await run.remove('app/fail/page.jsx');
  await productionCase('strict-repair', () =>
    positive('strict-repair', { ...expected, opacity: '0.74' }),
  );

  await productionCase('strict-post-completion-process-failure', async () => {
    const attempts = [];
    for (let index = 0; index < 3; index++) {
      const previous = await captureCanonical(run);
      source = {
        ...source,
        opacity: 0.76 + index / 1000,
        label: 'strict-after-boundary-' + index,
      };
      await run.write('semantic/Server.jsx', serverSource(source));
      const result = await build('strict-post-boundary-attempt-' + index, {
        PMS_QUALIFICATION_EXIT_AFTER_BOUNDARY: '1',
      });
      attempts.push({ previous, result });
      if (result.outcome.code !== 0) {
        assert(
          result.events.some(
            (event) => event.type === 'framework-build-complete',
          ),
        );
        const exit = result.events.find(
          (event) => event.type === 'installed-next-exited',
        );
        assert(exit && exit.exitCode !== 0);
        assert(
          !result.events.some((event) => event.type === 'semantic-committed'),
        );
        assert.equal(result.canonical.identity, previous.identity);
        return {
          pass: true,
          attempts,
          injectedOperation:
            'actual observer process exit89 after public completion event',
          canonicalRetained: true,
        };
      }
    }
    throw new Error(
      'No real post-completion nonzero Next exit obtained within bounded attempts',
    );
  });
  source = { ...source, opacity: 0.77, label: 'strict-final-repaired' };
  await run.write('semantic/Server.jsx', serverSource(source));
  await productionCase('strict-final-repair', () =>
    positive('strict-final-repair', { ...expected, opacity: '0.77' }),
  );
  const closure = await auditClosure(run.root, { secrets: lane.secrets });
  return {
    node,
    pass: cases.length === 11 && cases.every((item) => item.pass),
    cases,
    closure,
    canonical: await captureCanonical(run),
    authority:
      'public completion followed by actual installed Next exit zero and owner-process canonical commit',
  };
}

export async function main(arguments_ = process.argv.slice(2)) {
  const outputArgument = arguments_.shift();
  assert(
    outputArgument,
    'Usage: qualify-next-semantic-dev.mjs OUTPUT --strict-result FILE --strict-run-id ID [--consumer-root ROOT]',
  );
  const options = {};
  while (arguments_.length) {
    const name = arguments_.shift();
    assert(
      ['--strict-result', '--strict-run-id', '--consumer-root'].includes(name),
      'Unknown argument: ' + name,
    );
    const value = arguments_.shift();
    assert(value, 'Missing value for ' + name);
    options[name] = value;
  }
  assert(
    options['--strict-result'] && options['--strict-run-id'],
    'A fresh strict result and exact run identity are required',
  );
  assert.equal(process.version, 'v22.22.0');
  const output = path.resolve(outputArgument);
  await fs.mkdir(output, { recursive: true });
  const script = fileURLToPath(import.meta.url);
  const repo = path.resolve(path.dirname(script), '../..');
  const executedSource = await fs.readFile(script);
  await fs.writeFile(
    path.join(output, 'executed-harness.mjs.txt'),
    executedSource,
  );
  const strictFile = path.resolve(options['--strict-result']);
  const strictBytes = await fs.readFile(strictFile);
  const proof = JSON.parse(strictBytes);
  assert.equal(proof.pass, true);
  assert.equal(proof.runId, options['--strict-run-id']);
  const strictReportBytes = await fs.readFile(proof.sourceReport.path);
  assert.equal(sha256(strictReportBytes), proof.sourceReport.sha256);
  const strictReport = JSON.parse(strictReportBytes);
  assert.equal(strictReport.pass, true);
  const report = {
    scope: 'pandamstyle-packed-next-semantic-dev',
    startedAt: new Date().toISOString(),
    pass: false,
    executedSourceSha256: sha256(executedSource),
    toolchain: {
      next: '16.3.8',
      react: '19.2.8',
      reactDom: '19.2.8',
      puppeteerCore: '25.9.0',
      orchestratorNode: process.version,
    },
    packages: {},
    lanes: [],
    matrix: { pass: false, totalRows: 0, laneCount: 0 },
    strictProduction: { pass: false, lanes: [] },
    strictRegression: {
      runId: proof.runId,
      proofFile: strictFile,
      proofSha256: sha256(strictBytes),
      sourceReport: proof.sourceReport,
      pass: true,
    },
  };
  const save = () =>
    fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
  await save();
  const packRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'pms-semantic-pack-'),
  );
  const packing = new MatrixRun(
    path.join(output, 'packing'),
    'packing',
    packRoot,
  );
  await packing.initialize();
  packing.report.scope = 'pandamstyle-packaging-operation';
  delete packing.report.rows;
  const packs = path.join(output, 'tarballs');
  await fs.mkdir(packs, { recursive: true });
  const tarballs = [];
  for (const slug of ['core', 'compiler', 'vite', 'next']) {
    const commandOptions = { cwd: path.join(repo, 'packages', slug) };
    const packed = await packing.run(
      'npm',
      ['pack', '--json', '--pack-destination', packs],
      'pack-' + slug,
      commandOptions,
    );
    assert.equal(packed.code, 0, packed.text);
    const metadata = JSON.parse(packed.text)[0];
    const tarball = path.join(packs, metadata.filename);
    const bytes = await fs.readFile(tarball);
    const hash = sha256(bytes);
    const repeated = await packing.run(
      'npm',
      ['pack', '--json', '--pack-destination', packs],
      'pack-' + slug + '-repeat',
      commandOptions,
    );
    assert.equal(repeated.code, 0, repeated.text);
    assert.equal(sha256(await fs.readFile(tarball)), hash);
    assert(metadata.files.some((member) => member.path === 'LICENSE'));
    assert(metadata.files.some((member) => member.path === 'ATTRIBUTIONS.md'));
    assert.equal(
      hash,
      strictReport.packages[metadata.name]?.sha256,
      'Fresh strict proof and current package differ: ' + metadata.name,
    );
    report.packages[metadata.name] = {
      ...metadata,
      sha256: hash,
      repeatPack: 'identical',
      evidence: path.relative(output, tarball),
    };
    tarballs.push(tarball);
  }
  packing.report.packages = report.packages;
  packing.report.pass = true;
  await packing.save();
  await save();
  report.experimentalCompatibility = {
    required: false,
    support: 'experimental',
    lanes: [],
  };
  for (const node of ['22.22.0', '24.21.0', '26.10.0']) {
    const label = 'node' + node.split('.')[0];
    const consumerRoot = options['--consumer-root']
      ? path.resolve(
          options['--consumer-root'] + (node === '22.22.0' ? '' : '-' + label),
        )
      : await fs.mkdtemp(
          path.join(os.tmpdir(), 'pms-semantic-packed-' + label + '-'),
        );
    const secondaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'pms-semantic-packed-oracle-' + label + '-'),
    );
    const run = new MatrixRun(path.join(output, label), label, consumerRoot);
    const oracle = new MatrixRun(
      path.join(output, label, 'fresh-oracle'),
      label + '-oracle',
      secondaryRoot,
    );
    const laneReport = {
      node,
      consumerRoot,
      oracleRoot: secondaryRoot,
      pass: false,
      matrix: { pass: false, rows: run.report.rows },
      strictProduction: { pass: false, cases: [] },
      reportFile: path.relative(output, path.join(run.output, 'report.json')),
    };
    laneReport.required = node !== '26.10.0';
    (laneReport.required
      ? report.lanes
      : report.experimentalCompatibility.lanes
    ).push(laneReport);
    let lane;
    let secondary;
    try {
      await run.initialize();
      await oracle.initialize();
      oracle.report.scope = 'pandamstyle-independent-fresh-oracle';
      await writeFixture(run);
      await run.write('next.config.mjs', nextConfigSource());
      await packedInstall(run, tarballs);
      await writeFixture(oracle);
      await oracle.write('next.config.mjs', nextConfigSource());
      await packedInstall(oracle, tarballs);
      if (!laneReport.required) {
        for (const instance of [run, oracle]) {
          const betaInstall = await instance.run(
            'npm',
            [
              'install',
              '--save-dev',
              '--save-exact',
              '--no-audit',
              '--no-fund',
              'node26-semantic@npm:node@26.10.0',
            ],
            'install-experimental-node26',
          );
          assert.equal(betaInstall.code, 0, betaInstall.text);
          const metadata = await readJSON(
            path.join(
              instance.root,
              'node_modules/node26-semantic/package.json',
            ),
          );
          assert.equal(metadata.version, '26.10.0');
          instance.report.dependencies['node26-semantic'] = metadata.version;
          const lock = await fs.readFile(
            path.join(instance.root, 'package-lock.json'),
          );
          await fs.writeFile(
            path.join(instance.output, 'package-lock.json'),
            lock,
          );
          instance.report.installLockSha256 = sha256(lock);
        }
      }
      const runtime =
        node === '22.22.0'
          ? process.execPath
          : path.join(
              run.root,
              'node_modules/' +
                (laneReport.required ? 'node24-semantic' : 'node26-semantic') +
                '/bin/node',
            );
      lane = new DevLane(run, runtime);
      secondary = new DevLane(oracle, runtime);
      await lane.initialize();
      await secondary.initialize();
      assert.equal(run.report.runtimeNode, 'v' + node);
      run.report.packedPackages = report.packages;
      run.report.tarballs = tarballs;
      oracle.report.packedPackages = report.packages;
      oracle.report.tarballs = tarballs;
      let context;
      try {
        context = await runDevMatrix(lane, secondary, {
          file: strictFile,
          runId: proof.runId,
        });
      } catch (error) {
        laneReport.matrixFatal = { message: error.message, stack: error.stack };
        await lane.stop();
        if (lane.browser != null) {
          await lane.browser.close();
          lane.browser = null;
        }
        for (const directory of ['app', 'semantic', 'external'])
          await fs.rm(path.join(run.root, directory), {
            recursive: true,
            force: true,
          });
        await writeFixture(run);
        await run.write('next.config.mjs', nextConfigSource());
        context = {
          server: { opacity: 0.61, label: 'server-initial' },
          client: { opacity: 0.73, label: 'client-initial' },
          definition: fixtureDefinition(),
        };
        if (lane.options == null)
          await lane.start('production-independent-fixture-repair');
      }
      laneReport.matrix = {
        pass:
          !laneReport.matrixFatal &&
          run.report.rows.length === 40 &&
          run.report.rows.every((row) => row.status === 'PASS'),
        rows: run.report.rows,
      };
      try {
        laneReport.strictProduction = await runStrictProduction(lane, context);
      } catch (error) {
        laneReport.strictProduction = {
          pass: false,
          cases: run.report.production,
          error: { message: error.message, stack: error.stack },
        };
      }
    } catch (error) {
      laneReport.error = { message: error.message, stack: error.stack };
    } finally {
      for (const instance of [lane, secondary]) {
        if (instance == null) continue;
        await instance.stop().catch((error) => {
          laneReport.cleanupError = error.message;
        });
        if (instance.browser != null)
          await instance.browser.close().catch((error) => {
            laneReport.browserCleanupError = error.message;
          });
      }
      await run.close().catch((error) => {
        laneReport.captureError = error.message;
      });
      for (const handle of [...oracle.processes]) await oracle.stop(handle);
      await oracle.captureSources().catch((error) => {
        laneReport.oracleCaptureError = error.message;
      });
      delete oracle.report.rows;
      oracle.report.pass = !laneReport.oracleCaptureError;
      await oracle.save();
      laneReport.pass =
        laneReport.matrix.pass &&
        laneReport.strictProduction.pass &&
        !laneReport.error &&
        !laneReport.cleanupError &&
        !laneReport.captureError;
      if (
        !options['--consumer-root'] &&
        process.env.PMS_KEEP_NEXT_QUALIFICATION_TMP !== '1' &&
        !laneReport.captureError &&
        !laneReport.oracleCaptureError &&
        !laneReport.cleanupError &&
        !laneReport.browserCleanupError
      ) {
        await fs.rm(consumerRoot, { recursive: true });
        await fs.rm(secondaryRoot, { recursive: true });
        laneReport.disposableRootsRemovedAfterCapture = true;
      }
      await save();
    }
  }
  report.matrix = {
    pass:
      report.lanes.length === 2 &&
      report.lanes.every((lane) => lane.matrix.pass),
    totalRows: report.lanes.reduce(
      (count, lane) => count + lane.matrix.rows.length,
      0,
    ),
    laneCount: report.lanes.length,
  };
  report.strictProduction = {
    pass:
      report.lanes.length === 2 &&
      report.lanes.every((lane) => lane.strictProduction.pass),
    lanes: report.lanes.map((lane) => ({
      node: lane.node,
      ...lane.strictProduction,
    })),
  };
  report.pass =
    report.matrix.pass &&
    report.strictProduction.pass &&
    report.lanes.every((lane) => lane.pass);
  report.finishedAt = new Date().toISOString();
  await save();
  const inventory = await fileInventory(output);
  await fs.writeFile(
    path.join(output, 'SHA256SUMS.txt'),
    inventory
      .filter((member) => member.file !== 'SHA256SUMS.txt')
      .map((member) => member.sha256 + '  ' + member.file)
      .join('\n') + '\n',
  );
  process.stdout.write(
    JSON.stringify({
      pass: report.pass,
      report: path.join(output, 'report.json'),
      rows: report.matrix.totalRows,
    }) + '\n',
  );
  process.exitCode = report.pass ? 0 : 1;
  return report;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // Incomplete async work must never leave the CLI with a successful exit.
  process.exitCode = 1;
  main().catch((error) => {
    process.stderr.write((error.stack ?? String(error)) + '\n');
    process.exitCode = 1;
  });
}
