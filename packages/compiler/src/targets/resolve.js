/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Deterministic target resolution (`pandamstyle-target-resolution`, schema 1).
 *
 * Profiles are Browserslist queries, resolved with the exact-pinned
 * `browserslist`, `caniuse-lite`, `electron-to-chromium` and
 * `baseline-browser-mapping` the compiler depends on. Resolution never reads
 * `.browserslistrc`, `package.json#browserslist`, `browserslist-stats.json` or
 * any `BROWSERSLIST*` variable: queries are always explicit, the statistics
 * input is fixed, and query types that read ambient files or the clock are
 * refused before Browserslist runs.
 *
 * The record names the resolved browser list, the data packages (version and
 * digest) and the configuration provenance, and its digest is a function of
 * those alone.
 */

import crypto from 'crypto';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';

import { caveatCatalog } from './catalog';
import { transformTable } from './transforms';
import { compatData } from './data';
import { compareVersions } from './versions';
import defaultProfile from './profiles/default.v1.json';
import builtinResolutions from './profiles/builtin-resolutions.v1.json';
import minimumFloor from './profiles/minimum.v1.json';
import { Codes, PmsError, diagnostic } from '../protocol/diagnostics';

// Browserslist is loaded on the first live resolution only: built-in profiles
// resolve from their precomputed lists (below), so a project that uses them
// never loads it.
let browserslistModule = null;

function browserslistLib() {
  browserslistModule ??= createRequire(import.meta.url)('browserslist');
  return browserslistModule;
}

export const RESOLUTION_KIND = 'pandamstyle-target-resolution';
export const RESOLUTION_SCHEMA_VERSION = 1;

// Fixed Browserslist options. `stats: {}` stops Browserslist from reading
// BROWSERSLIST_STATS or searching parent directories for a statistics file;
// explicit queries stop it from loading any configuration.
export const BROWSERSLIST_OPTIONS = Object.freeze({
  config: false,
  env: undefined,
  path: undefined,
  ignoreUnknownVersions: false,
  mobileToDesktop: true,
});

// The exact pins (packages/compiler/package.json). The record states whether
// the loaded packages are these.
export const DATA_PINS = Object.freeze({
  browserslist: '4.28.0',
  'caniuse-lite': '1.0.30001799',
  'electron-to-chromium': '1.5.459',
  'baseline-browser-mapping': '2.11.23',
});

// Every query type of the pinned Browserslist, classified. `pinned` terms
// resolve from the pinned data packages alone; `clock` terms depend on the
// current date and `ambient` terms read files, packages, statistics or the
// environment, so both are refused before resolution. Two types depend on
// their arguments: a dated `baseline` term is pinned only up to the data's
// newest release year, and `cover ... in my stats` reads a statistics file
// while a region cover is pinned. A type missing here (a Browserslist upgrade)
// is refused as `unclassified` until it is classified; a test derives the
// type list from the pinned Browserslist's own query table.
export const QUERY_TYPES = Object.freeze({
  last_major_versions: 'pinned',
  last_versions: 'pinned',
  last_electron_major_versions: 'pinned',
  last_node_major_versions: 'pinned',
  last_browser_major_versions: 'pinned',
  last_electron_versions: 'pinned',
  last_node_versions: 'pinned',
  last_browser_versions: 'pinned',
  unreleased_versions: 'pinned',
  unreleased_electron_versions: 'pinned',
  unreleased_browser_versions: 'pinned',
  last_years: 'clock',
  since_y: 'clock',
  since_y_m: 'clock',
  since_y_m_d: 'clock',
  baseline: 'by-argument',
  popularity: 'pinned',
  popularity_in_my_stats: 'ambient',
  popularity_in_config_stats: 'ambient',
  popularity_in_place: 'pinned',
  cover: 'pinned',
  cover_in: 'by-argument',
  cover_config: 'ambient',
  supports: 'pinned',
  electron_range: 'pinned',
  node_range: 'pinned',
  browser_range: 'pinned',
  electron_ray: 'pinned',
  node_ray: 'pinned',
  browser_ray: 'pinned',
  firefox_esr: 'pinned',
  opera_mini_all: 'pinned',
  electron_version: 'pinned',
  node_major_version: 'pinned',
  node_minor_version: 'pinned',
  node_patch_version: 'pinned',
  current_node: 'ambient',
  maintained_node: 'clock',
  phantomjs_1_9: 'pinned',
  phantomjs_2_1: 'pinned',
  browser_version: 'pinned',
  browserslist_config: 'ambient',
  extends: 'ambient',
  defaults: 'pinned',
  dead: 'pinned',
  unknown: 'pinned',
});

