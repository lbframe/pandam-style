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

// Service handle routing, not a graph or semantic cache. Unsupported worker
// topology is rejected at configuration; all access uses public SDK methods.
const owners = new Map();
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

export function unsupported(message) {
  const error = new Error(message);
  error.code = 'PMS_UNSUPPORTED_FEATURE';
  return error;
}

function event(owner, type, details = {}) {
  owner.options.onEvent?.(
    Object.freeze({
      type,
      pid: process.pid,
      root: owner.root,
      revision: owner.revision,
      ...details,
    }),
  );
}

function enqueue(owner, operation) {
  const value = owner.tail.then(operation);
  owner.tail = value.catch(() => {});
  return value;
}

async function loadDefinition(owner) {
  if (typeof owner.options.definition !== 'string')
    return owner.options.definition;
  const file = owner.definitionPath;
  const hash = digest(fs.readFileSync(file));
  const url = pathToFileURL(file);
  url.searchParams.set('pandamstyle', hash);
  const module = await import(url.href);
  let definition = module.default ?? module;
  if (typeof definition === 'function') definition = await definition();
  owner.definitionDigest = hash;
  return definition;
}

async function validate(owner) {
  const current = await owner.project.current();
  owner.revision = current.revision;
  if (same(owner.validatedRevision, current.revision)) return;
  const result = await owner.project.validate(current.revision);
  const protocol = await owner.project.agentResult(result.revision);
  owner.options.onDiagnostics?.(protocol);
  event(owner, 'diagnostics', {
    result: protocol,
    counters: result.counters,
    fullFallback: result.fullFallback,
    fullFallbackReason: result.fullFallbackReason,
  });
  owner.generated = null;
  if (!result.ok) throw new PmsError(protocol.diagnostics);
  owner.validatedRevision = current.revision;
}

async function initialize(owner) {
  if (owner.project != null) return;
  const definition = await loadDefinition(owner);
  owner.project = createProjectSession({
    ...owner.options,
    rootDir: owner.root,
    definition,
    outDir: owner.outDir,
    designSystemFile: owner.designFile,
  });
  owner.host = createHostBridge(owner.project);
  const initial = await owner.project.initialize();
  owner.revision = initial.revision;
  // Watcher journals are compiler-owned. Backend hooks flush before reads or
  // settlement; callbacks never compile or publish a separate semantic model.
  owner.watcher = await owner.project.watch({
    debounceMs: 30,
    onError(error) {
      event(owner, 'watcher-error', { code: error.code ?? null });
    },
  });
  event(owner, 'initialized', { sessionId: owner.project.sessionId });
}

async function refresh(owner) {
  if (owner.closed)
    throw unsupported(
      'PandamStyle Next owner is closed. Restart the Next command.',
    );
  await initialize(owner);
  await owner.watcher.flush();
  if (owner.definitionPath != null) {
    const hash = digest(fs.readFileSync(owner.definitionPath));
    if (hash !== owner.definitionDigest) {
      const definition = await loadDefinition(owner);
      const current = await owner.project.current();
      await owner.project.applyChanges({
        baseRevision: current.revision,
        mode: 'verified-explicit',
        changed: [],
        added: [],
        removed: [],
        renamed: [],
        definition,
      });
    }
  }
  await validate(owner);
}

async function generated(owner) {
  if (same(owner.generated?.revision, owner.revision)) return owner.generated;
  owner.generated = await owner.host.readGeneratedArtifacts(owner.revision);
  return owner.generated;
}

