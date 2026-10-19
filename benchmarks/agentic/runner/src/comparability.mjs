/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Comparability key (DESIGN.md section 1.4). The projection is exact and
// versioned; transient values are normalized to placeholders and the raw
// values are kept elsewhere in the record. Product-dependent inputs are not
// part of the projection: they are the axis under comparison.

import { digestJson } from './util.mjs';

export const PROJECTION_VERSION = 'pms-agentic-comparability/v1';

export const PROJECTION_FIELDS = {
  task: ['id', 'taskDigest', 'epoch', 'corpusVersion', 'corpusLockSha256'],
  harness: ['runnerTreeDigest', 'harnessDepsLockSha256'],
  prompt: ['sha256'],
  model: [
    'cli',
    'cliVersion',
    'cliSha256',
    'requestedModel',
    'reasoningEffort',
    'normalizedArgv',
    'nonSecretEnv',
    'cliConfigSha256',
  ],
  policy: [
    'effectiveToolPolicy',
    'capabilityEnforcementMatrixSha256',
    'egressAllowlistSha256',
    'proxyImageId',
    'networkMode',
  ],
  budgets: ['timeoutSeconds', 'maxToolCalls', 'cliMaxTurns'],
  containers: [
    'agentImageId',
    'graderImageId',
    'cpus',
    'memoryBytes',
    'pidsLimit',
    'tmpfsBytes',
    'workspaceBytesCap',
  ],
  dependencies: [
    'nodeSha256',
    'packageManager',
    'fixtureClosureNonProductLockSha256',
  ],
};

const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Replaces transient values (session ids, attempt directories, temporary
 * paths) by placeholders. `transients` lists exact strings known to the
 * runner for this attempt (attempt dir, container names, ports).
 */
export function normalizeText(text, transients = []) {
  let out = String(text);
  for (const t of [...transients]
    .filter((x) => typeof x === 'string' && x.length > 0)
    .sort((a, b) => b.length - a.length))
    out = out.split(t).join('<attempt>');
  return out.replace(UUID, '<session>');
}

export function normalizeArgv(argv, transients = []) {
  return argv.map((a) => normalizeText(a, transients));
}

export function normalizeEnv(env, transients = []) {
  const out = {};
  for (const [k, v] of Object.entries(env))
    out[k] = v === '<secret>' ? v : normalizeText(v, transients);
  return out;
}

/** Builds the exact projection; throws on a missing field. */
export function buildProjection(input) {
  const projection = { version: PROJECTION_VERSION };
  for (const [group, fields] of Object.entries(PROJECTION_FIELDS)) {
    const src = input[group];
    if (src == null) throw new Error(`comparability: missing group ${group}`);
    projection[group] = {};
    for (const f of fields) {
      if (!(f in src))
        throw new Error(`comparability: missing field ${group}.${f}`);
      projection[group][f] = src[f];
    }
  }
  return projection;
}

export function comparabilityKey(projection) {
  return digestJson(projection);
}

/** Lists the projection fields that differ between two records. */
export function diffProjections(a, b) {
  const differences = [];
  if (a.version !== b.version) differences.push('version');
  for (const [group, fields] of Object.entries(PROJECTION_FIELDS))
    for (const f of fields)
      if (
        digestJson(a[group]?.[f] ?? null) !== digestJson(b[group]?.[f] ?? null)
      )
        differences.push(`${group}.${f}`);
  return differences;
}

/**
 * `compare`: pairs two attempt records only when their keys are equal;
 * otherwise refuses and names the differing fields.
 */
export function compareRecords(a, b) {
  if (a.kind !== b.kind)
    return { comparable: false, differences: ['kind'], reason: 'kind differs' };
  const differences = diffProjections(
    a.comparability.projection,
    b.comparability.projection,
  );
  if (differences.length > 0 || a.comparability.key !== b.comparability.key)
    return { comparable: false, differences, reason: 'projection differs' };
  const productDiffers = a.productBuild.digest !== b.productBuild.digest;
  return {
    comparable: true,
    key: a.comparability.key,
    productDiffers,
    a: summary(a),
    b: summary(b),
  };
}

function summary(r) {
  return {
    task: r.task.id,
    model: r.cell.modelKey,
    repetition: r.repetition,
    attempt: r.attempt,
    product: r.productBuild.digest,
    verdict: r.grading.verdict,
    taskSuccess: r.outcome.taskSuccess,
    toolCalls: r.metrics.toolCalls.total ?? null,
  };
}
