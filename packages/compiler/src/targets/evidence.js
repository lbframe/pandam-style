/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Executed-evidence records (`pandamstyle-target-evidence`, schema 1).
 *
 * The schema exists before any record does: executed Safari/iOS and Electron
 * proofs belong to CE-13.4 (#81). What it fixes now is what may count as
 * evidence for which engine:
 *
 *   - an engine is identified by its BCD browser id, exact version and build;
 *   - `safari_ios` evidence comes from a real device or from Apple's iOS
 *     Simulator, and the two stay distinct (`device: "real-device"` gives the
 *     basis `executed`, `device: "simulator"` gives `executed-simulator`);
 *   - a real-device claim needs real-device evidence;
 *   - Playwright WebKit is not Safari and not Safari on iOS, whatever the
 *     version string says; desktop Safari is not Safari on iOS.
 */

export const EVIDENCE_KIND = 'pandamstyle-target-evidence';
export const EVIDENCE_SCHEMA_VERSION = 1;
export const EVIDENCE_CLASSES = Object.freeze(['E3', 'E4']);
export const DEVICES = Object.freeze([
  'real-device',
  'simulator',
  'desktop',
  'headless',
]);
const EVIDENCE_ENGINES = new Set([
  'chrome',
  'chrome_android',
  'edge',
  'firefox',
  'firefox_android',
  'safari',
  'safari_ios',
  'webview_android',
  'electron',
]);
const SAFARI_ENGINES = new Set(['safari', 'safari_ios']);
const WEBKIT_PORTS = /playwright|webkitgtk|wpe|minibrowser/i;

/** Problems with one evidence record; an empty list means it is admissible. */
export function evidenceProblems(evidence) {
  const problems = [];
  if (evidence == null || typeof evidence !== 'object') return ['not-an-object'];
  if (!EVIDENCE_CLASSES.includes(evidence.class)) problems.push('class');
  if (typeof evidence.fixtureId !== 'string' || evidence.fixtureId === '') {
    problems.push('fixture-id');
  }
  if (typeof evidence.feature !== 'string') problems.push('feature');
  if (!['pass', 'fail'].includes(evidence.result)) problems.push('result');
  const engine = evidence.engine;
  if (engine == null || typeof engine !== 'object') {
    problems.push('engine');
    return problems;
  }
  if (!EVIDENCE_ENGINES.has(engine.id)) problems.push('engine-id');
  if (typeof engine.version !== 'string' || engine.version === '') {
    problems.push('engine-version');
  }
  if (typeof engine.build !== 'string' || engine.build === '') {
    problems.push('engine-build');
  }
  if (!DEVICES.includes(engine.device)) problems.push('engine-device');
  const automation = `${engine.driver ?? ''} ${engine.automationEngine ?? ''}`;
  if (SAFARI_ENGINES.has(engine.id) && WEBKIT_PORTS.test(automation)) {
    problems.push('webkit-port-is-not-safari');
  }
  if (
    engine.id === 'safari_ios' &&
    !['real-device', 'simulator'].includes(engine.device)
  ) {
    problems.push('ios-requires-device-or-simulator');
  }
  if (engine.id === 'safari' && engine.device === 'simulator') {
    problems.push('simulator-is-ios-only');
  }
  return problems;
}

/** The outcome basis an admissible record supports, or null. */
export function evidenceBasis(evidence) {
  if (evidenceProblems(evidence).length > 0) return null;
  return evidence.engine.device === 'simulator' ? 'executed-simulator' : 'executed';
}

/**
 * Whether evidence supports a claim of the given strength for an engine.
 * `claim` is `executed` (real device or real engine) or `executed-simulator`.
 */
export function evidenceSupports(claim, engineId, evidence) {
  if (evidence.engine?.id !== engineId) return false;
  const basis = evidenceBasis(evidence);
  if (basis == null || evidence.result !== 'pass') return false;
  if (claim === 'executed') return basis === 'executed';
  if (claim === 'executed-simulator') return basis !== null;
  return false;
}