async function materialize(owner) {
  const set = await generated(owner);
  // Exact SDK byte copies give Next ordinary JS/CSS file dependencies. The
  // cache is outside Next distDir to separate transport from framework output
  // cleanup. This never writes the canonical five-file set.
  const directory = owner.hostDir;
  fs.mkdirSync(directory, { recursive: true });
  for (const [kind, file] of [
    ['design-module', 'design.js'],
    ['css', 'styles.css'],
  ]) {
    const member = set.files.find((item) => item.kind === kind);
    if (member == null)
      throw new Error(`Missing compiler-owned ${kind} transport.`);
    const target = path.join(directory, file);
    if (
      !fs.existsSync(target) ||
      digest(fs.readFileSync(target)) !== digest(member.content)
    )
      fs.writeFileSync(target, member.content);
  }
  owner.transportDir = directory;
  return set;
}

async function abort(owner) {
  if (owner.ticket != null) {
    const ticket = owner.ticket;
    owner.ticket = null;
    await owner.host.abortPrepared(ticket);
    event(owner, 'aborted', { ticket });
  }
}

async function publish(owner) {
  // Next may report several successful webpack compilations for the same
  // semantic revision (for example, a later route compilation after the
  // initial multi-compiler barrier). A committed generated set is immutable
  // for that revision, so do not prepare and commit it again.
  if (same(owner.publishedRevision, owner.revision)) return;
  await abort(owner);
  owner.ticket = await owner.host.preparePublication(owner.revision);
  event(owner, 'prepared', { ticket: owner.ticket });
  // Any accepted source change while a ticket is prepared revokes it through
  // the service, even when backend compilation has already finished.
  await owner.watcher.flush();
  const current = await owner.project.current();
  if (!same(current.revision, owner.revision)) {
    const ticket = owner.ticket;
    owner.ticket = null;
    await owner.host.commitPrepared(ticket); // authoritative stale rejection
    throw unsupported(
      'A source mutation superseded this Next compilation. Retry the build.',
    );
  }
  const ticket = owner.ticket;
  owner.ticket = null;
  const receipt = await owner.host.commitPrepared(ticket);
  // The idempotency key is the host source revision being published. The
  // artifact revision belongs to the compiler's generated-artifact session
  // and may use a different session id.
  owner.publishedRevision = owner.revision;
  event(owner, 'committed', { receipt });
}

async function close(owner) {
  if (owner.closed) return;
  owner.closed = true;
  try {
    await abort(owner);
  } finally {
    owner.watcher?.close();
    await owner.project?.close();
    owners.delete(owner.id);
    event(owner, 'closed');
  }
}

export function createOwner(root, options, dev, distDir) {
  const outDir = path.resolve(root, options.outDir ?? '.pandamstyle');
  const hostDir = path.resolve(
    root,
    '.pandamstyle-next-host',
    digest(outDir + '\0' + distDir),
  );
  if (
    within(outDir, path.resolve(root, distDir)) ||
    within(path.resolve(root, distDir), outDir)
  ) {
    throw unsupported('PandamStyle outDir and Next distDir must not overlap.');
  }
  const roots = options.roots.map((file) => path.resolve(root, file));
  for (const file of roots) {
    if (
      !within(root, file) ||
      within(outDir, file) ||
      within(path.resolve(root, distDir), file) ||
      within(file, path.resolve(root, distDir)) ||
      within(file, hostDir) ||
      within(hostDir, file)
    ) {
      throw unsupported(
        'PandamStyle roots must stay inside the Next project and outside output directories.',
      );
    }
  }
  const id = digest(root + '\0' + outDir);
  if (owners.has(id))
    throw unsupported(
      'Another PandamStyle Next configuration owns this output.',
    );
  const designFile = options.designSystemFile ?? 'design.js';
  const owner = {
    id,
    root,
    roots,
    outDir,
    hostDir,
    options,
    dev,
    designFile,
    designPath: path.resolve(outDir, designFile),
    definitionPath:
      typeof options.definition === 'string'
        ? path.resolve(root, options.definition)
        : null,
    tail: Promise.resolve(),
    project: null,
    host: null,
    watcher: null,
    ticket: null,
    revision: null,
    validatedRevision: null,
    publishedRevision: null,
    generated: null,
    closed: false,
    compilers: new Map(),
  };
  owners.set(id, owner);
  return owner;
}