/** Why a parsed query term is refused, or null when it is pinned. */
export function queryRefusal(node) {
  const kind = Object.hasOwn(QUERY_TYPES, node.type)
    ? QUERY_TYPES[node.type]
    : 'unclassified';
  if (kind === 'pinned') return null;
  if (kind !== 'by-argument') return kind;
  if (node.type === 'baseline') {
    return (node.year == null && node.date == null) || beyondData(node)
      ? 'clock'
      : null;
  }
  // cover_in: `my stats` reads a statistics file; a region is pinned data.
  return /^my\s+stats$/i.test(String(node.place)) ? 'ambient' : null;
}

// Browserslist browser names PandamStyle can announce, with the BCD browser
// whose statements apply to them.
export const ANNOUNCEABLE = Object.freeze({
  chrome: 'chrome',
  and_chr: 'chrome_android',
  edge: 'edge',
  firefox: 'firefox',
  and_ff: 'firefox_android',
  safari: 'safari',
  ios_saf: 'safari_ios',
  android: 'webview_android',
});

export const BUILTIN_PROFILES = Object.freeze({
  'pandamstyle:default@1': { query: defaultProfile.query, platform: null },
  'pandamstyle:ios-safari@1': {
    query: defaultProfile.iosQuery,
    platform: null,
  },
  'pandamstyle:electron@1': { query: 'electron 44.7', platform: 'electron' },
  'pandamstyle:android-webview@1': {
    query: defaultProfile.androidWebViewQuery,
    platform: null,
  },
});
export const BUILTIN_PROFILE_REFS = Object.freeze(
  Object.keys(BUILTIN_PROFILES),
);
export const DEFAULT_PROFILE_REF = 'pandamstyle:default@1';

const CONFIG_KEYS = new Set(['profiles', 'define']);
const DEFINE_KEYS = new Set(['query', 'platform']);

function sha256(text) {
  return 'sha256:' + crypto.createHash('sha256').update(text).digest('hex');
}

