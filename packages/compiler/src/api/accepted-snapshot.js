/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { parse } from '@babel/parser';
import babelTraverse from '@babel/traverse';
import { validateArtifactSet } from '../artifacts/metadata/artifact-set.js';
import { readPublishedGenerationMembers } from '../artifacts/publication/transaction.js';
import { Codes, PmsError, diagnostic } from '../protocol/diagnostics.js';
import { sameRevisionIdentity } from '../protocol/identities.js';

const MEMBER_KINDS = Object.freeze([
  'design-module',
  'declarations',
  'manifest',
  'css',
  'artifact-metadata',
]);
const SET_DOMAIN = 'pandamstyle-canonical-five-file-set-v1\0';
const traverse = babelTraverse?.default ?? babelTraverse;

/** Compiler-produced transport provenance; offsets use JavaScript UTF-16. */
export function generatedImportsFor(javascript, sourceFile, designFile) {
  const target = path.resolve(designFile);
  const acceptedPaths = new Set([
    target,
    target.replace(/\.(?:mjs|cjs|js)$/i, ''),
  ]);
  const imports = [];
  const record = (literal) => {
    if (literal?.type !== 'StringLiteral' || typeof literal.value !== 'string')
      return;
    if (!literal.value.startsWith('.') && !path.isAbsolute(literal.value))
      return;
    const resolved = path.resolve(path.dirname(sourceFile), literal.value);
    if (acceptedPaths.has(resolved))
      imports.push({
        start: literal.start,
        end: literal.end,
        kind: 'design-module',
      });
  };
  traverse(parse(javascript, { sourceType: 'unambiguous', plugins: ['jsx'] }), {
    enter(astPath) {
      const { node } = astPath;
      if (
        [
          'ImportDeclaration',
          'ExportNamedDeclaration',
          'ExportAllDeclaration',
          'ImportExpression',
        ].includes(node.type)
      )
        record(node.source);
      if (
        node.type === 'CallExpression' &&
        node.arguments?.length === 1 &&
        (node.callee?.type === 'Import' ||
          (node.callee?.type === 'Identifier' &&
            node.callee.name === 'require' &&
            astPath.scope.getBinding('require') == null))
      )
        record(node.arguments[0]);
    },
  });
  return freeze(imports.sort((left, right) => left.start - right.start));
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function freeze(value) {
  if (value == null || typeof value !== 'object') return value;
  for (const item of Object.values(value)) freeze(item);
  return Object.freeze(value);
}

export function snapshotError(reason, message, context = {}) {
  return new PmsError([
    diagnostic({
      code:
        reason === 'source-mismatch' || reason === 'snapshot-expired'
          ? Codes.STALE_REVISION
          : reason === 'corrupt-member'
            ? Codes.GENERATED_ARTIFACT_MISMATCH
            : Codes.INVALID_REVISION,
      phase: 'lifecycle',
      rule: 'session.accepted-snapshot',
      message,
      context: { reason, ...context },
    }),
  ]);
}

function orderedMembers(files) {
  if (
    !Array.isArray(files) ||
    files.length !== MEMBER_KINDS.length ||
    new Set(files.map((member) => member.file)).size !== MEMBER_KINDS.length
  ) {
    throw snapshotError(
      'corrupt-member',
      'An accepted snapshot requires exactly five distinct canonical members.',
    );
  }
  return MEMBER_KINDS.map((kind) => {
    const matches = files.filter((member) => member.kind === kind);
    if (matches.length !== 1 || typeof matches[0].content !== 'string') {
      throw snapshotError(
        'corrupt-member',
        `Missing or duplicate canonical member kind: ${kind}.`,
      );
    }
    const member = matches[0];
    if (
      typeof member.file !== 'string' ||
      member.file === '' ||
      member.file.includes('\\') ||
      path.posix.isAbsolute(member.file) ||
      member.file
        .split('/')
        .some((part) => part === '..' || part === '.' || part === '')
    ) {
      throw snapshotError(
        'corrupt-member',
        'Canonical member names must be safe relative POSIX paths.',
      );
    }
    return member;
  });
}

/**
 * SHA-256(domain || u64be(5) || frame(name) || frame(content) ...).
 * A frame is u64be(UTF-8 byte length) followed by those exact bytes. Members
 * are ordered by MEMBER_KINDS, including the actual artifacts.json bytes.
 * This digest is deliberately separate from all existing publication digests.
 */
export function canonicalSetDigestOf(files) {
  const hash = createHash('sha256').update(SET_DOMAIN, 'utf8');
  const length = (size) => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64BE(BigInt(size));
    hash.update(bytes);
  };
  const frame = (value) => {
    const bytes = Buffer.from(value, 'utf8');
    length(bytes.length);
    hash.update(bytes);
  };
  const members = orderedMembers(files);
  length(members.length);
  for (const member of members) {
    frame(member.file);
    frame(member.content);
  }
  return hash.digest('hex');
}

