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

import browserslist from 'browserslist';
import crypto from 'crypto';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';

import { caveatCatalog } from './catalog';
import { compatData } from './data';
import { compareVersions } from './versions';
import defaultProfile from './profiles/default.v1.json';
import { Codes, PmsError, diagnostic } from '../protocol/diagnostics';

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

// Query types refused before resolution, and why.
const REFUSED_QUERY_TYPES = Object.freeze({
  last_years: 'clock',
  since_y: 'clock',
  since_y_m: 'clock',
  since_y_m_d: 'clock',
  maintained_node: 'clock',
  current_node: 'ambient',
  browserslist_config: 'ambient',
  extends: 'ambient',
  popularity_in_my_stats: 'ambient',
  popularity_in_config_stats: 'ambient',
});

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

/** Query types refused in `query`, as diagnostics; Browserslist parse errors too. */
export function refusedTerms(query) {
  let nodes;
  try {
    nodes = browserslist.parse(query, {});
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
    const why =
      REFUSED_QUERY_TYPES[node.type] ??
      (node.type === 'baseline' && node.year == null && node.date == null
        ? 'clock'
        : null);
    if (why == null) continue;
    out.push(
      targetDiagnostic(
        Codes.INVALID_TARGET_CONFIG,
        why === 'clock' ? 'targets.query.clock' : 'targets.query.ambient',
        why === 'clock'
          ? `Target query term "${node.query}" depends on the current date, so the same configuration would resolve differently over time. Use explicit versions, usage or "last N versions" terms instead.`
          : `Target query term "${node.query}" reads files, packages or the environment outside this configuration. Write the query explicitly instead.`,
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

function resolveQuery(ref, query, platform, errors, warnings) {
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
    list = browserslist(query, { ...BROWSERSLIST_OPTIONS, stats: {} });
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
  const { engines, excluded } = enginesOf(list, platform);
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