export function wireCompiler(owner, compiler) {
  const record = { revision: null, done: false, errors: false };
  owner.compilers.set(compiler, record);
  compiler.hooks.beforeCompile.tapPromise('PandamStyle', () =>
    enqueue(owner, async () => {
      record.done = false;
      record.validationError = null;
      // Reject through compilation.errors/loaders rather than aborting webpack's
      // watching lifecycle. A fatal beforeCompile rejection closes Next's
      // multi-compiler watcher and prevents invalid-source repair.
      try {
        await refresh(owner);
      } catch (error) {
        record.validationError = error;
      }
      record.revision = owner.revision;
      if (record.validationError == null) await materialize(owner);
      event(owner, 'compilation-start', { compiler: compiler.name });
    }),
  );
  compiler.hooks.thisCompilation.tap('PandamStyle', (compilation) => {
    if (record.validationError != null)
      compilation.errors.push(record.validationError);
    for (const file of owner.roots) compilation.contextDependencies.add(file);
    if (owner.definitionPath != null)
      compilation.fileDependencies.add(owner.definitionPath);
  });
  compiler.hooks.done.tapPromise('PandamStyle', (stats) =>
    enqueue(owner, async () => {
      record.done = true;
      record.errors = stats.hasErrors();
      event(owner, 'compilation-done', {
        compiler: compiler.name,
        errors: record.errors,
      });
      if (record.errors) {
        await abort(owner);
        return;
      }
      if (!owner.dev) return;
      // Every configured webpack compiler must settle on this exact revision.
      // Root/definition dependencies cause even an otherwise unused target to
      // participate in source invalidation. No timer approximates a barrier.
      const settled = [...owner.compilers.values()].every(
        (item) =>
          item.done && !item.errors && same(item.revision, owner.revision),
      );
      if (settled) {
        try {
          await publish(owner);
        } catch (error) {
          // A publication failure is a recoverable dev compilation error. A
          // rejected done hook would close Next's multi-compiler watcher.
          record.errors = true;
          stats.compilation.errors.push(error);
          const code = error.code ?? error.diagnostics?.[0]?.code ?? null;
          event(owner, 'publication-error', {
            code,
            diagnostics: error.diagnostics ?? null,
            message: error.message,
          });
          if (['PMS_STALE_REVISION', 'PMS_STALE_PUBLICATION'].includes(code)) {
            for (const target of owner.compilers.keys())
              target.watching?.invalidate();
          }
        }
      }
    }),
  );
  compiler.hooks.failed.tap('PandamStyle', () => {
    record.done = true;
    record.errors = true;
    void enqueue(owner, () => abort(owner)).catch(() => {});
  });
  compiler.hooks.watchClose.tap('PandamStyle', () => {
    owner.compilers.delete(compiler);
    if (owner.compilers.size === 0)
      void enqueue(owner, () => close(owner)).catch(() => {});
  });
}

