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
import { createCssState } from './css-state';
import {
  DEFAULT_DIRTY_INPUT_MODE,
  existenceChangedPaths,
  normalizeMutationTransaction,
  touchedPaths,
} from './dirty-input';
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
    // Spike 3. Which publication strategy this session uses. It is a config
    // field and NOT a semantic one: it changes how the same result is written
    // to disk, never what the result is, so it is deliberately absent from
    // SEMANTIC_CONFIG_KEYS and does not bump the semantic epoch.
    publishVariant: resolvePublishVariant(input.publishVariant),
    // Test seam, exactly like the CLI's `--inject-failure`: a point name (or a
    // `(point) => void` that throws) at which publication must fail. It is how
    // "a failure at any point leaves generation N current" is proved rather
    // than asserted. Never set by a caller that is not a test.
    publishFailAt: input.publishFailAt ?? null,
  };
}

/**
 * The publication variants, and what each one is allowed to skip.
 *
 *   session_full_publish        incremental compilation, FULL generation
 *                               publication, FULL CSS aggregation. The Spike 2
 *                               reference; it is the default so that no caller
 *                               changes behaviour, and it is the number every
 *                               Spike 3 result is measured against.
 *
 *   session_incremental_publish incremental compilation, DELTA output
 *                               publication (unchanged artifacts are reused, not
 *                               rewritten), FULL CSS aggregation.
 *
 *   session_incremental_publish_css
 *                               as above, plus INCREMENTAL CSS aggregation.
 *
 * The three are separate because the whole point of the spike is attribution:
 * collapsing them would make it impossible to say which change bought what.
 */
const PUBLISH_VARIANTS = Object.freeze([
  'session_full_publish',
  'session_incremental_publish',
  'session_incremental_publish_css',
]);

function resolvePublishVariant(name) {
  if (name == null) return 'session_full_publish';
  if (typeof name === 'string') {
    const trimmed = name.trim();
    if (trimmed === '') return 'session_full_publish';
    if (!PUBLISH_VARIANTS.includes(trimmed)) {
      throw new Error(
        `pandamstyle: unknown publishVariant ${JSON.stringify(name)}; expected one of ${PUBLISH_VARIANTS.join(', ')}.`,
      );
    }
    return trimmed;
  }
  // An object form, so a caller can name the two axes separately instead of
  // memorising the three combinations above.
  if (typeof name === 'object') {
    const incrementalPublish = name.incrementalPublish === true;
    const incrementalCss = name.incrementalCss === true;
    if (incrementalPublish) {
      return incrementalCss
        ? 'session_incremental_publish_css'
        : 'session_incremental_publish';
    }
    if (incrementalCss) {
      throw new Error(
        'pandamstyle: incrementalCss requires incrementalPublish; incremental CSS without incremental publication has nothing to be incremental about.',
      );
    }
    return 'session_full_publish';
  }
  throw new Error('pandamstyle: publishVariant must be a string or an object.');
}

