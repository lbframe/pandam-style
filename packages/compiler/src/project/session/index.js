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
 * This is the private session owner called by the public Project Service.
 * `buildProject` is retained separately as a fresh semantic oracle; it is not a
 * production project authority or host-facing session.
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
 * design-system view changed - which is propagated along relay chains - or when
 * one of its semantic units changes a file-visible compiler input. A definition
 * value edit can update CSS/runtime artifacts without invalidating sources whose
 * emitted references remain unchanged. Full fallback remains for inputs without
 * a precise dependency representation. Everything else keeps its previous
 * contribution. CSS ownership applies design-system rule deltas and changed file
 * contributions, then serializes the complete stylesheet artifact.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { processStylexRules } from '../../engine/index';
import { createCssState } from '../css-state/index';
import {
  DEFAULT_DIRTY_INPUT_MODE,
  existenceChangedPaths,
  normalizeMutationTransaction,
  touchedPaths,
} from '../mutations/transaction';
import { createFilesystemWatcher } from '../../hosts/watcher/index';
import { buildDesignSystem } from '../../design-system/registry/build-system';
import { PATTERN_CATALOG } from '../../design-system/patterns/compile';
import { isTokenRef, tokenRefPath } from '../../design-system/tokens/ref';
import { generateDesignSystemModule } from '../../artifacts/javascript/design-module';
import {
  designDeclarationCacheKey,
  generateDesignSystemDeclarations,
} from '../../artifacts/types/design-declarations';
import { toRecipeSpec, toThemeRef } from '../../artifacts/javascript/refs';
import {
  createArtifactSet,
  designDeclarationFile,
  withDesignSystemCssIdentity,
} from '../../artifacts/metadata/artifact-set';
import {
  candidateDomainOf,
  repairDomainOf,
} from '../../design-system/registry/snapshot';
import { PmsError, Codes, diagnostic } from '../../protocol/diagnostics';
import {
  BUILD_REPORT_KIND,
  BUILD_REPORT_SCHEMA_VERSION,
  COVERAGE_REPORT_FILE,
  DEFAULT_AFFECTED_ENTRY_LIMIT,
  auditBlock,
  buildAgentResult,
  buildCoverageReport,
  coverageReference,
  coverageSummary,
  generationBlock,
  incrementalBlock,
  machineDiagnostic,
  mutationBlock,
} from '../../protocol/diagnostics-result';
import {
  assertCoverageConsistency,
  commonBase,
  coverageGapDiagnostics,
  relativeToCwd,
  walkFiles,
} from './fresh';
import { compileFile } from '../../frontend/babel/compile-file';
import { cssSourceMap } from '../../artifacts/css/source-map';
import {
  clearModuleCache,
  clearModuleOverlay,
  createModuleGraphContext,
  moduleSummaryOfCode,
  relayAnswerKey,
  registerServiceOwnedGeneratedArtifact,
  resolveDesignSystemModule,
  runWithModuleGraphContext,
  setModuleOverlay,
  setRelayAnswerStore,
  SOURCE_EXTENSIONS,
} from '../graph/resolution';
import {
  coverageGraphStats,
  createCoverageGraph,
  refreshCoverageClosure,
  verifyCoverageGraph,
} from '../graph/coverage';
import { withGeneration } from '../../artifacts/publication/transaction';
import {
  count,
  perfCollector,
  perfNow,
  phase,
  recordParse,
} from '../../observability/metrics';

const CONTRACT_VERSION = 'pms-0.1';

/**
 * Config fields that change what a compiled file DEPENDS ON, not merely how the
 * output is shaped. A change to any of them is a counted full fallback.
 */
const SEMANTIC_CONFIG_KEYS = [
  'designSystemFile',
  'engineOptions',
  'useCSSLayers',
];

function sameArray(a, b) {
  if (a == null || b == null) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

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
        isTokenRef(value)
          ? `token-ref:${tokenRefPath(value)}`
          : typeof value === 'function'
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
    rootDir: path.resolve(input.rootDir ?? process.cwd()),
    rootDirBoundary: input.rootDirBoundary ?? input.rootDir != null,
    roots: (input.roots ?? []).map((r) => path.resolve(r)),
    outDir: path.resolve(input.outDir ?? '.pandamstyle'),
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
    // Spike 4, Phase C. Where the project-wide coverage snapshot goes.
    //
    //   'reference'  the default. `build-report.json` carries the coverage
    //                COUNTS and a reference; the detail document is produced
    //                only when something asks for it. This is the agent hot
    //                path.
    //   'inline'     the pre-Phase-C artifact: the whole per-file array in
    //                `build-report.json`, schema version 1, no reference, no
    //                separate document. Kept as a POLICY rather than deleted,
    //                for two reasons. A host that has a reader written against
    //                version 1 keeps working instead of breaking at a
    //                dependency bump; and the spike can measure the two
    //                policies against each other on ONE compiler, which
    //                attributes the difference to the metadata policy rather
    //                than to a different tree.
    //
    // It is a config field and not a semantic one: the generation's CONTENT is
    // the same either way, and it does not bump the semantic epoch, so switching
    // it does not invalidate a single compiled file.
    auditPolicy: resolveAuditPolicy(input.auditPolicy),
  };
}

/** The metadata policies, and what each one is allowed to do. */
const AUDIT_POLICIES = Object.freeze(['reference', 'inline']);

