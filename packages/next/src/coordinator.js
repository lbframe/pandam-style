/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createProjectSession, PmsError } from '@pandamstyle/compiler';
import { createHostBridge } from '@pandamstyle/compiler/host';
import {
  atomicJSON,
  createTransportStore,
  transportError,
} from './transport-snapshot.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const same = (a, b) =>
  a != null &&
  b != null &&
  a.projectId === b.projectId &&
  a.sessionId === b.sessionId &&
  a.revisionId === b.revisionId;
const within = (parent, file) => {
  const relative = path.relative(parent, file);
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
};
function canonicalPath(file) {
  let cursor = path.resolve(file);
  const suffix = [];
  while (true) {
    try {
      return path.join(fs.realpathSync.native(cursor), ...suffix);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}
function fileDigest(file) {
  try {
    return digest(fs.readFileSync(file));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function errorDetails(error) {
  return {
    code: error.code ?? error.diagnostics?.[0]?.code ?? 'PMS_COORDINATOR_ERROR',
    message: error.message,
    diagnostics: error.diagnostics ?? null,
    details: error.details ?? null,
  };
}

async function readDefinition(definitionPath, value) {
  if (definitionPath == null) return { definition: value, digest: null };
  const hash = fileDigest(definitionPath);
  if (hash == null)
    throw transportError(
      'PMS_INVALID_DEFINITION',
      'Definition entry is missing.',
      {
        owner: 'coordinator-definition-input',
        file: definitionPath,
        digest: hash,
      },
    );
  const url = pathToFileURL(definitionPath);
  url.searchParams.set('pandamstyle', hash);
  let definition;
  try {
    const imported = await import(url.href);
    definition = imported.default ?? imported;
    if (typeof definition === 'function') definition = await definition();
  } catch (error) {
    throw transportError('PMS_INVALID_DEFINITION', error.message, {
      owner: 'coordinator-definition-input',
      file: definitionPath,
      digest: hash,
    });
  }
  if (fileDigest(definitionPath) !== hash)
    throw transportError(
      'PMS_STALE_REVISION',
      'Definition entry changed while it was being loaded.',
      { file: definitionPath },
    );
  return { definition, digest: hash };
}

/** One session and publication queue, with no host semantic graph or compiler. */
export async function createCoordinator(
  root,
  options,
  { command = 'dev', distDir = '.next', onEvent } = {},
) {
  if (
    options?.backend !== 'turbopack' ||
    !['dev', 'build'].includes(command) ||
    (command === 'dev' && options.publicationMode !== 'semantic-dev') ||
    (command === 'build' && options.publicationMode === 'semantic-dev')
  )
    throw transportError(
      'PMS_UNSUPPORTED_FEATURE',
      'Coordinator requires explicit Turbopack semantic-dev development or strict production.',
    );
  if (
    options.publicationMode != null &&
    !['semantic-dev', 'strict'].includes(options.publicationMode)
  )
    throw transportError(
      'PMS_UNSUPPORTED_FEATURE',
      'Unsupported publication mode.',
    );
  root = canonicalPath(root);
  const outDir = canonicalPath(
    path.resolve(root, options.outDir ?? '.pandamstyle'),
  );
  const nextDir = canonicalPath(path.resolve(root, distDir));
  const hostDir = path.join(root, '.pandamstyle-next-host', digest(outDir));
  const roots = (options.roots ?? []).map((file) =>
    canonicalPath(path.resolve(root, file)),
  );
  if (
    roots.length === 0 ||
    options.definition == null ||
    within(outDir, nextDir) ||
    within(nextDir, outDir) ||
    within(outDir, hostDir) ||
    within(hostDir, outDir)
  )
    throw transportError(
      'PMS_UNSUPPORTED_FEATURE',
      'Explicit source roots and separate canonical/Next/transport outputs are required.',
    );
  for (const directory of roots) {
    if (
      !within(root, directory) ||
      within(outDir, directory) ||
      within(directory, outDir) ||
      within(nextDir, directory) ||
      within(directory, nextDir) ||
      within(directory, hostDir) ||
      within(hostDir, directory) ||
      !fs.statSync(directory).isDirectory()
    )
      throw transportError(
        'PMS_UNSUPPORTED_FEATURE',
        'Semantic-dev roots must be project directories outside generated outputs.',
      );
  }
  // Project Service now owns cross-process output exclusion for every host.
  // Retain the existing event identity without acquiring a second lease.
  const lease = {
    key: outDir,
    port: 10000 + (parseInt(digest(outDir).slice(0, 8), 16) % 20000),
  };
  let project;
  let watcher;
  let definitionWatcher;
  let transport;
  let tail = Promise.resolve();
  let scheduled = false;
  let closing = false;
  let closed = false;
  let closePromise;
  let revision = null;
  let validatedRevision = null;
  let invalidRevision = null;
  let invalidError = null;
  let definitionError = null;
  let ticket = null;
  let receipt = null;
  let currentRecord = null;
  let completedProduction = false;
  let statusText = null;
  let definitionDigest;
  const definitionPath =
    typeof options.definition === 'string'
      ? path.resolve(root, options.definition)
      : null;
  const retention = {
    maxSnapshots: 256,
    maxBytes: 128 * 1024 * 1024,
    maxPins: 512,
    ...options.acceptedSnapshotRetention,
  };
  const records = new Map();
  // Exact disk observations only for compiler-owned membership. No graph,
  // transformed-byte cache, coverage inference or semantic decisions live here.
  const observations = new Map();
  const events = [];
  const startedAt = performance.now();
  let eventSequence = 0;
  let eventsFile;
  const statusFile = path.join(hostDir, 'status.json');
  const currentFile = path.join(hostDir, 'current.json');
  function emit(type, details = {}) {
    const value = {
      schemaVersion: 1,
      type,
      sequence: ++eventSequence,
      time: new Date().toISOString(),
      elapsedMs: performance.now() - startedAt,
      pid: process.pid,
      projectId: project?.projectId ?? null,
      sessionId: project?.sessionId ?? null,
      revision,
      snapshotId: currentRecord?.descriptor.snapshotId ?? null,
      generationId: receipt?.generationId ?? null,
      ...details,
    };
    if (eventsFile != null) {
      try {
        fs.appendFileSync(eventsFile, JSON.stringify(value) + '\n', {
          mode: 0o600,
        });
      } catch (error) {
        // Durable observation is evidence, never publication authority.
        // Report its failure to in-memory subscribers without recursion.
        value.durableLogError = {
          owner: 'coordinator-observability',
          ...errorDetails(error),
        };
      }
    }
    const event = Object.freeze(value);
    events.push(event);
    if (events.length > 256) events.shift();
    for (const observer of [onEvent, options.onEvent]) {
      try {
        observer?.(event);
      } catch {
        /* observations never authorize publication */
      }
    }
  }
  async function status(state, error = null) {
    const value = {
      schemaVersion: 1,
      projectId: project.projectId,
      sessionId: project.sessionId,
      revision,
      state,
      snapshotId: currentRecord?.descriptor.snapshotId ?? null,
      accepted: currentRecord?.descriptor.accepted ?? false,
      receipt,
      definitionInput:
        definitionPath == null
          ? null
          : { file: definitionPath, digest: definitionDigest },
      error: error == null ? null : errorDetails(error),
    };
    const text = JSON.stringify(value);
    if (text === statusText) return;
    await atomicJSON(statusFile, value);
    statusText = text;
  }
  function enqueue(operation) {
    if (closing || closed)
      return Promise.reject(
        transportError(
          'PMS_SESSION_CLOSED',
          'Coordinator session is closed; restart and reload.',
        ),
      );
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  }
  function schedule() {
    if (scheduled || closing || closed) return;
    scheduled = true;
    void enqueue(async () => {
      scheduled = false;
      await refresh();
    }).catch(() => {});
  }
  function acceptedRevision(result) {
    revision = result.revision;
    emit('revision-accepted');
    schedule();
  }
  function mutation(baseRevision, changed = [], removed = []) {
    return {
      baseRevision,
      mode: 'verified-explicit',
      changed,
      added: [],
      removed,
      renamed: [],
    };
  }
  function seedObservations(snapshot) {
    const retained = new Set();
    for (const artifact of snapshot.moduleArtifacts) {
      retained.add(artifact.source);
      observations.set(artifact.source, artifact.sourceDigest);
    }
    for (const file of observations.keys())
      if (!retained.has(file)) observations.delete(file);
  }
  async function reconcileObservedInputs() {
    if (observations.size === 0) return;
    const changed = [];
    const removed = [];
    const actual = new Map();
    for (const [file, previous] of observations) {
      if (
        command !== 'build' &&
        roots.some((directory) => within(directory, path.resolve(root, file)))
      )
        continue;
      const next = fileDigest(path.resolve(root, file));
      actual.set(file, next);
      if (next !== previous) (next == null ? removed : changed).push(file);
    }
    if (changed.length === 0 && removed.length === 0) return;
    const current = await project.current();
    const result = await project.applyChanges(
      mutation(current.revision, changed, removed),
    );
    for (const [file, hash] of actual) observations.set(file, hash);
    revision = result.revision;
    emit('revision-accepted', {
      inputOwner:
        command === 'build'
          ? 'compiler-consumed-production-source'
          : 'compiler-declared-external-source',
      changed,
      removed,
    });
  }
  async function synchronizeDefinition() {
    if (definitionPath == null) return;
    const hash = fileDigest(definitionPath);
    if (hash === definitionDigest) {
      if (definitionError != null) throw definitionError;
      return;
    }
    let loaded;
    try {
      loaded = await readDefinition(definitionPath, options.definition);
    } catch (error) {
      if (error.code === 'PMS_STALE_REVISION') throw error;
      const current = await project.current();
      const observed = await project.applyChanges({
        ...mutation(current.revision),
        mode: 'full-discovery',
        forceFullDiscovery: true,
      });
      revision = observed.revision;
      definitionDigest = hash;
      error.details = { ...error.details, revision: observed.revision };
      definitionError = error;
      invalidRevision = null;
      emit('revision-accepted', { inputOwner: 'coordinator-definition-input' });
      emit('definition-input-error', {
        error: errorDetails(error),
        definitionInput: { file: definitionPath, digest: hash },
      });
      await status('definition-error', error);
      throw error;
    }
    const current = await project.current();
    const result = await project.applyChanges({
      ...mutation(current.revision),
      definition: loaded.definition,
    });
    definitionDigest = loaded.digest;
    definitionError = null;
    revision = result.revision;
    emit('revision-accepted', {
      inputOwner: 'definition-entry',
      definitionInput: { file: definitionPath, digest: definitionDigest },
    });
  }
  async function flushInputs() {
    await watcher.flush();
    await synchronizeDefinition();
    await reconcileObservedInputs();
    revision = (await project.current()).revision;
  }
  async function acceptTransport(acceptedReceipt) {
    const pin = await project.pinAcceptedSnapshot(
      acceptedReceipt.associationRevision,
      { owner: `next:${project.sessionId}` },
    );
    let owned = false;
    try {
      const descriptor = await transport.materialize(pin.snapshot);
      emit('transport-complete', { descriptor });
      await transport.offer(descriptor);
      const record = { pin, descriptor };
      records.set(descriptor.snapshotId, record);
      currentRecord = record;
      owned = true;
      seedObservations(pin.snapshot);
      emit('transport-offered', { descriptor });
      await status('ready');
      return record;
    } finally {
      if (!owned) await project.releaseAcceptedSnapshot(pin);
    }
  }
  async function refresh() {
    if (closed)
      throw transportError('PMS_SESSION_CLOSED', 'Coordinator is closed.');
    try {
      await flushInputs();
      if (definitionError != null) throw definitionError;
      if (
        command === 'build' &&
        ticket != null &&
        !same(ticket.revision, revision)
      )
        throw transportError(
          'PMS_STALE_REVISION',
          'A source/configuration mutation superseded the prepared Next production build.',
          { preparedRevision: ticket.revision, revision },
        );
      if (
        command === 'build' &&
        completedProduction &&
        !same(receipt?.associationRevision, revision)
      )
        throw transportError(
          'PMS_STALE_REVISION',
          'Source changed after the completed production candidate.',
        );
      if (same(invalidRevision, revision)) throw invalidError;
      if (
        same(validatedRevision, revision) &&
        same(currentRecord?.descriptor.associationRevision, revision) &&
        (command === 'build' || same(receipt?.associationRevision, revision))
      ) {
        await transport.verify(currentRecord.descriptor);
        await status('ready');
        return currentRecord;
      }
      if (!same(validatedRevision, revision)) {
        // Keep the exact attempted disk inputs for repair detection. These are
        // observations, never a successful compiled result or an overlay.
        for (const file of observations.keys()) {
          if (
            roots.some((directory) =>
              within(directory, path.resolve(root, file)),
            )
          )
            observations.set(file, fileDigest(path.resolve(root, file)));
        }
        const result = await project.validate(revision);
        const protocol = await project.agentResult(result.revision);
        emit('diagnostics', {
          result: protocol,
          counters: result.counters,
          fullFallback: result.fullFallback,
          fullFallbackReason: result.fullFallbackReason,
        });
        try {
          options.onDiagnostics?.(protocol);
        } catch {
          /* diagnostics are observations */
        }
        if (!result.ok) {
          invalidRevision = result.revision;
          invalidError = new PmsError(protocol.diagnostics);
          emit('semantic-invalid', { result: protocol });
          await status('semantic-invalid', invalidError);
          throw invalidError;
        }
        validatedRevision = result.revision;
        invalidRevision = null;
        invalidError = null;
      }
      if (command === 'dev' && same(receipt?.associationRevision, revision))
        return await acceptTransport(receipt);
      const generated = await host.readGeneratedArtifacts(revision);
      ticket = await host.preparePublication(revision);
      emit('semantic-prepared', { ticket });
      if (command === 'build') {
        const descriptor = await transport.materialize(
          {
            ...generated,
            projectId: project.projectId,
            sessionId: project.sessionId,
            snapshotId: `prepared-${ticket.ticketId}`,
            associationRevision: generated.revision,
            candidateDigest: ticket.candidateDigest,
          },
          { accepted: false },
        );
        await transport.offer(descriptor);
        currentRecord = { descriptor, pin: null };
        emit('transport-complete', { descriptor });
        emit('transport-offered', { descriptor });
        await status('ready');
        return currentRecord;
      }
      const prepared = ticket;
      await flushInputs();
      ticket = null;
      receipt = await host.commitPrepared(prepared);
      emit('semantic-committed', { receipt });
      return await acceptTransport(receipt);
    } catch (error) {
      const code = error.code ?? error.diagnostics?.[0]?.code;
      if (['PMS_STALE_REVISION', 'PMS_STALE_PUBLICATION'].includes(code)) {
        emit('semantic-rejected', { error: errorDetails(error) });
        if (command === 'dev') schedule();
      } else if (
        !same(invalidRevision, revision) &&
        error !== definitionError
      ) {
        emit('transport-failed', { receipt, error: errorDetails(error) });
        await status('transport-error', error);
      }
      throw error;
    }
  }
  let host;
  try {
    const loaded = await readDefinition(definitionPath, options.definition);
    definitionDigest = loaded.digest;
    project = createProjectSession({
      projectId: options.projectId,
      rootDir: root,
      roots,
      definition: loaded.definition,
      outDir,
      designSystemFile: options.designSystemFile ?? 'design.js',
      useCSSLayers: options.useCSSLayers,
      engineOptions: options.engineOptions,
      auditPolicy: options.auditPolicy,
      acceptedSnapshotRetention: retention,
    });
    host = createHostBridge(project);
    let initial;
    try {
      initial = await project.initialize();
    } catch (error) {
      if (
        error.diagnostics?.some(
          (item) => item.context?.reason === 'output-owned',
        )
      )
        throw transportError(
          'PMS_OUTPUT_OWNED',
          'Another Project Service owns this output directory.',
          { outDir },
        );
      throw error;
    }
    transport = await createTransportStore({
      hostDir,
      projectId: project.projectId,
      sessionId: project.sessionId,
      maxSnapshots: retention.maxSnapshots,
      maxBytes: retention.maxBytes,
    });
    eventsFile = path.join(transport.sessionDir, 'events.jsonl');
    // A retired session has no active owner after the OS lease is acquired.
    // Expire only snapshot directories; preserve its diagnostic trace.
    const sessionsDir = path.dirname(transport.sessionDir);
    for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === project.sessionId) continue;
      const retired = path.join(sessionsDir, entry.name);
      for (const member of fs.readdirSync(retired, { withFileTypes: true }))
        if (member.isDirectory())
          fs.rmSync(path.join(retired, member.name), {
            recursive: true,
            force: true,
          });
    }
    revision = initial.revision;
    emit('revision-accepted', {
      initial: true,
      lease: { key: lease.key, port: lease.port },
    });
    watcher = await project.watch({
      debounceMs: 30,
      onRevision: acceptedRevision,
      onError(error) {
        emit('watcher-error', { error: errorDetails(error) });
        schedule();
      },
    });
    if (!watcher.established)
      throw transportError(
        'PMS_WATCHER_UNAVAILABLE',
        'Compiler watcher did not establish every source root.',
        { startFailures: watcher.startFailures },
      );
    if (definitionPath != null) {
      definitionWatcher = fs.watch(
        path.dirname(definitionPath),
        { persistent: false },
        (_eventType, filename) => {
          if (
            filename == null ||
            String(filename) === path.basename(definitionPath)
          )
            schedule();
        },
      );
      definitionWatcher.on('error', (error) => {
        emit('definition-watch-error', { error: errorDetails(error) });
        schedule();
      });
    }
    await status('pending');
    try {
      await enqueue(refresh);
    } catch (error) {
      if (command === 'build') throw error;
    }
  } catch (error) {
    // Startup failure must release both process-local and OS ownership even
    // when removing an incomplete transport also fails.
    for (const cleanup of [
      () => watcher?.close(),
      () => definitionWatcher?.close(),
      () => transport?.close(),
      () => project?.close(),
    ]) {
      try {
        await cleanup();
      } catch {
        /* preserve the original startup failure */
      }
    }
    throw error;
  }
  function requireIdentity(request) {
    if (
      request?.projectId !== project.projectId ||
      request?.sessionId !== project.sessionId
    )
      throw transportError(
        'PMS_TRANSPORT_FOREIGN_SESSION',
        'Source request belongs to another coordinator project/session.',
      );
  }
  function dependencies(record, artifact) {
    return [
      ...new Set([
        statusFile,
        currentFile,
        ...(definitionPath == null ? [] : [definitionPath]),
        ...(record == null ? [] : [record.descriptor.descriptorFile]),
        // Public compiler snapshot membership supplies these paths. Register
        // external sources even when the requested artifact's own dependency
        // list is empty, so invalid edits can repair without another root edit.
        ...[...observations.keys()]
          .map((file) => path.resolve(root, file))
          .filter(
            (file) => !roots.some((directory) => within(directory, file)),
          ),
        ...(artifact?.dependencies ?? []).map((file) =>
          path.resolve(root, file),
        ),
      ]),
    ];
  }
  const owner = {
    projectId: project.projectId,
    sessionId: project.sessionId,
    root,
    roots,
    outDir,
    hostDir,
    statusFile,
    currentFile,
    eventsFile,
    events,
    registerDescription() {
      return {
        protocol: 1,
        protocolVersion: 1,
        projectId: project.projectId,
        sessionId: project.sessionId,
        root,
        roots,
        outDir,
        hostDir,
        statusFile,
        currentFile,
        eventsFile,
        definitionPath,
        command,
        snapshotId: currentRecord?.descriptor.snapshotId ?? null,
      };
    },
    synchronize() {
      return enqueue(refresh);
    },
    snapshotStats() {
      return enqueue(async () => ({
        compiler: await project.acceptedSnapshotRetentionStats(),
        transport: transport.stats(),
        pins: records.size,
        inputObservations: observations.size,
        externalInputObservations: [...observations.keys()].filter(
          (file) =>
            !roots.some((directory) =>
              within(directory, path.resolve(root, file)),
            ),
        ).length,
      }));
    },
    transform(request) {
      requireIdentity(request);
      if (
        typeof request.sourceDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(request.sourceDigest)
      )
        throw transportError(
          'PMS_STALE_REVISION',
          'Source request requires an exact SHA-256 digest.',
        );
      const file = canonicalPath(path.resolve(root, request.file));
      if (
        !within(root, file) ||
        within(outDir, file) ||
        within(hostDir, file) ||
        within(nextDir, file)
      )
        throw transportError(
          'PMS_UNSUPPORTED_FEATURE',
          'Source request is outside the project source domain.',
        );
      const relative = path.relative(root, file).split(path.sep).join('/');
      return enqueue(async () => {
        let record;
        if (request.allowHistorical === true) {
          record = records.get(request.snapshotId);
          if (record?.pin == null)
            throw transportError(
              'PMS_TRANSPORT_EXPIRED',
              'Historical snapshot is not pinned in this session; reload against the current coordinator.',
            );
        } else {
          await watcher.flush();
          if (
            observations.has(relative) ||
            roots.some((directory) => within(directory, file))
          ) {
            const actual = fileDigest(file);
            if (actual !== request.sourceDigest)
              throw transportError(
                'PMS_STALE_REVISION',
                'Next source input is superseded on disk; it cannot become an overlay.',
                { file: relative, sourceDigest: request.sourceDigest },
              );
            const state = await project.current();
            if (
              observations.has(relative) &&
              observations.get(relative) !== actual &&
              same(state.revision, invalidRevision)
            ) {
              const changed = await project.applyChanges(
                mutation(state.revision, [relative]),
              );
              observations.set(relative, actual);
              revision = changed.revision;
              emit('revision-accepted', {
                inputOwner: 'invalid-source-repair-observation',
                changed: [relative],
                sourceDigest: actual,
              });
            }
          }
          record = await refresh();
          if (
            request.snapshotId != null &&
            request.snapshotId !== record.descriptor.snapshotId
          )
            throw transportError(
              'PMS_STALE_REVISION',
              'Requested snapshot is no longer current.',
              {
                requestedSnapshotId: request.snapshotId,
                currentSnapshotId: record.descriptor.snapshotId,
              },
            );
        }
        let artifact;
        if (record.pin != null) {
          let member = record.pin.snapshot.moduleArtifacts.find(
            (value) => value.source === relative,
          );
          if (
            member == null &&
            request.allowHistorical !== true &&
            roots.some((directory) => within(directory, file))
          ) {
            if (fileDigest(file) !== request.sourceDigest)
              throw transportError(
                'PMS_STALE_REVISION',
                'New source request is superseded on disk.',
                { file: relative },
              );
            const current = await project.current();
            const discovered = await project.applyChanges({
              ...mutation(current.revision),
              mode: 'full-discovery',
              forceFullDiscovery: true,
            });
            revision = discovered.revision;
            emit('revision-accepted', {
              inputOwner: 'declared-root-discovery',
              source: relative,
            });
            record = await refresh();
            member = record.pin.snapshot.moduleArtifacts.find(
              (value) => value.source === relative,
            );
          }
          if (member == null)
            return {
              passthrough: true,
              revision,
              dependencies: dependencies(null, null),
            };
          if (
            request.allowHistorical !== true &&
            fileDigest(file) !== request.sourceDigest
          )
            throw transportError(
              'PMS_STALE_REVISION',
              'Next source input is superseded on disk; it cannot become an overlay.',
              { file: relative, sourceDigest: request.sourceDigest },
            );
          if (
            member.sourceDigest !== request.sourceDigest &&
            request.allowHistorical !== true &&
            fileDigest(file) === request.sourceDigest
          ) {
            const current = await project.current();
            const changed = await project.applyChanges(
              mutation(current.revision, [relative]),
            );
            revision = changed.revision;
            emit('revision-accepted', {
              inputOwner: 'current-disk-reconciliation',
              changed: [relative],
              sourceDigest: request.sourceDigest,
            });
            record = await refresh();
          }
          artifact = await project.readAcceptedArtifact(
            record.pin,
            relative,
            request.sourceDigest,
          );
        } else {
          try {
            artifact = await host.readArtifact(
              record.descriptor.associationRevision,
              relative,
            );
          } catch (error) {
            if (
              error.diagnostics?.some(
                (diagnostic) =>
                  diagnostic.rule === 'session.revision-identity' &&
                  diagnostic.context?.reason === 'uncovered-source' &&
                  diagnostic.context?.covered === false,
              )
            )
              return {
                passthrough: true,
                revision,
                dependencies: dependencies(null, null),
              };
            throw error;
          }
          if (
            artifact.sourceDigest !== request.sourceDigest ||
            fileDigest(file) !== request.sourceDigest
          )
            throw transportError(
              'PMS_STALE_REVISION',
              'Production input differs from the exact prepared compiler source.',
              { file: relative },
            );
          // Every exact compiler source consumed by the strict candidate must
          // still match disk at completion, even before fs.watch delivers its
          // notification. Public Service mutation makes any old ticket stale.
          observations.set(relative, artifact.sourceDigest);
        }
        await transport.verify(record.descriptor);
        emit('module-transformed', {
          file: relative,
          sourceDigest: request.sourceDigest,
          revision: record.descriptor.associationRevision,
          snapshotId: record.descriptor.snapshotId,
          canonicalSetDigest: record.descriptor.canonicalSetDigest ?? null,
          candidateDigest: record.descriptor.candidateDigest,
          historical: request.allowHistorical === true,
        });
        return {
          artifact,
          snapshot: record.descriptor,
          descriptor: record.descriptor,
          revision: record.descriptor.associationRevision,
          dependencies: dependencies(record, artifact),
        };
      }).catch((error) => {
        const declared = (error.diagnostics ?? [])
          .map((diagnostic) => diagnostic.source?.file)
          .filter((file) => typeof file === 'string')
          .map((file) => path.resolve(root, file))
          .filter((file) => within(root, file));
        error.dependencies = [
          ...new Set([...dependencies(currentRecord, null), ...declared]),
        ];
        throw error;
      });
    },
    recordNextProcessExit({ exitCode, signal, childPid }) {
      return enqueue(async () => {
        emit('installed-next-exited', { command, exitCode, signal, childPid });
      });
    },
    recordProductionBoundary() {
      if (command !== 'build')
        return Promise.reject(
          transportError(
            'PMS_UNSUPPORTED_FEATURE',
            'Framework production completion belongs to a strict build.',
          ),
        );
      return enqueue(async () => {
        const observation = {
          observed: true,
          revision:
            ticket?.revision ?? receipt?.associationRevision ?? revision,
          snapshotId: currentRecord?.descriptor.snapshotId ?? null,
        };
        emit('framework-build-complete', {
          authority: 'public-next-onBuildComplete',
          preparedRevision: observation.revision,
          consumedCandidateSnapshotId: observation.snapshotId,
        });
        return observation;
      });
    },
    finishProduction() {
      if (command !== 'build')
        return Promise.reject(
          transportError(
            'PMS_UNSUPPORTED_FEATURE',
            'Production completion cannot authorize semantic-dev publication.',
          ),
        );
      return enqueue(async () => {
        if (completedProduction) return receipt;
        const prepared = ticket;
        if (prepared == null)
          throw transportError(
            'PMS_INVALID_REVISION',
            'Production completion has no exact prepared candidate.',
          );
        try {
          await flushInputs();
          // commitPrepared supplies the authoritative stale-ticket rejection.
          ticket = null;
          receipt = await host.commitPrepared(prepared);
          completedProduction = true;
        } catch (error) {
          emit('semantic-rejected', {
            error: errorDetails(error),
            authority: 'supervisor-next-exit-zero-after-public-completion',
          });
          await status('production-error', error);
          throw error;
        }
        // Next already consumed a complete verified candidate. Once canonical
        // commit succeeds, later observation/exposure cannot turn that success
        // into a failed strict build or imply a rollback of canonical bytes.
        let exposureError = null;
        try {
          emit('semantic-committed', {
            receipt,
            authority: 'supervisor-next-exit-zero-after-public-completion',
            consumedCandidateSnapshotId: currentRecord.descriptor.snapshotId,
          });
        } catch (error) {
          exposureError = error;
        }
        try {
          await acceptTransport(receipt);
        } catch (error) {
          exposureError ??= error;
        }
        if (exposureError != null) {
          try {
            emit('transport-failed', {
              receipt,
              error: errorDetails(exposureError),
              authority: 'completed-production-observation',
            });
          } catch {
            /* canonical receipt remains authoritative if logging also fails */
          }
          try {
            await status('production-complete-transport-error', exposureError);
          } catch {
            /* completion cannot be revoked by a status-file write */
          }
        }
        return receipt;
      });
    },
    close() {
      if (closePromise != null) return closePromise;
      closing = true;
      closePromise = (async () => {
        let firstError = null;
        const cleanup = async (operation) => {
          try {
            await operation();
          } catch (error) {
            firstError ??= error;
          }
        };
        await cleanup(() => watcher.close());
        await cleanup(() => definitionWatcher?.close());
        await cleanup(() => tail);
        await cleanup(async () => {
          if (ticket != null) {
            await host.abortPrepared(ticket);
            ticket = null;
            emit('semantic-aborted');
          }
        });
        await cleanup(() => status('closed'));
        for (const record of records.values())
          if (record.pin != null)
            await cleanup(() => project.releaseAcceptedSnapshot(record.pin));
        await cleanup(() => transport.close());
        await cleanup(() => project.close());
        records.clear();
        observations.clear();
        closed = true;
        await cleanup(() =>
          emit('coordinator-closed', {
            error: firstError == null ? null : errorDetails(firstError),
          }),
        );
        if (firstError != null) throw firstError;
      })();
      return closePromise;
    },
  };
  return Object.freeze(owner);
}