export async function transportSource({
  id,
  kind,
  file,
  source,
  addDependency,
  addContextDependency,
  withSourceMap = false,
}) {
  const owner = owners.get(id);
  if (owner == null)
    throw unsupported(
      'PandamStyle loader has no service owner. Worker/process transport is unavailable for this configuration.',
    );
  for (const root of owner.roots) addContextDependency(root);
  if (owner.definitionPath != null) addDependency(owner.definitionPath);
  return enqueue(owner, async () => {
    await refresh(owner);
    await materialize(owner);
    if (kind !== 'source') {
      const set = await generated(owner);
      const member = set.files.find(
        (item) => item.kind === (kind === 'css' ? 'css' : 'design-module'),
      );
      if (member == null)
        throw new Error('Missing compiler-owned canonical member.');
      if (
        file !==
        path.join(
          owner.transportDir,
          kind === 'css' ? 'styles.css' : 'design.js',
        )
      ) {
        for (const compiler of owner.compilers.keys())
          compiler.watching?.invalidate();
        const error = new Error(
          'PMS_STALE_REVISION: generated webpack resource belongs to another artifact set.',
        );
        error.code = 'PMS_STALE_REVISION';
        throw error;
      }
      event(owner, 'generated-transport', {
        kind,
        sha256: digest(member.content),
      });
      return withSourceMap
        ? {
            code: member.content,
            map:
              member.sourceMap == null
                ? null
                : {
                    ...JSON.parse(member.sourceMap),
                    sources: JSON.parse(member.sourceMap).sources.map((item) =>
                      path.resolve(owner.root, item),
                    ),
                  },
          }
        : member.content;
    }
    const relative = path.relative(owner.root, file).split(path.sep).join('/');
    let artifact = await owner.host.readArtifact(owner.revision, relative);
    if (artifact.sourceDigest !== digest(source)) {
      if (!owner.dev)
        throw new Error(
          `PMS_COVERAGE_GAP: Next source differs from the validated artifact: ${relative}. Put PandamStyle before other source transforms.`,
        );
      // A queued webpack module may still contain pre-edit text. It is not
      // evidence for a newer service revision and must never become an overlay.
      const diskSource = fs.readFileSync(file, 'utf8');
      if (digest(diskSource) !== digest(source)) {
        for (const compiler of owner.compilers.keys())
          compiler.watching?.invalidate();
        const error = new Error(
          `PMS_STALE_REVISION: webpack input is superseded on disk: ${relative}.`,
        );
        error.code = 'PMS_STALE_REVISION';
        throw error;
      }
      const changed = await owner.project.applyChanges({
        baseRevision: owner.revision,
        mode: 'verified-explicit',
        changed: [relative],
        added: [],
        removed: [],
        renamed: [],
        sourceOverlays: [{ file: relative, source }],
      });
      owner.revision = changed.revision;
      await validate(owner);
      artifact = await owner.host.readArtifact(owner.revision, relative);
      for (const compiler of owner.compilers.keys())
        compiler.watching?.invalidate();
    }
    for (const dependency of artifact.dependencies) {
      const absolute = path.resolve(owner.root, dependency);
      if (within(owner.root, absolute)) addDependency(absolute);
    }
    event(owner, 'transform', {
      file: relative,
      sourceDigest: artifact.sourceDigest,
    });
    const cssImport = /^(src\/)?app\/(?:.*\/)?layout\.[jt]sx?$/.test(relative)
      ? `\nimport ${JSON.stringify(path.join(owner.transportDir, 'styles.css'))};\n`
      : '';
    return withSourceMap
      ? {
          code: artifact.javascript + cssImport,
          map:
            artifact.sourceMap == null
              ? null
              : {
                  ...JSON.parse(artifact.sourceMap),
                  sources: JSON.parse(artifact.sourceMap).sources.map((item) =>
                    path.resolve(owner.root, item),
                  ),
                },
        }
      : artifact.javascript + cssImport;
  });
}

export async function finishProduction(root) {
  const owner = [...owners.values()].find(
    (value) => value.root === path.resolve(root) && !value.dev,
  );
  if (owner == null)
    throw unsupported(
      'Next production completion has no matching in-process PandamStyle service owner.',
    );
  return enqueue(owner, async () => {
    try {
      await owner.watcher.flush();
      const current = await owner.project.current();
      if (!same(current.revision, owner.revision))
        throw new Error(
          'PMS_STALE_REVISION: source changed during the Next production build.',
        );
      if (
        ![...owner.compilers.values()].every(
          (item) =>
            item.done && !item.errors && same(item.revision, owner.revision),
        )
      ) {
        throw new Error(
          'PMS_INVALID_REVISION: Next compilers did not settle on one service revision.',
        );
      }
      await publish(owner);
    } finally {
      await close(owner);
    }
  });
}