function resolveAuditPolicy(name) {
  if (name == null) return 'reference';
  if (typeof name === 'string' && AUDIT_POLICIES.includes(name)) return name;
  throw new Error(
    `pandamstyle: unknown auditPolicy ${JSON.stringify(name)}; expected one of ${AUDIT_POLICIES.join(', ')}.`,
  );
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
  const graphContext = createModuleGraphContext();
  let cssMapCache = null;
  function sourceMapForCss(css) {
    if (cssMapCache?.revisionId === state.revisionId && cssMapCache.css === css)
      return cssMapCache.map;
    const map = cssSourceMap(
      css,
      [...(state.covered?.covered?.keys() ?? [])].map(
        (file) => state.fileStates.get(file)?.contribution,
      ),
    );
    cssMapCache = { revisionId: state.revisionId, css, map };
    return map;
  }
  const initialGenerationId = Number.isSafeInteger(config?.initialGenerationId)
    ? config.initialGenerationId
    : 0;
  const state = {
    revisionId: 0,
    generationId: initialGenerationId,
    // `projectSemanticEpoch` is part of every file's validity key. It changes
    // only for compiler inputs whose effects cannot be represented by the
    // session's semantic-unit dependency edges.
    semanticEpoch: 1,
    config: normalizeConfig(config),
    designSystem: null,
    designSystemSource: null,
    designDeclarationsFile: null,
    designDeclarationsSource: null,
    generatedModulePath: null,
    overlay: new Map(),
    // Source text explicitly supplied by a host is scoped to this Project
    // Service session and participates in the ordinary source hash, graph and
    // compiler path. A filesystem mutation for the same path clears it unless
    // the transaction supplies a replacement overlay.
    hostSourceOverlays: new Map(),
    fileStates: new Map(),
    // module path -> the files whose design-system view TRAVERSES it. This is
    // the relay-chain index: a file is a member of every module its walk
    // descended through, and losing the last one is how a file stops being a
    // consumer of a relay.
    dsConsumers: new Map(),
    // module path -> the files whose design-system view IMPORTS it, whether or
    // not the walk currently reaches the design system through it.
    //
    // The chain index above is not enough on its own, and the case that proves
    // it is a relay that is DELETED and then RESTORED. On deletion the
    // consumer's chain empties, so it withdraws from the chain index - which is
    // correct - and on restoration the relay is indexed as nothing's consumer,
    // so no propagation reaches it either. The consumer is holding a view that
    // says "no design system behind this request", and nothing would ever look
    // at it again.
    //
    // Indexing the IMPORT keeps the edge alive independently of what the walk
    // concluded, which is what a dependency index is for. It is deliberately
    // the broader relation: a file that imports a relay is examined when that
    // relay changes, and the memo - not the index - decides whether anything is
    // actually re-derived.
    dsImportConsumers: new Map(),
    // Spike 4, Phase D1. The persistent coverage graph: nodes, forward and
    // reverse local edges, root membership, coverage state and origin, the
    // unresolved / external / relay records, and a graph revision. It replaces a
    // per-revision project-wide closure walk, and it is the session's own state -
    // see `coverage-graph.js` for the reachability and ordering models and for
    // the one place its correctness is argued.
    coverageGraph: createCoverageGraph(),
    // Spike 4, Phase D2. The design-system-view state, kept across revisions.
    //
    //   designSystemEpoch   diagnostic/publication generation counter. It is
    //                       not a file validity key: definition values and
    //                       helper binding views have separate dependencies.
    //   moduleVersions      file -> how many times its BYTES changed. This is
    //                       the unit the memo keys of consumers are expressed
    //                       in: one `Map` lookup per module on a relay chain,
    //                       instead of a walk of the chain.
    //   relayAnswers        (first hop, specifier, relay depth) -> the walk's
    //                       answer plus the content versions it was produced
    //                       from. One walk per distinct hop rather than one per
    //                       consumer, which at c10000 is the difference between
    //                       re-parsing a ten-thousand-token generated module
    //                       once and ten thousand times.
    //   relayEntriesByFirstHop   the reverse index that makes forgetting one
    //                       O(1), so the cache is proportional to the CURRENT
    //                       import structure.
    dsv: {
      designSystemEpoch: 0,
      moduleVersions: new Map(),
      relayAnswers: new Map(),
      relayEntriesByFirstHop: new Map(),
      // The one semantic dependency index owned by the project session.
      // Per-file edges are recorded by the normal compiler transform; these
      // maps only index those authoritative dependencies and their current
      // fingerprints for selective invalidation.
      semanticConsumers: new Map(),
      semanticUnitFingerprints: new Map(),
      fileInputFingerprints: new Map(),
      fullFallback: false,
      fullFallbackReason: null,
    },
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
    designDeclarationsKey: null,
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

  /**
   * The files this revision READ and found changed.
   *
   * Derived from the revision's own scan rather than from its dirty set,
   * because a scan records what was actually read - which under
   * `verified-explicit` is exactly the declared set, and is nothing at all when
   * only the design system changed. That is what makes the coverage graph's work
   * proportional to what moved.
   */
  function filesNeedingExamination(active) {
    const out = new Set();
    for (const entry of active.scan.values()) {
      if (entry.changed === true) out.add(entry.file);
    }
    return out;
  }

  // The design-system-view state, named once because five functions below read
  // it and `state.dsv` five times is five chances to read the wrong object.
  const dsv = state.dsv;

  function refreshModuleOverlay() {
    const overlay = new Map(state.hostSourceOverlays);
    if (state.generatedModulePath != null && state.designSystemSource != null) {
      overlay.set(state.generatedModulePath, state.designSystemSource);
    }
    state.overlay = overlay;
    setModuleOverlay(overlay);
    if (state.generatedModulePath != null && state.designSystemSource != null) {
      registerServiceOwnedGeneratedArtifact(
        state.generatedModulePath,
        state.designSystemSource,
      );
    }
  }

  /**
   * The canonical semantic nodes and file-visible compiler inputs for one
   * design-system revision. The two maps answer different questions: semantic
   * nodes include value changes consumed by generated CSS/types, while file
   * inputs include only values that can change a source transform or its
   * diagnostics. Both are owned by this session and keyed by semantic unit.
   */
  function designSystemSemanticStateOf(designSystem) {
    const semanticUnits = new Map();
    const fileInputs = new Map();
    const registry = designSystem.registry;
    const systemId = registry.systemId;
    const set = (map, key, value) => map.set(key, digestOf(value));

    set(semanticUnits, 'runtime-identity', systemId);
    set(fileInputs, 'runtime-identity', systemId);

    for (const [tokenId, token] of Object.entries(registry.tokens)) {
      set(semanticUnits, `token:${tokenId}`, {
        token,
        resolvedValue: registry.resolvedValues[tokenId],
      });
      // A source transform emits a variable reference and validates category,
      // visibility, and existence. The token's current CSS value is owned by
      // the design-system stylesheet and does not change that emitted source.
      set(fileInputs, `token:${tokenId}`, {
        category: token.category,
        visibility: token.visibility,
        variable: designSystem.varsByToken[tokenId] ?? null,
      });
    }

    const themeNames = Object.keys(designSystem.themes);
    for (const themeName of themeNames) {
      const ref = toThemeRef(
        themeName,
        designSystem.themes[themeName],
        systemId,
        designSystem.themes,
      );
      set(semanticUnits, `theme:${themeName}`, {
        definition: registry.themes[themeName] ?? null,
        parent: registry.themeParents[themeName] ?? null,
        overrides: registry.themeOverrides[themeName] ?? null,
        resolved: designSystem.themes[themeName],
      });
      // toThemeRef accounts for cross-theme slot counts as well as the selected
      // theme's own class. An unrelated theme invalidates this consumer only if
      // it actually changes the ref emitted for this theme.
      set(fileInputs, `theme:${themeName}`, ref);
    }

    for (const [recipeId, definition] of Object.entries(registry.recipes)) {
      const recipe = designSystem.recipes[recipeId];
      const spec = toRecipeSpec(recipe, systemId);
      set(semanticUnits, `recipe:${recipeId}`, {
        definition: {
          visibility: definition.visibility,
          axisOrder: definition.axisOrder,
          variantMap: definition.variantMap,
          defaultVariants: definition.defaultVariants,
          slotOrder: definition.slotOrder,
        },
        spec,
      });
      set(fileInputs, `recipe:${recipeId}`, {
        visibility: definition.visibility,
        spec,
      });
    }

    for (const [patternId, pattern] of Object.entries(PATTERN_CATALOG)) {
      set(semanticUnits, `pattern:${patternId}`, pattern);
      set(fileInputs, `pattern:${patternId}`, { pattern, systemId });
    }

    const conditions = {
      definitions: registry.conditions,
      order: registry.conditionOrder,
    };
    set(semanticUnits, 'conditions', conditions);
    set(fileInputs, 'conditions', conditions);

    return { semanticUnits, fileInputs };
  }

  function changedMapKeys(previous, next) {
    const changed = new Set();
    for (const key of new Set([...previous.keys(), ...next.keys()])) {
      if (previous.get(key) !== next.get(key)) changed.add(key);
    }
    return changed;
  }

  function designSystemBindingMarker(marker) {
    if (marker == null) return null;
    return {
      abiVersion: marker.abiVersion ?? null,
      compilerContractVersion: marker.compilerContractVersion ?? null,
      manifestSchemaVersion: marker.manifestSchemaVersion ?? null,
      capabilities: marker.capabilities ?? null,
      hasDesignSystemIdentity: marker.designSystem != null,
    };
  }

  function relayFragmentOf(info) {
    return (
      `${info.modulePath}|${info.relayPath ?? ''}|` +
      `${stableJson(designSystemBindingMarker(info.marker))}|` +
      `${(info.exports ?? []).join(',')}|` +
      `${stableJson(info.exportsOfRelay ?? null)}|` +
      `${stableJson(info.issues ?? [])}`
    );
  }

  // ------------------------------------------------------------ design ------

  function rebuildDesignSystem() {
    const cfg = state.config;
    const outDirAbs = path.resolve(cfg.outDir);
    const generatedModulePath = path.join(outDirAbs, cfg.designSystemFile);
    // Keep the generation counter for reports and output ownership. A
    // definition edit does not by itself change helper binding views; file
    // output dependencies are represented by semantic units below.
    state.dsv.designSystemEpoch += 1;

    const designSystem = phase('boundary_ms', () =>
      buildDesignSystem(cfg.definition, { ...cfg.engineOptions }),
    );
    const designSystemSource = phase('ds_module_codegen_ms', () =>
      generateDesignSystemModule({ designSystem }),
    );
    const declarationsFile = designDeclarationFile(cfg.designSystemFile);
    const declarationsKey = designDeclarationCacheKey(designSystem.snapshot);
    let declarationsSource = state.designDeclarationsSource;
    if (
      declarationsSource == null ||
      state.designDeclarationsKey !== declarationsKey
    ) {
      declarationsSource = phase('ds_types_codegen_ms', () =>
        generateDesignSystemDeclarations(designSystem.snapshot),
      );
      state.designDeclarationsKey = declarationsKey;
      bump('generated_types_regenerated');
    } else {
      bump('generated_types_reused');
    }

    const semanticState = designSystemSemanticStateOf(designSystem);
    const changedSemanticUnits = changedMapKeys(
      state.dsv.semanticUnitFingerprints,
      semanticState.semanticUnits,
    );
    const changedFileInputs = changedMapKeys(
      state.dsv.fileInputFingerprints,
      semanticState.fileInputs,
    );
    state.dsv.semanticUnitFingerprints = semanticState.semanticUnits;
    state.dsv.fileInputFingerprints = semanticState.fileInputs;
    if (changedSemanticUnits.size > 0)
      bump('semantic_entities_changed', changedSemanticUnits.size);
    if (changedFileInputs.size > 0)
      bump('semantic_units_changed', changedFileInputs.size);
    if (state.active != null) {
      state.active.changedSemanticUnits = changedSemanticUnits;
      state.active.changedFileInputs = changedFileInputs;
    }

    // The generated module must be RESOLVABLE while the pages are compiled and
    // must NOT be on disk yet: that is the whole of the transactional
    // publication guarantee. The overlay serves it, exactly as the full build
    // does. See module-graph.js and generation.js.
    state.designSystem = designSystem;
    state.designSystemSource = designSystemSource;
    state.designDeclarationsFile = declarationsFile;
    state.designDeclarationsSource = declarationsSource;
    state.generatedModulePath = generatedModulePath;
    refreshModuleOverlay();
    return { changedSemanticUnits, changedFileInputs };
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

  // The cached answer to "which files are under this root" moved into the
  // coverage graph at Phase D (`state.coverageGraph.rootFiles`), because it is
  // the graph's root membership on disk rather than a fact about the session: a
  // file that appeared or disappeared re-reads one directory and every other
  // root's list is reused verbatim, and the graph's reachability model is stated
  // in terms of exactly that list.

  // candidate absolute path -> the resolution keys whose answer depends on
  // whether that path EXISTS. This is the reverse of the forward index the
  // resolver keeps, and it is what makes "a file appeared" observable without
  // re-probing every key the session has ever formed. See `probeResolution`.
  const resolutionCandidates = new Map();

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

  function isWithinProjectRoot(parent, target) {
    const relative = path.relative(parent, target);
    return (
      relative === '' ||
      (relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative))
    );
  }

  function realPathWithinProjectRoot(target) {
    if (!state.config.rootDirBoundary) return true;
    try {
      const realRoot = fs.realpathSync.native(state.config.rootDir);
      const realTarget = fs.realpathSync.native(target);
      return isWithinProjectRoot(realRoot, realTarget);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
      return false;
    }
  }

  function openProjectSource(realRoot, realFile) {
    if (process.platform !== 'linux') {
      return fs.openSync(
        realFile,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
    }

    const relative = path.relative(realRoot, realFile);
    if (
      relative === '' ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return null;
    }
    const parts = relative.split(path.sep);
    const directoryFlags =
      fs.constants.O_RDONLY |
      fs.constants.O_DIRECTORY |
      fs.constants.O_NOFOLLOW;
    const fileFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
    const directoryDescriptors = [];
    try {
      let parent = fs.openSync(realRoot, directoryFlags);
      directoryDescriptors.push(parent);
      for (const part of parts.slice(0, -1)) {
        parent = fs.openSync(`/proc/self/fd/${parent}/${part}`, directoryFlags);
        directoryDescriptors.push(parent);
      }
      return fs.openSync(
        `/proc/self/fd/${parent}/${parts[parts.length - 1]}`,
        fileFlags,
      );
    } finally {
      for (const directoryFd of directoryDescriptors.reverse()) {
        try {
          fs.closeSync(directoryFd);
        } catch {
          // Closing a directory descriptor does not affect the opened source.
        }
      }
    }
  }

  function readProjectSource(file) {
    if (!state.config.rootDirBoundary) {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    }

    let fd;
    try {
      const realRoot = fs.realpathSync.native(state.config.rootDir);
      const realFile = fs.realpathSync.native(file);
      if (!isWithinProjectRoot(realRoot, realFile)) return null;

      // Read from the resolved in-root path. Linux opens each component from
      // a held directory descriptor; other platforms use O_NOFOLLOW for the
      // final component where supported, then verify the opened file identity.
      fd = openProjectSource(realRoot, realFile);
      if (fd == null) return null;
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile()) return null;

      if (process.platform === 'linux') {
        const descriptorPath = fs.realpathSync.native(`/proc/self/fd/${fd}`);
        if (!isWithinProjectRoot(realRoot, descriptorPath)) return null;
      } else {
        const currentRealFile = fs.realpathSync.native(file);
        if (!isWithinProjectRoot(realRoot, currentRealFile)) return null;
        const current = fs.statSync(currentRealFile, { bigint: true });
        if (opened.dev !== current.dev || opened.ino !== current.ino)
          return null;
      }
      return fs.readFileSync(fd, 'utf8');
    } catch {
      return null;
    } finally {
      if (fd != null) {
        try {
          fs.closeSync(fd);
        } catch {
          // Preserve the read result; close errors do not change file identity.
        }
      }
    }
  }

  function isSafeResolutionCandidate(candidate) {
    if (
      candidate === state.generatedModulePath &&
      state.overlay.has(candidate)
    ) {
      return true;
    }
    if (
      state.config.rootDirBoundary &&
      !isWithinProjectRoot(state.config.rootDir, candidate)
    ) {
      return false;
    }
    if (realPathWithinProjectRoot(path.dirname(candidate)) === false) {
      return false;
    }
    if (state.overlay.has(candidate)) return true;
    return realPathWithinProjectRoot(candidate) === true;
  }

  function probeResolution(fromFile, request) {
    const base = path.resolve(path.dirname(fromFile), request);
    for (const candidate of candidatesOf(base)) {
      const generatedOverlay =
        candidate === state.generatedModulePath && state.overlay.has(candidate);
      if (
        !generatedOverlay &&
        state.config.rootDirBoundary &&
        !isWithinProjectRoot(state.config.rootDir, candidate)
      ) {
        // Keep looking because a compiler-owned generated module can be an
        // extension or index candidate in an output directory outside rootDir.
        // No filesystem lookup is made for this out-of-root candidate.
        continue;
      }

      // Do not enumerate an outside directory reached through a symlinked
      // parent. The logical import and its physical target must both stay
      // within the project boundary.
      if (!generatedOverlay) {
        const parentWithinRoot = realPathWithinProjectRoot(
          path.dirname(candidate),
        );
        if (parentWithinRoot === false) return null;
      }

      if (state.overlay.has(candidate)) {
        return isSafeResolutionCandidate(candidate) ? candidate : null;
      }
      if (listingOf(path.dirname(candidate)).has(path.basename(candidate))) {
        return isSafeResolutionCandidate(candidate) ? candidate : null;
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
  function indexResolutionKey(key, entry) {
    unindexResolutionKey(key);
    const base = path.resolve(path.dirname(entry.fromFile), entry.request);
    for (const candidate of candidatesOf(base)) {
      let set = resolutionCandidates.get(candidate);
      if (set === undefined) {
        set = new Set();
        resolutionCandidates.set(candidate, set);
      }
      set.add(key);
    }
    entry.candidatesIndexed = true;
  }

  function unindexResolutionKey(key) {
    const entry = resolutionKeys.get(key);
    if (entry == null || entry.candidatesIndexed !== true) return;
    const base = path.resolve(path.dirname(entry.fromFile), entry.request);
    for (const candidate of candidatesOf(base)) {
      const set = resolutionCandidates.get(candidate);
      if (set === undefined) continue;
      set.delete(key);
      if (set.size === 0) resolutionCandidates.delete(candidate);
    }
    entry.candidatesIndexed = false;
  }

  /**
   * WHICH resolution keys this revision has to re-probe.
   *
   * `null` means all of them, and that is the only answer that can be correct
   * without knowing the complete mutation set. An explicit or watched mutation
   * knows which paths moved, so it knows which resolution keys could possibly have
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
    const scope = affectedResolutionKeys(
      existenceChangedPaths(active.mutation),
    );
    count('resolution_keys_scoped', scope.size);
    return scope;
  }

  /** The resolution keys a declared existence change could have retargeted. */
  function affectedResolutionKeys(paths) {
    const keys = new Set();
    for (const file of paths) {
      const set = resolutionCandidates.get(file);
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
    if (known !== undefined) {
      // Resolution strings are cached, but symlink targets can change without
      // changing the candidate path. Recheck the physical target before the
      // cached answer can re-enter the coverage graph.
      if (
        known.resolved != null &&
        !isSafeResolutionCandidate(known.resolved)
      ) {
        known.resolved = phase('session_resolve_ms', () =>
          probeResolution(fromFile, request),
        );
      }
      return known.resolved;
    }
    const resolved = phase('session_resolve_ms', () =>
      probeResolution(fromFile, request),
    );
    const entry = { fromFile, request, resolved, candidatesIndexed: false };
    resolutionKeys.set(key, entry);
    // Positive resolution also depends on candidate existence/order. Keep the
    // existing candidate index for every answer, so a new earlier candidate or
    // a removed winner re-derives the forwarding source.
    indexResolutionKey(key, entry);
    if (resolved === null) {
      bump('negative_resolutions');
      // It is already indexed, so appearance of the target can repair it.
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
      // A removed winner is a resolution change just like a negative answer
      // becoming positive. Keep the answer aligned with the current revision
      // so the coverage graph can retire the stale edge and report the missing
      // request at its importer. Unreadable stubs are retained only while a
      // current edge still names them.
      if (before !== after) {
        repaired.push(entry.fromFile);
        if (before === null) count('negative_resolution_keys_rechecked', 1);
      }
      entry.resolved = after;
      if (entry.candidatesIndexed !== true) indexResolutionKey(key, entry);
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
        validityInputs: null,
        contribution: null,
        semanticUnits: [],
        // The coverage record of the last revision in which this file FAILED to
        // compile. Kept beside the contribution rather than inside it, because
        // a failure REPLACES the contribution with null and an agent repairing
        // the failure needs the record of what failed, not of what it used to
        // contribute. Cleared as soon as the file compiles cleanly.
        failureCoverage: null,
        compiledRevision: null,
        origin: null,
      };
      state.fileStates.set(file, fileState);
    }
    return fileState;
  }

  function unregisterSemanticUnits(file, units) {
    for (const unit of units ?? []) {
      const consumers = dsv.semanticConsumers.get(unit);
      if (consumers == null) continue;
      consumers.delete(file);
      if (consumers.size === 0) dsv.semanticConsumers.delete(unit);
    }
  }

  function registerSemanticUnits(file, units) {
    for (const unit of units) {
      let consumers = dsv.semanticConsumers.get(unit);
      if (consumers == null) {
        consumers = new Set();
        dsv.semanticConsumers.set(unit, consumers);
      }
      consumers.add(file);
    }
  }

  function replaceSemanticUnits(fileState, units) {
    const previous = fileState.semanticUnits ?? [];
    if (sameArray(previous, units)) return;
    unregisterSemanticUnits(fileState.file, previous);
    fileState.semanticUnits = units;
    registerSemanticUnits(fileState.file, units);
  }

  function invalidateSemanticConsumers(changedUnits) {
    const active = state.active;
    const affected = new Set();
    for (const unit of changedUnits ?? []) {
      for (const file of dsv.semanticConsumers.get(unit) ?? []) {
        if (!state.fileStates.has(file)) continue;
        active.invalid.add(file);
        affected.add(file);
      }
    }
    if (affected.size > 0)
      bump('semantic_dependency_files_invalidated', affected.size);
    active.semanticDependencyFilesInvalidated = affected.size;
    return affected;
  }

  function unregisterChain(file, chain) {
    for (const module of chain) {
      const set = state.dsConsumers.get(module);
      if (set == null) continue;
      set.delete(file);
      if (set.size === 0) state.dsConsumers.delete(module);
    }
  }

  function unregisterImportHops(file, hops) {
    for (const module of hops ?? []) {
      const set = state.dsImportConsumers.get(module);
      if (set == null) continue;
      set.delete(file);
      if (set.size === 0) state.dsImportConsumers.delete(module);
    }
  }

  /** The modules this file's import declarations resolve to. */
  function importHopsOf(file, fileState) {
    const hops = [];
    for (const source of fileState.importSources ?? []) {
      const firstHop = resolveLocal(file, source);
      if (firstHop == null) continue;
      if (hops.includes(firstHop)) continue;
      hops.push(firstHop);
    }
    return hops;
  }

  function registerImportHops(file, hops) {
    for (const module of hops) {
      let set = state.dsImportConsumers.get(module);
      if (set == null) {
        set = new Set();
        state.dsImportConsumers.set(module, set);
      }
      set.add(file);
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
    if (
      (state.config.rootDirBoundary &&
        !isWithinProjectRoot(state.config.rootDir, file)) ||
      realPathWithinProjectRoot(file) === false
    ) {
      return { text: null, ok: false };
    }
    if (state.hostSourceOverlays.has(file)) {
      return { text: state.hostSourceOverlays.get(file), ok: true };
    }
    const text = readProjectSource(file);
    return { text, ok: text != null };
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
   *
   * Phase D wraps this in two caches, and the shape of both follows from ONE
   * observation about what the answer is a function of:
   *
   *   resolveDesignSystemModule(fromFile, request, {maxDepth})
   *     is a function of module CONTENTS and downstream resolution inputs.
   *     Both are versioned dependencies. It resolves its first hop from `fromFile` and then walks
   *     downward from there, so every file that imports the same module by the
   *     same specifier gets the SAME answer.
   *
   * Hence the relay cache: one walk per distinct first hop, keyed by the first
   * hop and validated against all consulted module/candidate versions. Ten thousand pages
   * reaching the design system through one barrel pay for one walk, not ten
   * thousand - and at c10000 the generated module is a ten-thousand-token AST, so
   * that walk is the single most expensive thing on the design-system path.
   *
   * And hence the per-file memo: a file's view can only change if its own import
   * declarations changed, if a module on its chain changed, if the generated
   * design system changed, or if `maxRelayDepth` changed. A style-only edit
   * changes none of them, so the revision recomputes NOTHING.
   */
  function computeDsView(file, importSources, ctx) {
    const parts = [];
    const chain = [];
    const seen = new Set();
    for (const source of importSources) {
      const entry = ctx.resolveRelay(file, source);
      // All consulted inputs, including negative answers and resolution
      // candidates, participate in reverse invalidation.
      for (const module of entry?.versions.keys() ?? []) {
        if (seen.has(module)) continue;
        seen.add(module);
        chain.push(module);
      }
      if (entry == null || entry.info == null) {
        parts.push(`${source}=>null`);
        continue;
      }
      const info = entry.info;
      parts.push(`${source}=>${entry.fragment}`);
      for (const module of info.chain ?? []) {
        if (seen.has(module)) continue;
        seen.add(module);
        chain.push(module);
      }
    }
    return { digest: sha256(parts.join('\n')), chain };
  }

  /**
   * THE MEMO KEY.
   *
   * Two halves, and they are two halves because one of them is about the file
   * and the other is about the answer the file already has.
   *
   * `dsViewInputsKey` is everything the file itself contributes: the
   * relay depth, and each static import source together
   * with what that source resolves to FROM THIS FILE. Two files with the same
   * one of these walk the same path through the same design system.
   *
   * `dsViewChainIntact` is the other half, and it cannot be a key at all: it is
   * a question about the chain the PREVIOUS walk visited, and the previous walk
   * is the thing that is being validated. It compares a version number per
   * module on a chain that is two or three modules long - one `Map` lookup each,
   * not a traversal of anything.
   *
   * Together they have the property the whole optimisation rests on: if both
   * hold, the import declarations and every relay module are unchanged, and the
   * binding contract and depth are unchanged - so the walk is deterministic and
   * produces the same answer. That
   * is the whole licence to skip it.
   *
   * An earlier shape of this folded the chain into one hash. It was wrong in a
   * way only the second revision could show: the first revision has no chain to
   * hash, so its stored key described a walk that had not happened, and every
   * file recomputed exactly once more before the memo ever hit.
   */
  function dsViewInputsKey(fileState, ctx) {
    const parts = [`#depth${ctx.maxRelayDepth}`];
    for (const source of fileState.importSources ?? []) {
      const firstHop = ctx.relayFirstHop(fileState.file, source);
      // The CONTENT VERSION OF THE FIRST HOP IS PART OF THIS FILE'S INPUTS, and
      // leaving it out is a defect this shape had once.
      //
      // The chain versions cover the modules a walk descended through. A walk
      // that reached NOTHING has no chain, so nothing about it is versioned -
      // and the one case where that matters is a relay that is deleted and then
      // comes back. On deletion the consumer's chain empties and its reverse
      // index entry is withdrawn, because the consumer no longer traverses the
      // relay; on restoration the relay is no longer indexed as anything's
      // consumer, so no propagation reaches the file either. Its own inputs have
      // not changed on paper - same specifier, same first hop - and the view it
      // holds ("no design system behind this request") would have survived the
      // relay reappearing underneath it.
      //
      // Versioning the first hop closes that: the relay's bytes changed on the
      // way out and again on the way back, so the key moved both times, and the
      // view was re-derived both times.
      parts.push(
        `#src${source}\u0000${firstHop ?? ''}\u0000${
          firstHop == null ? '' : ctx.moduleVersion(firstHop)
        }`,
      );
    }
    return parts.join('\n');
  }

  function dsViewChainIntact(view, ctx) {
    const versions = view?.versions;
    if (versions == null) return false;
    for (const [module, version] of versions) {
      if (ctx.moduleVersion(module) !== version) return false;
    }
    return true;
  }

  /**
   * The design-system-view state the refresh reads and writes.
   *
   * The relay answers themselves live behind `relayStore`, which the module
   * graph also reads: this is the one place that knows when an answer went
   * stale.
   */
  function dsvContext(store) {
    const maxRelayDepth = state.config.engineOptions?.maxRelayDepth;
    const ctx = {
      maxRelayDepth,
      relayFirstHop: (file, source) => resolveLocal(file, source),
      moduleVersion: (file) => dsv.moduleVersions.get(file) ?? 0,
      // What the views derived during THIS compute were derived from. Kept on
      // the context rather than returned by the walk, because a view is a
      // function of every relay its own imports reach - the ones that resolved
      // to nothing included.
      consumedVersions: new Map(),
      resetConsumed: () => {
        ctx.consumedVersions.clear();
      },
      resolveRelay: (file, source) => {
        const key = relayAnswerKey(file, source, maxRelayDepth);
        const cached = store.get(key);
        if (cached !== undefined) {
          bump('dsv_relay_hits', 1);
          for (const [module, version] of cached.versions) {
            ctx.consumedVersions.set(module, version);
          }
          return cached;
        }
        bump('dsv_relay_walks', 1);
        // The walk is performed by the module graph and RECORDED by the store
        // on the way out, so the transform's own call for the same relay - made
        // a few lines later, while compiling the file this view belongs to -
        // is answered from the same place instead of being paid for twice.
        resolveDesignSystemModule(file, source, { maxDepth: maxRelayDepth });
        const walked = store.get(key);
        // Every module that walk read is an input of the view being computed,
        // and the store already holds the version each was seen at.
        if (walked !== undefined) {
          for (const [module, version] of walked.versions) {
            ctx.consumedVersions.set(module, version);
          }
        }
        return walked;
      },
    };
    return ctx;
  }

  /**
   * The relay answer table, and the fragment derived from each answer.
   *
   * `get` is where the invalidation lives. An entry is usable exactly when every
   * module its walk visited still has the content version the walk saw; one
   * moved version retires the entry, and the next `resolveDesignSystemModule`
   * re-walks. `set` records the versions alongside the answer, so the test is a
   * comparison and not a re-derivation.
   *
   * `relayEntriesByFirstHop` is the reverse index that makes forgetting one O(1),
   * which is what keeps the table proportional to the CURRENT import structure
   * rather than to every specifier the session has ever seen.
   */
  function relayStore() {
    return {
      get(key) {
        const entry = dsv.relayAnswers.get(key);
        if (entry === undefined) return undefined;
        for (const [module, version] of entry.versions) {
          if ((dsv.moduleVersions.get(module) ?? 0) !== version) {
            dsv.relayAnswers.delete(key);
            dsv.relayEntriesByFirstHop.get(entry.firstHop)?.delete(key);
            return undefined;
          }
        }
        return entry;
      },
      set(key, firstHop, info, consulted) {
        // Everything the walk READ, which is a superset of the chain it
        // returned. Versioning the chain alone is a defect this shape had once:
        // a relay that stops reaching the design system yields `null`, and
        // `null` has no chain, so the answer stayed valid across the revision
        // that broke the relay and the revision that repaired it.
        const versions = new Map();
        for (const module of consulted ?? info?.chain ?? []) {
          versions.set(module, dsv.moduleVersions.get(module) ?? 0);
        }
        const entry = {
          firstHop,
          versions,
          info,
          fragment: info == null ? null : relayFragmentOf(info),
        };
        dsv.relayAnswers.set(key, entry);
        if (firstHop != null) {
          let set = dsv.relayEntriesByFirstHop.get(firstHop);
          if (set == null) {
            set = new Set();
            dsv.relayEntriesByFirstHop.set(firstHop, set);
          }
          set.add(key);
        }
        return entry;
      },
    };
  }

  /** Forgets the design-system view of a file and every relay entry it used. */
  function dropRelayAnswersFor(file) {
    const keys = dsv.relayEntriesByFirstHop.get(file);
    if (keys == null) return;
    dsv.relayEntriesByFirstHop.delete(file);
    for (const key of keys) dsv.relayAnswers.delete(key);
  }

  /**
   * Propagates a changed design-system view to the files that consume it.
   *
   * The propagation runs along the RELAY CHAIN, not over the whole reverse
   * graph, and Phase D does not change that: a file's view can only change if
   * the file itself changed or if a module on its chain changed, and every other
   * reverse edge - a page importing a sibling, a barrel importing a leaf that is
   * not a design-system relay - has no bearing on whether this file's bindings
   * are recognized.
   *
   * What Phase D changes is what happens when the worklist reaches a file. It
   * used to recompute the view unconditionally. Now the file is a CANDIDATE, and
   * the memo decides: a file whose import declarations, relay chain, design
   * system and relay depth are all unchanged keeps the view it has, and
   * `dsv_files_recomputed` counts the ones that did not. A style-only edit names
   * one file, and that file's memo key is unchanged, so the revision recomputes
   * nothing at all.
   *
   * `coveredSet` is the session's own covered MAP rather than an array copy of
   * its keys, because building a thousand-element - or ten thousand-element -
   * Set on every revision to ask a membership question is exactly the kind of
   * project-sized work this pass is being taken apart for.
   */
  function refreshDesignSystemViews(covered, store) {
    const started = perfNow();
    const active = state.active;
    const ctx = dsvContext(store);
    const worklist = [];
    for (const file of active.dirty) {
      if (covered.has(file)) worklist.push(file);
    }
    for (const file of active.repairedResolutions ?? []) {
      if (covered.has(file)) worklist.push(file);
    }
    // Removed modules cannot be visited as covered work items. Their previous
    // consulted consumers still need to retire positive AND negative answers.
    for (const file of active.removedFiles) {
      for (const consumer of [
        ...(state.dsConsumers.get(file) ?? []),
        ...(state.dsImportConsumers.get(file) ?? []),
      ]) {
        if (covered.has(consumer)) worklist.push(consumer);
      }
    }
    // Coverage membership and DSV validity are separate facts. A full graph
    // rebuild reports every materialized node as entering coverage, even when
    // the same file was covered before; using that delta here turns a semantic
    // edit into a project-sized view scan. Newly covered and restored files
    // have no DSV, so validate() places them in `active.dirty` before reaching
    // this function. Changed files, repaired resolutions, and relay consumers
    // are likewise seeded directly above. Keep this worklist tied to those
    // semantic causes rather than to the closure's rebuild mechanics.
    const visited = new Set();

    // A file's content version is what the memo keys of its consumers are
    // expressed in, so it moves for every file this revision could have changed
    // and for nothing else. A file that was declared and found byte-identical
    // does not move its version, because it did not change - and that is the
    // difference between an agent that over-declares costing nothing here and
    // costing a project-wide re-derivation.
    for (const file of active.dirty) {
      if (!dsvContentChanged(file)) continue;
      dsv.moduleVersions.set(file, (dsv.moduleVersions.get(file) ?? 0) + 1);
    }
    for (const file of active.removedFiles) {
      dsv.moduleVersions.set(file, (dsv.moduleVersions.get(file) ?? 0) + 1);
      dropRelayAnswersFor(file);
    }

    let examined = 0;
    let recomputed = 0;
    let reused = 0;
    let consumersInvalidated = 0;

    while (worklist.length > 0) {
      const file = worklist.pop();
      if (visited.has(file)) continue;
      visited.add(file);
      const fileState = ensureFileState(file);
      examined += 1;
      const consumersBefore = state.dsConsumers.get(file);
      const previous = fileState.dsView;
      const key = dsViewInputsKey(fileState, ctx);

      if (
        previous != null &&
        previous.key === key &&
        dsViewChainIntact(previous, ctx)
      ) {
        reused += 1;
      } else {
        ctx.resetConsumed();
        const next = phase('session_dsv_view_ms', () =>
          computeDsView(file, fileState.importSources ?? [], ctx),
        );
        next.key = key;
        // The versions the new derivation was observed at - every module a
        // relay walk read, not only the ones on the chain it found - so the next
        // revision can ask whether any of them moved without walking anything.
        next.versions = new Map(ctx.consumedVersions);
        for (const module of next.chain) {
          next.versions.set(module, ctx.moduleVersion(module));
        }
        // The import index is maintained here, where the file's import
        // declarations were last known to be current, and nowhere else: a file
        // whose view is REUSED provably did not change its imports, because
        // `dsViewInputsKey` is a function of them.
        if (previous == null || !sameArray(previous.hops, next.hops)) {
          unregisterImportHops(file, previous?.hops);
          next.hops = importHopsOf(file, fileState);
          registerImportHops(file, next.hops);
        } else {
          next.hops = previous.hops;
        }
        const changed = previous == null || previous.digest !== next.digest;
        if (
          previous != null &&
          (previous.chain.length !== next.chain.length ||
            previous.chain.some((m, i) => m !== next.chain[i]))
        ) {
          unregisterChain(file, previous.chain);
        }
        fileState.dsView = next;
        registerChain(file, next.chain);
        recomputed += 1;
        if (changed) {
          active.invalid.add(file);
          // A view that changed on a file that was NOT itself dirty is, by
          // construction, a change reached through a relay. That is the only
          // mechanism by which a reverse dependent is invalidated, and it is
          // counted as such.
          if (previous != null) {
            bump('reverse_dependents_invalidated');
            consumersInvalidated += 1;
          }
        }
      }

      // Generated design-system bytes carry current token/recipe/theme data,
      // but their helper export and binding surface is fixed by this compiler
      // contract. Semantic consumers are invalidated through semantic-unit
      // edges, so walking every importing file from this node would recreate
      // the former global-view fan-out.
      if (file === state.generatedModulePath) continue;

      // The relay CHAIN, and the import index. Both, and neither alone: see
      // `dsImportConsumers` for the deleted-and-restored relay that the chain
      // index alone cannot reach.
      for (const consumer of [
        ...(consumersBefore ?? []),
        ...(state.dsImportConsumers.get(file) ?? []),
      ]) {
        if (consumer === file) continue;
        if (!covered.has(consumer)) continue;
        if (visited.has(consumer)) continue;
        worklist.push(consumer);
      }
    }

    bump('dsv_files_examined', examined);
    bump('dsv_files_recomputed', recomputed);
    bump('dsv_files_reused', reused);
    bump('dsv_consumers_invalidated', consumersInvalidated);
    bump('dsv_relay_nodes_touched', dsv.relayAnswers.size);
    if (dsv.fullFallback) {
      bump('dsv_full_fallback', 1);
      count(`dsv_full_fallback_reason_${dsv.fullFallbackReason}`, 1);
    }
    count('dsv_update_ms', (perfNow() - started) / 1e6);
  }

  /**
   * Whether this revision changed a file's BYTES.
   *
   * Content, never mtime and never the declaration: an agent that reformatted a
   * file without changing it must cost nothing here, and saying so is how a host
   * finds out it is over-declaring.
   */
  function dsvContentChanged(file) {
    // The generated module's bytes carry token/theme/recipe data, but its
    // compile-time helper binding surface is fixed by this compiler contract.
    // A definition-only rebuild therefore does not move the version consumed
    // by design-system views. Semantic file dependencies below decide which
    // source transforms need new inputs; the normal validity check remains the
    // final guard before a cached transform is reused.
    if (
      file === state.generatedModulePath &&
      state.active.designSystemDefinitionChanged === true &&
      state.active.fallbackReason == null
    ) {
      return false;
    }
    const entry = state.active.scan.get(file);
    if (entry !== undefined) return entry.changed === true;
    return false;
  }

  /**
   * The FULL audit of the incremental design-system views.
   *
   * Recomputes every covered file's view from scratch - no memo, no relay cache,
   * no reuse of anything the refresh produced - and compares the digests, the
   * chains and the recognized design-system module. It is deliberately not on
   * the hot path: an agent revision must never need it, and this is the function
   * a test is allowed to call because it is slow.
   */
  function verifyDesignSystemViews() {
    const covered = state.covered?.covered;
    if (covered == null || state.active == null) {
      throw new Error(
        'pandamstyle: verifyDesignSystemViews() audits the CURRENT revision, ' +
          'so a revision has to exist. Call applyChanges() first.',
      );
    }
    const differences = [];
    const maxRelayDepth = state.config.engineOptions?.maxRelayDepth;
    // The module-graph parse cache is dropped first, and it has to be.
    //
    // `resolveDesignSystemModule` reads an AST through the module-graph's parse
    // cache, and `compileFile` runs a Babel transform over the SAME cached AST
    // for the same module. An audit that ran after the analysis would therefore
    // re-read a tree a transform may already have rewritten - which is precisely
    // the hazard the module summary was introduced to avoid, and the reason the
    // audit cannot be a second call into whatever the hot path already holds.
    clearModuleCache();
    for (const file of covered.keys()) {
      const fileState = state.fileStates.get(file);
      if (fileState == null) continue;
      const parts = [];
      const chain = [];
      const seen = new Set();
      for (const source of fileState.importSources ?? []) {
        const consulted = new Set();
        const info = resolveDesignSystemModule(file, source, {
          maxDepth: maxRelayDepth,
          consulted,
        });
        for (const module of consulted) {
          if (seen.has(module)) continue;
          seen.add(module);
          chain.push(module);
        }
        if (info == null) {
          parts.push(`${source}=>null`);
          continue;
        }
        parts.push(`${source}=>${relayFragmentOf(info)}`);
        for (const module of info.chain ?? []) {
          if (seen.has(module)) continue;
          seen.add(module);
          chain.push(module);
        }
      }
      const expected = sha256(parts.join('\n'));
      const actual = fileState.dsView?.digest ?? null;
      if (actual !== expected) {
        differences.push({
          file,
          kind: 'digest',
          incremental: actual,
          fresh: expected,
        });
      }
      const expectedChain = chain.join('\u0000');
      const actualChain = (fileState.dsView?.chain ?? []).join('\u0000');
      if (expectedChain !== actualChain) {
        differences.push({
          file,
          kind: 'chain',
          incremental: actualChain,
          fresh: expectedChain,
        });
      }
    }
    return { ok: differences.length === 0, differences };
  }

  // ------------------------------------------------------------ coverage ----

  /**
   * THE CONTEXT THE COVERAGE GRAPH READS THE SESSION THROUGH.
   *
   * The graph owns the coverage state; the session owns the things the graph has
   * to ask about - the filesystem, the resolution cache, the per-file summary
   * cache, and the revision's own classification of what changed. Handing those
   * over as a plain object keeps the graph free of any assumption about how a
   * revision is prepared, which is what lets it be audited by a test with its
   * own context.
   */
  function coverageContext(active) {
    return {
      roots: state.config.roots,
      resolve: (p) => path.resolve(p),
      statOrNull,
      walkFiles,
      rootOwning,
      rootDelta: active.rootDelta ?? null,
      dirty: active.dirty,
      // The files whose BYTES this revision read and found changed, plus the
      // ones whose edge resolutions were re-probed. A file's module edges can
      // only move if one of those is true, so this - and not `dirty`, which a
      // global fallback makes every covered file - is the set the coverage graph
      // examines. See `examineRevision`.
      needsExamination: filesNeedingExamination(active),
      removedFiles: active.removedFiles,
      repairedResolutions: active.repairedResolutions ?? [],
      dirtyInputMode: () => active.dirtyInputMode ?? 'full-discovery',
      fullDiscoveryReason: () => active.fullDiscoveryReason ?? null,
      closureFallbackReason: () =>
        active.fallbackReason === 'roots' ||
        active.fallbackReason === 'output-directory'
          ? active.fallbackReason
          : null,
      summaryFor,
      ensureFileState,
      resolveLocal,
      invalidate: (file) => {
        active.invalid.add(file);
      },
      /**
       * Whether the file is GONE, as a fact about the filesystem rather than
       * about the declaration.
       *
       * The declaration is not the authority here, and using it as one would be
       * a way to make a session agree with a caller who lies. A file declared
       * removed that is still on disk is still covered; a file that is not there
       * is gone whatever anybody said.
       */
      gone: (file) => {
        const entry = active.scan.get(file);
        if (entry !== undefined) return entry.readable !== true;
        return scanEntryFor(file).readable !== true;
      },
      bump,
      rootMissing: (abs) =>
        new PmsError([
          diagnostic({
            code: Codes.COVERAGE_GAP,
            phase: 'coverage',
            message: `Declared root does not exist: ${abs}`,
            rule: 'coverage.roots',
            context: { root: abs },
          }),
        ]),
    };
  }

  /**
   * The covered set, from the PERSISTENT COVERAGE GRAPH.
   *
   * What this replaced, and why: the closure used to be rebuilt from the roots
   * over every covered file and every edge on every revision. At c10000 a
   * one-file agent edit spent 103.7ms of its 175.9ms diagnostics interval in
   * here - 59% - walking ten thousand modules in order to discover that their
   * edges had not moved, and the same pass is 33% of the interval at c1000, so
   * the cost grew with the project rather than with the edit.
   *
   * What it does now: a style-only edit produces an empty graph delta and the
   * PREVIOUS closure object is returned untouched, having visited no node. A
   * structural edit updates the affected region and re-derives the canonical
   * order from owned data with no read, no parse and no resolution probe. See
   * `coverage-graph.js` for the reachability model, the ordering model and the
   * named fallbacks, and for why the order is not traded away for speed.
   */
  function refreshClosure(active) {
    const graph = state.coverageGraph;
    const outcome = phase('session_closure_ms', () =>
      refreshCoverageClosure(graph, coverageContext(active)),
    );
    const delta = outcome.delta;
    bump('closure_nodes_examined', outcome.nodesExamined);
    bump('closure_nodes_reused', outcome.nodesReused);
    bump('closure_nodes_added', outcome.nodesAdded);
    bump('closure_nodes_removed', outcome.nodesRemoved);
    bump('closure_nodes_entering_coverage', outcome.nodesEnteringCoverage);
    bump('closure_nodes_leaving_coverage', outcome.nodesLeavingCoverage);
    bump('closure_edges_recomputed', outcome.edgesRecomputed);
    bump('closure_reachability_updates', outcome.reachabilityUpdates);
    bump('closure_nodes_pruned', delta.nodesPruned);
    bump('closure_graph_revision', 1);
    if (outcome.fullWalk) bump('closure_full_walk', 1);
    if (outcome.fullFallback) {
      bump('closure_full_fallback', 1);
      count(`closure_full_fallback_reason_${outcome.fullFallbackReason}`, 1);
    }
    if (delta.setDivergence > 0)
      bump('closure_set_divergence', delta.setDivergence);
    if (delta.propagationAborted) bump('closure_propagation_aborted', 1);
    count('closure_update_ms', outcome.elapsedMs);
    active.closureDelta = delta;
    return outcome.closure;
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
      // ---------------------------------------------------------------
      // The four completion points, as monotonic nanosecond stamps taken
      // against a single clock (perfNow), so every reported interval is a
      // difference of two real readings rather than a difference of two
      // wall-clock timestamps that could disagree.
      //
      // They are STAMPS, not durations, and they stay null until the thing
      // they describe has actually happened. A failed revision reaches
      // `diagnosticsReady` and stops: reporting a generation time for a
      // revision that refused to publish would be inventing work.
      //
      // `transactionAcceptedNs` is the zero the primary KPI is measured from.
      // It is taken inside `applyChanges`, before a single byte of the
      // declared set is read, so the interval it starts contains the
      // session's own discovery, hashing, closure and compilation and not
      // the host's write.
      // ---------------------------------------------------------------
      transactionAcceptedNs: perfNow(),
      diagnosticsReadyNs: null,
      generationReadyNs: null,
      generationCommittedNs: null,
      auditReportReadyNs: null,
      // Set when the caller asked for the project-wide audit of THIS
      // revision. Requested and ready are different states and are reported
      // as two.
      auditRequested: false,
      audit: null,
      agentResult: null,
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
    let sourceOverlayChanged = false;
    const hostMutation = changes.mutation ?? null;
    for (const file of hostMutation == null ? [] : touchedPaths(hostMutation)) {
      if (state.hostSourceOverlays.delete(path.resolve(file))) {
        sourceOverlayChanged = true;
      }
    }
    for (const entry of changes.sourceOverlays ?? []) {
      const file = path.resolve(entry.file);
      if (state.hostSourceOverlays.get(file) !== entry.source) {
        state.hostSourceOverlays.set(file, entry.source);
        sourceOverlayChanged = true;
      }
    }
    if (sourceOverlayChanged) refreshModuleOverlay();

    // ---- global fallback decision, before anything is read ---------------
    let nextConfig = previousConfig;
    let fallbackReason = null;
    let definitionChanged = false;
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
    definitionChanged =
      changes.definition != null &&
      (nextDefinitionDigest == null
        ? changes.definition !== previousConfig.definition
        : nextDefinitionDigest !== state.definitionDigest);
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
    active.designSystemDefinitionChanged = definitionChanged;

    try {
      if (
        state.designSystem == null ||
        fallbackReason != null ||
        definitionChanged
      ) {
        const rebuilt = rebuildDesignSystem();
        if (definitionChanged && fallbackReason == null) {
          invalidateSemanticConsumers(rebuilt.changedFileInputs);
        }
      }
      if (fallbackReason != null) {
        // Every cached result names the previous epoch. Dropping them is not an
        // optimisation: keeping one would be a stale result published under a
        // new revision.
        // Phase D2. The design-system views and the relay cache are DERIVED from
        // the module graph AND the design system, and both have just changed, so
        // they are dropped rather than left stale. Dropping the relay cache
        // matters as much as dropping the views: it is keyed by the design-system
        // epoch, so keeping it would serve an answer derived from the previous
        // design system to a revision that no longer has one.
        state.dsv.fullFallback =
          active.fallbackReason === 'design-system-definition';
        state.dsv.fullFallbackReason = state.dsv.fullFallback
          ? 'design-system-definition'
          : (active.fallbackReason ?? null);
        state.dsv.relayAnswers.clear();
        state.dsv.relayEntriesByFirstHop.clear();
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
          unregisterImportHops(file, fileState.dsView?.hops);
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
      bump('dirty_files_declared', touchedPaths(declared).size);
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
        bump('dirty_files_read', 1);
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
        bump('dirty_files_hashed', 1);
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
          bump('dirty_files_unchanged', 1);
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
      bump('dirty_files_read', 1);
      if (entry.readable) bump('dirty_files_hashed', 1);
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
      bump('dirty_files_read', 1);
      if (!entry.readable) continue;
      if (entry.readable) bump('dirty_files_hashed', 1);
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

      // The relay answer store is installed HERE and removed again below, so it
      // exists exactly while this session is deriving views and compiling files
      // and at no other time. A full rebuild - which runs in the same process,
      // against the same module-level variable - never sees it, which is what
      // keeps a session's memory out of the reference every oracle compares it
      // against.
      const store = relayStore();
      setRelayAnswerStore(store);

      // The files whose NEGATIVE resolution was re-probed and may now be
      // positive. The coverage graph needs them by name: a request that starts
      // resolving is a graph mutation, and a graph that is not told about one
      // would keep reporting a coverage gap for an import that is now real.
      active.repairedResolutions = revalidateResolution(
        resolutionScopeFor(active),
      );
      for (const file of active.repairedResolutions) {
        void file;
        bump('negative_resolutions_invalidated');
      }

      const closure = refreshClosure(active);
      state.covered = closure;
      // The SIZE of the covered set, recorded as soon as the closure is known
      // and BEFORE the analysis can fail.
      //
      // It is recorded separately from `active.coverage` because that array is
      // only assigned when the whole analysis succeeds, and a FAILED revision
      // is precisely the case where an agent most needs to be told how big the
      // project it just edited is. Deriving it from `coverage.length` would
      // report zero for every refusal, which is a number no reader could
      // interpret.
      active.coveredCount = closure.covered.size;

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
        unregisterImportHops(file, fileState.dsView?.hops);
        unregisterSemanticUnits(file, fileState.semanticUnits ?? []);
        dropRelayAnswersFor(file);
        state.fileStates.delete(file);
        active.dirty.add(file);
        active.removedFiles.add(file);
        active.invalid.add(file);
      }

      for (const file of closure.covered.keys()) {
        const fileState = ensureFileState(file);
        // A relay restoration can reintroduce a cached graph node whose file
        // state was retired during the break. It needs a semantic view even
        // when the graph retained the node's summary.
        if (fileState.dsView == null) active.dirty.add(file);
        if (fileState.contribution == null) active.invalid.add(file);
      }
      refreshDesignSystemViews(closure.covered, store);

      if (closure.unresolved.length > 0) {
        throw new PmsError(
          closure.unresolved.map((u) =>
            u.form === 'syntax'
              ? diagnostic({
                  code: Codes.COVERAGE_GAP,
                  phase: 'coverage',
                  message: `Syntax error in covered file ${u.from}. Fix the parse error before compiling this revision.`,
                  source: {
                    file: u.from,
                    line: u.line ?? null,
                    column: u.column ?? null,
                    role: 'page',
                  },
                  rule: 'coverage.source-syntax',
                  context: {
                    from: u.from,
                    form: 'syntax',
                    line: u.line ?? null,
                    column: u.column ?? null,
                  },
                })
              : diagnostic({
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

    setRelayAnswerStore(null);
    count('files_invalidated', active.invalid.size);
    active.validated = true;
    active.incrementalMs = perfNow() - start;
    bump('session_file_states', state.fileStates.size);
    count('session_resolution_keys', resolutionKeys.size);
    count('session_resolution_dirs', dirListings.size);
    pruneResolution();
    active.counters = buildReportCounters(active);
    // The verdict for THIS revision now exists, and it is stamped before the
    // agent result is built, so `diagnosticsMs` reports the compilation and not
    // the cost of describing the compilation. The two are timed separately and
    // both are reported: a caller that only needs the verdict is not paying for
    // the object, and a caller that needs the object is not paying for the
    // compile twice.
    active.diagnosticsReadyNs = perfNow();
    active.agentResult = buildResultFor(active);
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
      unindexResolutionKey(key);
      resolutionKeys.delete(key);
    }
  }

  function analyseCoveredFiles(closure, active) {
    const cfg = state.config;
    // One content check per revision, shared by all covered file guards.
    const engineOptionsDigest = digestOf(cfg.engineOptions);
    count('validity_input_hashes');
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
    //
    // It is RELABELLED in a local copy rather than written into
    // `closure.covered`, because from Phase D that map is the coverage graph's
    // persistent state: a revision that changes nothing in the graph hands the
    // SAME map to every later revision, and a map that grew the generated module
    // into itself would report a covered-file count one higher than every
    // revision before it.
    //
    // `relabelled`, not `appended`, because the generated module CAN be an
    // ordinary covered file: a configuration whose `outDir` and
    // `designSystemFile` place it under a declared root has it in the closure
    // already, and the pre-Phase-D `Map.set` overwrote that entry's origin IN
    // PLACE rather than adding a second one. Appending unconditionally
    // therefore added a file the full build has no entry for.
    const coveredEntries = [...closure.covered];
    const generatedIndex = coveredEntries.findIndex(
      ([file]) => file === designSystemPath,
    );
    if (generatedIndex === -1) {
      coveredEntries.push([designSystemPath, 'generated']);
    } else {
      coveredEntries[generatedIndex] = [designSystemPath, 'generated'];
    }
    const coveredFileNames = coveredEntries.map(([file]) => file);

    // ---------------------------------------------------------------
    // THE O(TOTAL) LOOP, INSTRUMENTED (Spike 4, Phase C)
    //
    // This loop still visits every covered file on every revision, including
    // the 10,000 that were not touched. Phase C's question is whether that
    // iteration is material to `agent_edit_to_diagnostics_ms`, and the only
    // honest way to answer it is to time the two halves SEPARATELY:
    //
    //   affected    reading, parsing, compiling and recording the files whose
    //               bytes or resolutions changed. This is the work the agent's
    //               edit actually caused.
    //   reuse       everything the loop does for a file it is NOT recompiling:
    //               the map lookup, the rule re-append, the coverage entry,
    //               the output record. No parse, no read of the source.
    //
    // Reporting only the aggregate would make a fast revision look like it did
    // no work, and a slow one undiagnosable. The timers are gated on a
    // collector being installed, so a production session executes neither
    // `perfNow` call.
    // ---------------------------------------------------------------
    const timing = perfCollector() != null;
    let affectedNs = 0;
    let reuseNs = 0;
    let entryNs = 0;

    for (const [file, origin] of coveredEntries) {
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

      const affectedStart = timing ? perfNow() : 0;
      if (!validityMatches(fileState, cfg, engineOptionsDigest)) {
        // Reverse edges seed the affected set. The validity key is the
        // authoritative correctness check, so a missing edge can never turn
        // the index into an under-invalidation fast path.
        active.invalid.add(file);
      }
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
          if (timing) affectedNs += perfNow() - affectedStart;
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
            cfg.rootDir,
          );
        } catch (err) {
          if (err != null && Array.isArray(err.diagnostics)) {
            failures.push(...err.diagnostics);
            const failedEntry = {
              file: relativeToCwd(file),
              origin,
              role: 'page',
              analysed: true,
              failed: true,
              diagnostics: err.diagnostics.length,
              codes: [...new Set(err.diagnostics.map((d) => d.code))],
            };
            coverage.push(failedEntry);
            // The coverage record of a file that FAILED is kept even though its
            // contribution is not: it is the only place the failing file's own
            // role, origin and codes are recorded, and the agent result looks it
            // up from here to attach LOCAL context to each of its diagnostics.
            // A repair revision replaces it with a passing entry.
            fileState.failureCoverage = failedEntry;
            analysed.push(file);
            // The file's previous contribution is REMOVED, not left behind a
            // diagnostic. A repair revision must publish the repaired file, and
            // a failed revision must not leave a stale rule reachable from the
            // aggregation.
            fileState.contribution = null;
            fileState.validity = null;
            if (timing) affectedNs += perfNow() - affectedStart;
            continue;
          }
          throw err;
        }
        const rules = result.metadata.pandamstyle ?? [];
        const coverageEntry = result.metadata.pandamstyleCoverage ?? {};
        fileState.contribution = {
          code: result.code,
          sourceMap: result.sourceMap,
          ruleOrigins: result.metadata.pandamstyleRuleOrigins ?? [],
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
        fileState.failureCoverage = null;
        fileState.compiledRevision = active.revisionId;
        replaceSemanticUnits(
          fileState,
          [...(result.metadata.pandamstyleSemanticUnits ?? [])].sort(),
        );
        fileState.validity = validityKeyOf(fileState, cfg);
        fileState.validityInputs = {
          resolutions: [...fileState.edgeResolution],
          semanticUnits: [...fileState.semanticUnits],
          semanticFingerprints: fileState.semanticUnits.map(
            (unit) => dsv.fileInputFingerprints.get(unit) ?? null,
          ),
        };
        if (timing) affectedNs += perfNow() - affectedStart;
      } else {
        bump('files_reused');
        if (timing) {
          const spent = perfNow() - affectedStart;
          affectedNs += spent;
          reuseNs -= spent;
        }
      }
      const entryStart = timing ? perfNow() : 0;
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
      if (timing) {
        // The tail of the loop - re-appending rules, recording the coverage
        // entry, recording the output - is the part a REUSED file pays. It is
        // attributed to whichever side the file belongs to, because the
        // question the two numbers answer is "what does not touching this file
        // cost", and that cost is exactly this tail.
        const spent = perfNow() - entryStart;
        entryNs += spent;
        if (fileState.compiledRevision === active.revisionId)
          affectedNs += spent;
        else reuseNs += spent;
      }
    }

    if (timing) {
      count('session_compile_affected_ms', affectedNs / 1e6);
      count('session_reuse_iteration_ms', reuseNs / 1e6);
      count('session_coverage_entries_ms', entryNs / 1e6);
      bump('covered_entries_iterated', coveredEntries.length);
    }

    const consistency = assertCoverageConsistency({
      coveredFiles: coveredFileNames,
      transformedFiles: analysed,
      exemptFiles: [designSystemPath],
      phase: 'cli',
    });

    // Every file that currently owns a rule contribution. A file stops owning
    // one by being deleted, by leaving the covered set, or by failing to compile
    // - three different paths that all end in the same place here, and that a
    // list of "files that were removed" would only catch one of.
    const liveRuleOwners = new Set();
    for (const file of coveredFileNames) {
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
      coveredFiles: coveredFileNames,
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
  // Compare the exact inputs captured with the compiled result. This retains
  // the independent validity guard even if a reverse dependency edge is absent,
  // without serializing and hashing three unchanged inputs for every file.
  function validityMatches(fileState, cfg, engineOptionsDigest) {
    count('validity_checks');
    const key = fileState.validity;
    const inputs = fileState.validityInputs;
    if (
      key == null ||
      inputs == null ||
      key.sourceHash !== fileState.sourceHash ||
      key.role !== fileState.role ||
      key.compilerContractVersion !== CONTRACT_VERSION ||
      key.projectSemanticEpoch !== state.semanticEpoch ||
      key.engineOptionsDigest !== engineOptionsDigest ||
      key.useCSSLayers !== cfg.useCSSLayers ||
      key.designSystemViewDigest !== (fileState.dsView?.digest ?? null) ||
      inputs.resolutions.length !== fileState.edgeResolution.size ||
      inputs.semanticUnits.length !== (fileState.semanticUnits ?? []).length
    )
      return false;
    for (const [request, resolved] of inputs.resolutions) {
      if (
        !fileState.edgeResolution.has(request) ||
        fileState.edgeResolution.get(request) !== resolved
      )
        return false;
    }
    for (let i = 0; i < inputs.semanticUnits.length; i++) {
      const unit = inputs.semanticUnits[i];
      if (
        unit !== fileState.semanticUnits[i] ||
        inputs.semanticFingerprints[i] !==
          (dsv.fileInputFingerprints.get(unit) ?? null)
      )
        return false;
    }
    return true;
  }

  function validityKeyOf(fileState, cfg) {
    count('validity_input_hashes', 3);
    const semanticInputs = (fileState.semanticUnits ?? []).map((unit) => [
      unit,
      dsv.fileInputFingerprints.get(unit) ?? null,
    ]);
    return {
      sourceHash: fileState.sourceHash,
      role: fileState.role,
      compilerContractVersion: CONTRACT_VERSION,
      projectSemanticEpoch: state.semanticEpoch,
      engineOptionsDigest: digestOf(cfg.engineOptions),
      useCSSLayers: cfg.useCSSLayers,
      resolutionDigest: digestOf(
        [...fileState.edgeResolution.entries()].sort((a, b) =>
          a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
        ),
      ),
      designSystemViewDigest: fileState.dsView?.digest ?? null,
      semanticUnitsDigest: digestOf(semanticInputs),
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
      processStylexRules(closureRules, {
        useLayers: cfg.useCSSLayers,
        __pmsPerfPhase: phase,
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
    const outcome = cssState.apply({
      fileRules: ruleContributionsOf(active),
      designSystemRules: active.designSystemRules,
      changedFiles: active.recompiledRules,
      liveOwners: active.liveRuleOwners,
      fallback: active.fallbackReason,
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

  function compile(options = {}) {
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
    return publish(active, options);
  }

  function publish(
    active,
    {
      revisionIdentity = null,
      generationId = null,
      candidateDigest = null,
    } = {},
  ) {
    const cfg = state.config;
    const absOut = path.resolve(cfg.outDir);
    const sourceBase = commonBase(cfg.roots);
    const variant = cfg.publishVariant;
    const incremental = publishesDelta(variant);
    const targetGenerationId =
      Number.isSafeInteger(generationId) && generationId > 0
        ? generationId
        : state.generationId + 1;
    const outputRelFor = (file) => {
      count('publication_output_paths');
      const rel = path.relative(sourceBase, file);
      const safe = rel.startsWith('..') ? path.basename(file) : rel;
      return path.posix.join('js', safe.split(path.sep).join('/'));
    };

    // One staging call for the whole generation, and the place where "did this
    // artifact change?" is decided.
    //
    //   full   retain byte-verified identical outputs, with undo copies only
    //          for changed/removed members of this compiler-owned tree.
    //          The fresh-build oracle remains unconditional.
    //   delta  an artifact whose content digest equals the one the previous
    //          generation published is REUSED - linked into the new generation
    //          without writing a byte - and only a new or changed one is
    //          written. An artifact the previous generation published and this
    //          one does not claim is removed, which is what makes a deleted
    //          source take its output with it.
    const put = (gen, rel, content, meta) => {
      count('publication_candidates');
      return incremental
        ? gen.stageArtifact(rel, content, meta)
        : gen.stage(rel, content, meta);
    };

    let committed = null;

    const result = withGeneration(
      absOut,
      (gen) => {
        const designSystem = state.designSystem;
        const registryDigest = designSystem.registry.registryDigest;
        const nextGenerationId = targetGenerationId;

        put(gen, cfg.designSystemFile, state.designSystemSource, {
          owner: 'design-system',
          kind: 'metadata',
        });

        const css = withDesignSystemCssIdentity(
          aggregateCss(active, cfg, variant),
          designSystem.snapshot.identity,
        );
        count('css_bytes_written', Buffer.byteLength(css, 'utf8'));

        // The project-wide coverage snapshot is a SEPARATE document (Spike 4,
        // Phase C). At c10000 the inline array was 3,250,511 of the report's
        // 3,252,194 bytes - 99.95% - and it was being serialized and written on
        // the critical path of an agent's one-line edit.
        //
        // The `entries` array itself is NOT computed here. It is already in
        // memory as `active.coverage` (every entry was built during analysis,
        // and the CSS aggregation needs the rule contributions beside it), so
        // deferring means deferring the SERIALIZATION and the WRITE - the two
        // things that cost milliseconds and megabytes - and not the collection.
        // That distinction matters: a "lazy" report that quietly re-derives the
        // array at read time has moved the cost, not removed it, and would make
        // the hot path look smaller by making the audit path dishonest.
        // The `inline` policy does not need the counts at all - the whole array
        // is right there - so deriving them would be O(project) work for a
        // document that does not read them. Skipped rather than computed and
        // discarded: the measurement below would otherwise charge the fast
        // policy for the slow one's work.
        const coverageSummaryOfRevision =
          cfg.auditPolicy === 'inline'
            ? null
            : phase('build_report_build_ms', () =>
                coverageSummary(active.coverage),
              );

        // The four metadata costs, timed apart. Building the object,
        // serializing it, staging it and committing it are different operations
        // with different causes, and an aggregate over them cannot say which one
        // a caller should stop paying for.
        const reportBuildStart = perfNow();
        // Schema version 1 under the `inline` policy: the whole array, in the
        // report, exactly as a pre-Phase-C reader expects to find it. It is
        // built from the same `active.coverage` every other policy uses, so
        // the two policies describe the same project and differ only in where
        // the bytes are written - which is the whole of what the measurement
        // attributes.
        const buildReport =
          cfg.auditPolicy === 'inline'
            ? {
                documentKind: BUILD_REPORT_KIND,
                schemaVersion: 1,
                contractVersion: designSystem.manifest.compilerContractVersion,
                systemId: designSystem.registry.systemId,
                registryDigest,
                coveredRoots: cfg.roots,
                coveredFileCount: active.coverage.length,
                analysedFileCount: active.analysed.length,
                designSystemRuleCount: active.designSystemRuleCount,
                consumerRuleCount:
                  active.ruleCount - active.designSystemRuleCount,
                ruleCount: active.ruleCount,
                cssBytes: Buffer.byteLength(css, 'utf8'),
                coverage: active.coverage,
                coverageConsistency: coverageConsistencyOf(),
                externalRequests: externalRequestsOf(),
                relayEdges: relayEdgesOf(),
                incremental: incrementalBlockOf(),
              }
            : {
                documentKind: BUILD_REPORT_KIND,
                schemaVersion: BUILD_REPORT_SCHEMA_VERSION,
                contractVersion: designSystem.manifest.compilerContractVersion,
                systemId: designSystem.registry.systemId,
                registryDigest,
                coveredRoots: cfg.roots,
                coveredFileCount: active.coverage.length,
                analysedFileCount: active.analysed.length,
                designSystemRuleCount: active.designSystemRuleCount,
                consumerRuleCount:
                  active.ruleCount - active.designSystemRuleCount,
                ruleCount: active.ruleCount,
                cssBytes: Buffer.byteLength(css, 'utf8'),
                // Version 1 of this document carried `coverage` here: the whole
                // project-wide array. Version 2 replaces it with the counts
                // derived from that same array plus a reference to the document
                // that holds it. Nothing was dropped: `requestFullAudit()`
                // produces the detail for this revision on demand, and
                // `auditPolicy: 'inline'` reproduces version 1 exactly.
                coverageSummary: coverageSummaryOfRevision,
                coverageReport: coverageReference({
                  revisionId: active.revisionId,
                  summary: coverageSummaryOfRevision,
                  // True only when this generation is about to publish the
                  // detail document itself, because the caller asked for it
                  // before publishing. A later `requestFullAudit()` on an
                  // already-published revision writes it outside the generation
                  // and the summary keeps saying `false`, which is why the
                  // reference carries `revisionId`: that is what makes the
                  // standalone document findable.
                  materialized: active.auditRequested,
                }),
                coverageConsistency: coverageConsistencyOf(),
                externalRequests: externalRequestsOf(),
                relayEdges: relayEdgesOf(),
                // The generation describes the WHOLE current revision, reused
                // files included. This block exists so a reader can see how
                // much of it was recomputed without inferring it from a
                // timestamp, and so a partial generation can never be mistaken
                // for a complete one.
                incremental: incrementalBlockOf(),
              };
        count('build_report_build_ms', (perfNow() - reportBuildStart) / 1e6);

        // Shared by both policies. Declared as functions so the two object
        // literals above cannot drift: the `inline` document is meant to be
        // version 1 of the SAME report, and a field that appeared in one branch
        // and not the other would make it version 1 of something else.
        function coverageConsistencyOf() {
          return {
            expectedCount: active.consistency.expectedCount,
            analysedCount: active.consistency.transformedCount,
            missing: active.consistency.missing.map(relativeToCwd),
            classification:
              'a covered file that the CLI did not analyse fails the build',
          };
        }
        function externalRequestsOf() {
          return (state.covered?.external ?? []).map((e) => ({
            request: e.request,
            form: e.form,
            from: relativeToCwd(e.from),
          }));
        }
        function relayEdgesOf() {
          return (state.covered?.relayEdges ?? []).map((e) => ({
            from: relativeToCwd(e.from),
            to: relativeToCwd(e.to),
            form: e.form,
          }));
        }
        function incrementalBlockOf() {
          return {
            revisionId: active.revisionId,
            generationId: nextGenerationId,
            publishVariant: variant,
            auditPolicy: cfg.auditPolicy,
            projectSemanticEpoch: state.semanticEpoch,
            ...active.counters,
            // What the stylesheet cost, and whether it was re-derived or
            // updated. Present only for the variant that owns CSS state; the
            // other two report the same generation without it.
            ...(active.cssReport == null ? {} : { css: active.cssReport }),
          };
        }

        const manifestWithDigest = designSystem.snapshot.tooling.manifest;
        const manifestText = phase(
          'ds_manifest_codegen_ms',
          () => JSON.stringify(manifestWithDigest, null, 2) + '\n',
        );
        const artifactSet = phase('ds_artifact_set_ms', () =>
          createArtifactSet(designSystem.snapshot, {
            designModuleFile: cfg.designSystemFile,
            declarationsFile: state.designDeclarationsFile,
            designModule: state.designSystemSource,
            declarations: state.designDeclarationsSource,
            manifest: manifestText,
            css,
          }),
        );

        const outputPaths = [];
        for (const { file, code, codeDigest, codeBytes } of active.outputs) {
          const outputPath = outputRelFor(file);
          outputPaths.push(outputPath);
          put(gen, outputPath, code, {
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
        put(gen, state.designDeclarationsFile, state.designDeclarationsSource, {
          owner: 'design-system',
          kind: 'types',
        });

        // The coverage detail, when and only when the caller asked for it
        // BEFORE publishing. Requested after publication it is written outside
        // the generation instead, because a committed generation is immutable:
        // writing a file into it afterwards would mutate a generation whose
        // manifest already certified its contents, which is precisely the
        // guarantee the transactional publication exists to provide.
        if (active.auditRequested) {
          const coverageDoc = materializeCoverageReport(active, {
            contractVersion: designSystem.manifest.compilerContractVersion,
            systemId: designSystem.registry.systemId,
            registryDigest,
            generationId: nextGenerationId,
            coveredRoots: cfg.roots,
          });
          put(gen, COVERAGE_REPORT_FILE, coverageDoc.text, {
            owner: 'metadata',
            kind: 'metadata',
          });
          active.audit = {
            ...coverageDoc.receipt,
            materializedAt: 'generation',
            inGeneration: true,
          };
          // The document EXISTS from here, but it is not committed yet. The
          // milestone that says so is `generationReady` - the same window in
          // which every other artifact of this generation exists and the
          // previous one is still current - so reporting it here rather than
          // after the commit keeps the two claims consistent.
          active.auditReportReadyNs = perfNow();
        }

        const reportSerializeStart = perfNow();
        const reportText = JSON.stringify(buildReport, null, 2) + '\n';
        count(
          'build_report_serialize_ms',
          (perfNow() - reportSerializeStart) / 1e6,
        );
        count('build_report_bytes', Buffer.byteLength(reportText, 'utf8'));
        put(gen, 'build-report.json', reportText, {
          owner: 'metadata',
          kind: 'metadata',
        });
        put(gen, 'manifest.json', manifestText, {
          owner: 'metadata',
          kind: 'metadata',
        });
        put(gen, 'artifacts.json', artifactSet.text, {
          owner: 'metadata',
          kind: 'metadata',
        });
        count(
          'metadata_bytes_written',
          Buffer.byteLength(reportText, 'utf8') +
            Buffer.byteLength(
              JSON.stringify(manifestWithDigest, null, 2),
              'utf8',
            ) +
            Buffer.byteLength(artifactSet.text, 'utf8') +
            Buffer.byteLength(state.designDeclarationsSource, 'utf8') +
            Buffer.byteLength(state.designSystemSource, 'utf8'),
        );

        // Everything the caller needs to describe WHAT was published, collected
        // before the commit so a failure cannot lose it.
        const publication = {
          mode: incremental ? 'delta' : 'full',
          variant,
          outputs: outputPaths,
          published: [
            ...outputPaths,
            'styles.css',
            state.designDeclarationsFile,
            'build-report.json',
            'manifest.json',
            'artifacts.json',
            cfg.designSystemFile,
            // Only when it was actually staged above. A `published` list that
            // named an artifact nobody wrote would be a list of intentions, and
            // this one is read as a list of facts by the delta publisher and by
            // every test that checks a generation's contents.
            ...(active.auditRequested ? [COVERAGE_REPORT_FILE] : []),
          ],
          css,
          manifest: manifestWithDigest,
          buildReport,
          coverage: active.coverage,
          registryDigest,
          revisionId: active.revisionId,
          nextGenerationId,
        };
        // `generationReady`: every artifact for this revision is STAGED. The
        // output directory is untouched - the previous generation is still
        // current - and there is a real window between here and the commit in
        // which a caller reading the output directory would read the wrong
        // bytes. That window is why this is a reported milestone and not an
        // implementation detail.
        active.generationReadyNs = perfNow();
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
        skipIdentical: !incremental,
        incrementalBackup: !incremental,
        generationId: targetGenerationId,
        revisionId: active.revisionId,
        revisionIdentity,
        candidateDigest,
        failAt: cfg.publishFailAt ?? null,
      },
    );

    // `generationCommitted`: the commit marker is on disk.
    active.generationCommittedNs = perfNow();

    // A generation can be REUSED: when every record is byte-identical to the one
    // already published, the current generation already is that content and is
    // left in place. A revision is not a generation - a revision can be
    // recorded without forcing new published bytes to exist.
    const generationReused = committed?.generationReused === true;
    state.generationId = Number.isSafeInteger(committed?.generationId)
      ? committed.generationId
      : state.generationId + (generationReused ? 0 : 1);
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
      artifactRevisionIdentity:
        committed?.artifactRevisionIdentity ?? revisionIdentity,
      associationRevisionIdentity:
        committed?.associationRevisionIdentity ?? revisionIdentity,
      artifactDigest: committed?.artifactDigest ?? null,
      candidateDigest: committed?.candidateDigest ?? candidateDigest ?? null,
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
      // How many files the analysis ACTUALLY compiled, as opposed to how many
      // files own a contribution this revision replaced.
      //
      // The two differ exactly where something went wrong or went away: a file
      // that FAILED to compile was compiled and owns nothing, and a file that
      // was removed was never compiled. `filesRecompiled` counts the
      // contributions, so on a refused revision it reports 0 while the compiler
      // was demonstrably busy - and a counter that reads 0 after the compiler
      // did the work is the kind of number an agent stops trusting. Both are
      // reported, and the difference between them is itself a signal: a
      // revision whose compiled count exceeds its recompiled count failed.
      filesCompiled: read('files_recompiled'),
      filesReused: reused,
      coverageSummariesReused: read('coverage_summaries_reused'),
      coverageSummariesRebuilt: read('coverage_summaries_rebuilt'),
      reverseDependentsInvalidated: read('reverse_dependents_invalidated'),
      negativeResolutionsInvalidated: read('negative_resolutions_invalidated'),
      semanticEntitiesChanged: read('semantic_entities_changed'),
      semanticUnitsChanged: read('semantic_units_changed'),
      semanticUnitsInvalidated: read('semantic_units_changed'),
      semanticFilesInvalidated: read('semantic_dependency_files_invalidated'),
      designSystemViewsExamined: read('dsv_files_examined'),
      designSystemViewsRecomputed: read('dsv_files_recomputed'),
      designSystemViewsReused: read('dsv_files_reused'),
      generatedTypesRegenerated: read('generated_types_regenerated'),
      generatedTypesReused: read('generated_types_reused'),
      fullFallback: active.fallbackReason != null ? 1 : 0,
      fullFallbackReason: active.fallbackReason,
      newlyCoveredFiles: active.newFiles.size,
      // The covered set's size, which exists for a failed revision too. See
      // `active.coveredCount`: deriving this from the analysis result would
      // report 0 for every refusal.
      coveredFileCount: active.coverage?.length ?? active.coveredCount ?? 0,
      fileStateCount: state.fileStates.size,
      // The dirty-input accounting, kept in the revision's own tally rather
      // than read back from a collector, so the agent result can say what the
      // transaction cost even when nobody installed one. `dirtyFilesUnchanged`
      // in particular is the number that distinguishes "an edit" from "a host
      // that declared a file it did not change".
      dirtyFilesDeclared: read('dirty_files_declared'),
      dirtyFilesRead: read('dirty_files_read'),
      dirtyFilesHashed: read('dirty_files_hashed'),
      dirtyFilesUnchanged: read('dirty_files_unchanged'),
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
      // The compact machine result for THIS revision. Attached additively: the
      // fields above are unchanged, and a caller that already reads them is
      // unaffected. The timestamps live here too, because "how long ago was
      // this revision's verdict produced" is a question about the revision, not
      // about a result object a caller may or may not have asked for.
      agentResult: active.agentResult ?? null,
      milestones: milestonesOf(active),
    };
  }

  /**
   * The four completion points, as durations from the moment the mutation
   * transaction was accepted.
   *
   * Every interval here is a difference of two readings of the SAME monotonic
   * clock, taken inside this session. A null means the thing did not happen -
   * and for a FAILED revision that is not a gap in the measurement, it is the
   * result: a refused revision reaches diagnostics and stops, and reporting a
   * generation time for it would be inventing work that was correctly refused.
   */
  function milestonesOf(active) {
    const t0 = active.transactionAcceptedNs;
    const since = (mark) => (mark == null ? null : (mark - t0) / 1e6);
    return {
      // The milestone BOOLEANS and the durations are both reported because they
      // answer different questions: a caller waiting on the loop needs to know
      // which points it can wait for, and a profile needs the numbers.
      diagnosticsReady: active.diagnosticsReadyNs != null,
      generationReady: active.generationReadyNs != null,
      generationCommitted: active.generationCommittedNs != null,
      auditReportReady: active.auditReportReadyNs != null,
      agent_edit_to_diagnostics_ms: since(active.diagnosticsReadyNs),
      agent_edit_to_generation_ready_ms: since(active.generationReadyNs),
      agent_edit_to_generation_committed_ms: since(
        active.generationCommittedNs,
      ),
      agent_edit_to_audit_report_ms: since(active.auditReportReadyNs),
    };
  }

  // ------------------------------------------------------ agent result ------

  /**
   * The coverage record of a file, looked up in O(1).
   *
   * It reads the per-file STATE rather than the revision's `coverage` array,
   * and that is the whole point: building an index over 10,003 entries to
   * attach context to the two diagnostics an agent actually caused would be the
   * O(total) cost Phase C exists to keep out of the loop, reintroduced in a
   * smaller disguise. The two states - a contribution's record and a failure's
   * record - are both kept on the file, so the lookup succeeds either way.
   *
   * The key is the ABSOLUTE path and the lookup resolves the diagnostic's
   * `relativeToCwd` form back to one. `relativeToCwd` falls back to the absolute
   * path for a file outside the working directory, and `path.resolve` is the
   * identity on an absolute path, so both forms resolve correctly without the
   * lookup having to know which convention produced the string.
   */
  function coverageLookup() {
    return {
      get(file) {
        const abs = path.resolve(file);
        const fileState = state.fileStates.get(abs);
        if (fileState == null) return null;
        return (
          fileState.contribution?.coverage ?? fileState.failureCoverage ?? null
        );
      },
    };
  }

  /**
   * The coverage of the files THIS revision touched, and nothing else.
   *
   * The agent needs to know whether the file it just wrote is covered, what role
   * it has, and which relay it reaches the design system through - all of which
   * are properties of that file. `projectEntries` is a count, so a reader can
   * see that the project is large without this object being large.
   */
  function affectedCoverageOf(active) {
    const touched = new Set();
    for (const file of active.invalid) touched.add(file);
    for (const file of active.newFiles) touched.add(file);
    for (const file of active.removedFiles) touched.add(file);
    const entries = [];
    for (const file of touched) {
      const fileState = state.fileStates.get(file);
      const entry =
        fileState?.contribution?.coverage ?? fileState?.failureCoverage ?? null;
      if (entry != null) entries.push(entry);
    }
    // A file that was REMOVED has no state left to describe it, and saying so is
    // better than omitting it: an agent that deleted a file needs to know that
    // the file it deleted is no longer covered.
    for (const file of active.removedFiles) {
      if (state.fileStates.has(file)) continue;
      entries.push({
        file: relativeToCwd(file),
        origin: null,
        role: null,
        analysed: false,
        removed: true,
        diagnostics: 0,
      });
    }
    entries.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    // The cap, and what is said about it. See `DEFAULT_AFFECTED_ENTRY_LIMIT`:
    // the affected set is normally a handful of files and this never fires, but a
    // GLOBAL FALLBACK's affected set is the whole project, and a result that
    // listed it would be the project - measured at 413,988 bytes at c1000,
    // which throws away the entire saving on the one revision where an agent
    // most needs a small answer. The remainder is in the coverage document and
    // `affectedTruncated` is how a caller knows there is one.
    const inlineEntries = entries.slice(0, DEFAULT_AFFECTED_ENTRY_LIMIT);
    return {
      // "Did this revision change WHAT the project covers?" - the question an
      // agent asks before it trusts its edit. It is about the covered SET
      // (files that appeared or disappeared), not about the bytes inside files,
      // and the name says so: an edit to an existing file does not change what
      // is covered, and reporting otherwise would teach a host to distrust the
      // flag.
      coveredSetChanged:
        active.newFiles.size > 0 || active.removedFiles.size > 0,
      affectedCount: entries.length,
      affectedEntryLimit: DEFAULT_AFFECTED_ENTRY_LIMIT,
      affectedTruncated: entries.length > inlineEntries.length,
      // The size of the project, as a NUMBER. Not as a list. This is the line
      // where a report that grew with the project would give itself away. It is
      // populated for a FAILED revision too, which is when an agent is most
      // likely to want to know it.
      projectEntries: active.coveredCount ?? active.coverage?.length ?? 0,
      affectedEntries: inlineEntries,
    };
  }

  /**
   * Builds the compact, revision-bound result for the active revision.
   *
   * `build_ms` and `serialize_ms` are separate because they have different
   * causes and different owners. The object is built when the verdict exists,
   * because that is the point at which an agent can act. The bytes are produced
   * on demand, because producing them is transport: a host that hands the
   * object to a function does not need a string, and a host that writes it to a
   * file does. Eagerly serializing here would put a cost on the caller who does
   * not want it, and measuring a serialization the compiler performed for its
   * own reasons would report a number nothing in the loop ever paid.
   */
  function buildResultFor(active, options = {}) {
    const buildStart = perfNow();
    const counters = active.counters ?? buildReportCounters(active);
    const coverageByFile = coverageLookup();
    const result = buildAgentResult({
      revisionId: active.revisionId,
      ok: active.ok,
      projectSemanticEpoch: state.semanticEpoch,
      diagnostics: active.diagnostics.map((d) =>
        machineDiagnostic(d, {
          coverageByFile,
          candidateLimit: options.candidateLimit,
        }),
      ),
      mutation: mutationBlock({
        mode:
          active.mutation?.mode ?? active.dirtyInputMode ?? 'full-discovery',
        transaction: active.mutation,
        counters,
      }),
      incremental: incrementalBlock({
        counters,
        mode:
          active.mutation?.mode ?? active.dirtyInputMode ?? 'full-discovery',
        // A revision ran the full walk rather than trusting a declared set, and
        // the agent should be able to see that its latency was paid for a
        // reason. `fullDiscovery` and `fullFallback` are different questions: one
        // is about WHERE the mutation set came from, the other about whether the
        // session had to discard its per-file results.
        fullDiscovery:
          active.mutation == null ||
          active.mutation.mode === 'full-discovery' ||
          active.fullDiscoveryReason != null,
        fullFallbackReason: active.fallbackReason,
      }),
      coverage: affectedCoverageOf(active),
      generation: generationBlock({
        published: active.published,
        // Null until there is a generation to name. A validated-but-unpublished
        // revision is a real state - it is exactly the state the invalid hot
        // path is always in - and giving it a generation id would be claiming
        // output on disk that does not exist.
        generationId: active.published ? state.generationId : null,
        generationReused: active.publication?.generationReused === true,
        mode: active.publication?.mode ?? null,
        outputsWritten:
          (active.publication?.outputsAdded ?? 0) +
          (active.publication?.outputsChanged ?? 0),
        outputsReused: active.publication?.outputsReused ?? 0,
        bytesWritten: active.publication?.bytesWritten ?? 0,
      }),
      audit: auditBlock({
        requested: active.auditRequested,
        ready: active.audit != null,
        document: active.audit?.path ?? null,
        bytes: active.audit?.bytes ?? null,
        reason: active.auditRequested
          ? null
          : 'not requested; project-wide coverage is available on demand',
      }),
      timings: milestoneTimings(active),
    });
    count('agent_result_build_ms', (perfNow() - buildStart) / 1e6);
    return result;
  }

  /**
   * The timings block.
   *
   * A SNAPSHOT, and the docstring says so rather than implying a live view. The
   * result object is built once, when the verdict exists, so its `generation`
   * block and its generation timestamps are the ones that were true at that
   * moment. A caller that needs the state after `compile()` or after
   * `requestFullAudit()` calls `session.agentResult()` again, which rebuilds
   * from the revision's own stamps.
   *
   * A live view was the alternative and it was rejected for a reason worth
   * writing down: an object whose fields change under a caller that has already
   * read them is harder to reason about than a snapshot the caller knows to
   * refresh, and the refresh is one method call.
   */
  function milestoneTimings(active) {
    return {
      ...milestonesOf(active),
      incrementalAnalysisMs:
        active.incrementalMs == null ? null : active.incrementalMs / 1e6,
    };
  }

  // ------------------------------------------------------------ full audit ----

  /**
   * Builds the project-wide coverage document for a revision.
   *
   * `active.coverage` is the array the analysis already produced this revision.
   * This is therefore a SERIALIZATION, not a re-derivation: the entries are the
   * same objects, in the same order, that version 1 of the build report carried
   * inline, and the audit oracle compares them directly rather than through a
   * semantic translation.
   */
  function materializeCoverageReport(
    active,
    { contractVersion, systemId, registryDigest, generationId, coveredRoots },
  ) {
    const buildStart = perfNow();
    const doc = buildCoverageReport({
      contractVersion,
      systemId,
      registryDigest,
      revisionId: active.revisionId,
      generationId:
        generationId ?? (active.published ? state.generationId : null),
      coveredRoots,
      entries: active.coverage,
    });
    count('coverage_report_build_ms', (perfNow() - buildStart) / 1e6);

    const serializeStart = perfNow();
    const text = JSON.stringify(doc, null, 2) + '\n';
    const bytes = Buffer.byteLength(text, 'utf8');
    count('coverage_report_serialize_ms', (perfNow() - serializeStart) / 1e6);
    count('coverage_report_bytes', bytes);
    count('full_report_bytes', bytes);
    return {
      text,
      bytes,
      document: doc,
      receipt: {
        revisionId: active.revisionId,
        bytes,
        path: null,
        documentKind: doc.documentKind,
        schemaVersion: doc.schemaVersion,
        entryCount: doc.entryCount,
      },
    };
  }

  /**
   * The directory audit documents are written to.
   *
   * A SIBLING of the output directory, derived the same way `generation.js`
   * derives its staging and state paths, and for the same reason: the output
   * directory is replaced by a rename on every publication, so anything written
   * inside it either travels with the generation or is destroyed by the swap.
   * An audit document that must outlive the generation it describes cannot live
   * there.
   */
  function auditDir() {
    const absOut = path.resolve(state.config.outDir);
    return path.join(
      path.dirname(absOut),
      `.${path.basename(absOut)}.pms-audit`,
    );
  }

  function writeCoverageStandalone(active, text) {
    const dir = auditDir();
    const file = path.join(dir, `coverage-rev-${active.revisionId}.json`);
    const writeStart = perfNow();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
    count('coverage_report_write_ms', (perfNow() - writeStart) / 1e6);
    count('full_report_write_ms', (perfNow() - writeStart) / 1e6);
    return file;
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
     * The compact, revision-bound, machine-readable result of the CURRENT
     * revision, rebuilt on access.
     *
     * An agent loop is
     *
     *     applyAgentChanges(mutation) -> validate() -> read this
     *
     * and `validate()` already returns it as `agentResult`. This method exists
     * for the two cases that method does not cover: a caller that wants it
     * again after `compile()` - when the generation milestones have moved - and
     * a caller holding only a revision summary.
     *
     * It REFUSES to answer for a revision that is not the current one. A
     * revision id is not a lookup key here: the session keeps the coverage of
     * the revision it is on and nothing older, and a method that accepted an
     * arbitrary id would have to either lie or silently describe the wrong
     * revision. Revision binding is a safety property, not a convenience.
     */
    agentResult(options = {}) {
      const active = state.active;
      if (active == null) {
        throw new Error(
          'pandamstyle: agentResult() was called before applyChanges(); there ' +
            'is no revision to describe.',
        );
      }
      if (
        options.revisionId != null &&
        options.revisionId !== active.revisionId
      ) {
        throw new Error(
          `pandamstyle: agentResult({ revisionId: ${options.revisionId} }) was ` +
            `refused: the session is on revision ${active.revisionId}. A result ` +
            'is bound to the revision it describes, and the session retains the ' +
            'current one only. Read the result before starting the next ' +
            'revision.',
        );
      }
      if (active.validated) return buildResultFor(active, options);
      return null;
    },

    /**
     * The agent result as BYTES, and the cost of producing them.
     *
     * Separated from building the object because serializing is transport. The
     * object is complete and authoritative the moment `validate()` returns;
     * turning it into a string is something a host does when it has somewhere
     * to put the string. Doing it here would charge every caller for a
     * serialization most of them never use, and would make
     * `agent_result_serialize_ms` a measurement of the compiler's choice rather
     * than of the host's.
     *
     * The returned text is COMPACT (`JSON.stringify`, no indentation) because
     * the whole point of the object is that it is small, and a pretty-printed
     * version of a 4 KB result is 9 KB of the same information.
     */
    serializeAgentResult(options = {}) {
      const result = api.agentResult(options);
      if (result == null) return null;
      const start = perfNow();
      const text = JSON.stringify(result);
      const bytes = Buffer.byteLength(text, 'utf8');
      count('agent_result_serialize_ms', (perfNow() - start) / 1e6);
      count('agent_result_bytes', bytes);
      return { text, bytes, serializeMs: (perfNow() - start) / 1e6, result };
    },

    /**
     * The full project-wide audit for a revision, produced ON DEMAND.
     *
     * This is the answer to "the agent got a small object; where did the rest of
     * the evidence go". Nothing was deleted: the compact build report says
     * `coverageReport.materialized: false` and carries the entry count and the
     * revision id, and this method writes the document that reference points
     * at.
     *
     * Two ways to use it, and the difference is about atomicity:
     *
     *   BEFORE `compile()`   the document is staged into the generation and
     *                        committed with everything else, so a generation
     *                     that contains it is a generation that is complete.
     *                        This is what CI wants.
     *   AFTER `compile()`    the generation is already committed and its
     *                     manifest already certified its contents, so the
     *                     document is written to the audit directory beside the
     *                     output directory instead. It names its revision and
     *                     generation, so the two halves are still joinable.
     *                     Mutating a committed generation is the one thing this
     *                     session will not do.
     *
     * It is a SYNCHRONOUS, caller-driven operation. There is no background
     * writer, no timer and no queue: a caller that asks and does not wait has
     * not got an audit, and this method's return value is the only evidence
     * that one exists.
     */
    requestFullAudit(options = {}) {
      const active = state.active;
      if (active == null) {
        throw new Error(
          'pandamstyle: requestFullAudit() was called before applyChanges(); ' +
            'there is no revision to audit.',
        );
      }
      if (active.revisionId !== state.revisionId) {
        throw new Error(
          'pandamstyle: requestFullAudit() can only audit the current revision.',
        );
      }
      if (!active.validated) {
        throw new Error(
          'pandamstyle: requestFullAudit() was called before validate(); the ' +
            'coverage of an unvalidated revision is not known.',
        );
      }
      const requested = options.revisionId ?? active.revisionId;
      if (requested !== active.revisionId) {
        throw new Error(
          `pandamstyle: requestFullAudit({ revisionId: ${requested} }) was ` +
            `refused: the session is on revision ${active.revisionId}, and a ` +
            "superseded revision's coverage is not retained. Request the audit " +
            'for the revision while it is current.',
        );
      }
      if (!active.ok) {
        // A refused revision has no coverage snapshot to publish: the whole
        // point of refusing is that no generation exists. Saying so is more
        // useful than emitting a document that would read like a passing build.
        throw new Error(
          'pandamstyle: requestFullAudit() was called for a revision that ' +
            'failed validation. A failed revision does not publish a ' +
            'generation, so it has no project-wide snapshot; its diagnostics ' +
            'are in the agent result.',
        );
      }

      const designSystem = state.designSystem;
      const contract = {
        contractVersion: designSystem.manifest.compilerContractVersion,
        systemId: designSystem.registry.systemId,
        registryDigest: designSystem.registry.registryDigest,
        generationId: active.published ? state.generationId : null,
        coveredRoots: state.config.roots,
      };

      if (!active.published) {
        // Requested before publication: stage it. The write happens inside the
        // generation, atomically with everything else.
        active.auditRequested = true;
        count('full_report_requested', 1);
        count('full_report_deferred', 1);
        return {
          revisionId: active.revisionId,
          documentKind: 'pandamstyle-full-audit-request',
          staged: true,
          materialized: false,
          inGeneration: true,
          note:
            'the coverage document will be staged into the next generation; ' +
            'call compile() to commit it',
        };
      }

      const doc = materializeCoverageReport(active, contract);
      const file = writeCoverageStandalone(active, doc.text);
      doc.receipt.path = file;
      doc.receipt.materialized = true;
      doc.receipt.inGeneration = false;
      active.audit = { ...doc.receipt, materializedAt: 'post-publication' };
      active.auditReportReadyNs = perfNow();
      active.agentResult = buildResultFor(active);
      count('full_report_requested', 1);
      return {
        revisionId: active.revisionId,
        generationId: state.generationId,
        documentKind: 'pandamstyle-full-audit-request',
        staged: false,
        materialized: true,
        inGeneration: false,
        path: file,
        bytes: doc.bytes,
        entryCount: doc.document.entryCount,
        timings: {
          agent_edit_to_audit_report_ms:
            (active.auditReportReadyNs - active.transactionAcceptedNs) / 1e6,
        },
      };
    },

    /**
     * The admissible token references for a category.
     *
     * The reason this exists is size. A `PMS_FORBIDDEN_VALUE` diagnostic used to
     * carry the whole admissible list for its category, and that list is
     * derived from the REGISTRY - so at a 10,000-token design system a single
     * one-line agent edit produced a diagnostic carrying 10,000 strings, and
     * the "compact" result scaled with the project after all. The diagnostic
     * now carries a capped prefix with `candidatesTotal` and
     * `candidatesTruncated` beside it, and this is where the rest is.
     *
     * `offset` exists so a caller can page through a large category without
     * either truncating silently or asking for everything at once.
     */
    candidateTokens(query = {}) {
      const snapshot = state.designSystem?.snapshot;
      if (snapshot == null) {
        throw new Error(
          'pandamstyle: candidateTokens() was called before a design system ' +
            'existed for this session.',
        );
      }
      const limit = Number.isInteger(query.limit)
        ? Math.max(0, query.limit)
        : 32;
      const offset = Number.isInteger(query.offset)
        ? Math.max(0, query.offset)
        : 0;
      const allowPrivate = query.allowPrivate === true;
      const all = candidateDomainOf(snapshot, {
        category: query.category,
        allowPrivate,
      });
      return {
        category: query.category ?? null,
        allowPrivate,
        total: all.length,
        offset,
        limit,
        truncated: offset + limit < all.length,
        tokens: all.slice(offset, offset + limit),
      };
    },

    // Private compiler SDK support. The public facade returns identity-bound
    // immutable views rather than exposing these registry objects.
    _designSystemIdentity() {
      const identity = state.designSystem?.snapshot?.identity;
      return identity == null
        ? null
        : Object.freeze({
            systemId: identity.systemId,
            registryDigest: identity.registryDigest,
          });
    },

    _candidateTokenEntries(ids) {
      const tokens = state.designSystem?.snapshot?.vocabulary.tokens ?? [];
      return ids.map((tokenId) => {
        const token = tokens.find((entry) => entry.tokenId === tokenId);
        return Object.freeze({
          tokenId,
          category: token?.category ?? null,
          visibility: token?.visibility ?? null,
        });
      });
    },

    _repairDomain(query = {}) {
      const snapshot = state.designSystem?.snapshot;
      return snapshot == null ? null : repairDomainOf(snapshot, query);
    },

    _artifactFor(file) {
      const stateForFile = state.fileStates.get(path.resolve(file));
      const contribution = stateForFile?.contribution;
      if (contribution == null) return null;
      return Object.freeze({
        file: stateForFile.file,
        code: contribution.code,
        sourceMap: contribution.sourceMap,
        dependencies: Object.freeze([...(stateForFile.dependencies ?? [])]),
        sourceHash: stateForFile.sourceHash,
      });
    },

    _canonicalArtifactsForCurrentRevision() {
      const active = state.active;
      const snapshot = state.designSystem?.snapshot;
      if (
        active == null ||
        active.validated !== true ||
        active.ok !== true ||
        !Array.isArray(active.allRules) ||
        snapshot == null
      ) {
        return null;
      }
      const css = withDesignSystemCssIdentity(
        aggregateCssFull(active.allRules, state.config),
        snapshot.identity,
      );
      const manifest =
        JSON.stringify(snapshot.tooling.manifest, null, 2) + '\n';
      const artifactSet = createArtifactSet(snapshot, {
        designModuleFile: state.config.designSystemFile,
        declarationsFile: state.designDeclarationsFile,
        designModule: state.designSystemSource,
        declarations: state.designDeclarationsSource,
        manifest,
        css,
      });
      return Object.freeze({
        designSystem: Object.freeze({
          systemId: snapshot.identity.systemId,
          registryDigest: snapshot.identity.registryDigest,
        }),
        abiVersion: snapshot.identity.abiVersion,
        files: Object.freeze([
          Object.freeze({
            file: state.config.designSystemFile,
            kind: 'design-module',
            content: state.designSystemSource,
          }),
          Object.freeze({
            file: state.designDeclarationsFile,
            kind: 'declarations',
            content: state.designDeclarationsSource,
          }),
          Object.freeze({
            file: 'manifest.json',
            kind: 'manifest',
            content: manifest,
          }),
          Object.freeze({
            file: 'styles.css',
            kind: 'css',
            content: css,
            sourceMap: sourceMapForCss(css),
          }),
          Object.freeze({
            file: 'artifacts.json',
            kind: 'artifact-metadata',
            content: artifactSet.text,
          }),
        ]),
      });
    },

    _cssForCurrentRevision() {
      const active = state.active;
      if (
        active == null ||
        active.validated !== true ||
        active.ok !== true ||
        !Array.isArray(active.allRules)
      ) {
        return null;
      }
      // This is a candidate read. It must not update the incremental CSS
      // owner state or read an older committed stylesheet from disk.
      return withDesignSystemCssIdentity(
        aggregateCssFull(active.allRules, state.config),
        state.designSystem.snapshot.identity,
      );
    },

    _cssSourceMapFor(css) {
      return sourceMapForCss(css);
    },

    _publicationCandidateDigest() {
      const active = state.active;
      if (
        active == null ||
        active.validated !== true ||
        active.ok !== true ||
        !Array.isArray(active.allRules)
      ) {
        return null;
      }
      const outputs = (active.outputs ?? [])
        .map(({ file, codeDigest }) => ({
          file: path.resolve(file),
          digest: codeDigest,
        }))
        .sort((a, b) => a.file.localeCompare(b.file));
      const snapshot = state.designSystem.snapshot;
      const css = withDesignSystemCssIdentity(
        aggregateCssFull(active.allRules, state.config),
        snapshot.identity,
      );
      const artifactSet = createArtifactSet(snapshot, {
        designModuleFile: state.config.designSystemFile,
        declarationsFile: state.designDeclarationsFile,
        designModule: state.designSystemSource,
        declarations: state.designDeclarationsSource,
        manifest: JSON.stringify(snapshot.tooling.manifest, null, 2) + '\n',
        css,
      });
      return sha256(
        stableJson({
          revisionId: active.revisionId,
          registryDigest: state.designSystem?.registry?.registryDigest ?? null,
          designSystemSource: state.designSystemSource,
          outputs,
          canonicalArtifactSet: artifactSet.text,
          coverage: active.coverage ?? [],
          auditRequested: active.auditRequested === true,
        }),
      );
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

    /**
     * The watcher route, for a host that cannot declare its mutations.
     *
     * It is a THIN wrapper over the same transaction type, deliberately: a
     * watched revision and a declared revision go through identical code, so
     * there is no second implementation of what a mutation means and nothing to
     * keep in step. What differs is only where the paths came from, and the
     * trust that is attached to them.
     *
     * An overflow is not an error to swallow: it returns null and says why, and
     * the caller is expected to fall back to full discovery, which it can do by
     * submitting `{ forceFullDiscovery: true }` or simply by not using the
     * watcher for that revision.
     */
    applyWatchedChanges(provider) {
      const transaction = provider?.pending?.() ?? null;
      count('watch_events_seen', provider?.stats?.().events ?? 0);
      count('watch_events_coalesced', provider?.stats?.().coalesced ?? 0);
      count('watch_ignored_events', provider?.stats?.().ignored ?? 0);
      count('watch_journal_depth', provider?.stats?.().pending ?? 0);
      if (transaction == null) {
        if (provider?.journal?.resyncRequired === true) {
          count('watch_resyncs', 1);
          return applyChanges({
            mutation: normalizeMutationTransaction({
              mode: 'full-discovery',
              forceFullDiscovery: true,
            }),
          });
        }
        return applyChanges({});
      }
      return applyChanges({
        mutation: normalizeMutationTransaction({
          ...transaction,
          mode: 'watcher',
        }),
      });
    },

    /**
     * Starts a watcher over this session's roots, seeded from what the session
     * already knows.
     *
     * The digests matter more than the paths. Recognising a rename needs the
     * content of the file as it was BEFORE it moved, and the session is the
     * only party that kept it: a watcher that tried to work it out afterwards
     * would find the old path gone, which is the whole difficulty. So the
     * watcher inherits the evidence rather than re-deriving it.
     */
    watch(options = {}) {
      const digests = [];
      for (const [file, fileState] of state.fileStates) {
        const digest = fileState?.sourceHash;
        if (digest != null) digests.push([file, digest]);
      }
      const { debounceMs, maxPending, onFlush, onResync } = options;
      return createFilesystemWatcher({
        roots: state.config.roots,
        outDir: state.config.outDir,
        digests,
        known: [...state.fileStates.keys()],
        debounceMs,
        maxPending,
        onFlush,
        onResync,
      });
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
        coverageGraph: coverageGraphStats(state.coverageGraph),
        resolutionKeyCount: resolutionKeys.size,
        negativeResolutionCount: [...resolutionKeys.values()].filter(
          (v) => v.resolved === null,
        ).length,
        dsConsumerModuleCount: state.dsConsumers.size,
        dsImportConsumerModuleCount: state.dsImportConsumers.size,
        semanticUnitCount: dsv.semanticUnitFingerprints.size,
        semanticFileInputCount: dsv.fileInputFingerprints.size,
        semanticDependencyUnitCount: dsv.semanticConsumers.size,
        semanticDependencyEdgeCount: [...dsv.semanticConsumers.values()].reduce(
          (sum, files) => sum + files.size,
          0,
        ),
        dsViewRelayAnswerCount: state.dsv.relayAnswers.size,
        dsViewRelayHopCount: state.dsv.relayEntriesByFirstHop.size,
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

    /**
     * The FULL audit of the incremental design-system views.
     *
     * Recomputes every covered file's view from scratch - no memo, no relay
     * cache - and compares the digests, the relay chains and therefore the
     * recognized design-system module, the compiler binding recognition and the
     * diagnostics that follow from it. Not on the hot path; a test may ask.
     */
    verifyDesignSystemViews() {
      return verifyDesignSystemViews();
    },

    /**
     * The FULL audit of the persistent coverage graph.
     *
     * Recomputes the covered set, the origins, the canonical order, the
     * unresolved edges, the external requests and the relay edges from the
     * module summaries, with no reuse of the incremental structure, and reports
     * every difference. It is deliberately not on the hot path: an agent
     * revision must never need it, and this is the function a test is allowed
     * to call because it is slow.
     */
    verifyCoverageGraph() {
      if (state.active == null) {
        throw new Error(
          'pandamstyle: verifyCoverageGraph() audits the CURRENT revision, ' +
            'so a revision has to exist. Call applyChanges() first.',
        );
      }
      return verifyCoverageGraph(
        state.coverageGraph,
        coverageContext(state.active),
      );
    },

    /**
     * The covered set, IN CANONICAL ORDER, as `[file, origin]` pairs.
     *
     * The order is semantic - the coverage array, the CSS contribution order
     * and the cascade output are all functions of it - so it is exposed rather
     * than inferred. A test that asserts "the incremental order equals the
     * fresh order" and a test that asserts "the order moved" both need to read
     * it, and an accessor is better than a published artifact for either.
     */
    coverageOrder() {
      const covered = state.coverageGraph.closure?.covered;
      if (covered == null) return [];
      return [...covered.entries()];
    },

    /**
     * The coverage graph's structural counts.
     *
     * Node, edge, reachability and root-list totals, so a long session can be
     * shown not to grow without bound. No revision history is kept anywhere in
     * the graph, so these numbers are the size of the CURRENT project.
     */
    coverageGraph() {
      return coverageGraphStats(state.coverageGraph);
    },

    // Read-only semantic oracle surface. Return the answers actually used by
    // the active revision; never recompute them through the fresh resolver.
    inspectForwarding(file) {
      const fileState = state.fileStates.get(file);
      if (fileState == null) return [];
      const store = relayStore();
      return (fileState.importSources ?? []).map((source) => {
        const key = relayAnswerKey(
          file,
          source,
          state.config.engineOptions?.maxRelayDepth,
        );
        const entry = store.get(key);
        return {
          source,
          bindings: entry?.info?.exportsOfRelay ?? [],
          issues: entry?.info?.issues ?? [],
        };
      });
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
      setRelayAnswerStore(null);
      clearModuleOverlay();
      clearModuleCache();
      state.overlay.clear();
      state.overlay = new Map();
      state.hostSourceOverlays.clear();
      state.fileStates.clear();
      cssMapCache = null;
      state.dsConsumers.clear();
      state.dsImportConsumers.clear();
      state.dsv.moduleVersions.clear();
      state.dsv.relayAnswers.clear();
      state.dsv.relayEntriesByFirstHop.clear();
      state.dsv.fullFallback = false;
      state.dsv.fullFallbackReason = null;
      resolutionKeys = new Map();
      dirListings = new Map();
      state.covered = null;
      state.active = null;
      state.designSystem = null;
      state.designSystemSource = null;
      state.designDeclarationsSource = null;
      state.designDeclarationsFile = null;
      state.generatedModulePath = null;
      state.coverageGraph = createCoverageGraph();
      state.published = null;
      state.lastPublication = null;
      state.config = {
        ...state.config,
        definition: null,
        roots: [],
        engineOptions: {},
      };
      cssState = null;
      cssStateKey = null;
      cssStateLastCss = null;
      tally.clear();
    },
  };

  for (const [name, method] of Object.entries(api)) {
    if (typeof method !== 'function') continue;
    api[name] = (...args) =>
      runWithModuleGraphContext(graphContext, () => method(...args));
  }

  return api;
}