const publishesDelta = (variant) => variant !== 'session_full_publish';
const usesIncrementalCss = (variant) =>
  variant === 'session_incremental_publish_css';

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
    lastPublication: null,
    dirtyInputMode: DEFAULT_DIRTY_INPUT_MODE,
    lastMutation: null,
    auditDue: false,
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

  // root absolute path -> the source files that were under it last time it was
  // walked. Maintained incrementally in `verified-explicit` mode, and rebuilt by
  // the walk in `full-discovery` mode. It exists because a root walk is O(project)
  // and the agent already told us which paths moved.
  const rootFileSets = new Map();

  // candidate absolute path -> the resolution keys whose answer depends on
  // whether that path EXISTS. This is the reverse of the forward index the
  // resolver keeps, and it is what makes "a file appeared" observable without
  // re-probing every key the session has ever formed. See `probeResolution`.
  const negativeCandidates = new Map();

  /** The declared root that contains `dir`, or null if none does. */
  function rootOwning(dir) {
    for (const root of state.config.roots) {
      const abs = path.resolve(root);
      if (dir === abs || isUnderDir(dir, abs)) return abs;
      // A root that is a FILE contains nothing.
      const stat = statOrNull(abs);
      if (stat != null && stat.isFile()) continue;
    }
    return null;
  }

  function isUnderDir(file, dir) {
    const rel = path.relative(dir, file);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  function statOrNull(file) {
    try {
      return fs.statSync(file);
    } catch {
      return null;
    }
  }
  // The project's incremental CSS state. Null until a variant asks for it.
  let cssState = null;
  let cssStateKey = null;
  let cssStateLastCss = null;

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

  /**
   * Remembers which resolution keys' answers depend on WHICH paths existing.
   *
   * A resolution answer is a function of the EXISTENCE of the key's candidate
   * set and of nothing else. So the set of keys a given path can possibly change
   * the answer of is exactly the keys that list it as a candidate - and a fully
   * negative key lists nineteen of them (the bare base, six extensions, six
   * stem-swapped extensions, six directory indices).
   *
   * Without this index, "a file appeared somewhere in the project" can only be
   * observed by re-probing every key the session has ever formed, which is
   * O(project) per revision and defeats the entire point of an explicit
   * mutation set. With it, an `added` path costs one map lookup and a re-probe
   * of the keys that actually mention it.
   *
   * The index is maintained, not merely built: a key's candidate registration
   * is replaced when its answer changes, and removed when its origin file leaves
   * the project, so it cannot grow without bound.
   */
  function indexNegativeKey(key, entry) {
    unindexNegativeKey(key);
    const base = path.resolve(path.dirname(entry.fromFile), entry.request);
    for (const candidate of candidatesOf(base)) {
      let set = negativeCandidates.get(candidate);
      if (set === undefined) {
        set = new Set();
        negativeCandidates.set(candidate, set);
      }
      set.add(key);
    }
    entry.candidatesIndexed = true;
  }

  function unindexNegativeKey(key) {
    const entry = resolutionKeys.get(key);
    if (entry == null || entry.candidatesIndexed !== true) return;
    const base = path.resolve(path.dirname(entry.fromFile), entry.request);
    for (const candidate of candidatesOf(base)) {
      const set = negativeCandidates.get(candidate);
      if (set === undefined) continue;
      set.delete(key);
      if (set.size === 0) negativeCandidates.delete(candidate);
    }
    entry.candidatesIndexed = false;
  }

  /**
   * WHICH resolution keys this revision has to re-probe.
   *
   * `null` means all of them, and that is the only answer that can be correct
   * without knowing the complete mutation set. An explicit or watched mutation
   * knows which paths moved, so it knows which negative keys could possibly have
   * a different answer: the keys that list one of those paths as a candidate.
   *
   * A path whose CONTENT changed but whose EXISTENCE did not is not in this set,
   * and that is correct rather than an omission: a resolution answer is a
   * function of existence, so rewriting a file that already resolved cannot
   * change any answer.
   */
  function resolutionScopeFor(active) {
    const mode = active.dirtyInputMode;
    if (mode !== 'verified-explicit' && mode !== 'watcher') return null;
    if (active.fullDiscoveryReason != null) return null;
    const paths = active.mutationTouched;
    if (paths == null) return null;
    const scope = affectedNegativeKeys(existenceChangedPaths(active.mutation));
    count('resolution_keys_scoped', scope.size);
    return scope;
  }

  /** The negative keys a declared existence change could have repaired. */
  function affectedNegativeKeys(paths) {
    const keys = new Set();
    for (const file of paths) {
      const set = negativeCandidates.get(file);
      if (set === undefined) continue;
      for (const key of set) keys.add(key);
    }
    return keys;
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
    const entry = { fromFile, request, resolved, candidatesIndexed: false };
    resolutionKeys.set(key, entry);
    if (resolved === null) {
      bump('negative_resolutions');
      // Index it immediately. A key that is born negative is the common case -
      // an import of a module that does not exist yet is how a project is
      // written - and it has to be findable the moment the module appears.
      indexNegativeKey(key, entry);
    }
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
  /**
   * @param scope `null` re-probes EVERY key, which is what `full-discovery` has
   *   always done and the only thing that can be correct without a complete
   *   mutation set. A set of keys re-probes only those, which is what an
   *   explicit mutation set can justify.
   */
  function revalidateResolution(scope) {
    const repaired = [];
    const keys =
      scope === null
        ? [...resolutionKeys.keys()]
        : [...scope].filter((key) => resolutionKeys.has(key));
    count('resolution_keys_rechecked', keys.length);
    for (const key of keys) {
      const entry = resolutionKeys.get(key);
      if (entry == null) continue;
      const before = entry.resolved;
      const after = phase('session_resolve_ms', () =>
        probeResolution(entry.fromFile, entry.request),
      );
      if (before === null && after !== null) {
        repaired.push(entry.fromFile);
        count('negative_resolution_keys_rechecked', 1);
      }
      entry.resolved = after;
      if (after === null) {
        if (entry.candidatesIndexed !== true) indexNegativeKey(key, entry);
      } else {
        // It resolves now, so it is no longer a negative key and its candidate
        // registration is dead weight. Dropping it here is what keeps the index
        // proportional to the number of CURRENTLY unresolvable edges.
        unindexNegativeKey(key);
      }
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
  function refreshClosure(active) {
    const covered = new Map();
    const queue = [];

    // WHICH FILES ARE UNDER THE ROOTS is a question with two very different
    // costs, and Spike 4 is about the difference between them.
    //
    //   full-discovery     ask the filesystem: one `readdir` per directory per
    //                      revision. Always correct, O(project).
    //   verified-explicit  take the previous answer and apply the declared
    //                      mutation to it. O(declared), and the answer is the
    //                      same one the filesystem would have given.
    //
    // The second is only sound because the caller performed the write. That is
    // the whole content of the `verified-explicit` contract, and a host that
    // cannot make that claim uses `full-discovery` and pays for it.
    const trustRoots =
      active?.dirtyInputMode === 'verified-explicit' ||
      active?.dirtyInputMode === 'watcher';
    const applied = trustRoots ? active.rootDelta : null;

    // The cached root lists have to keep the EXACT order `walkFiles` would have
    // produced, because the traversal order is a function of the coverage array
    // and of the stylesheet's cascade order. So a declared mutation is applied
    // by RE-READING THE DIRECTORY IT CHANGED, not by splicing the path into a
    // list we are guessing about.
    //
    // A file whose CONTENT changed is not in this set at all: its path, its
    // position and its neighbours are all unchanged, and there is nothing to
    // re-derive. That is the one-file agent edit, and it costs no directory read
    // whatsoever.
    //
    // A file that APPEARED or DISAPPEARED does change the order the walk would
    // produce, so its parent directory is re-read. One `readdir` of one
    // directory, not a walk of the tree - and in the pathological shape of a
    // project with ten thousand files in one directory, that is the same
    // `readdir` a walk would have done anyway, while the ten thousand file
    // READS and HASHES the walk also implied are what is actually saved.
    if (applied != null && rootFileSets.size > 0) {
      const dirsToRefresh = new Set();
      let shapeMoved = false;
      for (const abs of [...applied.added, ...applied.removed]) {
        const owner = rootOwning(path.dirname(abs));
        if (owner === null) {
          // The parent is not under any walked root: the tree's shape moved in
          // a way an incremental update cannot describe. A walk is the honest
          // answer, and it is counted.
          shapeMoved = true;
          break;
        }
        dirsToRefresh.add(owner);
      }
      if (shapeMoved) {
        active.fullDiscoveryReason =
          active.fullDiscoveryReason ?? 'root-shape-changed';
        rootFileSets.clear();
      } else {
        for (const dir of dirsToRefresh) {
          rootFileSets.set(dir, walkFiles(dir));
          count('discovery_directory_rereads', 1);
        }
      }
    }

    // Seed from each declared root. In full-discovery mode, and on a session's
    // first revision, the answer comes from the filesystem and is CACHED. In
    // verified-explicit mode the answer is reused from the cache and corrected
    // below, which is where the declared mutation is applied.
    for (const root of state.config.roots) {
      const abs = path.resolve(root);
      const stat = statOrNull(abs);
      if (stat == null) {
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
        continue;
      }
      const cached = trustRoots ? rootFileSets.get(abs) : undefined;
      const found = cached ?? walkFiles(abs);
      if (cached === undefined) rootFileSets.set(abs, found);
      for (const f of found) {
        covered.set(f, 'root');
        queue.push(f);
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
      // The mutation transaction, if the caller supplied one. `full-discovery` -
      // the default - leaves this null and every cost below is re-derived.
      active.mutation = changes.mutation ?? null;
      state.lastMutation = active.mutation;
      if (
        active.mutation != null &&
        Number.isInteger(active.mutation.auditInterval) &&
        active.mutation.auditInterval > 0 &&
        active.revisionId % active.mutation.auditInterval === 0
      ) {
        state.auditDue = true;
      }
      if (active.mutation != null) {
        state.dirtyInputMode = active.mutation.mode;
      }
      active.mutationTouched =
        changes.mutation == null
          ? null
          : new Set(
              [...touchedPaths(changes.mutation)].map((p) => path.resolve(p)),
            );
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

    const declared = changes.mutation;
    // Three independent reasons to stop trusting the declared set, and all three
    // land in the same place: re-derive everything and say so.
    const forcedFullDiscovery =
      declared != null &&
      (declared.forceFullDiscovery === true || state.auditDue === true);
    const trustDeclared =
      declared != null &&
      declared.mode !== 'full-discovery' &&
      !forcedFullDiscovery;

    count(
      'dirty_input_mode_' +
        (declared?.mode ?? 'full-discovery').replace(/-/g, '_'),
      1,
    );
    if (declared != null) {
      count('dirty_files_declared', touchedPaths(declared).size);
    }

    // -------------------------------------------------------------- declared
    //
    // The agent's transaction IS the mutation set. Only the declared paths are
    // read, and only they are hashed; everything else keeps the state it has.
    // At 10,000 files the previous path re-read and re-hashed every one of them
    // to be told that one had changed.
    if (trustDeclared) {
      const delta = { added: new Set(), removed: new Set() };
      for (const raw of touchedPaths(declared)) {
        const file = path.resolve(raw);
        const declaredRemoval =
          declared.removed.some((p) => path.resolve(p) === file) ||
          declared.renamed.some((r) => path.resolve(r.from) === file);
        if (declaredRemoval) {
          if (!active.removedFiles.has(file)) {
            active.removedFiles.add(file);
            active.dirty.add(file);
            active.invalid.add(file);
            if (known.has(file)) bump('files_removed');
          }
          delta.removed.add(file);
          continue;
        }
        const entry = scanEntryFor(file);
        count('dirty_files_read', 1);
        if (!entry.readable) {
          // Declared as changed and gone. A removal the caller did not label,
          // handled as one rather than ignored.
          if (known.has(file) && !active.removedFiles.has(file)) {
            active.removedFiles.add(file);
            active.dirty.add(file);
            active.invalid.add(file);
            bump('files_removed');
          }
          delta.removed.add(file);
          continue;
        }
        count('dirty_files_hashed', 1);
        if (!entry.known) {
          bump('files_added');
          active.newFiles.add(file);
          delta.added.add(file);
        } else if (entry.changed) {
          bump('files_changed');
        } else {
          // Declared dirty and hashed identical. An agent that reformatted a
          // file without changing it should cost nothing downstream, and
          // saying so is how a host can find out it is over-declaring.
          count('dirty_files_unchanged', 1);
        }
        active.dirty.add(file);
        active.invalid.add(file);
      }
      active.rootDelta = delta;
      active.dirtyInputMode = declared.mode;
      count('project_files_scanned', 0);
      return;
    }

    // -------------------------------------------------------- full discovery
    if (declared != null && declared.forceFullDiscovery === true) {
      bump('full_discovery_fallback');
      active.fullDiscoveryReason = 'caller-requested';
      state.auditDue = false;
    } else if (declared != null && state.auditDue === true) {
      // The standing completeness audit fired, so this revision re-derives
      // everything. It is O(project) by construction, which is exactly why it is
      // an interval a host opts into and not a default.
      state.auditDue = false;
      bump('full_discovery_fallback');
      active.fullDiscoveryReason = 'mutation-set-audit-interval';
    }
    active.dirtyInputMode = 'full-discovery';
    active.rootDelta = null;

    const rootFiles = new Set();
    for (const root of state.config.roots) {
      const abs = path.resolve(root);
      const stat = statOrNull(abs);
      if (stat == null) {
        // The coverage walk reports a missing declared root with a diagnostic.
        // The scan cannot read it, and the walk runs in `validate()`.
        continue;
      }
      if (stat.isFile()) rootFiles.add(abs);
      else for (const f of walkFiles(abs)) rootFiles.add(f);
    }
    count('project_files_scanned', known.size + rootFiles.size);

    const counted = new Set();
    for (const file of known) {
      const entry = scanEntryFor(file);
      count('dirty_files_read', 1);
      if (entry.readable) count('dirty_files_hashed', 1);
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
      count('dirty_files_read', 1);
      if (!entry.readable) continue;
      if (entry.readable) count('dirty_files_hashed', 1);
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

      for (const file of revalidateResolution(resolutionScopeFor(active))) {
        void file;
        bump('negative_resolutions_invalidated');
      }

      const closure = phase('session_closure_ms', () => refreshClosure(active));
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
      // How many rule contributions the whole project produced. This is the
      // number a full CSS aggregation runs over, and the number an incremental
      // one reduces from, so it belongs on the revision.
      active.ruleCount = analysis.ruleCount;
      active.consistency = analysis.consistency;
      active.designSystemRuleCount = analysis.designSystemRuleCount;
      // The three inputs the incremental CSS state consumes. They are properties
      // of THIS revision and are recomputed with it.
      active.designSystemRules = analysis.designSystemRules;
      active.recompiledRules = analysis.recompiledRules;
      active.liveRuleOwners = analysis.liveRuleOwners;
      active.coveredFiles = analysis.coveredFiles;
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
      unindexNegativeKey(key);
      resolutionKeys.delete(key);
    }
  }

  function analyseCoveredFiles(closure, active) {
    const cfg = state.config;
    const designSystemPath = state.generatedModulePath;

    // TWO arrays, and the difference matters.
    //
    // `designSystemRules()` reads `state.designSystem.injected`, which is a
    // MUTABLE ACCUMULATOR: every `create()` call the design system hands to a
    // page does `Object.assign(injected, result.injected)` on it. So the array
    // taken here is the design system's own rules, and it stops being that the
    // moment the pages below are compiled.
    //
    // Aliasing one array to both roles - which is what this did, and what made
    // the incremental CSS state believe the design system owned every rule in
    // the project, which made every page rule immortal - is the kind of aliasing
    // that is invisible until something needs to attribute a rule to an owner.
    const designSystemRulesForRevision = designSystemRules();
    const allRules = [...designSystemRulesForRevision];
    const designSystemRuleCount = designSystemRulesForRevision.length;
    const coverage = [];
    const failures = [];
    const outputs = [];
    const analysed = [];
    // The two sets the incremental CSS state consumes: the files whose rule
    // contribution this revision replaced, and the files that left. Everything
    // else keeps the contribution it already had, which is what makes a CSS
    // update a function of the changed set rather than of the project size.
    // An EMPTY map means "no file was recompiled", which is the case
    // incremental CSS exists for. `null` means "this caller did not supply a
    // delta", which is a different statement entirely and the only one that
    // forces a rebuild - so the two must not be the same value.
    const recompiledRules = new Map();

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
          // The CONTENT identity of this file's published output, taken here -
          // once, when the file is compiled, which is O(changed) work - rather
          // than at publication time, which would be O(project size). The
          // publisher needs it to answer "unchanged?" without reading the
          // previous generation.
          codeDigest: sha256(result.code),
          codeBytes: Buffer.byteLength(result.code, 'utf8'),
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
      if (fileState.compiledRevision === active.revisionId) {
        recompiledRules.set(file, fileState.contribution.rules);
      }
      analysed.push(file);
      outputs.push({
        file,
        code: fileState.contribution.code,
        codeDigest: fileState.contribution.codeDigest,
        codeBytes: fileState.contribution.codeBytes,
      });
    }

    const consistency = assertCoverageConsistency({
      coveredFiles: [...closure.covered.keys()],
      transformedFiles: analysed,
      exemptFiles: [designSystemPath],
      phase: 'cli',
    });

    // Every file that currently owns a rule contribution. A file stops owning
    // one by being deleted, by leaving the covered set, or by failing to compile
    // - three different paths that all end in the same place here, and that a
    // list of "files that were removed" would only catch one of.
    const liveRuleOwners = new Set();
    for (const file of closure.covered.keys()) {
      if (file === designSystemPath) continue;
      const fileState = state.fileStates.get(file);
      if (fileState?.contribution == null) continue;
      liveRuleOwners.add(file);
    }

    return {
      allRules,
      // What the CSS aggregation actually consumed, for the report. Kept as a
      // number so the report is not recomputed from the rule array at publish
      // time, and so a Phase B reader can see the contribution total that the
      // ordered output was reduced from.
      ruleCount: allRules.length,
      designSystemRuleCount,
      designSystemRules: designSystemRulesForRevision,
      recompiledRules,
      liveRuleOwners,
      coveredFiles: [...closure.covered.keys()],
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

  /**
   * The project's stylesheet, for the revision being published.
   *
   * `session_full_publish` and `session_incremental_publish` both take the full
   * route: every per-file contribution is handed to the StyleX aggregator, which
   * re-derives the whole cascade-relevant order and serialises the whole
   * stylesheet. That is the behaviour Spike 2 measured at 28ms (c1000) and
   * 220ms (c10000), and it is what Phase A is measured against - publication
   * and CSS are changed and attributed separately, never together.
   */
  function aggregateCssFull(closureRules, cfg) {
    return phase('session_aggregate_ms', () =>
      styleXTransform.processStylexRules(closureRules, {
        useLayers: cfg.useCSSLayers,
      }),
    );
  }

  /**
   * The project's stylesheet, owned incrementally.
   *
   * `cssState` is session state, not per-revision state: it survives revisions
   * exactly as the per-file contributions do, because the question it answers -
   * "which files own which rule, and in what order do they cascade" - is a
   * question about the project, not about a revision.
   *
   * The full route is still the default and is still what the two publication
   * variants use: Phase A measured publication with CSS held constant, and
   * holding it constant is the only way that measurement means anything.
   */
  function aggregateCss(active, cfg, variant) {
    if (!usesIncrementalCss(variant)) {
      return aggregateCssFull(active.allRules, cfg);
    }
    // The state caches the aggregator's CONFIG - the comparator, the layer
    // naming, the RTL wrapping, the specificity bump. A configuration change
    // therefore invalidates the whole of it, not just its contributions, and
    // reusing it would emit a stylesheet shaped by the previous configuration.
    // A config change is already a full fallback, so the cost of starting again
    // is paid exactly when everything else is being paid for.
    const cssConfigKey = `${cfg.useCSSLayers}`;
    if (cssState == null || cssStateKey !== cssConfigKey) {
      cssState = createCssState({ useLayers: cfg.useCSSLayers });
      cssStateKey = cssConfigKey;
      cssStateLastCss = null;
    }

    // A change the session cannot reason about locally is a global CSS rebuild.
    // It is counted and NAMED, so a run that leans on it says so rather than
    // looking incremental.
    const semanticFallback = active.fallbackReason != null;
    const outcome = cssState.apply({
      fileRules: ruleContributionsOf(active),
      designSystemRules: active.designSystemRules,
      changedFiles: active.recompiledRules,
      liveOwners: active.liveRuleOwners,
      fallback: semanticFallback ? active.fallbackReason : null,
    });

    const result = cssState.serialize();
    const stats = cssState.stats();
    const report = {
      incremental: !outcome.fallback,
      fallbackReason: outcome.reason,
      ruleRecords: stats.ruleRecords,
      ownerCount: stats.ownerCount,
      groupCount: result.groupCount,
      rulesAdded: stats.rulesAdded,
      rulesRemoved: stats.rulesRemoved,
      rulesReused: orderedReusedOf(result, stats),
      refcountChanged: stats.refcountChanged,
    };
    active.cssReport = report;
    count('css_incremental_update_ms', outcome.ns / 1e6);
    count('css_order_maintenance_ms', result.orderNs / 1e6);
    count('css_final_serialize_ms', result.serializeNs / 1e6);
    count('css_bytes_written', Buffer.byteLength(result.css, 'utf8'));
    count('css_generation_reused', result.css === cssStateLastCss ? 1 : 0);
    cssStateLastCss = result.css;
    return result.css;
  }

  function orderedReusedOf(result, stats) {
    return Math.max(0, result.ruleCount - stats.rulesAdded);
  }

  /** Every covered file's rule contribution, for a full CSS rebuild. */
  function ruleContributionsOf(active) {
    const out = new Map();
    for (const file of active.coveredFiles) {
      const fileState = state.fileStates.get(file);
      if (fileState?.contribution == null) continue;
      out.set(file, fileState.contribution.rules);
    }
    return out;
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
    const variant = cfg.publishVariant;
    const incremental = publishesDelta(variant);
    const outputRelFor = (file) => {
      const rel = path.relative(sourceBase, file);
      const safe = rel.startsWith('..') ? path.basename(file) : rel;
      return path.posix.join('js', safe.split(path.sep).join('/'));
    };

    // One staging call for the whole generation, and the place where "did this
    // artifact change?" is decided.
    //
    //   full   every artifact is written. That is the Spike 2 reference.
    //   delta  an artifact whose content digest equals the one the previous
    //          generation published is REUSED - linked into the new generation
    //          without writing a byte - and only a new or changed one is
    //          written. An artifact the previous generation published and this
    //          one does not claim is removed, which is what makes a deleted
    //          source take its output with it.
    const put = (gen, rel, content, meta) =>
      incremental
        ? gen.stageArtifact(rel, content, meta)
        : gen.stage(rel, content, meta);

    let committed = null;

    const result = withGeneration(
      absOut,
      (gen) => {
        const designSystem = state.designSystem;
        const registryDigest = designSystem.registry.registryDigest;
        const nextGenerationId = state.generationId + 1;

        put(gen, cfg.designSystemFile, state.designSystemSource, {
          owner: 'design-system',
          kind: 'metadata',
        });

        const css = aggregateCss(active, cfg, variant);
        count('css_bytes_written', Buffer.byteLength(css, 'utf8'));

        const buildReport = {
          documentKind: 'pandamstyle-build-report',
          contractVersion: designSystem.manifest.compilerContractVersion,
          systemId: designSystem.registry.systemId,
          registryDigest,
          coveredRoots: cfg.roots,
          coveredFileCount: active.coverage.length,
          analysedFileCount: active.analysed.length,
          designSystemRuleCount: active.designSystemRuleCount,
          consumerRuleCount: active.ruleCount - active.designSystemRuleCount,
          ruleCount: active.ruleCount,
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
            generationId: nextGenerationId,
            publishVariant: variant,
            projectSemanticEpoch: state.semanticEpoch,
            incrementalAnalysisMs: active.incrementalMs / 1e6,
            ...active.counters,
            // What the stylesheet cost, and whether it was re-derived or
            // updated. Present only for the variant that owns CSS state; the
            // other two report the same generation without it.
            ...(active.cssReport == null ? {} : { css: active.cssReport }),
          },
        };

        const manifestWithDigest = {
          ...designSystem.manifest,
          registryDigest,
          designSystemModule: relativeToCwd(state.generatedModulePath),
        };

        for (const { file, code, codeDigest, codeBytes } of active.outputs) {
          put(gen, outputRelFor(file), code, {
            // The owner is the source file that produced this output. It is
            // what lets a removed or renamed source take exactly its own
            // artifact with it, and nothing else.
            owner: relativeToCwd(file),
            kind: 'js',
            digest: codeDigest,
            size: codeBytes,
          });
        }
        put(gen, 'styles.css', css, { owner: 'styles', kind: 'css' });
        put(
          gen,
          'build-report.json',
          JSON.stringify(buildReport, null, 2) + '\n',
          {
            owner: 'metadata',
            kind: 'metadata',
          },
        );
        put(
          gen,
          'manifest.json',
          JSON.stringify(manifestWithDigest, null, 2) + '\n',
          {
            owner: 'metadata',
            kind: 'metadata',
          },
        );

        // Everything the caller needs to describe WHAT was published, collected
        // before the commit so a failure cannot lose it.
        const publication = {
          mode: incremental ? 'delta' : 'full',
          variant,
          outputs: active.outputs.map(({ file }) => outputRelFor(file)),
          published: [
            ...active.outputs.map(({ file }) => outputRelFor(file)),
            'styles.css',
            'build-report.json',
            'manifest.json',
            cfg.designSystemFile,
          ],
          css,
          manifest: manifestWithDigest,
          buildReport,
          coverage: active.coverage,
          registryDigest,
          revisionId: active.revisionId,
          nextGenerationId,
        };
        // `withGeneration` commits after this returns, so the delta is picked up
        // from the transaction rather than reconstructed here.
        gen.onCommitted = (outcome) => {
          committed = outcome;
        };
        return publication;
      },
      {
        commitMarker: 'manifest.json',
        mode: incremental ? 'delta' : 'full',
        generationId: state.generationId + 1,
        revisionId: active.revisionId,
        failAt: cfg.publishFailAt ?? null,
      },
    );

    // A generation can be REUSED: when every record is byte-identical to the one
    // already published, the current generation already is that content and is
    // left in place. A revision is not a generation - a revision can be
    // recorded without forcing new published bytes to exist.
    const generationReused = committed?.generationReused === true;
    if (!generationReused) {
      state.generationId += 1;
    }
    active.published = true;
    state.published = {
      revisionId: active.revisionId,
      generationId: state.generationId,
      registryDigest: result.registryDigest,
    };

    const delta = committed?.delta ?? {
      added: 0,
      changed: 0,
      reused: 0,
      removed: 0,
      bytesWritten: 0,
      bytesReused: 0,
      bytesDeleted: 0,
      byKind: {},
    };
    const publication = {
      ...result,
      generationId: state.generationId,
      generationReused,
      publication: {
        mode: result.mode,
        variant,
        outputsAdded: delta.added,
        outputsChanged: delta.changed,
        outputsReused: delta.reused,
        outputsRemoved: delta.removed,
        bytesWritten: delta.bytesWritten,
        bytesReused: delta.bytesReused,
        bytesDeleted: delta.bytesDeleted,
        hardlinks: delta.hardlinks,
        copies: delta.copies,
        byKind: delta.byKind,
        removed: committed?.removed ?? [],
      },
      incremental: active.counters,
    };
    active.publication = publication.publication;
    state.lastPublication = publication.publication;
    return publication;
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

    /**
     * An AI agent's mutation transaction, and the reason this method exists.
     *
     * The ordinary `applyChanges` asks the FILESYSTEM what changed. This one
     * asks the CALLER, because the caller is the party that just performed the
     * write and is therefore authoritative about WHICH paths moved - and which
     * is the only fact a 10,000-file project was being made to rediscover.
     *
     * One call is ONE revision boundary, however many files it names: an agent
     * that extracts a component across seven files gets one revision, not seven.
     *
     * The transaction narrows WHERE the session looks. It never supplies WHAT
     * is at those paths: every declared path is read and content-hashed, mtime
     * is never consulted, and a caller that lies about which paths changed is
     * violating a documented contract rather than bypassing a check.
     *
     * See `dirty-input.js` for the trust model and the incomplete-set contract.
     */
    applyAgentChanges(mutation) {
      // Reaching for THIS method is itself a provenance claim. A caller that
      // wants the session to go and look has `applyChanges`, and its default is
      // `full-discovery`; a caller that comes here is saying it performed the
      // write and knows the path. It may still pass an explicit `mode`, and
      // `mode: 'full-discovery'` here is honoured - so the method is a route,
      // not a promise.
      const transaction = normalizeMutationTransaction({
        ...mutation,
        mode: mutation?.mode ?? 'verified-explicit',
      });
      state.dirtyInputMode = transaction.mode;
      return applyChanges({ mutation: transaction });
    },

    /**
     * Audits the caller's mutation set against the filesystem.
     *
     * The incomplete-set contract says a `verified-explicit` transaction cannot
     * be checked for completeness without the walk it exists to avoid. This is
     * that walk, on demand, and it answers the question an integration needs to
     * be able to ask: "were you right?" A host that wants a standing check sets
     * `auditInterval` and gets this called for it.
     */
    verifyMutationSet() {
      const mode = state.dirtyInputMode;
      const before = new Set(state.fileStates.keys());
      const applied = state.lastMutation;
      const discrepancies = [];

      // The filesystem's own answer, computed without disturbing the session.
      //
      // PandamStyle's OWN OUTPUT is excluded, by ownership rather than by string
      // matching: the generated design-system module lives under the output
      // directory, and the output directory is the compiler's, not the
      // project's. Counting it as a source that "disappeared" would report a
      // discrepancy on every revision of a correct session - and, worse, would
      // invite a host to "fix" it by declaring the compiler's own output as a
      // source mutation, which is exactly the feedback loop this rule prevents.
      const outDir = path.resolve(state.config.outDir);
      const onDisk = new Set();
      for (const root of state.config.roots) {
        const abs = path.resolve(root);
        const stat = statOrNull(abs);
        if (stat == null) continue;
        if (stat.isFile()) {
          onDisk.add(abs);
          continue;
        }
        for (const f of walkFiles(abs)) {
          if (isUnderDir(f, outDir) || f.startsWith(outDir + path.sep))
            continue;
          onDisk.add(f);
        }
      }
      for (const file of before) {
        if (isUnderDir(file, outDir) || file.startsWith(outDir + path.sep))
          continue;
      }

      if (applied == null) {
        return {
          mode,
          audited: true,
          discrepancies,
          declared: 0,
          note: 'no declared transaction; nothing to check against',
        };
      }
      const declared = touchedPaths(applied);
      count('mutation_set_audits', 1);
      for (const file of onDisk) {
        if (before.has(file)) continue;
        if (declared.has(path.resolve(file))) continue;
        discrepancies.push({
          file: relativeToCwd(file),
          kind: 'undeclared-new',
        });
      }
      for (const file of before) {
        if (isUnderDir(file, outDir) || file.startsWith(outDir + path.sep))
          continue;
        if (onDisk.has(file)) continue;
        if (declared.has(path.resolve(file))) continue;
        discrepancies.push({
          file: relativeToCwd(file),
          kind: 'undeclared-removed',
        });
      }
      count('mutation_set_discrepancies', discrepancies.length);
      return {
        mode,
        audited: true,
        discrepancies,
        declared: declared.size,
      };
    },

    /** The provenance mode this session is currently accepting input from. */
    dirtyInput() {
      return {
        mode: state.dirtyInputMode,
        lastTransaction: state.lastMutation,
      };
    },

    /**
     * What the LAST publication actually did.
     *
     * The counters describe work performed - artifacts written, reused,
     * removed, and the bytes behind them - so a caller can see that a
     * one-file edit did not rewrite a project. They are read from the
     * transaction's own outcome, not recomputed here.
     */
    lastPublication() {
      return state.lastPublication ?? null;
    },

    /**
     * The incremental CSS state, for the variant that owns it.
     *
     * Exposed so ownership, rule counts and refcounts can be asserted directly
     * rather than inferred from which rules happened to survive into the
     * stylesheet, and so a long session can be shown not to grow without bound.
     * `null` for the variants that aggregate CSS in full, which have no such
     * state to report.
     */
    cssState() {
      if (cssState == null) return null;
      return {
        stats: cssState.stats(),
        ownership: cssState.ownership(),
        orderedClassNames: cssState.orderedClassNames(),
      };
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