/** Captures accepted bytes only; this function never writes canonical output. */
export function captureAcceptedSnapshot({
  receipt,
  candidateDigest,
  generated,
  modules,
  cssSourceMap,
  outDir,
}) {
  const ordered = orderedMembers(generated.files);
  const published = readPublishedGenerationMembers(
    outDir,
    receipt,
    ordered.map(({ file }) => file),
  );
  const files = ordered.map(({ file, kind, content: preview }) => {
    const content = published.find((member) => member.file === file).content;
    // artifacts.json may contain publisher-owned receipt metadata absent from
    // candidate previews. Always retain its actual committed bytes.
    if (kind !== 'artifact-metadata' && content !== preview) {
      throw snapshotError(
        'corrupt-member',
        `Canonical member ${file} differs from the accepted compiler candidate.`,
      );
    }
    return {
      file,
      kind,
      content,
      sha256: sha256(content),
      bytes: Buffer.byteLength(content, 'utf8'),
    };
  });
  const contents = Object.fromEntries(
    files.map((member) => [member.kind, member.content]),
  );
  const metadata = JSON.parse(contents['artifact-metadata']);
  validateArtifactSet(metadata, {
    designModule: contents['design-module'],
    declarations: contents.declarations,
    manifest: contents.manifest,
    css: contents.css,
  });
  if (
    metadata.systemId !== receipt.designSystem.systemId ||
    metadata.registryDigest !== receipt.designSystem.registryDigest ||
    metadata.abiVersion !== receipt.abiVersion
  ) {
    throw snapshotError(
      'corrupt-member',
      'Committed canonical identity differs from its publication receipt.',
    );
  }
  const canonicalSetDigest = canonicalSetDigestOf(files);
  const orderedModules = [...modules].sort((left, right) =>
    left.source < right.source ? -1 : left.source > right.source ? 1 : 0,
  );
  const identity = {
    projectId: receipt.projectId,
    sessionId: receipt.sessionId,
    artifactRevision: receipt.artifactRevision,
    associationRevision: receipt.associationRevision,
    generationId: receipt.generationId,
    artifactDigest: receipt.artifactDigest,
    candidateDigest,
    canonicalSetDigest,
  };
  const snapshotId = sha256(
    `pandamstyle-accepted-snapshot-v1\0${JSON.stringify({
      ...identity,
      cssSourceMap,
      modules: orderedModules.map((module) => ({
        source: module.source,
        sourceDigest: module.sourceDigest,
        javascriptDigest: sha256(module.javascript),
        sourceMap: module.sourceMap,
        dependencies: module.dependencies,
        transformedRevision: module.transformedRevision,
        generatedImports: module.generatedImports,
      })),
    })}`,
  );
  return freeze({
    schemaVersion: 1,
    snapshotId,
    ...identity,
    artifactSetDigest: metadata.artifactSetDigest,
    designSystem: receipt.designSystem,
    abiVersion: receipt.abiVersion,
    files,
    cssSourceMap,
    moduleArtifacts: orderedModules.map(
      ({ transformedRevision, ...module }) => ({
        ...module,
        provenance: { snapshotId, ...identity, transformedRevision },
      }),
    ),
  });
}

