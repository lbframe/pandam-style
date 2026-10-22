/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import fs from 'node:fs';
import path from 'node:path';
import { acquireProcessOutputLease } from './output-lease.js';
import { recoverPublishedGeneration } from '../artifacts/publication/transaction.js';
import { createProjectSession as createSynchronousSession } from '../project/session/index.js';
import {
  createProjectIdentity,
  createSessionIdentity,
  makePublicationReceipt,
  makeRevisionIdentity,
  sameRevisionIdentity,
} from '../protocol/identities.js';
import { buildDiagnosticsResult } from '../protocol/diagnostics-result-v1.js';
import { Codes, PmsError, diagnostic } from '../protocol/diagnostics.js';
import { normalizeMutationTransaction } from '../project/mutations/transaction.js';
import { perfNow, recordDuration } from '../observability/metrics.js';
import {
  captureAcceptedSnapshot,
  createAcceptedSnapshotStore,
  generatedImportsFor,
} from './accepted-snapshot.js';

// The agent layer's private access to a session (AG-01.1). The symbol is not
// exported from `api/index.js`, so no published entry can reach the hooks.
export const AGENT_SESSION_HOOKS = Symbol('pandamstyle.agentSessionHooks');

// This registry coordinates exclusive output ownership only. It contains no
// project graph, semantic cache, or session object, and entries are removed by
// failed initialization or close().
const activePublisherLeases = new Map();

