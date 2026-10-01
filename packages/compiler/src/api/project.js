/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import { digestOfTree } from '../artifacts/publication/transaction.js';
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

function resolveConfig(config = {}) {
  const rootDir = path.resolve(config.rootDir ?? process.cwd());
  const projectId = config.projectId ?? rootDir;
  const outDir = path.resolve(rootDir, config.outDir ?? '.pandamstyle');
  return {
    ...config,
    projectId,
    rootDir,
    outDir,
    roots: (config.roots ?? []).map((root) => path.resolve(rootDir, root)),
  };
}

function resolveMutationPaths(mutation, rootDir) {
  const resolvePath = (file) =>
    path.isAbsolute(file) ? file : path.resolve(rootDir, file);
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
  const normalized = resolveConfig(config);
  const project = createProjectIdentity(normalized);
  const session = createSessionIdentity(project.projectId);
  const implementation = createSynchronousSession(normalized);
  let revisionId = 0;
  let initialized = false;
  let validated = null;
  let closed = false;
  let association = null;
  const generationOrigins = new Map();
  const generationDigests = new Map();
  const tickets = new Map();

  const revision = (id = revisionId) => makeRevisionIdentity(session, id);
  const requireOpen = () => {
    if (closed)
      throw lifecycleError(
        Codes.SESSION_CLOSED,
        'The project session is closed.',
      );
  };
  const requireRevision = (expected, operation) => {
    requireOpen();
    if (!initialized) {
      throw lifecycleError(
        Codes.INVALID_REVISION,
        `${operation} requires an initialized session.`,
      );
    }
    if (!sameRevisionIdentity(expected, revision())) {
      throw lifecycleError(
        expected?.sessionId === session.sessionId
          ? Codes.STALE_REVISION
          : Codes.INVALID_REVISION,
        `${operation} requires the exact current project/session/revision identity.`,
        { expected: expected ?? null, current: revision() },
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
      );
    }
    if (requireValid && !validated.ok) {
      throw lifecycleError(
        Codes.INVALID_REVISION,
        `${operation} requires a valid current revision.`,
      );
    }
  };
  const protocolResult = (legacy, options = {}) => {
    const identity = implementation._designSystemIdentity();
    return buildDiagnosticsResult({
      legacy,
      revision: revision(legacy?.revisionId ?? revisionId),
      designSystem: {
        systemId: identity?.systemId ?? normalized.projectId,
        registryDigest: identity?.registryDigest ?? null,
      },
      candidateLimit: options.candidateLimit,
      rootDir: normalized.rootDir,
      artifactRevision:
        legacy?.generation?.generationId == null
          ? null
          : (generationOrigins.get(legacy.generation.generationId) ??
            revision()),
      artifactDigest:
        legacy?.generation?.generationId == null
          ? null
          : (generationDigests.get(legacy.generation.generationId) ?? null),
      associationRevision:
        legacy?.generation?.published === true ? revision() : null,
    });
  };
  const summary = (value, options = {}) => ({
    ...value,
    revision: revision(value?.revisionId ?? revisionId),
    agentResult:
      value?.agentResult == null
        ? null
        : protocolResult(value.agentResult, options),
  });

  async function initialize() {
    requireOpen();
    if (initialized) {
      throw lifecycleError(
        Codes.INVALID_REVISION,
        'initialize() may be called only once per session.',
      );
    }
    const value = implementation.initialize();
    initialized = true;
    revisionId = value.revisionId;
    association = implementation.current();
    return summary(value);
  }

  async function applyChanges(transaction) {
    requireOpen();
    if (!initialized) {
      throw lifecycleError(
        Codes.INVALID_REVISION,
        'applyChanges() requires initialize() first.',
      );
    }
    requireRevision(transaction?.baseRevision, 'applyChanges()');
    const mutation = resolveMutationPaths(
      normalizeMutationTransaction(transaction),
      normalized.rootDir,
    );
    const value = implementation.applyChanges({
      mutation,
      definition: transaction?.definition,
      config: transaction?.config,
    });
    for (const ticket of tickets.values()) ticket.revoked = true;
    revisionId = value.revisionId;
    validated = null;
    return summary(value);
  }

  async function validate(expectedRevision) {
    requireRevision(expectedRevision, 'validate()');
    const value = implementation.validate();
    validated = { revision: revision(), ok: value.ok === true };
    return summary(value);
  }

  async function compile(expectedRevision) {
    requireRevision(expectedRevision, 'compile()');
    if (
      validated == null ||
      !sameRevisionIdentity(validated.revision, revision())
    ) {
      await validate(revision());
    }
    if (!validated.ok) {
      const result = implementation.agentResult({ revisionId });
      throw new PmsError(result?.diagnostics ?? []);
    }
    const result = implementation.compile();
    const generationId = result.generationId ?? null;
    const reused = result.generationReused === true;
    const diskDigest =
      generationId == null ? null : digestOfTree(normalized.outDir);
    const artifactRevision = reused
      ? (generationOrigins.get(generationId) ?? revision())
      : revision();
    const artifactDigest = reused
      ? (generationDigests.get(generationId) ?? diskDigest?.sha256 ?? null)
      : (diskDigest?.sha256 ?? null);
    if (generationId != null) {
      generationOrigins.set(generationId, artifactRevision);
      generationDigests.set(generationId, artifactDigest);
    }
    association = {
      generationId,
      artifactRevision,
      associationRevision: revision(),
      artifactDigest,
      designSystem: {
        systemId: identitySystemId(result),
        registryDigest: result.registryDigest ?? null,
      },
      publication: result.publication ?? null,
    };
    return makePublicationReceipt({
      revision: revision(),
      artifactRevision,
      artifactDigest,
      generationId,
      designSystem: {
        systemId: identitySystemId(result),
        registryDigest: result.registryDigest ?? null,
      },
      publication: result.publication ?? null,
    });
  }

  async function current() {
    requireOpen();
    return Object.freeze({
      revision: initialized ? revision() : null,
      generation:
        association == null || association.generationId == null
          ? null
          : Object.freeze({ ...association }),
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

  async function candidateTokens(query = {}) {
    requireRevision(query.revision, 'candidateTokens()');
    const result = implementation.candidateTokens({
      category: query.category,
      offset: query.offset,
      limit: query.limit,
      allowPrivate: false,
    });
    return Object.freeze({
      revision: revision(),
      category: result.category,
      offset: result.offset,
      limit: result.limit,
      total: result.total,
      truncated: result.truncated,
      candidates: implementation
        ._candidateTokenEntries(
          [...result.tokens].sort((left, right) => left.localeCompare(right)),
        )
        .map(({ tokenId, category }) => Object.freeze({ tokenId, category })),
    });
  }

  async function requestFullAudit(expectedRevision) {
    requireValidated(expectedRevision, 'requestFullAudit()', true);
    return Object.freeze({
      ...implementation.requestFullAudit({ revisionId }),
      revision: revision(),
    });
  }

  async function auditMutationSet(expectedRevision) {
    requireRevision(expectedRevision, 'auditMutationSet()');
    return implementation.verifyMutationSet();
  }

  async function watch(options = {}) {
    requireOpen();
    return implementation.watch(options);
  }

  async function readArtifact(expectedRevision, moduleId) {
    requireValidated(expectedRevision, 'readArtifact()', true);
    const source = path.resolve(normalized.rootDir, moduleId);
    const compiled = implementation._artifactFor(source);
    if (compiled == null) {
      throw lifecycleError(
        Codes.INVALID_REVISION,
        `No compiled artifact is available for ${moduleId}.`,
      );
    }
    const css = implementation._cssForCurrentRevision();
    if (css == null) {
      throw lifecycleError(
        Codes.INVALID_REVISION,
        'No validated CSS artifact is available for the current revision.',
      );
    }
    const identity = implementation._designSystemIdentity();
    return Object.freeze({
      source: path
        .relative(normalized.rootDir, source)
        .split(path.sep)
        .join('/'),
      javascript: compiled.code,
      sourceMap: null,
      css: Object.freeze([Object.freeze({ file: 'styles.css', content: css })]),
      dependencies: compiled.dependencies,
      revision: revision(),
      designSystem: Object.freeze({
        systemId: identity?.systemId ?? normalized.projectId,
        registryDigest: identity?.registryDigest ?? null,
      }),
      abiVersion: 1,
    });
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
      throw lifecycleError(
        Codes.INVALID_REVISION,
        'Invalid revisions cannot prepare publication.',
      );
    }
    const candidateDigest = implementation._publicationCandidateDigest();
    if (candidateDigest == null) {
      throw lifecycleError(
        Codes.INVALID_REVISION,
        'The validated revision has no publishable artifact candidate.',
      );
    }
    const id = `${session.sessionId}:${revisionId}:${Math.random().toString(36).slice(2)}`;
    const ticket = Object.freeze({
      ticketId: id,
      sessionId: session.sessionId,
      revision: revision(),
      candidateDigest,
      state: 'prepared',
    });
    tickets.set(id, { public: ticket, candidateDigest, revoked: false });
    return ticket;
  }

  async function commitPrepared(ticket) {
    const currentTicket = tickets.get(ticket?.ticketId);
    if (
      currentTicket == null ||
      currentTicket.revoked ||
      currentTicket.public !== ticket ||
      !sameRevisionIdentity(ticket.revision, revision()) ||
      currentTicket.candidateDigest !==
        implementation._publicationCandidateDigest()
    ) {
      if (currentTicket != null) {
        currentTicket.revoked = true;
        tickets.delete(ticket.ticketId);
      }
      throw lifecycleError(
        Codes.STALE_REVISION,
        'Publication ticket is stale, revoked, or belongs to another session.',
      );
    }
    tickets.delete(ticket.ticketId);
    return compile(ticket.revision);
  }

  async function abortPrepared(ticket) {
    const currentTicket = tickets.get(ticket?.ticketId);
    if (currentTicket == null || currentTicket.public !== ticket) return false;
    tickets.delete(ticket.ticketId);
    currentTicket.revoked = true;
    return true;
  }

  async function close() {
    if (closed) return;
    closed = true;
    for (const ticket of tickets.values()) ticket.revoked = true;
    tickets.clear();
    implementation.close();
  }

  return Object.freeze({
    projectId: project.projectId,
    sessionId: session.sessionId,
    initialize,
    applyChanges,
    validate,
    compile,
    current,
    agentResult,
    candidateTokens,
    requestFullAudit,
    auditMutationSet,
    watch,
    readArtifact,
    preparePublication,
    commitPrepared,
    abortPrepared,
    close,
  });
}

function identitySystemId(result) {
  return result?.designSystem?.systemId ?? result?.manifest?.systemId ?? null;
}