export function stableJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`;
}

function targetDiagnostic(code, rule, message, context, severity = 'error') {
  return diagnostic({
    code,
    severity,
    phase: 'targets',
    message,
    source: null,
    rule,
    context,
  });
}

// ----------------------------------------------------------- data identity --

function packageRoot(file, name) {
  let dir = path.dirname(file);
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (parsed.name === name) return { dir, version: parsed.version };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function packageIdentity(requireFrom, name, entry, files) {
  const resolved = requireFrom.resolve(entry);
  const root = packageRoot(resolved, name);
  if (root == null) return { version: null, digest: null };
  const hash = crypto.createHash('sha256');
  for (const file of ['package.json', ...files]) {
    hash.update(`${file}\0`);
    hash.update(fs.readFileSync(path.join(root.dir, file)));
    hash.update('\0');
  }
  return {
    version: root.version,
    digest: `sha256:${hash.digest('hex')}`,
    dir: root.dir,
  };
}

let identityCache = null;

/** Versions and digests of the data packages actually loaded. */
export function dataPackages() {
  if (identityCache != null) return identityCache;
  const fromCompiler = createRequire(import.meta.url);
  const list = packageIdentity(fromCompiler, 'browserslist', 'browserslist', [
    'index.js',
    'node.js',
    'parse.js',
  ]);
  const fromList = createRequire(path.join(list.dir, 'index.js'));
  const packages = {
    browserslist: { version: list.version, digest: list.digest },
    'caniuse-lite': packageIdentity(
      fromList,
      'caniuse-lite',
      'caniuse-lite/dist/unpacker/agents',
      ['data/agents.js', 'data/browsers.js', 'data/browserVersions.js'],
    ),
    'electron-to-chromium': packageIdentity(
      fromList,
      'electron-to-chromium',
      'electron-to-chromium/versions',
      ['versions.js'],
    ),
    'baseline-browser-mapping': packageIdentity(
      fromList,
      'baseline-browser-mapping',
      'baseline-browser-mapping',
      [],
    ),
  };
  for (const key of Object.keys(packages)) {
    const { version, digest } = packages[key];
    packages[key] = { version, digest };
  }
  identityCache = Object.freeze({
    packages,
    pinned: Object.entries(DATA_PINS).every(
      ([name, version]) => packages[name].version === version,
    ),
  });
  return identityCache;
}

// ------------------------------------------------------------- resolution --

/**
 * The year of the newest browser release in the pinned data. A dated Baseline
 * term after it is refused: baseline-browser-mapping rejects a year later than
 * the wall clock's, so such a term would fail today and resolve later. Up to
 * this year the term never depends on the clock, because the data's newest
 * release is never in the future.
 */
function dataYear() {
  let latest = 0;
  for (const agent of Object.values(browserslistLib().data)) {
    for (const time of Object.values(agent.releaseDate ?? {})) {
      if (time != null && time > latest) latest = time;
    }
  }
  return new Date(latest * 1000).getUTCFullYear();
}

function beyondData(node) {
  const year = Number(node.year ?? String(node.date ?? '').slice(0, 4));
  return Number.isFinite(year) && year > dataYear();
}

/**
 * Browserslist warns on stderr once its data is six months old, telling the
 * reader to update it. The data is an exact pin here, so that advice would
 * break the recorded identity; the check is skipped for this synchronous call
 * and the variable restored.
 */
function withoutOldDataWarning(run) {
  const previous = process.env.BROWSERSLIST_IGNORE_OLD_DATA;
  process.env.BROWSERSLIST_IGNORE_OLD_DATA = '1';
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.BROWSERSLIST_IGNORE_OLD_DATA;
    else process.env.BROWSERSLIST_IGNORE_OLD_DATA = previous;
  }
}

const REFUSAL_MESSAGES = Object.freeze({
  clock: (term) =>
    `Target query term "${term}" depends on the current date, so the same configuration would resolve differently over time. Use explicit versions, usage or "last N versions" terms instead.`,
  ambient: (term) =>
    `Target query term "${term}" reads files, packages or the environment outside this configuration. Write the query explicitly instead.`,
  unclassified: (term) =>
    `Target query term "${term}" has a Browserslist query type PandamStyle has not classified as deterministic. Write the query with another term.`,
});

/** Query types refused in `query`, as diagnostics; Browserslist parse errors too. */
export function refusedTerms(query) {
  let nodes;
  try {
    nodes = browserslistLib().parse(query, {});
  } catch (error) {
    return [
      targetDiagnostic(
        Codes.INVALID_TARGET_CONFIG,
        'targets.query.syntax',
        `Browserslist cannot parse "${query}": ${error.message}`,
        { query },
      ),
    ];
  }
  const out = [];
  for (const node of nodes) {
    const why = queryRefusal(node);
    if (why == null) continue;
    out.push(
      targetDiagnostic(
        Codes.INVALID_TARGET_CONFIG,
        `targets.query.${why}`,
        REFUSAL_MESSAGES[why](node.query),
        { query, term: node.query, type: node.type, reason: why },
      ),
    );
  }
  return out;
}

function obsoleteDisposition(name, version) {
  const first = Number(String(version).split('-')[0].split('.')[0]);
  if (['ie', 'ie_mob', 'op_mini', 'bb'].includes(name)) return 'obsolete';
  if (name === 'edge' && first < 79) return 'obsolete';
  if ((name === 'opera' || name === 'op_mob') && first < 15) return 'obsolete';
  return null;
}

function lowerBound(version) {
  return String(version).split('-')[0];
}

/** Splits a resolved browser list into announced engines and exclusions. */
function enginesOf(list, platform) {
  const byEngine = new Map();
  const excluded = [];
  for (const entry of list) {
    const [name, version] = entry.split(' ');
    const obsolete = obsoleteDisposition(name, version);
    if (obsolete != null || !Object.hasOwn(ANNOUNCEABLE, name)) {
      excluded.push({
        browser: name,
        version,
        disposition: obsolete ?? 'unannounced',
      });
      continue;
    }
    const engine =
      platform === 'electron' && name === 'chrome'
        ? 'electron'
        : ANNOUNCEABLE[name];
    if (!byEngine.has(engine)) {
      byEngine.set(engine, {
        engine,
        dataEngine: ANNOUNCEABLE[name],
        versions: [],
      });
    }
    byEngine.get(engine).versions.push(lowerBound(version));
  }
  const engines = [...byEngine.values()]
    .map((target) => {
      const versions = [...new Set(target.versions)].sort(compareVersions);
      return {
        engine: target.engine,
        dataEngine: target.dataEngine,
        floor: versions[0],
        upTo: versions.at(-1),
        basis:
          target.engine === 'electron' ? 'derived-from-electron' : 'declared',
        versions,
      };
    })
    .sort((a, b) => (a.engine < b.engine ? -1 : a.engine > b.engine ? 1 : 0));
  return { engines, excluded };
}

/**
 * Built-in profiles' browser lists, precomputed by
 * `tools/targets/build-builtin-resolutions.mjs` with the pinned packages and
 * checked byte for byte in CI. A list is used only when the profile's query
 * and the identities (version and digest) of every loaded data package equal
 * the recorded ones; anything else resolves live, so a consumer override of a
 * data package never reads a stale list.
 */
export function precomputedBrowsers(
  ref,
  query,
  packages = dataPackages().packages,
) {
  const entry = builtinResolutions.profiles[ref];
  if (entry == null || entry.query !== query) return null;
  for (const [name, identity] of Object.entries(builtinResolutions.data)) {
    const loaded = packages[name];
    if (
      loaded == null ||
      loaded.version !== identity.version ||
      loaded.digest !== identity.digest
    ) {
      return null;
    }
  }
  return entry.browsers;
}

/** A query resolved with the loaded Browserslist and the fixed options. */
export function liveBrowsers(query) {
  return withoutOldDataWarning(() =>
    browserslistLib()(query, { ...BROWSERSLIST_OPTIONS, stats: {} }),
  );
}

export const BUILTIN_RESOLUTIONS = builtinResolutions;

function resolveQuery(ref, query, platform, errors, warnings, builtin) {
  const precomputed = builtin ? precomputedBrowsers(ref, query) : null;
  if (precomputed != null) {
    return resolvedList(
      ref,
      query,
      [...precomputed],
      platform,
      errors,
      warnings,
    );
  }
  const refused = refusedTerms(query);
  if (refused.length > 0) {
    errors.push(
      ...refused.map((d) => ({
        ...d,
        context: { ...d.context, profile: ref },
      })),
    );
    return null;
  }
  let list;
  try {
    list = withoutOldDataWarning(() =>
      browserslistLib()(query, { ...BROWSERSLIST_OPTIONS, stats: {} }),
    );
  } catch (error) {
    errors.push(
      targetDiagnostic(
        Codes.INVALID_TARGET_CONFIG,
        'targets.query.resolution',
        `Browserslist cannot resolve "${query}" for ${ref}: ${error.message}`,
        { profile: ref, query },
      ),
    );
    return null;
  }
  return resolvedList(ref, query, list, platform, errors, warnings);
}

/** Splits a resolved list into engines and exclusions, with their findings. */
// Orchestrator decision O13: the oldest engine release PandamStyle supports.
export const MINIMUM_FLOOR = minimumFloor;

let chromiumVersions = null;

/**
 * The Blink version of a downstream browser release (`samsung 29` -> 136),
 * from the pinned baseline-browser-mapping, or null when it records none.
 * Loaded only when a resolved list holds such a browser.
 */
function chromiumEquivalent(browser, version) {
  const name = MINIMUM_FLOOR.chromiumEquivalents.browsers[browser];
  if (name == null) return null;
  if (chromiumVersions == null) {
    // The copy Browserslist loads (the pinned data package).
    const fromList = createRequire(
      createRequire(import.meta.url).resolve('browserslist'),
    );
    chromiumVersions = new Map();
    const releases = withoutOldDataWarning(() =>
      fromList('baseline-browser-mapping').getAllVersions({
        includeDownstreamBrowsers: true,
        suppressWarnings: true,
      }),
    );
    for (const release of releases) {
      if (release.engine !== 'Blink' || release.engine_version == null)
        continue;
      chromiumVersions.set(
        `${release.browser}|${Number.parseFloat(release.version)}`,
        String(release.engine_version),
      );
    }
  }
  return (
    chromiumVersions.get(`${name}|${Number.parseFloat(lowerBound(version))}`) ??
    null
  );
}

/** Refusals of a resolved list below the minimum floor (O13). */
function belowMinimum(ref, query, engines, excluded) {
  const out = [];
  const refuse = (browser, version, minimum, extra = {}) =>
    out.push(
      targetDiagnostic(
        Codes.INVALID_TARGET_CONFIG,
        'targets.below-minimum',
        `${ref} resolves to ${browser === 'electron' ? 'Electron at' : browser} ${browser === 'electron' ? `Chromium ${version}` : version}${extra.chromium == null || browser === 'electron' ? '' : ` (Chromium ${extra.chromium})`}, below PandamStyle's minimum ${minimum}: engines released before 2022 are not supported. Raise the query's floor.`,
        { profile: ref, query, browser, version, minimum, ...extra },
      ),
    );
  for (const target of engines) {
    const minimum = MINIMUM_FLOOR.engines[target.engine];
    if (minimum != null && compareVersions(target.floor, minimum) < 0) {
      // An Electron target's versions are its Chromium versions.
      if (target.engine === 'electron') {
        refuse('electron', target.floor, `Chromium ${minimum}`, {
          chromium: target.floor,
        });
      } else {
        refuse(target.engine, target.floor, `${target.engine} ${minimum}`);
      }
    }
  }
  for (const entry of excluded) {
    if (entry.disposition !== 'unannounced') continue;
    const chromium = chromiumEquivalent(entry.browser, entry.version);
    const minimum = MINIMUM_FLOOR.chromiumEquivalents.minimum;
    if (chromium != null && compareVersions(chromium, minimum) < 0) {
      refuse(entry.browser, entry.version, `Chromium ${minimum}`, {
        chromium,
      });
    }
  }
  return out;
}

function resolvedList(ref, query, list, platform, errors, warnings) {
  const { engines, excluded } = enginesOf(list, platform);
  const refused = belowMinimum(ref, query, engines, excluded);
  if (refused.length > 0) {
    errors.push(...refused);
    return null;
  }
  if (excluded.length > 0) {
    warnings.push(
      targetDiagnostic(
        Codes.INCOMPATIBLE_TARGET_ENGINE,
        excluded.some((e) => e.disposition === 'obsolete')
          ? 'targets.engine.obsolete'
          : 'targets.engine.unannounced',
        `${ref} resolves to browsers PandamStyle does not announce; they are recorded as incompatible or unannounced and receive no support claim: ${excluded.map((e) => `${e.browser} ${e.version}`).join(', ')}.`,
        { profile: ref, query, excluded, limitation: 'LIM-05' },
        'warning',
      ),
    );
  }
  if (engines.length === 0) {
    errors.push(
      targetDiagnostic(
        Codes.INCOMPATIBLE_TARGET_ENGINE,
        'targets.engine.none-announced',
        `${ref} resolves to no engine PandamStyle can announce (${Object.keys(ANNOUNCEABLE).join(', ')}).`,
        { profile: ref, query, excluded },
      ),
    );
    return null;
  }
  return { browsers: list, engines, excluded };
}

/**
 * Resolves a `targets` configuration value.
 *
 * Returns `{ record, diagnostics }`: the frozen resolution record and the
 * resolution warnings. Throws `PmsError` when the configuration is refused.
 */
export function resolveTargets(input) {
  // A pure function of the input and the pinned data: memoized by the input's
  // canonical form, so a design-system rebuild does not resolve again.
  const key = stableJson(input ?? null);
  let resolved = resolutionCache.get(key);
  if (resolved == null) {
    resolved = resolveUncached(input);
    if (resolutionCache.size > 64) resolutionCache.clear();
    resolutionCache.set(key, resolved);
  }
  return { record: resolved.record, diagnostics: [...resolved.diagnostics] };
}

const resolutionCache = new Map();

function resolveUncached(input) {
  const errors = [];
  const warnings = [];
  const origin = input == null ? 'default' : 'project-config';
  const config = input ?? { profiles: [DEFAULT_PROFILE_REF] };
  if (config == null || typeof config !== 'object' || Array.isArray(config)) {
    throw new PmsError([
      targetDiagnostic(
        Codes.INVALID_TARGET_CONFIG,
        'targets.config',
        '`targets` must be an object with a `profiles` list.',
        {},
      ),
    ]);
  }
  const unknown = Object.keys(config).filter((key) => !CONFIG_KEYS.has(key));
  if (unknown.length > 0) {
    errors.push(
      targetDiagnostic(
        Codes.INVALID_TARGET_CONFIG,
        'targets.config',
        `Unknown \`targets\` field(s): ${unknown.join(', ')}.`,
        {
          fields: unknown,
          accepted: [...CONFIG_KEYS],
        },
      ),
    );
  }
  const refs = config.profiles;
  if (!Array.isArray(refs) || refs.length === 0) {
    errors.push(
      targetDiagnostic(
        Codes.INVALID_TARGET_CONFIG,
        'targets.config',
        '`targets.profiles` must be a non-empty list of profile references.',
        {
          candidates: [...BUILTIN_PROFILE_REFS],
        },
      ),
    );
  }
  const defined = config.define ?? {};
  const profiles = [];
  const seen = new Set();
  for (const ref of Array.isArray(refs) ? refs : []) {
    if (seen.has(ref)) {
      errors.push(
        targetDiagnostic(
          Codes.INVALID_TARGET_CONFIG,
          'targets.config',
          `Profile ${ref} is listed twice.`,
          { ref },
        ),
      );
      continue;
    }
    seen.add(ref);
    let definition = null;
    let profileOrigin = 'builtin';
    if (typeof ref === 'string' && Object.hasOwn(BUILTIN_PROFILES, ref)) {
      definition = BUILTIN_PROFILES[ref];
    } else if (
      typeof ref === 'string' &&
      ref.startsWith('project:') &&
      Object.hasOwn(defined, ref.slice(8))
    ) {
      definition = defined[ref.slice(8)];
      profileOrigin = 'project';
      const fields =
        definition != null && typeof definition === 'object'
          ? Object.keys(definition)
          : [];
      const bad = fields.filter((key) => !DEFINE_KEYS.has(key));
      if (
        bad.length > 0 ||
        typeof definition?.query !== 'string' ||
        (definition.platform != null && definition.platform !== 'electron')
      ) {
        errors.push(
          targetDiagnostic(
            Codes.INVALID_TARGET_CONFIG,
            'targets.config',
            `Profile ${ref} must be \`{ query: string, platform?: "electron" }\`.`,
            { ref, fields },
          ),
        );
        continue;
      }
    } else {
      errors.push(
        targetDiagnostic(
          Codes.INVALID_TARGET_CONFIG,
          'targets.profile.unknown',
          `Unknown target profile "${String(ref)}".`,
          {
            ref: ref ?? null,
            candidates: [
              ...BUILTIN_PROFILE_REFS,
              ...Object.keys(defined).map((name) => `project:${name}`),
            ],
          },
        ),
      );
      continue;
    }
    const platform = definition.platform ?? null;
    const resolved = resolveQuery(
      ref,
      definition.query,
      platform,
      errors,
      warnings,
      profileOrigin === 'builtin',
    );
    if (resolved == null) continue;
    profiles.push({
      ref,
      origin: profileOrigin,
      query: definition.query,
      platform,
      definitionDigest: sha256(
        stableJson({ query: definition.query, platform }),
      ),
      browsers: resolved.browsers,
      engines: resolved.engines,
      excluded: resolved.excluded,
    });
  }
  if (errors.length > 0) throw new PmsError(errors);

  const data = compatData();
  const packages = dataPackages();
  const body = {
    kind: RESOLUTION_KIND,
    schemaVersion: RESOLUTION_SCHEMA_VERSION,
    provenance: {
      origin,
      inputDigest: sha256(stableJson(input ?? null)),
      ambientSourcesConsulted: [],
    },
    data: {
      ...packages.packages,
      pinned: packages.pinned,
      browserslistOptions: { ...BROWSERSLIST_OPTIONS, stats: 'fixed-empty' },
      compatData: {
        schemaVersion: 1,
        digest: data.digest,
        bcd: {
          version: data.sources.bcd.version,
          publishedDataDigest: data.sources.bcd.publishedDataDigest,
        },
      },
      caveatReviewsDigest: sha256(stableJson(caveatCatalog())),
      // Outcomes credit only committed transform-table entries (CE-01.2).
      transformsDigest: sha256(stableJson(transformTable())),
    },
    profiles,
  };
  const record = deepFreeze({ ...body, digest: sha256(stableJson(body)) });
  return { record, diagnostics: warnings };
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}
