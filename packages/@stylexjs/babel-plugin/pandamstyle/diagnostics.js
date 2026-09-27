/**
 * PandamStyle — diagnostics structurés (ARC-16).
 * Codes stables PMS_* ; chaque erreur remonte à la source auteur/consommateur.
 * Aucun autofix en P0 (D-10) : `autofix` reste null.
 */

export const DIAG_SCHEMA_VERSION = 1;

export function diagnostic({
  code,
  severity = 'error',
  phase,
  message,
  source = null,
  rule = null,
  context = {},
}) {
  return {
    schemaVersion: DIAG_SCHEMA_VERSION,
    code,
    severity,
    phase,
    message,
    source,
    rule,
    context,
    autofix: null,
  };
}

export class PmsError extends Error {
  constructor(diagnostics) {
    super(diagnostics.map((d) => `${d.code}: ${d.message}`).join('\n'));
    this.name = 'PmsError';
    this.diagnostics = diagnostics;
  }
}

export const Codes = {
  UNKNOWN_TOKEN: 'PMS_UNKNOWN_TOKEN',
  TOKEN_CYCLE: 'PMS_TOKEN_CYCLE',
  DUPLICATE_TOKEN: 'PMS_DUPLICATE_TOKEN',
  INVALID_TOKEN_CATEGORY: 'PMS_INVALID_TOKEN_CATEGORY',
  TOKEN_NOT_PUBLIC: 'PMS_TOKEN_NOT_PUBLIC',
  FORBIDDEN_VALUE: 'PMS_FORBIDDEN_VALUE',
  UNSUPPORTED_PROPERTY: 'PMS_UNSUPPORTED_PROPERTY',
  UNSUPPORTED_PROPERTY_FORM: 'PMS_UNSUPPORTED_PROPERTY_FORM',
  UNKNOWN_CONDITION: 'PMS_UNKNOWN_CONDITION',
  INVALID_VARIANT_KEY: 'PMS_INVALID_VARIANT_KEY',
  INVALID_VARIANT_VALUE: 'PMS_INVALID_VARIANT_VALUE',
  UNSUPPORTED_FEATURE: 'PMS_UNSUPPORTED_FEATURE',
};
