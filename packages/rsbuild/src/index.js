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
import { pathToFileURL } from 'node:url';
import { Codes, PmsError, createProjectSession } from '@pandamstyle/compiler';
import { createHostBridge } from '@pandamstyle/compiler/host';

const NAME = 'pandamstyle-rsbuild';
const SOURCE = /\.(?:[cm]?js|jsx|ts|tsx)$/;
const digest = (text) => createHash('sha256').update(text).digest('hex');
const member = (set, kind) => set.files.find((file) => file.kind === kind);
const sameRevision = (a, b) =>
  a &&
  b &&
  a.projectId === b.projectId &&
  a.sessionId === b.sessionId &&
  a.revisionId === b.revisionId;

function canonical(file) {
  const absolute = path.resolve(file);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function ignoreGeneratedWatchPaths(config, root, generatedPaths) {
  const existing = config.watchOptions?.ignored;
  const generated = generatedPaths.map((entry) => {
    const absolute = path.resolve(root, entry);
    // A trailing star marks atomic-write temporary files, which do not exist
    // yet and therefore cannot be canonicalized through the filesystem.
    return absolute.endsWith('*') ? absolute : canonical(absolute);
  });
  const ignored = (entry) => {
    const absolute = canonical(path.resolve(root, entry));
    if (
      generated.some((item) =>
        item.endsWith('*')
          ? absolute.startsWith(item.slice(0, -1))
          : absolute === item || inside(item, absolute),
      )
    )
      return true;
    if (typeof existing === 'function') return existing(entry);
    if (existing instanceof RegExp) {
      existing.lastIndex = 0;
      return existing.test(absolute.split(path.sep).join('/'));
    }
    return false;
  };

  config.watchOptions ??= {};
  if (typeof existing === 'function' || existing instanceof RegExp) {
    config.watchOptions.ignored = ignored;
    return;
  }
  const patterns =
    existing == null ? [] : Array.isArray(existing) ? existing : [existing];
  config.watchOptions.ignored = [...patterns, ...generatedPaths];
}

function fail(code, message, context = {}) {
  return new PmsError([
    {
      code,
      severity: 'error',
      phase: 'rsbuild',
      rule: 'rsbuild.host-contract',
      message,
      context,
      source: null,
      location: null,
      autofix: null,
    },
  ]);
}

/** One public Project Service; all other state is host transport/lifecycle. */
export function pandamstyle(options = {}) {
  if (options.publicationMode === 'semantic-dev') {
    throw fail(
      Codes.UNSUPPORTED_FEATURE,
      'semantic-dev is available only for qualified Next Turbopack development.',
    );
  }
  if (options.acceptedSnapshotRetention != null) {
    throw fail(
      Codes.UNSUPPORTED_FEATURE,
      'Rsbuild uses current revision reads and does not enable accepted snapshot retention.',
    );
  }
  const input = { ...options };
  return {
    name: NAME,
    // Pre-loaders run right to left. Register after the framework so the
    // PandamStyle pre-loader sees original source before framework wrappers.
    enforce: 'post',
    async setup(api) {
      const root = canonical(api.context.rootPath);
      const output = canonical(
        path.resolve(root, input.outDir ?? '.pandamstyle'),
      );
      const designFile = path.join(
        output,
        input.designSystemFile ?? 'design.pandamstyle.js',
      );
      const cssFile = path.join(output, 'styles.css');
      const definitionFile =
        typeof input.definition === 'string'
          ? canonical(path.resolve(root, input.definition))
          : null;
      const roots = (input.roots ?? []).map((file) =>
        canonical(path.resolve(root, file)),
      );
      const passthroughUncovered = input.passthroughUncovered === true;
      if (
        !roots.length ||
        roots.some((file) => !inside(root, file) || inside(output, file))
      ) {
        throw fail(
          Codes.UNSUPPORTED_FEATURE,
          'Explicit source roots must stay inside Rsbuild root and outside generated output.',
        );
      }
      let definitionBytes = null;
      async function loadDefinition() {
        if (definitionFile === null) return input.definition;
        const bytes = await fsp.readFile(definitionFile, 'utf8');
        const url = pathToFileURL(definitionFile);
        url.searchParams.set('pms', digest(bytes));
        const loaded = await import(url.href);
        let value = loaded.default ?? loaded;
        if (typeof value === 'function') value = await value();
        definitionBytes = bytes;
        return value;
      }
      const definition = await loadDefinition();
      if (!definition || typeof definition !== 'object') {
        throw fail(
          Codes.UNSUPPORTED_FEATURE,
          'A design-system definition is required.',
        );
      }
      const projectInput = { ...input };
      delete projectInput.passthroughUncovered;
      const project = createProjectSession({
        ...projectInput,
        rootDir: root,
        definition,
        outDir: output,
        designSystemFile: path.basename(designFile),
      });
      const host = createHostBridge(project);
      let revision = null;
      let round = null;
      let lastSet = null;
      let compilers = [];
      let devEnvironments = null;
      const watchers = [];
      const pendingFiles = new Set();
      let pendingDiscovery = false;
      let watchTimer = null;
      let reloadTimer = null;
      const compilationRounds = new WeakMap();
      const compilationFiles = new WeakMap();
      const environmentRounds = new Map();
      let closed = false;
      let queue = Promise.resolve();
      let closePromise = null;
      const virtuals = new Map();
      // These are exact loaded-input observations for settlement authentication,
      // not a coverage graph, semantic cache or reuse decision.
      const loadedInputs = new Map();
      const observedFiles = new Set();
      const watchedObservedFiles = new Set();
      const sourceFileRootsByDirectory = new Map();
      const sourceDirectoryWatchers = new Map();
      let watchObservedFile = null;
      const emit = (kind, detail = {}) => {
        try {
          input.onEvent?.(Object.freeze({ kind, revision, ...detail }));
        } catch {
          /* observation callbacks have no authority */
        }
      };
      const enqueue = (operation) => {
        const result = queue.then(() => {
          if (closed)
            throw fail(Codes.SESSION_CLOSED, 'The Rsbuild project is closed.');
          return operation();
        });
        queue = result.catch(() => {});
        return result;
      };
      const relative = (file) =>
        path.relative(root, file).split(path.sep).join('/');
      const isLocal = (file) =>
        inside(root, file) &&
        !inside(output, file) &&
        !file.split(path.sep).includes('node_modules') &&
        SOURCE.test(file);
      const covered = (file) =>
        isLocal(file) && roots.some((entry) => inside(entry, file));
      const addSourceRootDependency = (compilation, sourceRoot) => {
        let directory = false;
        try {
          directory = fs.statSync(sourceRoot).isDirectory();
        } catch {
          // A missing exact root is still watched through its parent directory.
        }
        if (directory) compilation.contextDependencies.add(sourceRoot);
        else {
          compilation.fileDependencies.add(sourceRoot);
          compilation.contextDependencies.add(path.dirname(sourceRoot));
        }
      };
      const addTransformRootDependency = (context, sourceRoot) => {
        let directory = false;
        try {
          directory = fs.statSync(sourceRoot).isDirectory();
        } catch {
          // A missing exact root is still watched through its parent directory.
        }
        if (directory) context.addContextDependency(sourceRoot);
        else {
          context.addDependency(sourceRoot);
          context.addContextDependency(path.dirname(sourceRoot));
        }
      };

      async function abort() {
        if (round?.ticket) await host.abortPrepared(round.ticket);
        if (round) round.ticket = null;
      }
      async function close() {
        if (closePromise) return closePromise;
        closed = true;
        clearTimeout(watchTimer);
        clearTimeout(reloadTimer);
        for (const watcher of watchers) watcher.close();
        closePromise = (async () => {
          await queue;
          try {
            await abort();
          } finally {
            await project.close();
            loadedInputs.clear();
            devEnvironments = null;
            observedFiles.clear();
            watchedObservedFiles.clear();
            sourceFileRootsByDirectory.clear();
            sourceDirectoryWatchers.clear();
            virtuals.clear();
            emit('closed');
            lastSet = null;
            round = null;
          }
        })();
        return closePromise;
      }
      try {
        revision = (await project.initialize()).revision;
        const validation = await project.validate(revision);
        if (validation.ok)
          lastSet = await host.readGeneratedArtifacts(revision);
      } catch (error) {
        await close();
        throw error;
      }

      async function begin() {
        return enqueue(async () => {
          const started = performance.now();
          const current = await project.current();
          const changed = new Set(pendingFiles);
          pendingFiles.clear();
          const discover = pendingDiscovery;
          pendingDiscovery = false;
          const removed = new Set();
          for (const compiler of compilers) {
            for (const file of compiler.modifiedFiles ?? []) {
              const normalized = canonical(file);
              if (covered(normalized)) changed.add(normalized);
            }
            for (const file of compiler.removedFiles ?? []) {
              const normalized = canonical(file);
              if (covered(normalized)) removed.add(normalized);
            }
          }
          let nextDefinition;
          if (
            definitionFile &&
            (await fsp.readFile(definitionFile, 'utf8')) !== definitionBytes
          ) {
            nextDefinition = await loadDefinition();
          }
          const added = [];
          const actualChanged = [];
          for (const file of changed) {
            if (!fs.existsSync(file)) {
              removed.add(file);
              continue;
            }
            // The service decides whether a source artifact exists. The host
            // supplies add/change evidence without maintaining a second graph.
            try {
              const artifact = await host.readArtifact(
                current.revision,
                relative(file),
              );
              if (artifact.sourceDigest !== digest(await fsp.readFile(file)))
                actualChanged.push(relative(file));
            } catch {
              (observedFiles.has(file) ? actualChanged : added).push(
                relative(file),
              );
            }
          }
          let accepted = null;
          if (
            actualChanged.length ||
            added.length ||
            removed.size ||
            nextDefinition !== undefined ||
            discover ||
            !round
          ) {
            await abort();
            accepted = await project.applyChanges({
              baseRevision: current.revision,
              mode: round && !discover ? 'verified-explicit' : 'full-discovery',
              forceFullDiscovery: !round || discover,
              changed: actualChanged,
              added,
              removed: [...removed].map(relative),
              renamed: [],
              ...(nextDefinition === undefined
                ? {}
                : { definition: nextDefinition }),
            });
            revision = accepted.revision;
            for (const file of removed) {
              observedFiles.delete(file);
              loadedInputs.delete(file);
            }
          } else revision = current.revision;
          if (sameRevision(round?.revision, revision)) return;
          await abort();
          const validation = await project.validate(revision);
          const diagnostics = await project.agentResult(revision);
          const set = validation.ok
            ? await host.readGeneratedArtifacts(revision)
            : null;
          round = {
            revision,
            set,
            validation,
            diagnostics,
            ticket: null,
            started,
            inputs: new Map(),
            changed: [...changed].map(relative),
            removed: [...removed].map(relative),
            definitionBytes,
            definitionChanged: nextDefinition !== undefined,
            reloadSent: false,
          };
          emit('revision', {
            diagnostics,
            counters: validation.counters ?? accepted?.counters ?? {},
            hostMs: performance.now() - started,
            fullFallback: validation.fullFallback === true,
            fullFallbackReason:
              validation.fullFallbackReason ??
              accepted?.fullFallbackReason ??
              null,
            invalidatedModules: round.changed,
            removed: round.removed,
          });
        });
      }

      async function authenticate(target = round, activeFiles) {
        if (!target?.validation.ok)
          throw new PmsError(target?.diagnostics?.diagnostics ?? []);
        const current = await project.current();
        if (!sameRevision(target.revision, current.revision)) {
          throw fail(
            Codes.STALE_REVISION,
            'The compilation revision was superseded.',
          );
        }
        // Authenticate persisted inputs too: a bundler may reuse a module.
        for (const [file, sourceDigest] of new Map([
          ...loadedInputs,
          ...target.inputs,
        ])) {
          if (activeFiles && !activeFiles.has(file)) continue;
          if (target.removed.includes(relative(file))) continue;
          const artifact = await host.readArtifact(
            target.revision,
            relative(file),
          );
          const exactDigest = target.inputs.get(file) ?? sourceDigest;
          if (
            artifact.sourceDigest !== exactDigest ||
            digest(await fsp.readFile(file)) !== exactDigest
          ) {
            throw fail(
              Codes.STALE_REVISION,
              'A loaded source changed during compilation or a reused module is stale.',
              { file: relative(file) },
            );
          }
        }
        if (
          definitionFile &&
          (await fsp.readFile(definitionFile, 'utf8')) !==
            target.definitionBytes
        ) {
          throw fail(
            Codes.STALE_REVISION,
            'The design system changed during compilation.',
          );
        }
      }

      async function settle({ stats, isFirstCompile }) {
        return enqueue(async () => {
          const results = stats?.stats ?? (stats ? [stats] : []);
          const snapshots = results.map((item) =>
            compilationRounds.get(item.compilation),
          );
          const target = snapshots[0];
          if (
            !target ||
            snapshots.some(
              (item) => !sameRevision(item?.revision, target.revision),
            )
          ) {
            await abort();
            emit('rejected', { reason: 'mixed-host-revisions' });
            return;
          }
          if (target !== round) {
            emit('rejected', { reason: 'superseded-host-compilation' });
            return;
          }
          if (!round)
            throw fail(
              Codes.INVALID_REVISION,
              'Missing logical compilation revision.',
            );
          if (!stats || stats.hasErrors()) {
            await abort();
            emit('rejected', {
              reason: 'rspack-compilation',
              diagnostics: round.diagnostics,
            });
            return;
          }
          try {
            const activeFiles = new Set();
            for (const item of results) {
              const files = compilationFiles.get(item.compilation);
              if (!files)
                throw fail(
                  Codes.INVALID_REVISION,
                  'Missing finished host module observations.',
                );
              for (const file of files) activeFiles.add(file);
            }
            for (const file of activeFiles) {
              if (!target.inputs.has(file) && !loadedInputs.has(file))
                throw fail(
                  Codes.COVERAGE_GAP,
                  'A loaded host module has no authenticated source observation.',
                  { file: relative(file) },
                );
            }
            await authenticate(target, activeFiles);
            if (!round.ticket)
              throw fail(
                Codes.INVALID_REVISION,
                'No prepared publication for aggregate settlement.',
              );
            const ticket = round.ticket;
            const receipt = await host.commitPrepared(ticket);
            round.ticket = null;
            lastSet = round.set;
            for (const file of loadedInputs.keys())
              if (!activeFiles.has(file)) loadedInputs.delete(file);
            for (const [file, hash] of round.inputs)
              loadedInputs.set(file, hash);
            for (const file of round.removed)
              loadedInputs.delete(path.resolve(root, file));
            const css = member(round.set, 'css');
            emit('settled', {
              generation: receipt.generationId,
              cssDigest: digest(css.content),
              hostMs: performance.now() - round.started,
              outcome: api.context.action === 'dev' ? 'full-reload' : 'build',
              invalidatedModules: round.changed,
              counters: round.validation.counters ?? {},
            });
            if (api.context.action === 'dev' && isFirstCompile)
              round.reloadSent = true;
            if (api.context.action === 'dev' && !round.reloadSent) {
              // Coalesce notifications and let done expose assets. A new
              // source edit can precede its watch event, so reauthenticate
              // exact bytes before sending a reload of this compilation.
              clearTimeout(reloadTimer);
              reloadTimer = setTimeout(() => {
                void enqueue(async () => {
                  if (
                    closed ||
                    target !== round ||
                    pendingFiles.size ||
                    pendingDiscovery
                  )
                    return;
                  if (target.reloadSent) return;
                  if (!devEnvironments) return;
                  await authenticate(target, activeFiles);
                  for (const environment of Object.values(devEnvironments))
                    environment.hot.send('full-reload');
                  target.reloadSent = true;
                  emit('reload', {
                    revision: target.revision,
                    generation: receipt.generationId,
                    cssDigest: digest(css.content),
                    outcome: 'full-reload',
                    hostMs: performance.now() - target.started,
                  });
                }).catch((error) => {
                  if (!closed)
                    emit('rejected', {
                      revision: target.revision,
                      reason: 'reload-transport',
                      message: error.message,
                    });
                });
              }, 100);
            }
          } catch (error) {
            await abort();
            emit('rejected', { reason: 'publication', message: error.message });
            if (api.context.action !== 'dev') throw error;
          }
        });
      }

      api.onBeforeStartDevServer(({ server }) => {
        // Compile hooks expose contexts; the server exposes EnvironmentAPI.
        devEnvironments = server.environments;
      });
      api.modifyRsbuildConfig((config) => {
        if (api.context.action === 'dev') {
          // This adapter's admitted transport is full reload. Native hot
          // updates must not race it across rejected source revisions.
          config.dev ??= {};
          config.dev.hmr = false;
          config.dev.liveReload = true;
        }
      });
      api.modifyEnvironmentConfig((config) => {
        if ((config.output?.target ?? 'web') === 'web') {
          config.source ??= {};
          config.source.preEntry = [...(config.source.preEntry ?? []), cssFile];
        }
      });
      api.modifyRspackConfig(async (config, { rspack, environment }) => {
        if (api.context.action === 'dev') {
          // A rejected compilation must not replace the last valid browser
          // bundle with error stubs that can destroy its reload client.
          config.optimization ??= {};
          config.optimization.emitOnErrors = false;
          const outputBase = path.basename(output);
          const parent = path.dirname(output);
          const currentState = path.join(
            parent,
            `.${outputBase}.pms-state.json`,
          );
          const pendingState = path.join(
            parent,
            `.${outputBase}.pms-state.pending.json`,
          );
          ignoreGeneratedWatchPaths(config, root, [
            output,
            path.join(parent, `.${outputBase}.pms-staging`),
            path.join(parent, `.${outputBase}.pms-backup`),
            currentState,
            `${currentState}.tmp-*`,
            pendingState,
            `${pendingState}.tmp-*`,
          ]);
        }
        const destination = canonical(config.output.path);
        if (inside(output, destination) || inside(destination, output)) {
          await close();
          throw fail(
            Codes.UNSUPPORTED_FEATURE,
            'Compiler output and Rsbuild output must not overlap.',
          );
        }
        // The compiler owns the content; the plugin owns in-memory delivery.
        const modules = {
          [designFile]: lastSet
            ? member(lastSet, 'design-module').content
            : 'export {};',
          [cssFile]: lastSet ? member(lastSet, 'css').content : '',
        };
        const virtual = new rspack.experiments.VirtualModulesPlugin(modules);
        virtuals.set(environment.name, virtual);
        let transportedDesign = modules[designFile];
        let transportedCss = modules[cssFile];
        config.plugins ??= [];
        config.plugins.push(virtual, {
          apply(compiler) {
            compiler.hooks.thisCompilation.tap(NAME, (compilation) => {
              compilationRounds.set(compilation, round);
              environmentRounds.set(environment.name, round);
              compilation.hooks.finishModules.tap(NAME, (modules) => {
                const files = new Set();
                for (const module of modules) {
                  if (module.resource) {
                    const file = canonical(module.resource.split('?')[0]);
                    if (covered(file) || observedFiles.has(file))
                      files.add(file);
                  }
                }
                compilationFiles.set(compilation, files);
              });
              for (const sourceRoot of roots)
                addSourceRootDependency(compilation, sourceRoot);
              if (definitionFile)
                compilation.fileDependencies.add(definitionFile);
              const set = round?.set ?? lastSet;
              if (set) {
                const design = member(set, 'design-module').content;
                const css = member(set, 'css').content;
                if (design !== transportedDesign) {
                  virtual.writeModule(designFile, design);
                  transportedDesign = design;
                }
                if (css !== transportedCss) {
                  virtual.writeModule(cssFile, css);
                  transportedCss = css;
                }
              }
            });
            compiler.hooks.failed.tap(NAME, () => {
              void enqueue(abort).catch(() => {});
            });
            compiler.hooks.shutdown.tapPromise(NAME, close);
          },
        });
      });
      api.onBeforeCreateCompiler(async ({ bundlerConfigs }) => {
        if (
          bundlerConfigs.length > 2 ||
          bundlerConfigs.some((config) => config.experiments?.rsc)
        ) {
          await close();
          throw fail(
            Codes.UNSUPPORTED_FEATURE,
            'Phase 11 supports one compiler or one web/server pair; RSC and larger topologies are unsupported.',
          );
        }
        if (bundlerConfigs.length === 2) {
          const targets = bundlerConfigs.map((config) => String(config.target));
          if (
            targets.filter((target) => target.includes('web')).length !== 1 ||
            targets.filter((target) => target.includes('node')).length !== 1
          ) {
            await close();
            throw fail(
              Codes.UNSUPPORTED_FEATURE,
              'Multiple outputs require one web and one node environment.',
            );
          }
        }
      });
      api.onAfterCreateCompiler(({ compiler }) => {
        compilers = compiler.compilers ?? [compiler];
        if (api.context.action === 'dev') {
          // File notifications are host evidence only. Advancing the service
          // here would race a prepared compilation; begin() alone applies it.
          const notify = (file) => {
            if (closed) return;
            const owned = covered(file) || observedFiles.has(file);
            if (!owned && file !== definitionFile && !pendingDiscovery) return;
            if (owned) pendingFiles.add(file);
            clearTimeout(watchTimer);
            watchTimer = setTimeout(() => {
              if (!closed)
                for (const item of compilers) item.watching?.invalidate();
            }, 50);
          };
          const watchSourceRoot = (sourceRoot) => {
            const directory = fs.statSync(sourceRoot).isDirectory();
            if (!directory) {
              // Keep exact-root edits incremental, and notice new local source
              // files beside a root. The latter can repair a previously
              // unresolved import without editing the importer a second time;
              // only the Project Service decides which new modules enter the
              // covered graph.
              const parent = path.dirname(sourceRoot);
              let fileRoots = sourceFileRootsByDirectory.get(parent);
              if (fileRoots == null) {
                fileRoots = new Set();
                sourceFileRootsByDirectory.set(parent, fileRoots);
              }
              fileRoots.add(sourceRoot);
              if (!sourceDirectoryWatchers.has(parent)) {
                const watcher = fs.watch(parent, (event, file) => {
                  if (file == null) {
                    pendingDiscovery = true;
                    notify(fileRoots.values().next().value);
                    return;
                  }
                  const target = canonical(path.join(parent, String(file)));
                  if (fileRoots.has(target)) {
                    notify(target);
                    return;
                  }
                  if (!isLocal(target) || !SOURCE.test(target)) return;
                  if (event === 'rename') pendingDiscovery = true;
                  notify(target);
                });
                sourceDirectoryWatchers.set(parent, watcher);
                watchers.push(watcher);
              }
              return;
            }
            // Recursive fs.watch may keep the replaced file's inode on Node
            // 22. Watch directory entries instead; this map owns notification
            // resources only. The Service still owns source discovery.
            const directories = new Map();
            const refreshDirectories = (base) => {
              if (!fs.existsSync(base)) return;
              if (!directories.has(base)) {
                const watcher = fs.watch(base, (event, file) => {
                  if (!file || closed) return;
                  const target = path.join(base, String(file));
                  if (event === 'rename') {
                    const wasDirectory = directories.has(target);
                    let isDirectory = false;
                    try {
                      isDirectory = fs.statSync(target).isDirectory();
                    } catch (error) {
                      if (error.code !== 'ENOENT') throw error;
                    }
                    if (wasDirectory || isDirectory) {
                      pendingDiscovery = true;
                      refreshDirectories(sourceRoot);
                    }
                  }
                  notify(canonical(target));
                });
                directories.set(base, watcher);
                watchers.push(watcher);
              }
              for (const entry of fs.readdirSync(base, {
                withFileTypes: true,
              })) {
                if (entry.isDirectory() && entry.name !== 'node_modules') {
                  const child = path.join(base, entry.name);
                  if (!inside(output, child)) refreshDirectories(child);
                }
              }
              for (const [watched, watcher] of directories) {
                if (!fs.existsSync(watched)) {
                  watcher.close();
                  directories.delete(watched);
                  watchers.splice(watchers.indexOf(watcher), 1);
                }
              }
            };
            refreshDirectories(sourceRoot);
          };
          watchObservedFile = (file) => {
            if (watchedObservedFiles.has(file) || !fs.existsSync(file)) return;
            watchedObservedFiles.add(file);
            watchers.push(
              fs.watch(path.dirname(file), (_event, name) => {
                if (String(name) === path.basename(file)) notify(file);
              }),
            );
          };
          for (const sourceRoot of roots) watchSourceRoot(sourceRoot);
          if (definitionFile)
            watchers.push(
              fs.watch(path.dirname(definitionFile), (_event, file) => {
                if (String(file) === path.basename(definitionFile))
                  notify(definitionFile);
              }),
            );
        }
      });
      api.onBeforeBuild({ order: 'post', handler: begin });
      api.onBeforeDevCompile({ order: 'post', handler: begin });
      api.transform(
        { test: (file) => canonical(file) === cssFile, order: 'pre' },
        (context) =>
          enqueue(() => {
            const target = environmentRounds.get(context.environment.name);
            for (const sourceRoot of roots)
              addTransformRootDependency(context, sourceRoot);
            if (definitionFile) context.addDependency(definitionFile);
            if (!target?.set)
              return lastSet ? member(lastSet, 'css').content : '';
            const css = member(target.set, 'css');
            return {
              code: css.content,
              map:
                css.sourceMap == null
                  ? null
                  : {
                      ...JSON.parse(css.sourceMap),
                      sources: JSON.parse(css.sourceMap).sources.map((source) =>
                        path.resolve(root, source),
                      ),
                    },
            };
          }),
      );
      api.transform({ test: SOURCE, order: 'pre' }, async (context) =>
        enqueue(async () => {
          const target = environmentRounds.get(context.environment.name);
          const file = canonical(context.resourcePath);
          if (file === designFile) {
            if (!target?.set)
              throw new PmsError(target?.diagnostics?.diagnostics ?? []);
            for (const sourceRoot of roots)
              addTransformRootDependency(context, sourceRoot);
            if (definitionFile) context.addDependency(definitionFile);
            return member(target.set, 'design-module').content;
          }
          if (!isLocal(file)) return context.code;
          for (const sourceRoot of roots)
            addTransformRootDependency(context, sourceRoot);
          if (definitionFile) context.addDependency(definitionFile);
          if (!target?.validation.ok) {
            if (
              passthroughUncovered &&
              !covered(file) &&
              !observedFiles.has(file)
            )
              return context.code;
            throw new PmsError(target?.diagnostics?.diagnostics ?? []);
          }
          let artifact;
          try {
            artifact = await host.readArtifact(target.revision, relative(file));
          } catch (error) {
            const isUncovered = error?.diagnostics?.some(
              (item) =>
                item.code === Codes.INVALID_REVISION &&
                item.context?.reason === 'uncovered-source',
            );
            if (passthroughUncovered && !covered(file) && isUncovered)
              return context.code;
            if (!covered(file) && isUncovered) {
              throw fail(
                Codes.COVERAGE_GAP,
                'A host-loaded local source is outside the declared roots.',
                { file: relative(file) },
              );
            }
            throw error;
          }
          if (
            artifact.sourceDigest !== digest(context.code) ||
            !sameRevision(artifact.revision, target.revision)
          ) {
            throw fail(
              Codes.COVERAGE_GAP,
              'Host source bytes differ from the exact compilation revision; source-transform ordering or a concurrent edit must be repaired.',
              { file: relative(file), query: context.resourceQuery },
            );
          }
          // Queries retain original source identity only when exact bytes match.
          // Arbitrary virtual wrappers never receive an application exemption.
          for (const sourceRoot of roots)
            addTransformRootDependency(context, sourceRoot);
          if (definitionFile) context.addDependency(definitionFile);
          for (const dependency of artifact.dependencies)
            context.addDependency(path.resolve(root, dependency));
          target.inputs.set(file, artifact.sourceDigest);
          observedFiles.add(file);
          watchObservedFile?.(file);
          emit('transform', {
            file: relative(file),
            query: context.resourceQuery,
            hostMs: performance.now() - target.started,
            environment: context.environment.name,
            sourceDigest: artifact.sourceDigest,
          });
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
          };
        }),
      );
      api.processAssets({ stage: 'report' }, async ({ compilation, sources }) =>
        enqueue(async () => {
          if (compilationRounds.get(compilation) !== round) {
            compilation.errors.push(
              fail(
                Codes.STALE_REVISION,
                'The asset compilation was superseded.',
              ),
            );
            return;
          }
          if (!round?.validation.ok) {
            compilation.errors.push(
              new PmsError(round?.diagnostics?.diagnostics ?? []),
            );
            return;
          }
          const css = member(round.set, 'css');
          if (compilation.getAsset('pandamstyle/styles.css'))
            throw fail(
              Codes.UNSUPPORTED_FEATURE,
              'PandamStyle CSS asset collision.',
            );
          compilation.emitAsset(
            'pandamstyle/styles.css',
            new sources.RawSource(css.content),
          );
          if (!round.ticket)
            round.ticket = await host.preparePublication(round.revision);
        }),
      );
      api.onAfterBuild({ order: 'post', handler: settle });
      api.onAfterDevCompile({ order: 'post', handler: settle });
      api.onCloseDevServer(close);
      api.onCloseBuild(close);
      api.onExit(close);
    },
  };
}

export default pandamstyle;
