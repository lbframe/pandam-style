/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - the incremental PROJECT SESSION (Spike 2).
 *
 * WHAT THIS IS
 *
 * A real, reusable compilation session over one PandamStyle project. It owns
 * the state a project build produces - per-file compiled results, per-file
 * PandamStyle rule contributions, per-file coverage certificates, the forward
 * and reverse module graphs, the resolution state - and keeps them across
 * revisions, so that a revision only re-does the work whose inputs changed.
 *
 * It is production compiler code. The benchmark harness drives it; it does not
 * exist for the benchmark. `buildProject` - the full rebuild - is UNCHANGED and
 * remains the semantic reference this session is measured against.
 *
 * THE ONE RULE THAT MAKES IT CORRECT
 *
 *     incremental(revision N) == fresh_full_rebuild(revision N)
 *
 * for every externally meaningful compiler semantic. Not "produces plausible
 * output", not "reuses the common case": the same bytes, the same diagnostics
 * with the same locations, the same coverage set, the same CSS in the same
 * cascade-relevant order. The session therefore never decides to skip work from
 * a heuristic. It decides from a VALIDITY KEY per file, and the key is built
 * from the inputs a file's compiled result actually depends on.
 *
 * WHAT A FILE'S COMPILED RESULT ACTUALLY DEPENDS ON
 *
 * Reading `compileFile` is the only honest way to answer this, and the answer
 * is narrower than "the whole project":
 *
 *   1. the file's own source text;
 *   2. the design system (registry, tokens, themes, recipes, injected rules),
 *      the compiler contract, and the engine options;
 *   3. the file's own LOCAL EDGE RESOLUTIONS - only to decide whether a local
 *      import is a coverage gap, never to read the target's content;
 *   4. the file's DESIGN-SYSTEM VIEW - which module the design system is
 *      reached through, its generation marker, its exports, and the re-export
 *      map of the relay in between, because that is what decides which
 *      bindings are recognized.
 *
 * It does NOT depend on the CONTENT of any other covered file: a page's
 * compiled JavaScript is a function of the page and of the registry, and a
 * style class name in it is a function of the page's own declarations. That
 * fact is what makes file-level reuse possible at all, and it is why the
 * session's per-revision work is a function of the affected set rather than of
 * the project size.
 *
 * THE STATE MODEL, IN FULL
 *
 *   RevisionId     monotonically increasing; every result carries it
 *   GenerationId   monotonically increasing; only a published generation has one
 *   ProjectState   covered roots, covered set, graphs, resolution state,
 *                  current design system, current policy/config identity,
 *                  current valid generation
 *   FileState[]    per covered file: identity, source hash, role, module
 *                  summary, edge resolutions, design-system view, validity key,
 *                  and its OWN contribution to the output
 *
 * No Babel `NodePath` and no AST is ever retained. The module summary is plain
 * data, extracted before anything is handed to a transform that may mutate it.
 *
 * INVALIDATION, IN ONE PARAGRAPH
 *
 * A revision re-scans the declared roots and every file the previous revision
 * covered, reads and CONTENT-HASHES each one (never mtime: mtime is a statement
 * about the filesystem's bookkeeping, not about the bytes), and rebuilds the
 * coverage closure from the persistent module summaries. A file is recompiled
 * when its content changed, when its edge resolutions changed, when its
 * design-system view changed - which is propagated along the relay chains, so a
 * style-only edit invalidates nothing but itself and a re-export edit invalidates
 * exactly the consumers of that relay - or when a global fallback fires.
 * Everything else keeps its previous contribution. CSS is re-aggregated from all
 * contributions every revision, because aggregation is cheap and a partial
 * stylesheet is not a thing this compiler will ever publish.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import styleXTransform from '../src/index';
import { buildDesignSystem } from './index';
import { generateDesignSystemModule } from './codegen';
import { PmsError, Codes, diagnostic } from './diagnostics';
import {
  assertCoverageConsistency,
  commonBase,
  compileFile,
  coverageGapDiagnostics,
  relativeToCwd,
  walkFiles,
} from './build';
import {
  clearModuleCache,
  clearModuleOverlay,
  moduleSummaryOfCode,
  resolveDesignSystemModule,
  setModuleOverlay,
  SOURCE_EXTENSIONS,
} from './module-graph';
import { withGeneration } from './generation';
import { count, perfNow, phase, recordParse } from './perf';

const CONTRACT_VERSION = 'pms-0.1';

/**
 * Config fields that change what a compiled file DEPENDS ON, not merely how the
 * output is shaped. A change to any of them is a counted full fallback.
 */
const SEMANTIC_CONFIG_KEYS = [
  'runtimeModule',
  'designSystemFile',
  'engineOptions',
  'useCSSLayers',
];

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function stableJson(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
    .join(',')}}`;
}

function digestOf(value) {
  return sha256(stableJson(value));
}

/**
 * The CONTENT identity of a design-system definition.
 *
 * Object identity would be the wrong question, and not only for the caller that
 * hands back an equal object: a build tool reloads its configuration module on
 * every revision, so the same definition arrives as a NEW object every time.
 * Keying a full fallback on identity would therefore invalidate the entire
 * project on every revision and make the session a very expensive no-op.
 *
 * Functions are serialized by their source, because a definition expresses a
 * token reference through a helper (`t("spacing.md")`) and two calls to the
 * same helper with different arguments are different designs while two equal
 * calls are the same design. A definition that cannot be serialized at all
 * returns null, and the caller falls back to identity rather than pretending
 * two unserializable objects are equal.
 */
function definitionDigest(definition) {
  try {
    return sha256(
      JSON.stringify(definition, (key, value) =>
        typeof value === 'function'
          ? `fn:${Function.prototype.toString.call(value)}`
          : value,
      ) ?? 'undefined',
    );
  } catch {
    return null;
  }
}

function normalizeConfig(input) {
  return {
    definition: input.definition,
    roots: (input.roots ?? []).map((r) => path.resolve(r)),
    outDir: path.resolve(input.outDir ?? '.pandamstyle'),
    runtimeModule: input.runtimeModule ?? '@pandamstyle/compiler/runtime',
    designSystemFile: input.designSystemFile ?? 'design.pandamstyle.js',
    engineOptions: input.engineOptions ?? {},
    useCSSLayers: input.useCSSLayers === true,
  };
}

export function createProjectSession(config) {
  const state = {
    revisionId: 0,
    generationId: 0,
    // `projectSemanticEpoch` is part of every file's validity key. It changes
    // on every global mutation the session cannot yet reason about locally.
    semanticEpoch: 1,
    config: normalizeConfig(config),
    designSystem: null,
    designSystemSource: null,
    generatedModulePath: null,
    overlay: new Map(),
    fileStates: new Map(),
    // module path -> the files whose design-system view traverses it.
    dsConsumers: new Map(),
    covered: null,
    active: null,
    published: null,
    closed: false,
    supersededRevisions: 0,
    lastFallbackReason: null,
    definitionDigest: null,
  };

  // Per-revision tallies. The perf collector is reset by whoever drives the
  // build; the session cannot assume that, so it keeps its own numbers and
  // publishes them on the revision.
  const tally = new Map();
  function bump(name, n = 1) {
    tally.set(name, (tally.get(name) ?? 0) + n);
    count(name, n);
  }
  function read(name) {
    return tally.get(name) ?? 0;
  }

  // ------------------------------------------------------------ design ------

  function rebuildDesignSystem() {
    const cfg = state.config;
    const outDirAbs = path.resolve(cfg.outDir);
    const generatedModulePath = path.join(outDirAbs, cfg.designSystemFile);

    const designSystem = phase('boundary_ms', () =>
      buildDesignSystem(cfg.definition, { ...cfg.engineOptions }),
    );
    const designSystemSource = phase('ds_module_codegen_ms', () =>
      generateDesignSystemModule({
        designSystem,
        runtimeModule: cfg.runtimeModule,
      }),
    );

    // The generated module must be RESOLVABLE while the pages are compiled and
    // must NOT be on disk yet: that is the whole of the transactional
    // publication guarantee. The overlay serves it, exactly as the full build
    // does. See module-graph.js and generation.js.
    const overlay = new Map([[generatedModulePath, designSystemSource]]);
    setModuleOverlay(overlay);

    state.designSystem = designSystem;
    state.designSystemSource = designSystemSource;
    state.generatedModulePath = generatedModulePath;
    state.overlay = overlay;
  }

  // --------------------------------------------------------- resolution -----

  // The session owns resolution because NEGATIVE resolution is real state that
  // must be invalidated when a file appears. The module-graph cache cannot do
  // that job: it is dropped wholesale at every generation boundary, which is
  // right for a build that recompiles everything and useless for a session
  // that recompiles one file.
  //
  // `dirListings` is per revision - one directory read per revision per
  // directory that has an edge in it - and `resolutionKeys` is persistent state:
  // every key the session has ever resolved is re-probed on every revision, so
  // a file appearing or disappearing anywhere the graph can reach is observed
  // and a negative result is never stale.
  let dirListings = new Map();
  let resolutionKeys = new Map();

  function listingOf(dir) {
    let names = dirListings.get(dir);
    if (names !== undefined) return names;
    names = new Set();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (entry.isFile()) {
        names.add(entry.name);
        continue;
      }
      if (entry.isSymbolicLink()) {
        // `statSync` follows links and `readdir`'s dirent does not, so a
        // symlinked module would resolve here and not in the full build.
        try {
          if (fs.statSync(path.join(dir, entry.name)).isFile()) {
            names.add(entry.name);
          }
        } catch {
          /* a dangling link resolves to nothing, which is the honest answer */
        }
      }
    }
    dirListings.set(dir, names);
    return names;
  }

  /**
   * The candidate list, in the SAME order `probeRelativeFile` tries, for the
   * same reason: two orders mean a request can be resolvable in one code path
   * and unresolvable in the other, and the coverage verdict would then depend
   * on which one ran.
   */
  function candidatesOf(base) {
    const candidates = [base];
    for (const ext of SOURCE_EXTENSIONS) candidates.push(base + ext);
    const ext = path.extname(base);
    if (ext !== '' && SOURCE_EXTENSIONS.includes(ext)) {
      const stem = base.slice(0, -ext.length);
      for (const e of SOURCE_EXTENSIONS) candidates.push(stem + e);
    }
    for (const e of SOURCE_EXTENSIONS) {
      candidates.push(path.join(base, 'index' + e));
    }
    return candidates;
  }

  function probeResolution(fromFile, request) {
    const base = path.resolve(path.dirname(fromFile), request);
    for (const candidate of candidatesOf(base)) {
      if (state.overlay.has(candidate)) return candidate;
      if (listingOf(path.dirname(candidate)).has(path.basename(candidate))) {
        return candidate;
      }
    }
    return null;
  }

  function resolutionKeyOf(fromFile, request) {
    return `${path.dirname(fromFile)}\u0000${request}`;
  }

  function resolveLocal(fromFile, request) {
    if (!request.startsWith('.')) return null;
    const key = resolutionKeyOf(fromFile, request);
    const known = resolutionKeys.get(key);
    if (known !== undefined) return known.resolved;
    const resolved = phase('session_resolve_ms', () =>
      probeResolution(fromFile, request),
    );
    resolutionKeys.set(key, { fromFile, request, resolved });
    if (resolved === null) bump('negative_resolutions');
    count('resolution_probes');
    return resolved;
  }

  /**
   * Re-probes every key the session has ever resolved, once per revision.
   *
   * This is the reason `"./foo" does not exist` is never a permanent fact. A
   * key's answer can only change when the existence of one of its candidates
   * changed, and asking the filesystem once per key per revision is the
   * smallest question that covers every candidate of every key - including the
   * ones that were negative, which is the whole point.
   */
  function revalidateResolution() {
    const repaired = [];
    for (const entry of resolutionKeys.values()) {
      const before = entry.resolved;
      const after = phase('session_resolve_ms', () =>
        probeResolution(entry.fromFile, entry.request),
      );
      if (before === null && after !== null) repaired.push(entry.fromFile);
      entry.resolved = after;
    }
    return repaired;
  }

  // --------------------------------------------------------- file states ----

  function ensureFileState(file) {
    let fileState = state.fileStates.get(file);
    if (fileState == null) {
      fileState = {
        file,
        role: 'page',
        sourceHash: null,
        summary: null,
        importSources: [],
        edgeResolution: new Map(),
        dsView: null,
        validity: null,
        contribution: null,
        compiledRevision: null,
        origin: null,
      };
      state.fileStates.set(file, fileState);
    }
    return fileState;
  }

  function unregisterChain(file, chain) {
    for (const module of chain) {
      const set = state.dsConsumers.get(module);
      if (set == null) continue;
      set.delete(file);
      if (set.size === 0) state.dsConsumers.delete(module);
    }
  }

  function registerChain(file, chain) {
    for (const module of chain) {
      let set = state.dsConsumers.get(module);
      if (set == null) {
        set = new Set();
        state.dsConsumers.set(module, set);
      }
      set.add(file);
    }
  }

  function readSource(file) {
    if (file === state.generatedModulePath) {
      return { text: state.designSystemSource, ok: true };
    }
    try {
      return { text: fs.readFileSync(file, 'utf8'), ok: true };
    } catch {
      return { text: null, ok: false };
    }
  }

  /**
   * Reads `file` once per revision, hashes it, and records whether its bytes
   * changed.
   *
   * CONTENT, never mtime. An mtime check is a statement about the filesystem's
   * bookkeeping, not about the source, and it is wrong in ways that matter
   * here: a checkout can rewrite timestamps, a build tool can restore a file
   * within one timestamp tick, and an editor can save identical bytes with a
   * new one. Only the bytes decide.
   */
  function scanEntryFor(file) {
    const active = state.active;
    const existing = active.scan.get(file);
    if (existing != null) return existing;

    const read = phase('io_ms', () => readSource(file));
    const hash = read.ok ? sha256(read.text) : null;
    const previous = state.fileStates.get(file);
    const entry = {
      file,
      text: read.ok ? read.text : null,
      hash,
      readable: read.ok,
      known: previous != null,
      changed: previous == null || previous.sourceHash !== hash,
    };
    if (read.ok) {
      count('read_bytes', Buffer.byteLength(read.text, 'utf8'));
      count('read_calls');
    }
    active.scan.set(file, entry);
    return entry;
  }

  /**
   * The module summary of `file`: rebuilt only when the bytes changed.
   *
   * This is the reuse that removes the coverage parse from unchanged files. The
   * summary is plain data - `request`, `form`, `local`, `isStylesheet`,
   * `computed`, `line`, plus the static import sources - and holds no reference
   * into the parse that produced it, so nothing downstream can be holding a
   * node a later transform has already rewritten.
   */
  function summaryFor(file) {
    const active = state.active;
    const entry = scanEntryFor(file);
    const fileState = state.fileStates.get(file);
    if (
      fileState?.summary != null &&
      !entry.changed &&
      fileState.sourceHash === entry.hash
    ) {
      bump('coverage_summaries_reused');
      return fileState.summary;
    }

    let summary;
    if (!entry.readable) {
      count('unreadable_modules');
      summary = { unreadable: true, edges: [], importSources: [] };
    } else {
      const start = perfNow();
      summary = moduleSummaryOfCode(entry.text);
      const elapsed = perfNow() - start;
      count('parse_calls');
      count('parsed_files');
      // Attributed to the pipeline where the parse happened, so the parse
      // accounting stays directly comparable with a full build's.
      recordParse(file, 'module-graph', elapsed);
      bump('files_reparsed');
    }
    bump('coverage_summaries_rebuilt');

    const owner = ensureFileState(file);
    // The summary is always built from the bytes just read, so the file's
    // content hash is current from here on - including for the generated
    // design-system module, whose bytes come from the overlay rather than disk.
    owner.sourceHash = entry.hash;
    owner.summary = summary;
    owner.importSources = summary.importSources;
    owner.edgeResolution = new Map();
    if (entry.changed) {
      // A summary could only be rebuilt because the BYTES changed, so the
      // compiled result is stale by construction. Marking it dirty without
      // marking it invalid is how a changed file keeps serving the result of
      // the revision that last compiled it.
      active.dirty.add(file);
      active.invalid.add(file);
    }
    return summary;
  }

  // ------------------------------------------------- design-system view -----

  /**
   * What the plugin will believe about this file's PandamStyle bindings.
   *
   * The plugin asks, for every static import declaration, whether the request
   * reaches the generated design system and with which export map. That answer
   * - not the target's content - is what decides whether `create`, `props` and
   * `token` are recognized here. So the view is a digest of those answers plus
   * the chain of files that produced them, and it is the reason a re-export edit
   * invalidates its consumers while a style edit does not.
   */
  function computeDsView(file, importSources) {
    const maxDepth = state.config.engineOptions?.maxRelayDepth;
    const parts = [];
    const chain = [];
    const seen = new Set();
    for (const source of importSources) {
      const info = resolveDesignSystemModule(file, source, { maxDepth });
      if (info == null) {
        parts.push(`${source}=>null`);
        continue;
      }
      parts.push(
        `${source}=>${info.modulePath}|${info.relayPath ?? ''}|` +
          `${stableJson(info.marker)}|${(info.exports ?? []).join(',')}|` +
          `${stableJson(info.exportsOfRelay ?? null)}`,
      );
      for (const module of info.chain ?? []) {
        if (seen.has(module)) continue;
        seen.add(module);
        chain.push(module);
      }
    }
    return { digest: sha256(parts.join('\n')), chain };
  }

  /**
   * Propagates a changed design-system view to the files that consume it.
   *
   * The propagation runs along the RELAY CHAIN, not over the whole reverse
   * graph. A file's view can only change if the file itself changed or if a
   * module on its chain changed; every other reverse edge - a page importing a
   * sibling, a barrel importing a leaf that is not a design-system relay - has
   * no bearing on whether this file's bindings are recognized.
   */
  function refreshDesignSystemViews(coveredFiles) {
    const active = state.active;
    const coveredSet = new Set(coveredFiles);
    const worklist = [];
    for (const file of active.dirty) {
      if (coveredSet.has(file)) worklist.push(file);
    }
    const recomputed = new Set();

    while (worklist.length > 0) {
      const file = worklist.pop();
      if (recomputed.has(file)) continue;
      recomputed.add(file);
      const fileState = ensureFileState(file);
      const consumersBefore = state.dsConsumers.get(file);
      const previous = fileState.dsView;
      const next = phase('session_dsv_view_ms', () =>
        computeDsView(file, fileState.importSources ?? []),
      );
      const changed = previous == null || previous.digest !== next.digest;
      fileState.dsView = next;
      if (
        previous != null &&
        (previous.chain.length !== next.chain.length ||
          previous.chain.some((m, i) => m !== next.chain[i]))
      ) {
        unregisterChain(file, previous.chain);
      }
      registerChain(file, next.chain);
      if (changed) {
        active.invalid.add(file);
        // A view that changed on a file that was NOT itself dirty is, by
        // construction, a change reached through a relay. That is the only
        // mechanism by which a reverse dependent is invalidated, and it is
        // counted as such.
        if (previous != null) bump('reverse_dependents_invalidated');
      }
      if (consumersBefore != null) {
        for (const consumer of consumersBefore) {
          if (consumer === file) continue;
          if (!coveredSet.has(consumer)) continue;
          if (recomputed.has(consumer)) continue;
          worklist.push(consumer);
        }
      }
    }
  }

  // ------------------------------------------------------------ coverage ----

  /**
   * The covered set, rebuilt from persistent summaries.
   *
   * The traversal is deliberately the SAME traversal `collectCoveredFiles`
   * performs, in the same order with the same queue discipline, because the
   * build report and the CSS rule order are both functions of the iteration
   * order of this map. A faster traversal that visited files in a different
   * order would emit a differently ordered stylesheet, which is exactly the
   * class of regression the differential oracle exists to catch.
   */
  function refreshClosure() {
    const cfg = state.config;
    const covered = new Map();
    const queue = [];

    for (const root of cfg.roots) {
      const abs = path.resolve(root);
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        throw new PmsError([
          diagnostic({
            code: Codes.COVERAGE_GAP,
            phase: 'coverage',
            message: `Declared root does not exist: ${abs}`,
            rule: 'coverage.roots',
            context: { root: abs },
          }),
        ]);
      }
      if (stat.isFile()) {
        covered.set(abs, 'root');
        queue.push(abs);
      } else {
        for (const f of walkFiles(abs)) {
          covered.set(f, 'root');
          queue.push(f);
        }
      }
    }

    const unresolved = [];
    const external = [];
    const relayEdges = [];

    while (queue.length > 0) {
      const file = queue.pop();
      const summary = summaryFor(file);
      if (summary.unreadable) {
        unresolved.push({
          from: file,
          request: '<unparseable>',
          form: 'unreadable',
          line: null,
        });
        continue;
      }
      const fileState = ensureFileState(file);
      for (const edge of summary.edges) {
        if (edge.computed === true) {
          unresolved.push({
            from: file,
            request: '<computed>',
            form: edge.form,
            line: edge.line,
          });
          continue;
        }
        // Resolution is DERIVED per revision and compared with the previous
        // answer. A request that was unresolvable and now resolves invalidates
        // the file that made it, and the closure grows to include the new
        // target - which is then analysed, because a newly covered file is
        // analysed before the revision can be valid.
        const resolved =
          edge.local && !edge.isStylesheet
            ? resolveLocal(file, edge.request)
            : null;
        const before = fileState.edgeResolution.get(edge.request);
        if (before !== undefined && before !== resolved) {
          state.active.invalid.add(file);
        }
        fileState.edgeResolution.set(edge.request, resolved);

        if (!edge.local) {
          if (edge.form !== 'import') {
            external.push({
              from: file,
              request: edge.request,
              form: edge.form,
            });
          }
          continue;
        }
        if (edge.isStylesheet) continue;
        if (resolved == null) {
          unresolved.push({
            from: file,
            request: edge.request,
            form: edge.form,
            line: edge.line,
          });
          continue;
        }
        if (!covered.has(resolved)) {
          covered.set(resolved, `closure:${edge.form}`);
          relayEdges.push({
            from: file,
            to: resolved,
            form: edge.form,
            request: edge.request,
          });
          queue.push(resolved);
        }
      }
    }

    return { covered, unresolved, external, relayEdges };
  }

  // ------------------------------------------------------------ revision ----

  function beginRevision() {
    const previous = state.active;
    if (previous != null && previous.published !== true) {
      // A revision that was prepared but never published is SUPERSEDED, never
      // merged into the next one. It never reached the published generation, so
      // discarding it is safe - and it is counted rather than dropped.
      state.supersededRevisions += 1;
    }
    tally.clear();
    const active = {
      revisionId: ++state.revisionId,
      scan: new Map(),
      dirty: new Set(),
      invalid: new Set(),
      fallbackReason: null,
      newFiles: new Set(),
      removedFiles: new Set(),
      counters: null,
      validated: false,
      ok: false,
      published: false,
      diagnostics: [],
      incrementalMs: null,
    };
    state.active = active;
    bump('session_revisions');
    return active;
  }

  /**
   * Applies a mutation and prepares the next revision.
   *
   * `changes` describes what the CALLER did to the world. The session does not
   * trust it: the scan re-derives what actually changed from the filesystem.
   * The change list is used for reporting, and for the one thing a scan
   * provably cannot see - a file DELETED outside every declared root, which no
   * root walk can observe and whose absence otherwise only shows up much later.
   *
   * A second `applyChanges` while a revision is prepared but unpublished
   * SUPERSEDES that revision. The session is single-writer and synchronous, so
   * a revision is never half-mixed with another: the only thing a supersede can
   * discard is a revision that never reached the output directory.
   */
  function applyChanges(changes = {}) {
    if (state.closed) {
      throw new Error('pandamstyle: the project session is closed.');
    }
    const active = beginRevision();
    const previousConfig = state.config;

    // ---- global fallback decision, before anything is read ---------------
    let nextConfig = previousConfig;
    let fallbackReason = null;
    if (changes.config != null) {
      const merged = normalizeConfig({ ...previousConfig, ...changes.config });
      for (const key of SEMANTIC_CONFIG_KEYS) {
        if (digestOf(merged[key]) !== digestOf(previousConfig[key])) {
          fallbackReason = fallbackReason ?? 'compiler-configuration';
        }
      }
      if (stableJson(merged.roots) !== stableJson(previousConfig.roots)) {
        fallbackReason = fallbackReason ?? 'roots';
      }
      if (merged.outDir !== previousConfig.outDir) {
        fallbackReason = fallbackReason ?? 'output-directory';
      }
      nextConfig = merged;
    }
    if (changes.definition != null) {
      nextConfig = { ...nextConfig, definition: changes.definition };
    }
    const nextDefinitionDigest = definitionDigest(nextConfig.definition);
    const definitionChanged =
      changes.definition != null &&
      (nextDefinitionDigest == null
        ? changes.definition !== previousConfig.definition
        : nextDefinitionDigest !== state.definitionDigest);
    if (definitionChanged) {
      // Token add/remove, category, visibility, semantic alias, theme,
      // condition and recipe changes all arrive as "the definition changed",
      // because at this architectural level they are one input. Naming them
      // separately would be a design graph this batch does not have; recording
      // them as ONE counted fallback is the honest label, and the report says
      // which scenarios land here.
      fallbackReason = fallbackReason ?? 'design-system-definition';
    }
    if (typeof changes.fullFallback === 'string') {
      // An input the session cannot observe - a lockfile, a package resolution
      // context, a policy resolved from outside the config. The caller says so
      // explicitly rather than the session guessing.
      fallbackReason = changes.fullFallback;
    }
    if (fallbackReason != null) {
      state.semanticEpoch += 1;
      bump('full_fallback');
    }
    state.config = nextConfig;
    state.definitionDigest = nextDefinitionDigest;
    state.lastFallbackReason = fallbackReason;
    active.fallbackReason = fallbackReason;

    try {
      if (state.designSystem == null || fallbackReason != null) {
        rebuildDesignSystem();
      }
      if (fallbackReason != null) {
        // Every cached result names the previous epoch. Dropping them is not an
        // optimisation: keeping one would be a stale result published under a
        // new revision.
        for (const [file, fileState] of [...state.fileStates]) {
          fileState.contribution = null;
          fileState.validity = null;
          fileState.edgeResolution = new Map();
          // The design-system view is derived from the module graph AND the
          // design system, and both just changed. It is dropped, not merely
          // left stale, and the file is marked dirty so the next validation
          // re-derives it and re-registers its place in the reverse index. A
          // fallback that forgot the reverse index would leave the session
          // quietly unable to invalidate a reverse dependent afterwards.
          unregisterChain(file, fileState.dsView?.chain ?? []);
          fileState.dsView = null;
          active.dirty.add(file);
        }
      }
      dirListings = new Map();
      phase('session_scan_ms', () => scanPreviousAndRoots(active, changes));
    } catch (err) {
      active.scanError = err;
    }
    return revisionSummary(active);
  }

  /**
   * Reads and hashes every file the previous revision knew about, plus every
   * file under the declared roots.
   *
   * This is the cost that makes a no-change revision O(project bytes) rather
   * than O(project parses). It is reported on its own - `io_ms` and
   * `session_scan_ms` - precisely so it is never confused with compilation.
   */
  function scanPreviousAndRoots(active, changes) {
    const known = new Set();
    if (state.covered != null) {
      for (const file of state.covered.covered.keys()) known.add(file);
    }
    for (const file of state.fileStates.keys()) known.add(file);

    const rootFiles = new Set();
    for (const root of state.config.roots) {
      const abs = path.resolve(root);
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        // The coverage walk reports a missing declared root with a diagnostic.
        // The scan simply cannot read it, and the walk runs in `validate()`.
        continue;
      }
      if (stat.isFile()) rootFiles.add(abs);
      else for (const f of walkFiles(abs)) rootFiles.add(f);
    }

    const counted = new Set();
    for (const file of known) {
      const entry = scanEntryFor(file);
      if (!entry.readable) {
        if (entry.known) {
          active.dirty.add(file);
          active.invalid.add(file);
          active.removedFiles.add(file);
        }
        continue;
      }
      if (!entry.known) {
        bump('files_added');
        counted.add(file);
        active.newFiles.add(file);
        active.dirty.add(file);
        active.invalid.add(file);
      } else if (entry.changed) {
        bump('files_changed');
        active.dirty.add(file);
        active.invalid.add(file);
      }
    }
    for (const file of rootFiles) {
      if (known.has(file)) continue;
      const entry = scanEntryFor(file);
      if (!entry.readable) continue;
      if (!counted.has(file)) bump('files_added');
      counted.add(file);
      active.newFiles.add(file);
      active.dirty.add(file);
      active.invalid.add(file);
    }

    for (const removed of changes.removedFiles ?? []) {
      const abs = path.resolve(removed);
      if (active.scan.get(abs)?.readable === true) continue;
      if (!active.removedFiles.has(abs)) {
        active.removedFiles.add(abs);
        active.dirty.add(abs);
        active.invalid.add(abs);
      }
    }
    for (const added of changes.addedFiles ?? []) {
      const abs = path.resolve(added);
      const entry = scanEntryFor(abs);
      if (!entry.readable) continue;
      if (!entry.known && !counted.has(abs)) {
        bump('files_added');
        active.newFiles.add(abs);
      }
      counted.add(abs);
      active.dirty.add(abs);
      active.invalid.add(abs);
    }
  }

  // ------------------------------------------------------------ validate ----

  function validate() {
    const active = state.active;
    if (active == null) {
      throw new Error(
        'pandamstyle: validate() was called before applyChanges(); there is ' +
          'no revision to validate.',
      );
    }
    if (active.validated) return revisionSummary(active);

    const start = perfNow();
    try {
      if (active.scanError != null) throw active.scanError;
      if (state.designSystem == null) rebuildDesignSystem();

      // The module-graph parse cache is process-global and the session now owns
      // its lifetime: a file whose bytes changed must never be served a node
      // from a previous revision, and nothing writes files during a revision,
      // so one clear at the start of the analysis is both necessary and
      // sufficient.
      clearModuleCache();

      for (const key of revalidateResolution()) {
        void key;
        bump('negative_resolutions_invalidated');
      }

      const closure = phase('session_closure_ms', () => refreshClosure());
      state.covered = closure;

      // Files that left the covered set lose EVERYTHING they owned. This is the
      // step that makes "no stale rule from a deleted file" true rather than
      // hoped for: the contribution is dropped, not shadowed, and its reverse
      // chain registration is undone.
      for (const [file, fileState] of [...state.fileStates]) {
        if (closure.covered.has(file)) {
          fileState.origin = closure.covered.get(file);
          continue;
        }
        unregisterChain(file, fileState.dsView?.chain ?? []);
        state.fileStates.delete(file);
        active.dirty.add(file);
        active.removedFiles.add(file);
        active.invalid.add(file);
      }

      for (const file of closure.covered.keys()) {
        if (ensureFileState(file).contribution == null)
          active.invalid.add(file);
      }
      refreshDesignSystemViews([...closure.covered.keys()]);

      if (closure.unresolved.length > 0) {
        throw new PmsError(
          closure.unresolved.map((u) =>
            diagnostic({
              code: Codes.COVERAGE_GAP,
              phase: 'coverage',
              message:
                `Unresolved local ${u.form ?? 'import'} "${u.request}" from ` +
                `covered file ${u.from}. P0 requires a static module graph, so ` +
                'an unresolved edge is a coverage gap, not a skipped file.',
              source: u.from,
              rule: 'coverage.local-imports',
              context: {
                request: u.request,
                from: u.from,
                form: u.form ?? 'import',
                line: u.line ?? null,
              },
            }),
          ),
        );
      }

      const analysis = phase('session_compile_files_ms', () =>
        analyseCoveredFiles(closure, active),
      );
      if (analysis.failures.length > 0) throw new PmsError(analysis.failures);
      if (!analysis.consistency.ok) {
        throw new PmsError(
          coverageGapDiagnostics(analysis.consistency.missing, 'cli'),
        );
      }

      active.coverage = analysis.coverage;
      active.outputs = analysis.outputs;
      active.analysed = analysis.analysed;
      active.allRules = analysis.allRules;
      active.consistency = analysis.consistency;
      active.designSystemRuleCount = analysis.designSystemRuleCount;
      active.ok = true;
    } catch (err) {
      active.ok = false;
      if (err != null && Array.isArray(err.diagnostics)) {
        active.diagnostics = err.diagnostics;
        active.error = err;
      } else {
        active.diagnostics = [diagnosticFromError(err)];
      }
    }

    active.validated = true;
    active.incrementalMs = perfNow() - start;
    bump('session_file_states', state.fileStates.size);
    count('session_resolution_keys', resolutionKeys.size);
    count('session_resolution_dirs', dirListings.size);
    pruneResolution();
    active.counters = buildReportCounters(active);
    return revisionSummary(active);
  }

  function diagnosticFromError(err) {
    return {
      schemaVersion: 1,
      code: 'PMS_SESSION_INTERNAL',
      severity: 'error',
      phase: 'session',
      message: String(err?.message ?? err),
      source: null,
      location: { file: null, line: null, column: null, role: null },
      rule: 'session.internal',
      context: { revisionId: state.active?.revisionId ?? null },
      autofix: null,
    };
  }

  /** Drops resolution keys for files that are no longer part of the project. */
  function pruneResolution() {
    for (const [key, entry] of [...resolutionKeys]) {
      if (state.fileStates.has(entry.fromFile)) continue;
      resolutionKeys.delete(key);
    }
  }

  function analyseCoveredFiles(closure, active) {
    const cfg = state.config;
    const designSystemPath = state.generatedModulePath;

    const allRules = designSystemRules();
    const designSystemRuleCount = allRules.length;
    const coverage = [];
    const failures = [];
    const outputs = [];
    const analysed = [];

    // The generated design-system module is the generator's own output, not a
    // page: it is staged as-is and never re-analysed. Relabelling it here,
    // before the loop, is what lets the expected-vs-analysed cross-check keep
    // meaning something.
    closure.covered.set(designSystemPath, 'generated');

    for (const [file, origin] of [...closure.covered]) {
      if (file === designSystemPath) {
        coverage.push({
          file: relativeToCwd(file),
          origin,
          role: 'design-system',
          analysed: true,
          diagnostics: 0,
        });
        // The generated module is NOT counted as analysed: it is the
        // generator's own output and is exempt from the cross-check, exactly
        // as in the full build. Counting it would make the two builds report
        // different analysed counts for the same project.
        continue;
      }
      const fileState = ensureFileState(file);
      fileState.origin = origin;

      if (fileState.contribution == null || active.invalid.has(file)) {
        const entry = scanEntryFor(file);
        if (!entry.readable) {
          failures.push(
            diagnostic({
              code: Codes.COVERAGE_GAP,
              phase: 'coverage',
              message: `Covered file could not be read: ${file}`,
              source: file,
              rule: 'coverage.readable',
              context: { file },
            }),
          );
          analysed.push(file);
          continue;
        }
        bump('files_recompiled');
        let result;
        try {
          result = compileFile(
            entry.text,
            file,
            state.designSystem,
            cfg.engineOptions,
          );
        } catch (err) {
          if (err != null && Array.isArray(err.diagnostics)) {
            failures.push(...err.diagnostics);
            coverage.push({
              file: relativeToCwd(file),
              origin,
              role: 'page',
              analysed: true,
              failed: true,
              diagnostics: err.diagnostics.length,
              codes: [...new Set(err.diagnostics.map((d) => d.code))],
            });
            analysed.push(file);
            // The file's previous contribution is REMOVED, not left behind a
            // diagnostic. A repair revision must publish the repaired file, and
            // a failed revision must not leave a stale rule reachable from the
            // aggregation.
            fileState.contribution = null;
            fileState.validity = null;
            continue;
          }
          throw err;
        }
        const rules = result.metadata.pandamstyle ?? [];
        const coverageEntry = result.metadata.pandamstyleCoverage ?? {};
        fileState.contribution = {
          code: result.code,
          rules,
          coverage: {
            file: relativeToCwd(file),
            origin,
            role: 'page',
            analysed: true,
            usedDesignSystem: coverageEntry.usedDesignSystem === true,
            usedPmsHelpers: coverageEntry.usedPmsHelpers === true,
            ruleCount: rules.length,
            relayChain: (coverageEntry.relayChain ?? []).map(relativeToCwd),
            diagnostics: 0,
          },
          diagnostics: [],
        };
        fileState.compiledRevision = active.revisionId;
        fileState.validity = validityKeyOf(fileState, cfg);
      } else {
        bump('files_reused');
      }
      for (const rule of fileState.contribution.rules) allRules.push(rule);
      coverage.push(fileState.contribution.coverage);
      analysed.push(file);
      outputs.push({ file, code: fileState.contribution.code });
    }

    const consistency = assertCoverageConsistency({
      coveredFiles: [...closure.covered.keys()],
      transformedFiles: analysed,
      exemptFiles: [designSystemPath],
      phase: 'cli',
    });

    return {
      allRules,
      designSystemRuleCount,
      coverage,
      failures,
      outputs,
      analysed,
      consistency,
    };
  }

  /**
   * The validity key of a compiled file result.
   *
   * Never a path. A path is not an input: two revisions at the same path with
   * different bytes, or the same bytes under a different registry, are
   * different results, and a path-keyed cache cannot tell them apart. It is
   * also never mtime, and never "the file is still there".
   */
  function validityKeyOf(fileState, cfg) {
    return {
      sourceHash: fileState.sourceHash,
      role: fileState.role,
      compilerContractVersion: CONTRACT_VERSION,
      projectSemanticEpoch: state.semanticEpoch,
      engineOptionsDigest: digestOf(cfg.engineOptions),
      useCSSLayers: cfg.useCSSLayers,
      runtimeModule: cfg.runtimeModule,
      resolutionDigest: digestOf(
        [...fileState.edgeResolution.entries()].sort((a, b) =>
          a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
        ),
      ),
      designSystemViewDigest: fileState.dsView?.digest ?? null,
    };
  }

  function designSystemRules() {
    const rules = [];
    for (const [key, { priority, ...rest }] of Object.entries(
      state.designSystem.injected,
    )) {
      rules.push([key, rest, priority ?? 0]);
    }
    return rules;
  }

  // ------------------------------------------------------------- compile ----

  function compile() {
    const active = state.active;
    if (active == null || !active.validated) {
      throw new Error(
        'pandamstyle: compile() was called before a validated revision.',
      );
    }
    if (!active.ok) {
      // A failed revision does not publish. The previously published generation
      // stays current, byte for byte, and the caller gets the diagnostics for
      // THIS revision.
      throw active.error ?? new PmsError(active.diagnostics);
    }
    return publish(active);
  }

  function publish(active) {
    const cfg = state.config;
    const absOut = path.resolve(cfg.outDir);
    const sourceBase = commonBase(cfg.roots);
    const outputRelFor = (file) => {
      const rel = path.relative(sourceBase, file);
      const safe = rel.startsWith('..') ? path.basename(file) : rel;
      return path.posix.join('js', safe.split(path.sep).join('/'));
    };

    const result = withGeneration(
      absOut,
      (gen) => {
        const designSystem = state.designSystem;
        const registryDigest = designSystem.registry.registryDigest;

        gen.stage(cfg.designSystemFile, state.designSystemSource);

        const allRules = active.allRules;
        const css = phase('session_aggregate_ms', () =>
          styleXTransform.processStylexRules(allRules, {
            useLayers: cfg.useCSSLayers,
          }),
        );

        const buildReport = {
          documentKind: 'pandamstyle-build-report',
          contractVersion: designSystem.manifest.compilerContractVersion,
          systemId: designSystem.registry.systemId,
          registryDigest,
          coveredRoots: cfg.roots,
          coveredFileCount: active.coverage.length,
          analysedFileCount: active.analysed.length,
          designSystemRuleCount: active.designSystemRuleCount,
          consumerRuleCount: allRules.length - active.designSystemRuleCount,
          ruleCount: allRules.length,
          cssBytes: Buffer.byteLength(css, 'utf8'),
          coverage: active.coverage,
          coverageConsistency: {
            expectedCount: active.consistency.expectedCount,
            analysedCount: active.consistency.transformedCount,
            missing: active.consistency.missing.map(relativeToCwd),
            classification:
              'a covered file that the CLI did not analyse fails the build',
          },
          externalRequests: (state.covered?.external ?? []).map((e) => ({
            request: e.request,
            form: e.form,
            from: relativeToCwd(e.from),
          })),
          relayEdges: (state.covered?.relayEdges ?? []).map((e) => ({
            from: relativeToCwd(e.from),
            to: relativeToCwd(e.to),
            form: e.form,
          })),
          // The generation describes the WHOLE current revision, reused files
          // included. This block exists so a reader can see how much of it was
          // recomputed without inferring it from a timestamp, and so a partial
          // generation can never be mistaken for a complete one.
          incremental: {
            revisionId: active.revisionId,
            generationId: state.generationId + 1,
            projectSemanticEpoch: state.semanticEpoch,
            incrementalAnalysisMs: active.incrementalMs / 1e6,
            ...active.counters,
          },
        };

        const manifestWithDigest = {
          ...designSystem.manifest,
          registryDigest,
          designSystemModule: relativeToCwd(state.generatedModulePath),
        };

        for (const { file, code } of active.outputs) {
          gen.stage(outputRelFor(file), code);
        }
        gen.stage('styles.css', css);
        gen.stage(
          'build-report.json',
          JSON.stringify(buildReport, null, 2) + '\n',
        );
        gen.stage(
          'manifest.json',
          JSON.stringify(manifestWithDigest, null, 2) + '\n',
        );

        return {
          css,
          manifest: manifestWithDigest,
          buildReport,
          coverage: active.coverage,
          outputs: active.outputs,
          registryDigest,
          revisionId: active.revisionId,
          published: [
            ...active.outputs.map(({ file }) => outputRelFor(file)),
            'styles.css',
            'build-report.json',
            'manifest.json',
            cfg.designSystemFile,
          ],
        };
      },
      { commitMarker: 'manifest.json' },
    );

    state.generationId += 1;
    active.published = true;
    state.published = {
      revisionId: active.revisionId,
      generationId: state.generationId,
      registryDigest: result.registryDigest,
    };
    return {
      ...result,
      generationId: state.generationId,
      incremental: active.counters,
    };
  }

  // ------------------------------------------------------------- reports ----

  function buildReportCounters(active) {
    let reused = 0;
    let recompiled = 0;
    for (const fileState of state.fileStates.values()) {
      if (fileState.contribution == null) continue;
      if (fileState.compiledRevision === active.revisionId) recompiled += 1;
      else reused += 1;
    }
    return {
      filesChanged: read('files_changed'),
      filesAdded: read('files_added'),
      filesRemoved: active.removedFiles.size,
      filesReparsed: read('files_reparsed'),
      filesRecompiled: recompiled,
      filesReused: reused,
      coverageSummariesReused: read('coverage_summaries_reused'),
      coverageSummariesRebuilt: read('coverage_summaries_rebuilt'),
      reverseDependentsInvalidated: read('reverse_dependents_invalidated'),
      negativeResolutionsInvalidated: read('negative_resolutions_invalidated'),
      fullFallback: active.fallbackReason != null ? 1 : 0,
      fullFallbackReason: active.fallbackReason,
      newlyCoveredFiles: active.newFiles.size,
      coveredFileCount: active.coverage?.length ?? 0,
      fileStateCount: state.fileStates.size,
    };
  }

  function revisionSummary(active) {
    return {
      revisionId: active.revisionId,
      ok: active.ok,
      validated: active.validated,
      published: active.published,
      fullFallback: active.fallbackReason != null,
      fullFallbackReason: active.fallbackReason,
      projectSemanticEpoch: state.semanticEpoch,
      diagnostics: active.diagnostics,
      incrementalAnalysisMs:
        active.incrementalMs == null ? null : active.incrementalMs / 1e6,
      counters: active.counters ?? buildReportCounters(active),
    };
  }

  // ----------------------------------------------------------------- API ----

  const api = {
    /**
     * Prepares revision 1 from the configuration the session was created with.
     *
     * A full analysis, not a special case of the incremental one: the first
     * revision has no previous results, so every covered file is parsed and
     * compiled, and the session afterwards is in exactly the state a session
     * that had been running for a while would be in.
     */
    initialize() {
      return api.applyChanges({ initial: true });
    },

    applyChanges,

    validate,

    compile,

    /** The last published generation, or null if none was ever published. */
    current() {
      return state.published;
    },

    stats() {
      const mem = process.memoryUsage();
      return {
        revisionId: state.revisionId,
        generationId: state.generationId,
        projectSemanticEpoch: state.semanticEpoch,
        fileStateCount: state.fileStates.size,
        resolutionKeyCount: resolutionKeys.size,
        negativeResolutionCount: [...resolutionKeys.values()].filter(
          (v) => v.resolved === null,
        ).length,
        dsConsumerModuleCount: state.dsConsumers.size,
        supersededRevisions: state.supersededRevisions,
        lastFallbackReason: state.lastFallbackReason,
        counters: Object.fromEntries(tally),
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
      };
    },

    /**
     * The validity key a file's cached result is stored under, or null if the
     * file has no result. Exposed so a test can assert that reuse is decided by
     * the key and never by a path or a timestamp.
     */
    validityOf(file) {
      return state.fileStates.get(path.resolve(file))?.validity ?? null;
    },

    fileStates() {
      return [...state.fileStates.values()].map((f) => ({
        file: f.file,
        origin: f.origin,
        sourceHash: f.sourceHash,
        compiledRevision: f.compiledRevision,
        ruleCount: f.contribution?.rules.length ?? null,
        codeBytes: f.contribution?.code.length ?? null,
        validity: f.validity,
      }));
    },

    close() {
      state.closed = true;
      clearModuleOverlay();
      clearModuleCache();
      state.fileStates.clear();
      state.dsConsumers.clear();
      resolutionKeys = new Map();
      dirListings = new Map();
      state.covered = null;
      state.active = null;
      state.designSystem = null;
    },
  };

  return api;
}