/** Session-owned bounded byte retention, without a semantic graph or cache. */
export function createAcceptedSnapshotStore({ projectId, sessionId, options }) {
  const enabled = options != null;
  if (enabled && (typeof options !== 'object' || Array.isArray(options))) {
    throw new TypeError('acceptedSnapshotRetention must be an options object.');
  }
  const limits = {
    maxSnapshots: options?.maxSnapshots ?? 32,
    maxBytes: options?.maxBytes ?? 64 * 1024 * 1024,
    maxPins: options?.maxPins ?? 128,
  };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(
        `acceptedSnapshotRetention.${key} must be a positive safe integer.`,
      );
    }
  }
  const snapshots = new Map();
  const pins = new Map();
  let bytes = 0;
  let lastFailure = null;
  let closed = false;
  const requireEnabled = () => {
    if (closed)
      throw snapshotError(
        'session-closed',
        'Accepted snapshot session is closed.',
      );
    if (!enabled)
      throw snapshotError(
        'snapshot-disabled',
        'Accepted snapshot retention requires acceptedSnapshotRetention configuration.',
      );
  };
  const requireSession = (identity) => {
    requireEnabled();
    if (
      identity?.projectId !== projectId ||
      identity?.sessionId !== sessionId
    ) {
      throw snapshotError(
        'foreign-session',
        'Accepted snapshot request belongs to another project or session.',
      );
    }
  };
  const evict = (requiredBytes = 0, requiredSnapshots = 0) => {
    for (const [id, entry] of snapshots) {
      if (
        bytes + requiredBytes <= limits.maxBytes &&
        snapshots.size + requiredSnapshots <= limits.maxSnapshots
      )
        break;
      if (entry.pins !== 0) continue;
      snapshots.delete(id);
      bytes -= entry.bytes;
    }
    return (
      bytes + requiredBytes <= limits.maxBytes &&
      snapshots.size + requiredSnapshots <= limits.maxSnapshots
    );
  };
  const resolvePin = (pin) => {
    requireSession(pin);
    const owned = pins.get(pin?.pinId);
    if (
      owned == null ||
      owned.owner !== pin.owner ||
      owned.snapshotId !== pin.snapshotId
    ) {
      throw snapshotError(
        'snapshot-expired',
        'Accepted snapshot pin is released, expired, or does not match its owner.',
      );
    }
    return { owned, entry: snapshots.get(owned.snapshotId) };
  };
  return Object.freeze({
    enabled,
    retain(snapshot) {
      requireSession(snapshot);
      if (snapshots.has(snapshot.snapshotId)) {
        lastFailure = null;
        return;
      }
      const size = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
      if (size > limits.maxBytes || !evict(size, 1)) {
        throw snapshotError(
          'retention-limit',
          'Accepted snapshot retention is exhausted; release owned pins or restart the coordinator and reload its consumers.',
          { ...limits, requiredBytes: size },
        );
      }
      snapshots.set(snapshot.snapshotId, { snapshot, bytes: size, pins: 0 });
      bytes += size;
      lastFailure = null;
    },
    recordFailure(revision, error) {
      lastFailure = { revision, error };
    },
    pin(revision, { owner } = {}) {
      requireSession(revision);
      if (
        typeof owner !== 'string' ||
        owner.trim() === '' ||
        owner.length > 256
      ) {
        throw new TypeError(
          'An accepted snapshot pin requires a nonempty owner of at most 256 characters.',
        );
      }
      if (pins.size >= limits.maxPins) {
        throw snapshotError(
          'retention-limit',
          'Accepted snapshot pin limit is exhausted; release owned pins or restart and reload consumers.',
          limits,
        );
      }
      if (sameRevisionIdentity(lastFailure?.revision, revision))
        throw lastFailure.error;
      const entry = [...snapshots.values()]
        .reverse()
        .find(({ snapshot }) =>
          sameRevisionIdentity(snapshot.associationRevision, revision),
        );
      if (entry == null) {
        throw snapshotError(
          'snapshot-expired',
          'No retained accepted snapshot exists for this exact association revision; reload against the current coordinator.',
        );
      }
      const pinId = randomUUID();
      const pin = freeze({
        pinId,
        projectId,
        sessionId,
        snapshotId: entry.snapshot.snapshotId,
        owner,
        snapshot: entry.snapshot,
      });
      pins.set(pinId, { owner, snapshotId: pin.snapshotId });
      entry.pins += 1;
      return pin;
    },
    read(pin, moduleId, sourceDigest) {
      const { entry } = resolvePin(pin);
      const artifact = entry.snapshot.moduleArtifacts.find(
        (module) => module.source === moduleId,
      );
      if (artifact == null)
        throw snapshotError(
          'unknown-source',
          `No accepted module artifact exists for ${moduleId}.`,
        );
      if (
        typeof sourceDigest !== 'string' ||
        sourceDigest !== artifact.sourceDigest
      ) {
        throw snapshotError(
          'source-mismatch',
          'Loader source digest differs from the exact accepted snapshot source; stale bytes cannot become a newer overlay.',
          {
            moduleId,
            requestedSourceDigest: sourceDigest ?? null,
            acceptedSourceDigest: artifact.sourceDigest,
            snapshotId: entry.snapshot.snapshotId,
          },
        );
      }
      const css = entry.snapshot.files.find((member) => member.kind === 'css');
      return freeze({
        ...artifact,
        css: [
          {
            file: css.file,
            content: css.content,
            sourceMap: entry.snapshot.cssSourceMap,
          },
        ],
      });
    },
    release(pin) {
      requireSession(pin);
      if (!pins.has(pin?.pinId)) return false;
      const { owned, entry } = resolvePin(pin);
      pins.delete(pin.pinId);
      entry.pins -= 1;
      // Released snapshots remain eligible history until bounded admission
      // evicts them. Release never changes a published immutable byte value.
      evict();
      return owned != null;
    },
    stats() {
      return Object.freeze({
        enabled,
        ...limits,
        snapshots: snapshots.size,
        bytes,
        pins: pins.size,
      });
    },
    close() {
      closed = true;
      snapshots.clear();
      pins.clear();
      bytes = 0;
      lastFailure = null;
    },
  });
}