function canonicalPath(value) {
  const target = path.resolve(value);
  let cursor = target;
  const suffix = [];
  while (true) {
    try {
      const resolved = fs.realpathSync.native(cursor);
      return path.join(resolved, ...suffix);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return target;
      const parent = path.dirname(cursor);
      if (parent === cursor) return target;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function snapshotInput(value, seen = new WeakMap()) {
  if (value == null || typeof value !== 'object') return value;
  const prior = seen.get(value);
  if (prior != null) return prior;
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (value instanceof Map) {
    const copy = new Map();
    seen.set(value, copy);
    for (const [key, item] of value) {
      copy.set(snapshotInput(key, seen), snapshotInput(item, seen));
    }
    return copy;
  }
  if (value instanceof Set) {
    const copy = new Set();
    seen.set(value, copy);
    for (const item of value) copy.add(snapshotInput(item, seen));
    return copy;
  }
  const copy = Array.isArray(value)
    ? []
    : Object.create(Object.getPrototypeOf(value));
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    copy[key] = snapshotInput(value[key], seen);
  }
  return copy;
}

function resolveConfig(config = {}) {
  const rootDir = canonicalPath(config.rootDir ?? process.cwd());
  const projectId = config.projectId ?? rootDir;
  const outDir = canonicalPath(
    path.resolve(rootDir, config.outDir ?? '.pandamstyle'),
  );
  const roots = (config.roots ?? []).map((root) =>
    canonicalPath(path.resolve(rootDir, root)),
  );
  for (const root of roots) {
    if (!isWithin(rootDir, root) || isWithin(outDir, root)) {
      throw new TypeError(
        `Project root must stay inside rootDir and outside outDir: ${root}`,
      );
    }
  }
  return {
    ...config,
    projectId,
    rootDir,
    outDir,
    roots,
    definition: snapshotInput(config.definition),
    engineOptions: snapshotInput(config.engineOptions ?? {}),
    // CE-01.1: browser targets, plain data; absent means the default profile
    // in advisory mode.
    targets: config.targets == null ? null : snapshotInput(config.targets),
  };
}

function isWithin(parent, target) {
  const relative = path.relative(parent, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function resolveMutationPaths(mutation, rootDir, outDir) {
  const resolvePath = (file) => {
    const resolved = canonicalPath(path.resolve(rootDir, file));
    if (!isWithin(rootDir, resolved) || isWithin(outDir, resolved)) {
      throw new TypeError(
        `Mutation path must stay inside rootDir and outside outDir: ${file}`,
      );
    }
    return resolved;
  };
  return {
    ...mutation,
    changed: mutation.changed.map(resolvePath),
    added: mutation.added.map(resolvePath),
    removed: mutation.removed.map(resolvePath),
    renamed: mutation.renamed.map(({ from, to }) => ({
      from: resolvePath(from),
      to: resolvePath(to),
    })),
  };
}

function resolveConfigChanges(changes, normalized) {
  if (changes == null) return undefined;
  for (const key of ['projectId', 'rootDir', 'outDir']) {
    if (changes[key] === undefined) continue;
    const value =
      key === 'projectId'
        ? changes[key]
        : canonicalPath(path.resolve(normalized.rootDir, changes[key]));
    if (value !== normalized[key]) {
      throw new TypeError(
        `Project identity field ${key} cannot change within a session.`,
      );
    }
  }
  const roots =
    changes.roots === undefined
      ? undefined
      : changes.roots.map((root) =>
          canonicalPath(path.resolve(normalized.rootDir, root)),
        );
  for (const root of roots ?? []) {
    if (
      !isWithin(normalized.rootDir, root) ||
      isWithin(normalized.outDir, root)
    ) {
      throw new TypeError(
        `Project root must stay inside rootDir and outside outDir: ${root}`,
      );
    }
  }
  return {
    ...changes,
    ...(roots === undefined ? {} : { roots }),
    ...(changes.definition === undefined
      ? {}
      : { definition: snapshotInput(changes.definition) }),
    ...(changes.engineOptions === undefined
      ? {}
      : { engineOptions: snapshotInput(changes.engineOptions) }),
    ...(changes.targets === undefined
      ? {}
      : {
          targets:
            changes.targets == null ? null : snapshotInput(changes.targets),
        }),
  };
}

function snapshotRevision(value) {
  if (value == null || typeof value !== 'object') return value;
  return Object.freeze({
    projectId: value.projectId,
    sessionId: value.sessionId,
    revisionId: value.revisionId,
  });
}

function immutableCopy(value, seen = new WeakMap()) {
  if (value == null || typeof value !== 'object') return value;
  const prior = seen.get(value);
  if (prior != null) return prior;
  const copy = Array.isArray(value) ? [] : {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    copy[key] = immutableCopy(item, seen);
  }
  return Object.freeze(copy);
}

function snapshotMutation(transaction) {
  if (transaction == null || typeof transaction !== 'object')
    return transaction;
  return {
    ...transaction,
    baseRevision: snapshotRevision(transaction.baseRevision),
    definition: snapshotInput(transaction.definition),
    config: snapshotInput(transaction.config),
    changed: Array.isArray(transaction.changed)
      ? [...transaction.changed]
      : transaction.changed,
    added: Array.isArray(transaction.added)
      ? [...transaction.added]
      : transaction.added,
    removed: Array.isArray(transaction.removed)
      ? [...transaction.removed]
      : transaction.removed,
    renamed: Array.isArray(transaction.renamed)
      ? transaction.renamed.map((move) => ({ ...move }))
      : transaction.renamed,
    sourceOverlays: Array.isArray(transaction.sourceOverlays)
      ? transaction.sourceOverlays.map((entry) => ({ ...entry }))
      : transaction.sourceOverlays,
  };
}

function resolveSourceOverlays(overlays, mutation, rootDir, outDir) {
  if (overlays === undefined) return [];
  if (!Array.isArray(overlays)) {
    throw new TypeError('sourceOverlays must be an array.');
  }
  const writablePaths = new Set([
    ...mutation.changed,
    ...mutation.added,
    ...mutation.renamed.map(({ to }) => to),
  ]);
  const seen = new Set();
  return overlays.map((entry) => {
    if (
      entry == null ||
      typeof entry.file !== 'string' ||
      entry.file === '' ||
      path.isAbsolute(entry.file) ||
      typeof entry.source !== 'string'
    ) {
      throw new TypeError(
        'Each source overlay requires a project-relative file and string source.',
      );
    }
    const file = canonicalPath(path.resolve(rootDir, entry.file));
    if (!isWithin(rootDir, file) || isWithin(outDir, file)) {
      throw new TypeError(
        `Source overlay must stay inside rootDir and outside outDir: ${entry.file}`,
      );
    }
    if (!writablePaths.has(file)) {
      throw new TypeError(
        `Source overlay path must be listed as changed, added or renamed.to: ${entry.file}`,
      );
    }
    if (seen.has(file)) {
      throw new TypeError(`Duplicate source overlay path: ${entry.file}`);
    }
    seen.add(file);
    return { file, source: entry.source };
  });
}

function snapshotTicket(ticket) {
  if (ticket == null || typeof ticket !== 'object') return ticket;
  return {
    ticketId: ticket.ticketId,
    projectId: ticket.projectId,
    sessionId: ticket.sessionId,
    revision: snapshotRevision(ticket.revision),
    candidateDigest: ticket.candidateDigest,
    state: ticket.state,
  };
}

function lifecycleError(code, message, context = {}) {
  return new PmsError([
    diagnostic({
      code,
      phase: 'lifecycle',
      rule: 'session.revision-identity',
      message,
      context,
    }),
  ]);
}

export function createProjectSession(config) {
  let normalized = resolveConfig(config);
  const project = createProjectIdentity(normalized);
  const session = createSessionIdentity(project.projectId);
  const acceptedSnapshots = createAcceptedSnapshotStore({
    projectId: project.projectId,
    sessionId: session.sessionId,
    options: normalized.acceptedSnapshotRetention,
  });
  let implementation = null;
  let revisionId = 0;
  let initializeAttempted = false;
  let initialized = false;
  let validated = null;
  let closed = false;
  let leaseAcquired = false;
  let processOutputLease = null;
  let association = null;
  let lastCandidateDigest = null;
  let nextTicketSequence = 1;
  const tickets = new Map();
  const watchers = new Set();
  const generatedImportMetadata = new Map();
  let operationTail = Promise.resolve();

  const generatedImportsOf = (javascript, sourceFile, designFile) => {
    if (!acceptedSnapshots.enabled) return Object.freeze([]);
    const previous = generatedImportMetadata.get(sourceFile);
    if (
      previous?.javascript === javascript &&
      previous?.designFile === designFile
    )
      return previous.imports;
    const imports = generatedImportsFor(javascript, sourceFile, designFile);
    generatedImportMetadata.set(sourceFile, {
      javascript,
      designFile,
      imports,
    });
    return imports;
  };

  const revision = (id = revisionId) => makeRevisionIdentity(session, id);
  const enqueue = (operation) => {
    const queuedAt = perfNow();
    const result = operationTail.then(async () => {
      recordDuration('project_service_queue_wait_ms', perfNow() - queuedAt);
      const startedAt = perfNow();
      try {
        return await operation();
      } finally {
        recordDuration('project_service_queue_run_ms', perfNow() - startedAt);
      }
    });
    operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const revokeTickets = () => tickets.clear();
  const releasePublisherLease = async () => {
    await processOutputLease?.release();
    processOutputLease = null;
    if (
      leaseAcquired &&
      activePublisherLeases.get(project.outDir) === session.sessionId
    ) {
      activePublisherLeases.delete(project.outDir);
    }
    leaseAcquired = false;
  };
  const acquirePublisherLease = async () => {
    const owner = activePublisherLeases.get(project.outDir);
    if (owner != null && owner !== session.sessionId) {
      throw lifecycleError(
        Codes.INVALID_REVISION,
        'Another active Project Service session owns this output directory.',
        {
          reason: 'output-owned',
          projectId: project.projectId,
          outDir: project.outDir,
        },
      );
    }
    activePublisherLeases.set(project.outDir, session.sessionId);
    leaseAcquired = true;
    try {
      processOutputLease = await acquireProcessOutputLease(project.outDir);
    } catch (error) {
      throw lifecycleError(
        Codes.INVALID_REVISION,
        'Another process holds this output directory lease, or its OS lease address is unavailable.',
        {
          reason: 'output-owned',
          projectId: project.projectId,
          outDir: project.outDir,
          filesystemCode: error.code ?? null,
        },
      );
    }
  };
  const requireOpen = () => {
    if (closed)
      throw lifecycleError(
        Codes.SESSION_CLOSED,
        'The project session is closed.',
        { reason: 'session-closed' },
      );
  };
  const requireInitialized = (operation) => {
    requireOpen();
    if (!initialized || implementation == null) {
      throw lifecycleError(
        Codes.INVALID_REVISION,
        `${operation} requires an initialized session.`,
        { reason: 'not-initialized' },
      );
    }
  };
  const requireRevision = (expected, operation) => {
    requireInitialized(operation);
    if (
      expected == null ||
      typeof expected.projectId !== 'string' ||
      typeof expected.sessionId !== 'string' ||
      !Number.isSafeInteger(expected.revisionId) ||
      expected.revisionId < 1
    ) {
      throw lifecycleError(
        Codes.INVALID_REVISION,
        `${operation} requires a complete project/session/revision identity.`,
        {
          reason: 'malformed-identity',
          expected: expected ?? null,
          current: revision(),
        },
      );
    }
    if (
      expected.projectId !== project.projectId ||
      expected.sessionId !== session.sessionId
    ) {
      throw lifecycleError(
        Codes.INVALID_REVISION,
        `${operation} received a foreign project or session revision.`,
        { reason: 'foreign-identity', expected, current: revision() },
      );
    }
    if (!sameRevisionIdentity(expected, revision())) {
      throw lifecycleError(
        Codes.STALE_REVISION,
        `${operation} requires the exact current project/session/revision identity.`,
        { reason: 'revision-mismatch', expected, current: revision() },
      );
    }
  };
  const requireValidated = (expected, operation, requireValid = false) => {
    requireRevision(expected, operation);
    if (
      validated == null ||
      !sameRevisionIdentity(validated.revision, revision())
    ) {
      throw lifecycleError(
        Codes.INVALID_REVISION,
        `${operation} requires validation of the current revision first.`,
        { reason: 'not-validated' },
      );
    }
    if (requireValid && !validated.ok) {
      throw lifecycleError(
        Codes.INVALID_REVISION,
        `${operation} requires a valid current revision.`,
        { reason: 'revision-invalid' },
      );
    }
  };
  // A design-system identity is reported for the current revision only when
  // the current build was derived from its definition and configuration (I9).
  const currentDesignSystem = () => {
    const identity = implementation?._designSystemIdentity() ?? null;
    return identity?.current === true ? identity : null;
  };
  const protocolResult = (legacy, options = {}) => {
    const identity = currentDesignSystem();
    const generationId = legacy?.generation?.generationId ?? null;
    const committed =
      generationId != null && association?.generationId === generationId
        ? association
        : null;
    return buildDiagnosticsResult({
      legacy,
      revision: revision(legacy?.revisionId ?? revisionId),
      designSystem: {
        systemId: identity?.systemId ?? null,
        registryDigest: identity?.registryDigest ?? null,
      },
      candidateLimit: options.candidateLimit,
      repairDomain:
        identity == null
          ? null
          : (query) => implementation._repairDomain(query),
      rootDir: normalized.rootDir,
      artifactRevision: committed?.artifactRevision ?? null,
      artifactDigest: committed?.artifactDigest ?? null,
      associationRevision:
        committed?.associationRevision ??
        (legacy?.generation?.published === true ? revision() : null),
    });
  };
  const summary = (value, options = {}) =>
    immutableCopy({
      ...value,
      revision: revision(value?.revisionId ?? revisionId),
      agentResult:
        value?.agentResult == null
          ? null
          : protocolResult(value.agentResult, options),
    });

  async function initialize() {
    requireOpen();
    if (initializeAttempted) {
      throw lifecycleError(
        Codes.INVALID_REVISION,
        'initialize() may be called only once per session.',
        { reason: 'already-initialized' },
      );
    }
    initializeAttempted = true;
    try {
      await acquirePublisherLease();
      const recovered = recoverPublishedGeneration(normalized.outDir);
      implementation = createSynchronousSession({
        ...normalized,
        // Snapshot retention is bounded by the public project's rootDir. A
        // caller-supplied config field cannot disable that trust boundary.
        rootDirBoundary: true,
        // The stable Project Service owns the publication strategy. Delta
        // publication persists generation identity and lets the publisher
        // reconcile output across cold session restarts.
        publishVariant: 'session_incremental_publish_css',
        initialGenerationId: recovered?.generationId ?? 0,
      });
      const value = implementation.initialize();
      initialized = true;
      revisionId = value.revisionId;
      association = recovered ?? implementation.current();
      lastCandidateDigest = recovered?.candidateDigest ?? null;
      return summary(value);
    } catch (error) {
      implementation?.close();
      implementation = null;
      acceptedSnapshots.close();
      await releasePublisherLease();
      closed = true;
      normalized = {
        ...normalized,
        roots: [],
        definition: null,
        engineOptions: {},
      };
      throw error;
    }
  }

  async function applyChanges(transaction) {
    requireInitialized('applyChanges()');
    for (const field of ['changed', 'added', 'removed', 'renamed']) {
      if (!Array.isArray(transaction?.[field])) {
        throw new TypeError(
          `applyChanges() requires a complete transaction; ${field} must be an array.`,
        );
      }
    }
    if (typeof transaction?.mode !== 'string') {
      throw new TypeError(
        'applyChanges() requires a mutation transaction mode.',
      );
    }
    requireRevision(transaction?.baseRevision, 'applyChanges()');
    const mutation = resolveMutationPaths(
      normalizeMutationTransaction(transaction),
      normalized.rootDir,
      normalized.outDir,
    );
    const sourceOverlays = resolveSourceOverlays(
      transaction?.sourceOverlays,
      mutation,
      normalized.rootDir,
      normalized.outDir,
    );
    const value = implementation.applyChanges({
      mutation,
      sourceOverlays,
      definition: transaction?.definition,
      config: resolveConfigChanges(transaction?.config, normalized),
    });
    revokeTickets();
    revisionId = value.revisionId;
    validated = null;
    return summary(value);
  }

  async function validate(expectedRevision) {
    requireRevision(expectedRevision, 'validate()');
    validated = null;
    revokeTickets();
    try {
      const value = implementation.validate();
      if (acceptedSnapshots.enabled) {
        const covered = new Set(
          implementation.coverageOrder().map(([file]) => path.resolve(file)),
        );
        for (const file of generatedImportMetadata.keys()) {
          if (!covered.has(path.resolve(file)))
            generatedImportMetadata.delete(file);
        }
      }
      validated = { revision: revision(), ok: value.ok === true };
      if (!validated.ok) revokeTickets();
      return summary(value);
    } catch (error) {
      validated = null;
      revokeTickets();
      throw error;
    }
  }

  async function compile(expectedRevision, options = {}) {
    requireRevision(expectedRevision, 'compile()');
    if (
      validated == null ||
      !sameRevisionIdentity(validated.revision, revision())
    ) {
      await validate(revision());
    }
    if (!validated.ok) {
      revokeTickets();
      const result = implementation.agentResult({ revisionId });
      throw new PmsError(result?.diagnostics ?? []);
    }
    try {
      const candidateDigest =
        options.candidateDigest ?? implementation._publicationCandidateDigest();
      const previousGenerationId = Number.isSafeInteger(
        association?.generationId,
      )
        ? association.generationId
        : 0;
      const targetGenerationId =
        previousGenerationId > 0 &&
        candidateDigest != null &&
        candidateDigest === lastCandidateDigest
          ? previousGenerationId
          : previousGenerationId + 1;
      const result = implementation.compile({
        revisionIdentity: revision(),
        generationId: targetGenerationId,
        candidateDigest,
      });
      const committedGenerationId = result.generationId ?? null;
      const artifactRevision =
        snapshotRevision(result.artifactRevisionIdentity) ?? revision();
      const artifactDigest = result.artifactDigest ?? null;
      lastCandidateDigest = result.candidateDigest ?? candidateDigest;
      association = immutableCopy({
        generationId: committedGenerationId,
        artifactRevision,
        associationRevision:
          snapshotRevision(result.associationRevisionIdentity) ?? revision(),
        artifactDigest,
        designSystem: {
          systemId: identitySystemId(result),
          registryDigest: result.registryDigest ?? null,
        },
        publication: result.publication ?? null,
      });
      revokeTickets();
      const receipt = makePublicationReceipt({
        revision: revision(),
        artifactRevision,
        artifactDigest,
        generationId: committedGenerationId,
        designSystem: association.designSystem,
        publication: association.publication,
      });
      if (acceptedSnapshots.enabled) {
        try {
          const generated =
            implementation._canonicalArtifactsForCurrentRevision();
          const coveredFiles = new Set(
            implementation.coverageOrder().map(([file]) => path.resolve(file)),
          );
          const cssSourceMap = generated.files.find(
            (member) => member.kind === 'css',
          ).sourceMap;
          for (const file of generatedImportMetadata.keys()) {
            if (!coveredFiles.has(path.resolve(file)))
              generatedImportMetadata.delete(file);
          }
          const modules = implementation.fileStates().flatMap((fileState) => {
            if (!coveredFiles.has(path.resolve(fileState.file))) return [];
            if (!isWithin(normalized.rootDir, canonicalPath(fileState.file))) {
              throw lifecycleError(
                Codes.INVALID_REVISION,
                'Accepted snapshots cannot retain sources outside rootDir.',
                { reason: 'outside-root-retention' },
              );
            }
            const compiled = implementation._artifactFor(fileState.file);
            if (compiled == null) return [];
            return [
              {
                source: path
                  .relative(normalized.rootDir, fileState.file)
                  .split(path.sep)
                  .join('/'),
                sourceDigest: compiled.sourceHash,
                javascript: compiled.code,
                sourceMap: compiled.sourceMap,
                dependencies: [...compiled.dependencies],
                revision: receipt.associationRevision,
                designSystem: receipt.designSystem,
                abiVersion: receipt.abiVersion,
                transformedRevision: revision(fileState.compiledRevision),
                generatedImports: generatedImportsOf(
                  compiled.code,
                  fileState.file,
                  path.join(
                    normalized.outDir,
                    generated.files.find(
                      (member) => member.kind === 'design-module',
                    ).file,
                  ),
                ),
              },
            ];
          });
          acceptedSnapshots.retain(
            captureAcceptedSnapshot({
              receipt,
              candidateDigest: lastCandidateDigest,
              generated,
              cssSourceMap,
              modules,
              outDir: normalized.outDir,
            }),
          );
        } catch (error) {
          // Canonical publication has already succeeded. Byte retention is a
          // distinct availability domain and cannot roll that commit back.
          acceptedSnapshots.recordFailure(receipt.associationRevision, error);
        }
      }
      return receipt;
    } catch (error) {
      revokeTickets();
      throw error;
    }
  }

  async function current() {
    requireOpen();
    return immutableCopy({
      revision: initialized ? revision() : null,
      generation:
        association == null || association.generationId == null
          ? null
          : association,
    });
  }

  async function agentResult(expectedRevision, options = {}) {
    requireValidated(expectedRevision, 'agentResult()');
    const legacy = implementation.agentResult({
      revisionId,
      candidateLimit: options.candidateLimit,
    });
    return legacy == null ? null : protocolResult(legacy, options);
  }

  const requireCurrentDesignSystem = (operation) => {
    if (currentDesignSystem() != null) return;
    const identity = implementation._designSystemIdentity();
    throw lifecycleError(
      Codes.INVALID_REVISION,
      `${operation} requires a design system built for the current revision.`,
      {
        reason: 'design-system-unavailable',
        revision: revision(),
        lastValidDesignSystem:
          identity == null
            ? null
            : {
                systemId: identity.systemId,
                registryDigest: identity.registryDigest,
                derivedFromRevision: revision(identity.derivedFromRevisionId),
              },
      },
    );
  };

  async function candidateTokens(query = {}) {
    requireRevision(query.revision, 'candidateTokens()');
    requireCurrentDesignSystem('candidateTokens()');
    const result = implementation.candidateTokens({
      category: query.category,
      offset: query.offset,
      limit: query.limit,
      allowPrivate: false,
    });
    return immutableCopy({
      revision: revision(),
      category: result.category,
      offset: result.offset,
      limit: result.limit,
      total: result.total,
      truncated: result.truncated,
      candidates: implementation
        ._candidateTokenEntries(result.tokens)
        .map(({ tokenId, category }) => Object.freeze({ tokenId, category })),
    });
  }

  async function requestFullAudit(expectedRevision) {
    requireValidated(expectedRevision, 'requestFullAudit()', true);
    return immutableCopy({
      ...implementation.requestFullAudit({ revisionId }),
      revision: revision(),
    });
  }

  async function auditMutationSet(expectedRevision) {
    requireRevision(expectedRevision, 'auditMutationSet()');
    return immutableCopy({
      ...implementation.verifyMutationSet(),
      revision: revision(),
    });
  }

  async function watch(options = {}) {
    requireInitialized('watch()');
    const onRevision = options.onRevision;
    const onError = options.onError;
    const onResync = options.onResync;
    let stopped = false;
    let queuedOperation = null;
    let resyncOperation = null;

    const reportError = (error) => {
      if (typeof onError !== 'function') return;
      try {
        onError(error);
      } catch {
        /* host callbacks do not alter Project Service state */
      }
    };
    const reportRevision = (result) => {
      if (typeof onRevision !== 'function') return;
      try {
        onRevision(result);
      } catch (error) {
        reportError(error);
      }
    };
    const submitMutation = (transaction) => {
      if (stopped) return Promise.resolve(null);
      const snapshot = {
        mode: 'watcher',
        changed: [...(transaction.changed ?? [])],
        added: [...(transaction.added ?? [])],
        removed: [...(transaction.removed ?? [])],
        renamed: (transaction.renamed ?? []).map((move) => ({ ...move })),
      };
      const operation = enqueue(() =>
        applyChanges({ ...snapshot, baseRevision: revision() }),
      );
      queuedOperation = operation;
      operation.then(reportRevision, reportError).then(() => {
        if (queuedOperation === operation) queuedOperation = null;
      });
      return operation;
    };
    const submitResync = (reason) => {
      if (stopped) return Promise.resolve(null);
      if (resyncOperation != null) return resyncOperation;
      const operation = enqueue(() =>
        applyChanges({
          baseRevision: revision(),
          mode: 'full-discovery',
          changed: [],
          added: [],
          removed: [],
          renamed: [],
          forceFullDiscovery: true,
        }),
      );
      resyncOperation = operation;
      operation.then((result) => {
        reportRevision(result);
        if (typeof onResync === 'function') {
          try {
            onResync(reason, result);
          } catch (error) {
            reportError(error);
          }
        }
      }, reportError);
      return operation;
    };

    const provider = implementation.watch({
      debounceMs: options.debounceMs,
      maxPending: options.maxPending,
      onFlush: (transaction) => {
        void submitMutation(transaction).catch(() => {});
      },
      onResync: (reason) => {
        void submitResync(reason).catch(() => {});
      },
    });

    const handle = {
      name: provider.name,
      mode: provider.mode,
      get established() {
        return provider.established;
      },
      startFailures: immutableCopy(provider.startFailures),
      flush() {
        if (stopped) return Promise.resolve(null);
        const transaction = provider.pending();
        if (transaction != null) return submitMutation(transaction);
        if (provider.journal.resyncRequired) {
          return submitResync(provider.journal.resyncReason);
        }
        return queuedOperation ?? Promise.resolve(null);
      },
      stats() {
        return immutableCopy(provider.stats());
      },
      close() {
        if (stopped) return;
        stopped = true;
        provider.close();
        watchers.delete(handle);
      },
    };
    watchers.add(handle);
    return Object.freeze(handle);
  }

  async function readArtifact(expectedRevision, moduleId) {
    requireValidated(expectedRevision, 'readArtifact()', true);
    if (
      typeof moduleId !== 'string' ||
      moduleId === '' ||
      path.isAbsolute(moduleId)
    ) {
      throw new TypeError(
        'readArtifact() requires a project-relative moduleId.',
      );
    }
    const source = canonicalPath(path.resolve(normalized.rootDir, moduleId));
    if (
      !isWithin(normalized.rootDir, source) ||
      isWithin(normalized.outDir, source)
    ) {
      throw new TypeError(
        'readArtifact() moduleId must stay inside rootDir and outside outDir.',
      );
    }
    const compiled = implementation._artifactFor(source);
    if (compiled == null) {
      throw lifecycleError(
        Codes.INVALID_REVISION,
        `No compiled artifact is available for ${moduleId}.`,
        {
          reason: 'uncovered-source',
          covered: false,
          moduleId: path
            .relative(normalized.rootDir, source)
            .split(path.sep)
            .join('/'),
        },
      );
    }
    const generated = acceptedSnapshots.enabled
      ? implementation._canonicalArtifactsForCurrentRevision()
      : null;
    const css =
      generated == null
        ? implementation._cssForCurrentRevision()
        : generated.files.find((member) => member.kind === 'css')?.content;
    if (css == null) {
      throw lifecycleError(
        Codes.INVALID_REVISION,
        'No validated CSS artifact is available for the current revision.',
        { reason: 'no-css-artifact' },
      );
    }
    const identity = currentDesignSystem();
    return immutableCopy({
      source: path
        .relative(normalized.rootDir, source)
        .split(path.sep)
        .join('/'),
      sourceDigest: compiled.sourceHash,
      javascript: compiled.code,
      generatedImports:
        generated == null
          ? []
          : generatedImportsOf(
              compiled.code,
              source,
              path.join(
                normalized.outDir,
                generated.files.find(
                  (member) => member.kind === 'design-module',
                ).file,
              ),
            ),
      sourceMap: compiled.sourceMap,
      css: [
        {
          file: 'styles.css',
          content: css,
          sourceMap: implementation._cssSourceMapFor(css),
        },
      ],
      dependencies: [...compiled.dependencies],
      revision: revision(),
      designSystem: {
        systemId: identity?.systemId ?? null,
        registryDigest: identity?.registryDigest ?? null,
      },
      abiVersion: 1,
    });
  }

  async function readGeneratedArtifacts(expectedRevision) {
    requireValidated(expectedRevision, 'readGeneratedArtifacts()', true);
    const generated = implementation._canonicalArtifactsForCurrentRevision();
    if (generated == null) {
      throw lifecycleError(
        Codes.INVALID_REVISION,
        'No canonical generated artifacts are available for the current revision.',
        { reason: 'no-generated-artifacts' },
      );
    }
    return immutableCopy({
      ...generated,
      revision: revision(),
    });
  }

  async function pinAcceptedSnapshot(expectedRevision, options) {
    requireInitialized('pinAcceptedSnapshot()');
    return acceptedSnapshots.pin(expectedRevision, options);
  }

  async function readAcceptedArtifact(pin, moduleId, sourceDigest) {
    requireInitialized('readAcceptedArtifact()');
    if (
      typeof moduleId !== 'string' ||
      moduleId === '' ||
      path.isAbsolute(moduleId) ||
      moduleId.includes('\\') ||
      moduleId
        .split('/')
        .some((part) => part === '..' || part === '.' || part === '')
    ) {
      throw new TypeError(
        'readAcceptedArtifact() requires a project-relative POSIX moduleId.',
      );
    }
    return acceptedSnapshots.read(pin, moduleId, sourceDigest);
  }

  async function releaseAcceptedSnapshot(pin) {
    requireInitialized('releaseAcceptedSnapshot()');
    return acceptedSnapshots.release(pin);
  }

  async function acceptedSnapshotRetentionStats() {
    requireOpen();
    return acceptedSnapshots.stats();
  }

  async function preparePublication(expectedRevision) {
    requireRevision(expectedRevision, 'preparePublication()');
    if (
      validated == null ||
      !sameRevisionIdentity(validated.revision, revision())
    ) {
      await validate(revision());
    }
    if (!validated.ok) {
      revokeTickets();
      throw lifecycleError(
        Codes.INVALID_REVISION,
        'Invalid revisions cannot prepare publication.',
        { reason: 'revision-invalid' },
      );
    }
    const candidateDigest = implementation._publicationCandidateDigest();
    if (candidateDigest == null) {
      revokeTickets();
      throw lifecycleError(
        Codes.INVALID_REVISION,
        'The validated revision has no publishable artifact candidate.',
        { reason: 'no-publishable-candidate' },
      );
    }
    revokeTickets();
    const id = `${session.sessionId}:${nextTicketSequence}`;
    nextTicketSequence += 1;
    const ticket = Object.freeze({
      ticketId: id,
      projectId: project.projectId,
      sessionId: session.sessionId,
      revision: revision(),
      candidateDigest,
      state: 'prepared',
    });
    tickets.set(id, {
      projectId: project.projectId,
      sessionId: session.sessionId,
      revision: revision(),
      candidateDigest,
    });
    return ticket;
  }

  async function commitPrepared(inputTicket) {
    requireOpen();
    const ticket = snapshotTicket(inputTicket);
    if (
      ticket?.projectId !== project.projectId ||
      ticket?.sessionId !== session.sessionId ||
      ticket?.revision?.projectId !== project.projectId ||
      ticket?.revision?.sessionId !== session.sessionId
    ) {
      throw lifecycleError(
        Codes.INVALID_REVISION,
        'Publication ticket belongs to another project or session.',
        { reason: 'foreign-ticket' },
      );
    }
    const currentTicket = tickets.get(ticket?.ticketId);
    if (
      currentTicket == null ||
      ticket?.state !== 'prepared' ||
      currentTicket.projectId !== project.projectId ||
      currentTicket.sessionId !== session.sessionId ||
      !sameRevisionIdentity(currentTicket.revision, ticket?.revision) ||
      currentTicket.candidateDigest !== ticket?.candidateDigest ||
      !sameRevisionIdentity(ticket.revision, revision()) ||
      currentTicket.candidateDigest !==
        implementation._publicationCandidateDigest()
    ) {
      if (currentTicket != null) tickets.delete(ticket.ticketId);
      throw lifecycleError(
        Codes.STALE_REVISION,
        'Publication ticket is stale, revoked, or no longer matches its candidate.',
        { reason: 'ticket-stale' },
      );
    }
    tickets.delete(ticket.ticketId);
    return compile(ticket.revision, {
      candidateDigest: currentTicket.candidateDigest,
    });
  }

  async function abortPrepared(inputTicket) {
    const ticket = snapshotTicket(inputTicket);
    if (
      ticket?.projectId != null &&
      (ticket.projectId !== project.projectId ||
        ticket.sessionId !== session.sessionId)
    ) {
      throw lifecycleError(
        Codes.INVALID_REVISION,
        'Publication ticket belongs to another project or session.',
        { reason: 'foreign-ticket' },
      );
    }
    const currentTicket = tickets.get(ticket?.ticketId);
    if (currentTicket == null) return false;
    if (
      !sameRevisionIdentity(currentTicket.revision, ticket?.revision) ||
      currentTicket.candidateDigest !== ticket?.candidateDigest
    ) {
      throw lifecycleError(
        Codes.STALE_REVISION,
        'Publication ticket is stale or does not match the prepared candidate.',
        { reason: 'ticket-stale' },
      );
    }
    tickets.delete(ticket.ticketId);
    return true;
  }

  async function close() {
    if (closed) return;
    closed = true;
    revokeTickets();
    for (const watcher of [...watchers]) watcher.close();
    watchers.clear();
    const ownedImplementation = implementation;
    implementation = null;
    validated = null;
    association = null;
    generatedImportMetadata.clear();
    acceptedSnapshots.close();
    try {
      ownedImplementation?.close();
    } finally {
      await releasePublisherLease();
      normalized = {
        ...normalized,
        roots: [],
        definition: null,
        engineOptions: {},
      };
    }
  }

  // ------------------------------------------------- AG-01.1 agent hooks ----
  //
  // Each hook is one queued step, so its identities and its value describe the
  // same session state. `beforeStart` runs first inside the step: the agent
  // layer cancels there, before any effect. Rejections the agent maps to
  // invalid input are returned as `{ rejected }`, never thrown as lifecycle
  // codes. Nothing here runs unless the agent layer calls it.
  const portableFile = (file) =>
    typeof file === 'string' && path.isAbsolute(file)
      ? path.relative(normalized.rootDir, file).split(path.sep).join('/')
      : file;
  const agentIdentities = () => {
    const identity = implementation?._designSystemIdentity() ?? null;
    const live = initialized && !closed;
    return {
      projectId: project.projectId,
      sessionId: session.sessionId,
      revision: live ? revision() : null,
      designSystem:
        live && identity?.current === true
          ? {
              systemId: identity.systemId,
              registryDigest: identity.registryDigest,
            }
          : null,
      lastValidDesignSystem:
        live && identity != null && identity.current !== true
          ? {
              systemId: identity.systemId,
              registryDigest: identity.registryDigest,
              derivedFromRevision: revision(identity.derivedFromRevisionId),
            }
          : null,
    };
  };
  const agentStep = (beforeStart, step) =>
    enqueue(async () => {
      beforeStart?.();
      const value = await step();
      return { identities: agentIdentities(), value };
    });
  const affectedPage = (offset, limit) => {
    const page = implementation._affectedCoverage({ offset, limit });
    return {
      total: page.total,
      entries: page.entries.map((entry) => ({
        file: portableFile(entry.file),
        role: entry.role ?? null,
        analysed: entry.analysed === true,
        removed: entry.removed === true,
      })),
    };
  };
  const currentDocument = (candidateLimit) =>
    protocolResult(implementation.agentResult({ revisionId, candidateLimit }), {
      candidateLimit,
    });
  const candidateCategory = (selector, candidateLimit) => {
    if (selector.kind === 'category') return { category: selector.category };
    if (selector.kind === 'category-index') {
      const categories = implementation._candidateCategories();
      return selector.index < categories.length
        ? { category: categories[selector.index] }
        : { rejected: 'index-out-of-range' };
    }
    requireValidated(revision(), 'diagnostics.candidates');
    const diagnostics = currentDocument(candidateLimit).diagnostics;
    if (selector.index >= diagnostics.length)
      return { rejected: 'index-out-of-range' };
    const category = diagnostics[selector.index].expected?.category ?? null;
    return category == null
      ? { rejected: 'no-candidate-domain' }
      : { category };
  };
  const agentHooks = Object.freeze({
    closed: () => closed,
    paths: () => ({ rootDir: project.rootDir, outDir: project.outDir }),
    status: (beforeStart) =>
      agentStep(beforeStart, () => {
        requireOpen();
        return {
          initialized,
          generationId: association?.generationId ?? null,
        };
      }),
    check: (expected, options, beforeStart) =>
      agentStep(beforeStart, async () => {
        requireRevision(expected, 'check');
        // A verdict for the exact current revision is reused, so a reader
        // never revokes a live publication ticket (F1). Without one, no live
        // ticket can exist: preparing one validates first.
        if (
          validated == null ||
          !sameRevisionIdentity(validated.revision, revision())
        ) {
          await validate(revision());
        }
        return {
          document: currentDocument(options.candidateLimit),
          affected: affectedPage(0, options.affectedLimit).entries,
        };
      }),
    document: (expected, options, beforeStart) =>
      agentStep(beforeStart, () => {
        requireValidated(expected, 'records.read');
        return { document: currentDocument(options.candidateLimit) };
      }),
    affected: (expected, { offset, limit }, beforeStart) =>
      agentStep(beforeStart, () => {
        requireValidated(expected, 'diagnostics.affected');
        return affectedPage(offset, limit);
      }),
    candidates: (expected, options, beforeStart) =>
      agentStep(beforeStart, () => {
        requireRevision(expected, 'diagnostics.candidates');
        requireCurrentDesignSystem('diagnostics.candidates');
        const selected = candidateCategory(
          options.selector,
          options.candidateLimit,
        );
        if (selected.rejected != null) return selected;
        const categories = implementation._candidateCategories();
        // Membership is checked against the enumeration, never by property
        // lookup, so a category such as `constructor` is simply empty.
        const { tokens, total } = categories.includes(selected.category)
          ? implementation.candidateTokens({
              category: selected.category,
              offset: options.offset,
              limit: options.limit,
              allowPrivate: false,
            })
          : { tokens: [], total: 0 };
        const categoryIndex = categories.indexOf(selected.category);
        return {
          categoriesTotal: categories.length,
          categoryIndex: categoryIndex < 0 ? null : categoryIndex,
          total,
          entries: implementation
            ._candidateTokenEntries(tokens)
            .map(({ tokenId, category }) => ({ tokenId, category })),
        };
      }),
    // AG-01.2 §3.6. Read and compute assign nothing and never validate: an
    // unvalidated revision is refused, so its validation state is preserved.
    auditCompute: (expected, options, beforeStart) =>
      agentStep(beforeStart, () => {
        requireValidated(expected, 'audit.compute');
        return implementation._auditCoverage({
          offset: options.offset,
          limit: options.limit,
          summary: options.summary === true,
          canonical: options.summary === true,
        });
      }),
    auditRead: (expected, beforeStart) =>
      agentStep(beforeStart, () => {
        requireValidated(expected, 'audit.read');
        return implementation._auditArtifacts();
      }),
    // One queued step: the revision, validity and generation checks and the
    // write see the same state. It never stages and never revokes a ticket.
    auditMaterialize: (expected, expectedGenerationId, beforeStart) =>
      agentStep(beforeStart, () => {
        requireValidated(expected, 'audit.materialize', true);
        if (implementation._auditGenerationId() !== expectedGenerationId) {
          throw lifecycleError(
            Codes.STALE_REVISION,
            'audit.materialize expected another generation.',
            { reason: 'generation-changed' },
          );
        }
        return implementation._materializeAudit();
      }),
  });

  return Object.freeze({
    [AGENT_SESSION_HOOKS]: agentHooks,
    projectId: project.projectId,
    sessionId: session.sessionId,
    initialize: () => enqueue(initialize),
    applyChanges: (transaction) => {
      const snapshot = snapshotMutation(transaction);
      return enqueue(() => applyChanges(snapshot));
    },
    validate: (expectedRevision) => {
      const snapshot = snapshotRevision(expectedRevision);
      return enqueue(() => validate(snapshot));
    },
    compile: (expectedRevision) => {
      const snapshot = snapshotRevision(expectedRevision);
      return enqueue(() => compile(snapshot));
    },
    current: () => enqueue(current),
    agentResult: (expectedRevision, options = {}) => {
      const revisionSnapshot = snapshotRevision(expectedRevision);
      const optionsSnapshot = snapshotInput(options);
      return enqueue(() => agentResult(revisionSnapshot, optionsSnapshot));
    },
    candidateTokens: (query = {}) => {
      const querySnapshot = {
        ...query,
        revision: snapshotRevision(query.revision),
      };
      return enqueue(() => candidateTokens(querySnapshot));
    },
    requestFullAudit: (expectedRevision) => {
      const snapshot = snapshotRevision(expectedRevision);
      return enqueue(() => requestFullAudit(snapshot));
    },
    auditMutationSet: (expectedRevision) => {
      const snapshot = snapshotRevision(expectedRevision);
      return enqueue(() => auditMutationSet(snapshot));
    },
    watch: (options = {}) => {
      const snapshot = snapshotInput(options);
      return enqueue(() => watch(snapshot));
    },
    readArtifact: (expectedRevision, moduleId) => {
      const snapshot = snapshotRevision(expectedRevision);
      return enqueue(() => readArtifact(snapshot, moduleId));
    },
    readGeneratedArtifacts: (expectedRevision) => {
      const snapshot = snapshotRevision(expectedRevision);
      return enqueue(() => readGeneratedArtifacts(snapshot));
    },
    pinAcceptedSnapshot: (expectedRevision, options = {}) => {
      const snapshot = snapshotRevision(expectedRevision);
      const optionsSnapshot = { owner: options?.owner };
      return enqueue(() => pinAcceptedSnapshot(snapshot, optionsSnapshot));
    },
    readAcceptedArtifact: (pin, moduleId, sourceDigest) => {
      const snapshot = snapshotPin(pin);
      return enqueue(() =>
        readAcceptedArtifact(snapshot, moduleId, sourceDigest),
      );
    },
    releaseAcceptedSnapshot: (pin) => {
      const snapshot = snapshotPin(pin);
      return enqueue(() => releaseAcceptedSnapshot(snapshot));
    },
    acceptedSnapshotRetentionStats: () =>
      enqueue(acceptedSnapshotRetentionStats),
    preparePublication: (expectedRevision) => {
      const snapshot = snapshotRevision(expectedRevision);
      return enqueue(() => preparePublication(snapshot));
    },
    commitPrepared: (ticket) => {
      const snapshot = snapshotTicket(ticket);
      return enqueue(() => commitPrepared(snapshot));
    },
    abortPrepared: (ticket) => {
      const snapshot = snapshotTicket(ticket);
      return enqueue(() => abortPrepared(snapshot));
    },
    close: () => enqueue(close),
  });
}

function snapshotPin(pin) {
  return {
    pinId: pin?.pinId,
    projectId: pin?.projectId,
    sessionId: pin?.sessionId,
    snapshotId: pin?.snapshotId,
    owner: pin?.owner,
  };
}

function identitySystemId(result) {
  return result?.designSystem?.systemId ?? result?.manifest?.systemId ?? null;
}

export function projectServiceResourceStats() {
  return Object.freeze({ activePublisherLeases: activePublisherLeases.size });
}
