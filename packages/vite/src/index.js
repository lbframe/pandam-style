/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Codes, PmsError, createProjectSession } from '@pandamstyle/compiler';
import { createHostBridge } from '@pandamstyle/compiler/host';

const SOURCE_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
]);
const CSS_ROUTE = '__pandamstyle.css';
const CSS_ASSET_FILE = 'pandamstyle/styles.css';
const CLIENT_ID = 'virtual:pandamstyle/client';
const RESOLVED_CLIENT_ID = '\0pandamstyle:client';
const RESOLVED_DESIGN_ID = '\0pandamstyle:generated-design-system';

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sameRevision(left, right) {
  return (
    left != null &&
    right != null &&
    left.projectId === right.projectId &&
    left.sessionId === right.sessionId &&
    left.revisionId === right.revisionId
  );
}

function within(parent, target) {
  const relative = path.relative(parent, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function cleanId(value) {
  if (typeof value !== 'string' || value === '' || value.includes('\0')) {
    return null;
  }
  let clean = value.split('?')[0].split('#')[0];
  if (clean.startsWith('/@fs/')) clean = clean.slice('/@fs'.length);
  if (clean.startsWith('file://')) {
    try {
      clean = fileURLToPath(clean);
    } catch {
      return null;
    }
  }
  return clean;
}

function canonicalFile(value) {
  const absolute = path.resolve(value);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function firstDiagnosticCode(error) {
  return Array.isArray(error?.diagnostics)
    ? error.diagnostics.find((item) => typeof item?.code === 'string')?.code
    : error?.code;
}

function adapterError(code, message, rule, context = {}, source = null) {
  const diagnostic = {
    code,
    severity: 'error',
    phase: 'vite',
    rule,
    message,
    source,
    location: null,
    context,
    autofix: null,
  };
  const error = new PmsError([diagnostic]);
  error.code = code;
  error.context = context;
  return error;
}

function diagnosticsError(result) {
  return new PmsError([...result.diagnostics]);
}

function unsupportedConfig(message, context = {}) {
  return adapterError(
    Codes.UNSUPPORTED_FEATURE,
    message,
    'vite.configuration',
    context,
  );
}

function isSourceId(file) {
  return SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function isNodeModules(file) {
  return file.split(path.sep).includes('node_modules');
}

function asBaseUrl(base, file) {
  const normalized = typeof base === 'string' && base !== '' ? base : '/';
  return `${normalized.endsWith('/') ? normalized : `${normalized}/`}${file}`;
}

function findGeneratedFile(set, kind) {
  return set?.files?.find((entry) => entry.kind === kind) ?? null;
}

async function loadDefinition(option, root, server = null) {
  if (option != null && typeof option === 'object') return option;
  if (typeof option !== 'string' || option === '') {
    throw unsupportedConfig(
      'pandamstyle requires a design-system definition object or module path.',
      { option: 'definition' },
    );
  }
  const file = canonicalFile(path.resolve(root, option));
  let loaded;
  const ssrRunner = server?.environments?.ssr?.runner;
  if (typeof ssrRunner?.import === 'function') {
    loaded = await ssrRunner.import(file);
  } else {
    const url = pathToFileURL(file);
    url.searchParams.set('pandamstyle-reload', String(Date.now()));
    loaded = await import(url.href);
  }
  let definition = loaded?.default ?? loaded;
  if (typeof definition === 'function') definition = await definition();
  if (definition == null || typeof definition !== 'object') {
    throw unsupportedConfig(
      'The configured design-system module must export a definition object.',
      { file },
    );
  }
  return definition;
}

function clientModuleSource(cssUrl) {
  return `
const cssUrl = ${JSON.stringify(cssUrl)};
const diagnosticsId = 'pandamstyle-vite-diagnostics';
function applyCss(revision) {
  const link = document.querySelector('link[data-pandamstyle]');
  if (!link || revision == null) return;
  const version = encodeURIComponent(revision.sessionId + '-' + revision.revisionId);
  link.href = cssUrl + (cssUrl.includes('?') ? '&' : '?') + 'pms=' + version;
}
function showDiagnostics(result) {
  let overlay = document.getElementById(diagnosticsId);
  if (result?.ok === true) {
    overlay?.remove();
    return;
  }
  if (!overlay) {
    overlay = document.createElement('pre');
    overlay.id = diagnosticsId;
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '1rem',
      zIndex: '2147483647',
      overflow: 'auto',
      margin: '0',
      padding: '1rem',
      color: '#fff',
      background: '#4c1010',
      whiteSpace: 'pre-wrap',
      font: '13px/1.5 ui-monospace, monospace',
    });
    document.body.appendChild(overlay);
  }
  overlay.textContent = (result?.diagnostics ?? [])
    .map((item) => item.code + ': ' + item.message)
    .join('\\n');
}
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.on('pandamstyle:css-update', (event) => applyCss(event?.revision));
  import.meta.hot.on('pandamstyle:diagnostics', showDiagnostics);
}
`;
}

/** Create a Vite plugin backed only by the public compiler Project Service. */
export function pandamstyle(options = {}) {
  if (options.publicationMode === 'semantic-dev') {
    throw adapterError(
      Codes.UNSUPPORTED_FEATURE,
      'semantic-dev is available only for qualified Next Turbopack development.',
      'vite.host-contract',
    );
  }
  if (options.acceptedSnapshotRetention != null) {
    throw adapterError(
      Codes.UNSUPPORTED_FEATURE,
      'Vite uses current revision reads and does not enable accepted snapshot retention.',
      'vite.host-contract',
    );
  }
  const userOptions = { ...options };
  let config = null;
  let root = process.cwd();
  let compilerOutDir = null;
  const compilerScratchPaths = () =>
    compilerOutDir == null
      ? []
      : [
          'pms-staging',
          'pms-backup',
          'pms-state.json',
          'pms-state.pending.json',
        ].map((suffix) =>
          path.join(
            path.dirname(compilerOutDir),
            `.${path.basename(compilerOutDir)}.${suffix}`,
          ),
        );
  const isCompilerOutput = (file) =>
    within(compilerOutDir, file) ||
    compilerScratchPaths().some((directory) => within(directory, file));
  let viteOutDir = null;
  let designModulePath = null;
  let definitionPath = null;
  let rootPaths = [];
  let cssUrl = `/${CSS_ROUTE}`;
  let cssRoutePath = `/${CSS_ROUTE}`;
  let project = null;
  let host = null;
  let revision = null;
  let server = null;
  let closeWatcher = null;
  let watcherReady = false;
  let pendingTimer = null;
  let pendingFilesystemOperation = Promise.resolve();
  let pendingAdded = new Set();
  let pendingRemoved = new Set();
  let preparedTicket = null;
  let sharedBuildEnvironmentNames = [];
  const closedSharedBuildEnvironments = new Set();
  let sharedPluginBuild = false;
  let generatedArtifacts = null;
  let cssArtifact = null;
  const cssArtifactCache = new Map();
  const cssRevisionIndex = new Map();
  let operationTail = Promise.resolve();
  let closePromise = null;
  let closing = false;
  let closed = false;
  let buildError = null;
  let firstTransformMs = null;
  const transformedArtifacts = new Map();
  const configuredAt = performance.now();

  function enqueue(operation) {
    const result = operationTail.then(() => {
      if (closing || closed) {
        throw adapterError(
          Codes.SESSION_CLOSED,
          'The PandamStyle Vite project is closing or closed.',
          'vite.session-lifecycle',
        );
      }
      return operation();
    });
    operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function emitCustom(event, data) {
    const clientHot = server?.environments?.client?.hot;
    if (clientHot == null) return;
    clientHot.send(event, data);
  }

  function emitReload() {
    const clientHot = server?.environments?.client?.hot;
    if (clientHot == null) return;
    clientHot.send({ type: 'full-reload' });
  }

  function publishDiagnostics(result) {
    emitCustom('pandamstyle:diagnostics', result);
  }

  async function publishDiagnosticsForRevision(result) {
    const diagnostics = await project.agentResult(result.revision);
    publishDiagnostics(diagnostics ?? result);
    return diagnostics ?? result;
  }

  function revisionUrl(target) {
    if (target == null) return cssUrl;
    const query = encodeURIComponent(
      `${target.sessionId}-${target.revisionId}`,
    );
    return `${cssUrl}${cssUrl.includes('?') ? '&' : '?'}pms=${query}`;
  }

  function rememberCssArtifact(artifact) {
    const { revision: target } = artifact;
    const version = `${target.sessionId}-${target.revisionId}`;
    const identity = JSON.stringify([
      target.projectId,
      target.sessionId,
      target.revisionId,
      artifact.digest ?? sha256(artifact.content),
    ]);
    cssArtifactCache.set(identity, artifact);
    cssRevisionIndex.set(version, identity);
    while (cssRevisionIndex.size > 16) {
      const oldestVersion = cssRevisionIndex.keys().next().value;
      const oldestIdentity = cssRevisionIndex.get(oldestVersion);
      cssRevisionIndex.delete(oldestVersion);
      if (![...cssRevisionIndex.values()].includes(oldestIdentity)) {
        cssArtifactCache.delete(oldestIdentity);
      }
    }
  }

  async function currentState() {
    const value = await project.current();
    if (value.revision == null) {
      throw adapterError(
        Codes.INVALID_REVISION,
        'The Project Service has no initialized revision.',
        'vite.project-initialization',
      );
    }
    return value;
  }

  async function readGeneratedArtifacts(targetRevision) {
    if (sameRevision(generatedArtifacts?.revision, targetRevision)) {
      return generatedArtifacts;
    }
    const set = await host.readGeneratedArtifacts(targetRevision);
    if (!sameRevision(set.revision, targetRevision)) {
      throw adapterError(
        Codes.STALE_REVISION,
        'The canonical generated artifact set did not match the requested revision.',
        'vite.artifact-revision',
      );
    }
    generatedArtifacts = set;
    return set;
  }

  async function publishCssForRevision(targetRevision) {
    const artifacts = await readGeneratedArtifacts(targetRevision);
    const css = findGeneratedFile(artifacts, 'css');
    if (css == null) {
      throw adapterError(
        Codes.GENERATED_ARTIFACT_MISMATCH,
        'The compiler did not return the canonical styles.css member.',
        'vite.css-artifact',
      );
    }
    cssArtifact = Object.freeze({ ...css, revision: artifacts.revision });
    rememberCssArtifact(cssArtifact);
    emitCustom('pandamstyle:css-update', {
      revision: artifacts.revision,
      href: revisionUrl(artifacts.revision),
    });
    return cssArtifact;
  }

  function sendRevisionObservation(observation) {
    emitCustom('pandamstyle:revision', observation);
  }

  async function processMutation(transaction, optionsForUpdate = {}) {
    const started = performance.now();
    const before = await currentState();
    const beforeRevision = before.revision;
    const beforeGeneration = before.generation?.generationId ?? null;
    const accepted = await project.applyChanges({
      baseRevision: beforeRevision,
      mode: 'watcher',
      changed: transaction.changed ?? [],
      added: transaction.added ?? [],
      removed: transaction.removed ?? [],
      renamed: transaction.renamed ?? [],
      ...(transaction.sourceOverlays == null
        ? {}
        : { sourceOverlays: transaction.sourceOverlays }),
      ...(transaction.definition === undefined
        ? {}
        : { definition: transaction.definition }),
    });
    revision = accepted.revision;
    generatedArtifacts = null;

    const validationStarted = performance.now();
    const result = await project.validate(accepted.revision);
    const hostValidationMs = performance.now() - validationStarted;
    if (!result.ok) {
      invalidateFiles([...transformedArtifacts.keys()]);
      await publishDiagnosticsForRevision(result);
      const current = await project.current();
      sendRevisionObservation({
        revisionBefore: beforeRevision,
        revisionAfter: result.revision,
        generationBefore: beforeGeneration,
        generationAfter: current.generation?.generationId ?? null,
        hostQueueWaitMs: Math.max(0, validationStarted - started),
        hostValidationMs,
        projectDiagnosticsMs:
          result.milestones?.agent_edit_to_diagnostics_ms ??
          result.milestones?.diagnosticsReadyMs ??
          null,
        counters: result.counters ?? accepted.counters ?? {},
        fullFallback: result.fullFallback === true,
        fullFallbackReason:
          result.fullFallbackReason ?? accepted.fullFallbackReason ?? null,
        mutation: {
          changed: transaction.changed ?? [],
          added: transaction.added ?? [],
          removed: transaction.removed ?? [],
          renamed: transaction.renamed ?? [],
        },
        invalidatedModules: optionsForUpdate.invalidatedModules ?? [],
        outcome: 'diagnostic',
      });
      return { result, ok: false, revision: result.revision };
    }

    const compileStarted = performance.now();
    const receipt = await project.compile(result.revision);
    const hostCompileMs = performance.now() - compileStarted;
    const changedModules = [];
    for (const [file, previous] of transformedArtifacts) {
      try {
        const artifact = await host.readArtifact(
          result.revision,
          path.relative(root, file).split(path.sep).join('/'),
        );
        if (
          artifact.javascript !== previous.javascript ||
          JSON.stringify(artifact.dependencies) !==
            JSON.stringify(previous.dependencies)
        )
          changedModules.push(file);
        transformedArtifacts.set(file, {
          javascript: artifact.javascript,
          dependencies: artifact.dependencies,
        });
      } catch (error) {
        if (
          error?.diagnostics?.some((item) => item.context?.covered === false)
        ) {
          transformedArtifacts.delete(file);
          changedModules.push(file);
        } else throw error;
      }
    }
    await publishCssForRevision(result.revision);
    await publishDiagnosticsForRevision(result);
    const current = await project.current();
    const serviceDiagnosticsMs =
      result.milestones?.agent_edit_to_diagnostics_ms ??
      result.milestones?.diagnosticsReadyMs ??
      null;
    sendRevisionObservation({
      revisionBefore: beforeRevision,
      revisionAfter: result.revision,
      generationBefore: beforeGeneration,
      generationAfter: current.generation?.generationId ?? receipt.generationId,
      hostQueueWaitMs: Math.max(0, validationStarted - started),
      hostValidationMs,
      hostCompileMs,
      projectDiagnosticsMs: serviceDiagnosticsMs,
      hostCssSettledMs: performance.now() - started,
      counters: result.counters ?? accepted.counters ?? {},
      fullFallback: result.fullFallback === true,
      fullFallbackReason:
        result.fullFallbackReason ?? accepted.fullFallbackReason ?? null,
      mutation: {
        changed: transaction.changed ?? [],
        added: transaction.added ?? [],
        removed: transaction.removed ?? [],
        renamed: transaction.renamed ?? [],
      },
      invalidatedModules: optionsForUpdate.invalidatedModules ?? [],
      outcome: optionsForUpdate.outcome ?? 'hmr',
    });
    return {
      result,
      ok: true,
      revision: result.revision,
      receipt,
      changedModules,
    };
  }

  async function validateCurrent() {
    const current = await currentState();
    const result = await project.validate(current.revision);
    revision = result.revision;
    if (!result.ok) {
      await publishDiagnosticsForRevision(result);
      throw diagnosticsError(result);
    }
    return result;
  }

  async function sourceArtifact(code, file, fileRelative) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await currentState();
      let artifact;
      try {
        artifact = await host.readArtifact(current.revision, fileRelative);
      } catch (error) {
        if (
          attempt === 0 &&
          [Codes.STALE_REVISION, Codes.SUPERSEDED_REVISION].includes(
            firstDiagnosticCode(error),
          )
        ) {
          continue;
        }
        throw error;
      }
      const incomingDigest = sha256(code);
      if (artifact.sourceDigest === incomingDigest) {
        revision = artifact.revision;
        return artifact;
      }
      if (config.command !== 'serve') {
        throw adapterError(
          Codes.COVERAGE_GAP,
          'Vite supplied source that differs from the compiler input during a production build. Put PandamStyle before source-transform plugins so every output module can share one exact service revision.',
          'vite.source-provenance',
          {
            file: fileRelative,
            filesystemSourceDigest: artifact.sourceDigest,
            viteSourceDigest: incomingDigest,
          },
          fileRelative,
        );
      }
      const mutationStarted = performance.now();
      const mutation = await project.applyChanges({
        baseRevision: current.revision,
        mode: 'watcher',
        changed: [fileRelative],
        added: [],
        removed: [],
        renamed: [],
        sourceOverlays: [{ file: fileRelative, source: code }],
      });
      revision = mutation.revision;
      generatedArtifacts = null;
      const validationStarted = performance.now();
      const result = await project.validate(mutation.revision);
      const hostValidationMs = performance.now() - validationStarted;
      if (!result.ok) {
        await publishDiagnosticsForRevision(result);
        throw diagnosticsError(result);
      }
      const compileStarted = performance.now();
      const receipt = await project.compile(result.revision);
      const hostCompileMs = performance.now() - compileStarted;
      await publishCssForRevision(result.revision);
      await publishDiagnosticsForRevision(result);
      const currentGeneration = await project.current();
      const hostCssSettledMs = performance.now() - mutationStarted;
      sendRevisionObservation({
        revisionBefore: current.revision,
        revisionAfter: result.revision,
        generationBefore: current.generation?.generationId ?? null,
        generationAfter:
          currentGeneration.generation?.generationId ?? receipt.generationId,
        hostQueueWaitMs: Math.max(0, validationStarted - mutationStarted),
        hostValidationMs,
        hostCompileMs,
        projectDiagnosticsMs:
          result.milestones?.agent_edit_to_diagnostics_ms ??
          result.milestones?.diagnosticsReadyMs ??
          null,
        hostCssSettledMs,
        counters: result.counters ?? mutation.counters ?? {},
        fullFallback: result.fullFallback === true,
        fullFallbackReason:
          result.fullFallbackReason ?? mutation.fullFallbackReason ?? null,
        invalidatedModules: [file],
        outcome: 'full-reload',
      });
      emitReload();
    }
    throw adapterError(
      Codes.STALE_REVISION,
      'The Vite module remained stale while its exact Project Service revision was being read.',
      'vite.source-revision',
      { file: fileRelative },
      fileRelative,
    );
  }

  async function applyPendingFilesystemChanges() {
    if (pendingTimer != null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (pendingAdded.size === 0 && pendingRemoved.size === 0) return null;
    const added = [...pendingAdded];
    const removed = [...pendingRemoved];
    pendingAdded = new Set();
    pendingRemoved = new Set();
    const outcome = await enqueue(async () => {
      const current = await currentState();
      const addedByDigest = new Map();
      const removedByDigest = new Map();
      for (const file of added) {
        const absolute = path.resolve(root, file);
        const source = await fsp.readFile(absolute, 'utf8').catch(() => null);
        if (source == null) continue;
        const digest = sha256(source);
        const matches = addedByDigest.get(digest) ?? [];
        matches.push(file);
        addedByDigest.set(digest, matches);
      }
      for (const file of removed) {
        try {
          const artifact = await host.readArtifact(current.revision, file);
          const matches = removedByDigest.get(artifact.sourceDigest) ?? [];
          matches.push(file);
          removedByDigest.set(artifact.sourceDigest, matches);
        } catch {
          // Unreadable or invalid old revisions stay explicit add/remove events.
        }
      }
      const renamed = [];
      const pairedAdded = new Set();
      const pairedRemoved = new Set();
      for (const [digest, oldFiles] of removedByDigest) {
        const newFiles = addedByDigest.get(digest) ?? [];
        if (oldFiles.length !== 1 || newFiles.length !== 1) continue;
        renamed.push({ from: oldFiles[0], to: newFiles[0] });
        pairedRemoved.add(oldFiles[0]);
        pairedAdded.add(newFiles[0]);
      }
      return processMutation(
        {
          changed: [],
          added: added.filter((file) => !pairedAdded.has(file)),
          removed: removed.filter((file) => !pairedRemoved.has(file)),
          renamed,
        },
        { outcome: 'full-reload' },
      );
    });
    if (outcome.ok) {
      invalidateFiles(outcome.changedModules);
      emitReload();
    }
    return outcome;
  }

  async function settlePendingFilesystemChanges() {
    const started = performance.now();
    let waitingForChanges =
      pendingTimer != null || pendingAdded.size > 0 || pendingRemoved.size > 0;
    while (waitingForChanges) {
      if (performance.now() - started > 5000) {
        throw adapterError(
          Codes.STALE_REVISION,
          'The Vite watcher journal did not settle before the dependent module update.',
          'vite.watcher-settle',
        );
      }
      if (pendingTimer != null) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      } else {
        await pendingFilesystemOperation;
      }
      waitingForChanges =
        pendingTimer != null ||
        pendingAdded.size > 0 ||
        pendingRemoved.size > 0;
    }
    await pendingFilesystemOperation;
  }

  function queueFilesystemEvent(kind, inputPath) {
    if (!watcherReady || closing || closed) return;
    const file = canonicalFile(path.resolve(inputPath));
    if (
      !within(root, file) ||
      isCompilerOutput(file) ||
      within(viteOutDir, file) ||
      isNodeModules(file) ||
      !isSourceId(file) ||
      (definitionPath != null && file === definitionPath)
    ) {
      return;
    }
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (kind === 'add') {
      pendingRemoved.delete(relative);
      pendingAdded.add(relative);
    } else {
      pendingAdded.delete(relative);
      pendingRemoved.add(relative);
    }
    if (pendingTimer != null) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      pendingFilesystemOperation = applyPendingFilesystemChanges().catch(
        (error) => {
          server?.config?.logger?.error(error?.stack ?? String(error));
        },
      );
    }, 300);
  }

  async function applyDefinitionChange(ctx) {
    const definition = await loadDefinition(
      userOptions.definition,
      root,
      server,
    );
    const outcome = await processMutation(
      {
        changed: [],
        added: [],
        removed: [],
        renamed: [],
        definition,
      },
      {
        outcome: 'full-reload',
        invalidatedModules: ctx.modules.map((module) => module.id),
      },
    );
    if (outcome.ok) {
      // A design-system revision changes the compiler-owned runtime module and
      // possibly a small set of transformed sources. Invalidating the whole
      // Vite graph turns a semantic value edit back into project-wide work.
      invalidateGeneratedDesignSystem();
      invalidateFiles(outcome.changedModules);
      emitReload();
    }
    return outcome;
  }

  function invalidateFiles(files) {
    const modules = new Set();
    for (const environment of Object.values(server?.environments ?? {})) {
      for (const file of files ?? []) {
        for (const module of environment.moduleGraph.getModulesByFile?.(file) ??
          []) {
          environment.moduleGraph.invalidateModule(module);
          if (environment === server.environments.client) modules.add(module);
        }
      }
    }
    return [...modules];
  }

  function invalidateGeneratedDesignSystem() {
    for (const environment of Object.values(server?.environments ?? {})) {
      const module =
        environment.moduleGraph.getModuleById?.(RESOLVED_DESIGN_ID);
      if (module != null) environment.moduleGraph.invalidateModule(module);
    }
  }

  async function closeProject() {
    if (closePromise != null) return closePromise;
    if (closed) return;
    closing = true;
    closePromise = (async () => {
      if (pendingTimer != null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      await operationTail;
      if (preparedTicket != null && host != null) {
        try {
          await host.abortPrepared(preparedTicket);
        } catch {
          // close() still releases the service's ticket and resources.
        }
        preparedTicket = null;
      }
      closeWatcher?.();
      closeWatcher = null;
      try {
        await project?.close();
      } finally {
        generatedArtifacts = null;
        cssArtifact = null;
        cssArtifactCache.clear();
        cssRevisionIndex.clear();
        transformedArtifacts.clear();
        closed = true;
        closing = false;
      }
    })();
    return closePromise;
  }

  function sharedBuildEnvironmentIsFinal(name) {
    if (!sharedPluginBuild || sharedBuildEnvironmentNames.length < 2)
      return true;
    return name === sharedBuildEnvironmentNames.at(-1);
  }

  function sharedBuildEnvironmentClosed(name) {
    if (!sharedPluginBuild || sharedBuildEnvironmentNames.length < 2)
      return true;
    if (typeof name === 'string') closedSharedBuildEnvironments.add(name);
    return (
      buildError != null ||
      sharedBuildEnvironmentNames.every((environmentName) =>
        closedSharedBuildEnvironments.has(environmentName),
      )
    );
  }

  return {
    name: 'pandamstyle',
    enforce: 'pre',

    async configResolved(resolvedConfig) {
      if (
        project != null &&
        config?.command === 'build' &&
        sharedPluginBuild &&
        resolvedConfig.command === 'build' &&
        resolvedConfig.builder?.sharedPlugins === true &&
        canonicalFile(path.resolve(resolvedConfig.root)) === root
      ) {
        const output = resolvedConfig.build?.rolldownOptions?.output;
        if (Array.isArray(output) && output.length > 1) {
          throw unsupportedConfig(
            'PandamStyle supports one Vite/Rollup output per build.',
            { outputCount: output.length },
          );
        }
        if (resolvedConfig.build?.write === false) {
          throw unsupportedConfig(
            'PandamStyle publication requires Vite to write its output. build.write: false is unsupported.',
            { buildWrite: false },
          );
        }
        const environmentOutDir = canonicalFile(
          path.resolve(root, resolvedConfig.build?.outDir ?? 'dist'),
        );
        if (
          within(compilerOutDir, environmentOutDir) ||
          within(environmentOutDir, compilerOutDir)
        ) {
          throw unsupportedConfig(
            'The PandamStyle output directory and Vite build.outDir must not overlap.',
            { compilerOutDir, viteOutDir: environmentOutDir },
          );
        }
        return;
      }
      config = resolvedConfig;
      sharedPluginBuild =
        resolvedConfig.command === 'build' &&
        resolvedConfig.builder?.sharedPlugins === true;
      sharedBuildEnvironmentNames = sharedPluginBuild
        ? Object.keys(resolvedConfig.environments ?? {})
        : [];
      root = canonicalFile(path.resolve(resolvedConfig.root));
      if (!Array.isArray(userOptions.roots) || userOptions.roots.length === 0) {
        throw unsupportedConfig(
          'pandamstyle requires at least one explicit source root.',
          { option: 'roots' },
        );
      }
      if (
        typeof userOptions.definition !== 'string' &&
        (userOptions.definition == null ||
          typeof userOptions.definition !== 'object')
      ) {
        throw unsupportedConfig(
          'pandamstyle requires a design-system definition object or module path.',
          { option: 'definition' },
        );
      }

      const output = resolvedConfig.build?.rolldownOptions?.output;
      if (Array.isArray(output) && output.length > 1) {
        throw unsupportedConfig(
          'PandamStyle supports one Vite/Rollup output per build.',
          { outputCount: output.length },
        );
      }
      if (
        resolvedConfig.command === 'build' &&
        resolvedConfig.build?.write === false
      ) {
        throw unsupportedConfig(
          'PandamStyle publication requires Vite to write its output. build.write: false is unsupported.',
          { buildWrite: false },
        );
      }

      compilerOutDir = canonicalFile(
        path.resolve(root, userOptions.outDir ?? '.pandamstyle'),
      );
      viteOutDir = canonicalFile(
        path.resolve(root, resolvedConfig.build?.outDir ?? 'dist'),
      );
      if (
        within(compilerOutDir, viteOutDir) ||
        within(viteOutDir, compilerOutDir)
      ) {
        throw unsupportedConfig(
          'The PandamStyle output directory and Vite build.outDir must not overlap.',
          { compilerOutDir, viteOutDir },
        );
      }
      rootPaths = userOptions.roots.map((entry) =>
        canonicalFile(path.resolve(root, entry)),
      );
      for (const sourceRoot of rootPaths) {
        if (!within(root, sourceRoot) || within(compilerOutDir, sourceRoot)) {
          throw unsupportedConfig(
            'Every PandamStyle source root must stay inside Vite root and outside the generated output directory.',
            { sourceRoot, root, compilerOutDir },
          );
        }
      }

      const designSystemFile =
        userOptions.designSystemFile ?? 'design.pandamstyle.js';
      designModulePath = canonicalFile(
        path.resolve(compilerOutDir, designSystemFile),
      );
      definitionPath =
        typeof userOptions.definition === 'string'
          ? canonicalFile(path.resolve(root, userOptions.definition))
          : null;
      const base = resolvedConfig.base ?? '/';
      cssUrl = asBaseUrl(base, CSS_ROUTE);
      cssRoutePath = new URL(cssUrl, 'http://pandamstyle.invalid').pathname;

      const definition = await loadDefinition(userOptions.definition, root);
      project = createProjectSession({
        projectId: userOptions.projectId ?? root,
        rootDir: root,
        definition,
        roots: userOptions.roots,
        outDir: userOptions.outDir ?? '.pandamstyle',
        designSystemFile,
        useCSSLayers: userOptions.useCSSLayers,
        engineOptions: userOptions.engineOptions,
        auditPolicy: userOptions.auditPolicy,
      });
      host = createHostBridge(project);
      const initialized = await project.initialize();
      revision = initialized.revision;
    },

    async buildStart() {
      if (project == null) {
        throw unsupportedConfig(
          'PandamStyle must be initialized through Vite config resolution before a build starts.',
          { hook: 'buildStart' },
        );
      }
      const validation = await validateCurrent();
      if (config.command === 'serve') {
        await project.compile(validation.revision);
        await publishCssForRevision(validation.revision);
        await publishDiagnosticsForRevision(validation);
      }
    },

    resolveId(source, importer) {
      if (source === CLIENT_ID && config?.command === 'serve') {
        return RESOLVED_CLIENT_ID;
      }
      const cleanSource = cleanId(source);
      const cleanImporter = cleanId(importer);
      if (cleanSource == null || designModulePath == null) return null;
      let candidate = null;
      if (path.isAbsolute(cleanSource)) candidate = path.resolve(cleanSource);
      else if (
        cleanImporter != null &&
        (cleanSource.startsWith('.') || cleanSource.startsWith('/'))
      ) {
        candidate = path.resolve(path.dirname(cleanImporter), cleanSource);
      }
      if (candidate != null && canonicalFile(candidate) === designModulePath) {
        return RESOLVED_DESIGN_ID;
      }
      return null;
    },

    async load(id) {
      if (id === RESOLVED_CLIENT_ID) {
        if (config?.command !== 'serve') return 'export {};';
        return clientModuleSource(cssUrl);
      }
      if (id !== RESOLVED_DESIGN_ID) return null;
      const current = await currentState();
      const set = await readGeneratedArtifacts(current.revision);
      const designModule = findGeneratedFile(set, 'design-module');
      if (designModule == null) {
        throw adapterError(
          Codes.GENERATED_ARTIFACT_MISMATCH,
          'The compiler did not return the canonical design-system module.',
          'vite.design-module-artifact',
        );
      }
      return designModule.content;
    },

    async transform(code, id) {
      const clean = cleanId(id);
      if (clean == null) return null;
      const file = canonicalFile(path.resolve(clean));
      if (
        !within(root, file) ||
        isCompilerOutput(file) ||
        within(viteOutDir, file) ||
        isNodeModules(file) ||
        (definitionPath != null && file === definitionPath)
      ) {
        return null;
      }
      if (path.extname(file).toLowerCase() === '.vue') {
        throw adapterError(
          Codes.UNSUPPORTED_FEATURE,
          'This Phase 8 adapter accepts filesystem-backed JavaScript and TypeScript modules; Vue single-file component submodules need a dedicated source identity adapter.',
          'vite.module-identity',
          { file },
          path.relative(root, file).split(path.sep).join('/'),
        );
      }
      if (!isSourceId(file)) return null;
      const fileRelative = path.relative(root, file).split(path.sep).join('/');
      const transformStarted = performance.now();
      return enqueue(async () => {
        let artifact;
        try {
          artifact = await sourceArtifact(code, file, fileRelative);
        } catch (error) {
          if (
            !rootPaths.some((sourceRoot) => within(sourceRoot, file)) &&
            error?.diagnostics?.some((item) => item.context?.covered === false)
          )
            return null;
          throw error;
        }
        transformedArtifacts.set(file, {
          javascript: artifact.javascript,
          dependencies: artifact.dependencies,
        });
        for (const dependency of artifact.dependencies)
          this.addWatchFile?.(path.resolve(root, dependency));
        if (!sameRevision(artifact.revision, revision)) {
          throw adapterError(
            Codes.STALE_REVISION,
            'The compiler artifact revision changed before Vite received the transform result.',
            'vite.transform-revision',
            { file: fileRelative },
            fileRelative,
          );
        }
        if (firstTransformMs == null) {
          firstTransformMs = performance.now() - transformStarted;
          emitCustom('pandamstyle:performance', {
            metric: 'first-transform',
            hostMs: firstTransformMs,
            revision: artifact.revision,
            file: fileRelative,
          });
        }
        if (config.command === 'serve') {
          emitCustom('pandamstyle:transform', {
            file: fileRelative,
            revision: artifact.revision,
            sourceDigest: artifact.sourceDigest,
          });
        }
        return {
          code: artifact.javascript,
          map:
            artifact.sourceMap == null
              ? null
              : {
                  ...JSON.parse(artifact.sourceMap),
                  sources: JSON.parse(artifact.sourceMap).sources.map(
                    (source) => path.resolve(root, source),
                  ),
                },
          meta: {
            pandamstyle: {
              revision: artifact.revision,
              sourceDigest: artifact.sourceDigest,
            },
          },
        };
      });
    },

    configureServer(devServer) {
      server = devServer;
      devServer.watcher.unwatch([compilerOutDir, ...compilerScratchPaths()]);
      if (definitionPath != null) devServer.watcher.add(definitionPath);

      const onReady = () => {
        watcherReady = true;
      };
      const onAdd = (file) => queueFilesystemEvent('add', file);
      const onUnlink = (file) => queueFilesystemEvent('unlink', file);
      const onWatcherError = (error) => {
        void enqueue(async () => {
          const current = await currentState();
          const accepted = await project.applyChanges({
            baseRevision: current.revision,
            mode: 'full-discovery',
            changed: [],
            added: [],
            removed: [],
            renamed: [],
            forceFullDiscovery: true,
          });
          const result = await project.validate(accepted.revision);
          if (!result.ok) {
            await publishDiagnosticsForRevision(result);
            return;
          }
          await project.compile(result.revision);
          await publishCssForRevision(result.revision);
          await publishDiagnosticsForRevision(result);
          invalidateProjectModules();
          emitReload();
        }).catch((failure) => {
          devServer.config.logger.error(
            `PandamStyle watcher resync failed after ${String(error)}: ${failure?.stack ?? String(failure)}`,
          );
        });
      };
      devServer.watcher.on('ready', onReady);
      devServer.watcher.on('add', onAdd);
      devServer.watcher.on('unlink', onUnlink);
      devServer.watcher.on('error', onWatcherError);
      watcherReady = true;
      devServer.httpServer?.once('listening', () => {
        emitCustom('pandamstyle:performance', {
          metric: 'cold-dev-server-ready',
          hostMs: performance.now() - configuredAt,
          revision,
        });
      });

      const middleware = (request, response, next) => {
        const requestUrl = new URL(
          request.url ?? '/',
          'http://pandamstyle.invalid',
        );
        const wantsMap = requestUrl.pathname === cssRoutePath + '.map';
        if (requestUrl.pathname !== cssRoutePath && !wantsMap) return next();
        const version = requestUrl.searchParams.get('pms');
        const identity = version == null ? null : cssRevisionIndex.get(version);
        const artifact =
          identity == null
            ? version == null
              ? cssArtifact
              : null
            : (cssArtifactCache.get(identity) ?? null);
        if (artifact == null) {
          response.statusCode = version == null ? 503 : 409;
          response.setHeader('Cache-Control', 'no-store');
          response.end('PandamStyle CSS revision is unavailable.');
          return;
        }
        response.statusCode = 200;
        response.setHeader(
          'Content-Type',
          wantsMap
            ? 'application/json; charset=utf-8'
            : 'text/css; charset=utf-8',
        );
        if (!wantsMap)
          response.setHeader('SourceMap', cssUrl + '.map' + requestUrl.search);
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader(
          'X-PandamStyle-Revision',
          `${artifact.revision.sessionId}-${artifact.revision.revisionId}`,
        );
        response.end(
          wantsMap
            ? JSON.stringify({
                ...JSON.parse(artifact.sourceMap),
                sources: JSON.parse(artifact.sourceMap).sources.map((source) =>
                  path.resolve(root, source),
                ),
              })
            : artifact.content,
        );
      };
      devServer.middlewares.use(middleware);

      closeWatcher = () => {
        devServer.watcher.off('ready', onReady);
        devServer.watcher.off('add', onAdd);
        devServer.watcher.off('unlink', onUnlink);
        devServer.watcher.off('error', onWatcherError);
      };
    },

    async handleHotUpdate(ctx) {
      const file = canonicalFile(path.resolve(ctx.file));
      if (definitionPath != null && file === definitionPath) {
        await enqueue(() => applyDefinitionChange(ctx));
        return [];
      }
      if (
        !within(root, file) ||
        isCompilerOutput(file) ||
        within(viteOutDir, file) ||
        isNodeModules(file) ||
        !isSourceId(file)
      ) {
        return undefined;
      }
      await settlePendingFilesystemChanges();
      const fileRelative = path.relative(root, file).split(path.sep).join('/');
      const source = await ctx.read();
      const filesystemSource = await fsp
        .readFile(file, 'utf8')
        .catch(() => null);
      const sourceOverlays =
        filesystemSource === source
          ? undefined
          : [{ file: fileRelative, source }];
      const invalidatedModules = ctx.modules.map((module) => module.id);
      const outcome = await enqueue(() =>
        processMutation(
          {
            changed: [fileRelative],
            added: [],
            removed: [],
            renamed: [],
            sourceOverlays,
          },
          {
            invalidatedModules,
            outcome: invalidatedModules.length > 0 ? 'hmr' : 'full-reload',
          },
        ),
      );
      if (!outcome.ok) {
        // No current artifact exists for a rejected semantic revision. Clear
        // cached transforms so a subsequent host read must cross that barrier.
        return [];
      }
      const modules = new Set([
        ...ctx.modules,
        ...invalidateFiles(outcome.changedModules),
      ]);
      if (modules.size === 0 && outcome.changedModules.length > 0) emitReload();
      return [...modules];
    },

    transformIndexHtml: {
      order: 'pre',
      handler() {
        if (config.command === 'serve') {
          return {
            tags: [
              {
                tag: 'link',
                attrs: {
                  rel: 'stylesheet',
                  href: revisionUrl(revision),
                  'data-pandamstyle': true,
                },
                injectTo: 'head-prepend',
              },
              {
                tag: 'script',
                attrs: { type: 'module' },
                children: `import ${JSON.stringify(CLIENT_ID)};`,
                injectTo: 'head-prepend',
              },
            ],
          };
        }
        return {
          tags: [
            {
              tag: 'link',
              attrs: {
                rel: 'stylesheet',
                href: asBaseUrl(config.base ?? '/', CSS_ASSET_FILE),
              },
              injectTo: 'head-prepend',
            },
          ],
        };
      },
    },

    async generateBundle(_outputOptions, bundle) {
      if (config.command !== 'build') return;
      const current = await currentState();
      const validation = await project.validate(current.revision);
      if (!validation.ok) {
        await publishDiagnosticsForRevision(validation);
        throw diagnosticsError(validation);
      }
      revision = validation.revision;
      const set = await readGeneratedArtifacts(validation.revision);
      const css = findGeneratedFile(set, 'css');
      if (css == null) {
        throw adapterError(
          Codes.GENERATED_ARTIFACT_MISMATCH,
          'The compiler did not return the canonical styles.css member for this build.',
          'vite.css-artifact',
        );
      }
      if (bundle[CSS_ASSET_FILE] != null) {
        throw adapterError(
          Codes.UNSUPPORTED_FEATURE,
          `The Vite output already contains ${CSS_ASSET_FILE}.`,
          'vite.css-output-collision',
          { file: CSS_ASSET_FILE },
        );
      }
      this.emitFile({
        type: 'asset',
        fileName: CSS_ASSET_FILE,
        source: css.content,
      });
      if (config.build?.sourcemap && css.sourceMap != null) {
        this.emitFile({
          type: 'asset',
          fileName: CSS_ASSET_FILE + '.map',
          source: css.sourceMap,
        });
      }
      if (
        preparedTicket == null &&
        sharedBuildEnvironmentIsFinal(this.environment?.name)
      ) {
        preparedTicket = await host.preparePublication(validation.revision);
      }
    },

    buildEnd(error) {
      if (error != null) buildError = error;
    },

    writeBundle: {
      order: 'post',
      async handler() {
        if (config.command !== 'build' || preparedTicket == null) return;
        if (buildError != null) {
          await host.abortPrepared(preparedTicket);
          preparedTicket = null;
          return;
        }
        if (!sharedBuildEnvironmentIsFinal(this.environment?.name)) return;
        const ticket = preparedTicket;
        preparedTicket = null;
        await host.commitPrepared(ticket);
      },
    },

    async closeBundle() {
      if (
        config?.command === 'build' &&
        !sharedBuildEnvironmentClosed(this.environment?.name)
      ) {
        return;
      }
      await closeProject();
    },

    async closeServer() {
      await closeProject();
    },

    async closePreviewServer() {
      await closeProject();
    },
  };
}

export default pandamstyle;
