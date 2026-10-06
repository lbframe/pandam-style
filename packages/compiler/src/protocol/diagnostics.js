/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - structured diagnostics (ARC-16).
 * Stable PMS_* codes; every error points back to the author/consumer source.
 * No autofix in P0 (D-10): `autofix` stays null.
 *
 * A diagnostic carries two distinct locators:
 *  - `source`   : the responsible module (file path, or phase label);
 *  - `location` : the exact position inside the page (file, line, column).
 * `source` accepts a string (back-compat) or a location object.
 */

export const DIAG_SCHEMA_VERSION = 1;

function normalizeLocation(source) {
  if (source == null) return { source: null, location: null };
  if (typeof source === 'string') {
    return { source, location: null };
  }
  if (typeof source === 'object') {
    const { file = null, line = null, column = null, role = null } = source;
    if (file == null && line == null) {
      return { source: null, location: null };
    }
    return {
      source: role != null ? `${file} (${role})` : file,
      location: { file, line, column, role },
    };
  }
  return { source: null, location: null };
}

function renderLocation(diag) {
  if (diag.location == null) return '';
  const { file, line, column } = diag.location;
  if (file == null) return '';
  if (line == null) return ` (${file})`;
  if (column == null) return ` (${file}:${line})`;
  return ` (${file}:${line}:${column})`;
}

export function diagnostic({
  code,
  severity = 'error',
  phase,
  message,
  source = null,
  location = null,
  rule = null,
  context = {},
}) {
  // An explicit `location` wins over a `source` object.
  const normalizedSource = normalizeLocation(source);
  let normalizedLocation = normalizedSource.location;
  let normalizedLabel = normalizedSource.source;
  if (location != null) {
    const n = normalizeLocation(location);
    normalizedLocation = n.location ?? normalizedLocation;
    normalizedLabel = n.source ?? normalizedLabel;
  }
  return {
    schemaVersion: DIAG_SCHEMA_VERSION,
    code,
    severity,
    phase,
    message,
    source: normalizedLabel,
    location: normalizedLocation,
    rule,
    context,
    autofix: null,
  };
}

export class PmsError extends Error {
  constructor(diagnostics) {
    super(
      diagnostics
        .map((d) => `${d.code}: ${d.message}${renderLocation(d)}`)
        .join('\n'),
    );
    this.name = 'PmsError';
    this.diagnostics = diagnostics;
  }
}

export const Codes = {
  UNKNOWN_PATTERN: 'PMS_UNKNOWN_PATTERN',
  INVALID_PATTERN_PARAMETER: 'PMS_INVALID_PATTERN_PARAMETER',
  UNKNOWN_TOKEN: 'PMS_UNKNOWN_TOKEN',
  TOKEN_CYCLE: 'PMS_TOKEN_CYCLE',
  DUPLICATE_TOKEN: 'PMS_DUPLICATE_TOKEN',
  INVALID_TOKEN_CATEGORY: 'PMS_INVALID_TOKEN_CATEGORY',
  TOKEN_NOT_PUBLIC: 'PMS_TOKEN_NOT_PUBLIC',
  UNKNOWN_THEME: 'PMS_UNKNOWN_THEME',
  INVALID_THEME: 'PMS_INVALID_THEME',
  THEME_CYCLE: 'PMS_THEME_CYCLE',
  THEME_TOKEN_CYCLE: 'PMS_THEME_TOKEN_CYCLE',
  FORBIDDEN_VALUE: 'PMS_FORBIDDEN_VALUE',
  UNSUPPORTED_PROPERTY: 'PMS_UNSUPPORTED_PROPERTY',
  UNSUPPORTED_PROPERTY_FORM: 'PMS_UNSUPPORTED_PROPERTY_FORM',
  UNKNOWN_CONDITION: 'PMS_UNKNOWN_CONDITION',
  INVALID_VARIANT_KEY: 'PMS_INVALID_VARIANT_KEY',
  INVALID_VARIANT_VALUE: 'PMS_INVALID_VARIANT_VALUE',
  INVALID_RECIPE: 'PMS_INVALID_RECIPE',
  INVALID_RECIPE_SLOT: 'PMS_INVALID_RECIPE_SLOT',
  AMBIGUOUS_RECIPE_COMPOUND: 'PMS_AMBIGUOUS_RECIPE_COMPOUND',
  UNSUPPORTED_FEATURE: 'PMS_UNSUPPORTED_FEATURE',
  // Codes added by this batch (build boundaries and non-static values).
  NON_STATIC_VALUE: 'PMS_NON_STATIC_VALUE',
  FORBIDDEN_IMPORT: 'PMS_FORBIDDEN_IMPORT',
  FORBIDDEN_STYLE_CHANNEL: 'PMS_FORBIDDEN_STYLE_CHANNEL',
  UNVERIFIED_JSX_SPREAD: 'PMS_UNVERIFIED_JSX_SPREAD',
  ROLE_VIOLATION: 'PMS_ROLE_VIOLATION',
  COVERAGE_GAP: 'PMS_COVERAGE_GAP',
  // Codes added by the consolidation batch.
  //
  // A `props()` argument whose provenance is not demonstrated. Separate from
  // PMS_UNVERIFIED_JSX_SPREAD on purpose: the spread may be a recognized
  // props() result whose ARGUMENT is raw, and the two need different fixes.
  UNVERIFIED_PROPS_SOURCE: 'PMS_UNVERIFIED_PROPS_SOURCE',
  // A value that was proven and can then still be written to or escaped into
  // an unrecognized call, so its provenance is not durable.
  UNVERIFIED_PROVENANCE: 'PMS_UNVERIFIED_PROVENANCE',
  STALE_REVISION: 'PMS_STALE_REVISION',
  SUPERSEDED_REVISION: 'PMS_SUPERSEDED_REVISION',
  INVALID_REVISION: 'PMS_INVALID_REVISION',
  SESSION_CLOSED: 'PMS_SESSION_CLOSED',
  ABI_MISMATCH: 'PMS_ABI_MISMATCH',
  GENERATED_ARTIFACT_MISMATCH: 'PMS_GENERATED_ARTIFACT_MISMATCH',
};

/** Stable single-line rendering of a diagnostic (used by the build report). */
export function formatDiagnostic(diag) {
  const loc = renderLocation(diag);
  const rule = diag.rule ? ` [${diag.rule}]` : '';
  return `${diag.code}${rule}: ${diag.message}${loc}`;
}
