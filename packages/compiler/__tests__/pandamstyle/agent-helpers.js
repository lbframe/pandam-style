/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Shared helpers for the AG-01.1 agent contract suites. The agent layer is
 * reached through the private inspection bundle, together with the session
 * whose module-private hooks it uses: the two must come from one module graph.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { openProject } = require('./session-helpers');
const { evaluateDefinitionText } = require('./pms-helpers');

function loadCompiler() {
  // eslint-disable-next-line
  return require(
    path.resolve(
      __dirname,
      '../../../../.pms-test-support/compiler-inspection.cjs',
    ),
  );
}

const compiler = loadCompiler();

/** A request in the agent protocol. */
function request(operation, input, extra = {}) {
  return {
    protocolVersion: 1,
    operation,
    ...(input === undefined ? {} : { input }),
    ...extra,
  };
}

/**
 * A bound project on a fresh fixture copy. `definition` replaces the shared
 * definition before the session starts; `sessionOptions` reach the session.
 */
async function openAgentProject(name = 'valid', options = {}) {
  const fixture = openProject(name);
  if (options.prepare != null) {
    options.prepare(fixture);
    fixture.reloadDefinition();
  }
  const session = fixture.openPublicSession({
    ...(options.definition === undefined
      ? {}
      : { definition: options.definition }),
    ...(options.sessionOptions ?? {}),
  });
  const binding = await compiler.createAgentBinding({
    session,
    initialize: options.initialize ?? true,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  const capability = binding.mintCapability({ grants: ['consult'] });
  const dispatch = (operation, input, extra = {}, dispatchOptions = {}) =>
    binding.dispatch(request(operation, input, extra), {
      capability,
      ...dispatchOptions,
    });
  const status = async () => (await dispatch('session.status', {})).identities;
  return {
    fixture,
    session,
    binding,
    capability,
    dispatch,
    async revision() {
      return (await status()).revision;
    },
    definition() {
      return evaluateDefinitionText(fixture.sharedDefinitionPath);
    },
    async close() {
      await session.close();
    },
  };
}

/** The shared fixture definition, freshly evaluated, then edited. */
function definitionWith(fixture, edit) {
  const definition = evaluateDefinitionText(fixture.sharedDefinitionPath);
  edit(definition);
  return definition;
}

function emptyMutation(baseRevision) {
  return {
    baseRevision,
    mode: 'full-discovery',
    changed: [],
    added: [],
    removed: [],
    renamed: [],
  };
}

/** SHA-256 of every file under `dir`, keyed by relative path. */
function hashTree(dir) {
  const out = {};
  const walk = (current) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.name === 'node_modules') continue;
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile())
        out[path.relative(dir, abs)] = crypto
          .createHash('sha256')
          .update(fs.readFileSync(abs))
          .digest('hex');
    }
  };
  walk(dir);
  return out;
}

/** Reads a whole record through `records.read`, chunk by chunk. */
async function readRecord(dispatch, rev, address, chunk, view = 'compact') {
  let offset = 0;
  let text = '';
  let last = null;
  for (let guard = 0; guard < 100000; guard += 1) {
    const response = await dispatch(
      'records.read',
      { rev, address, page: { offset, limit: chunk } },
      { view },
    );
    if (response.outcome !== 'success') return { response, text: null };
    last = response.result;
    text += last.chunk;
    if (last.nextOffset == null) break;
    expect(last.nextOffset).toBeGreaterThan(offset);
    offset = last.nextOffset;
  }
  return { text, bytes: last.bytes, sha256: last.sha256 };
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** The (outcome, code, reason) triple an envelope reports. */
function observedTriple(envelope) {
  return {
    outcome: envelope.outcome,
    code: envelope.diagnostics[0]?.code ?? null,
    reason: envelope.failure?.reason ?? null,
  };
}

/** True when `triple` is covered by one of the entry's declared contracts. */
function declares(entry, triple) {
  return entry.errors.some(
    (error) =>
      error.outcome === triple.outcome &&
      // A null code stands for the verdict's or definition's own diagnostics.
      (error.code === triple.code || error.code === null) &&
      error.reasons.includes(triple.reason),
  );
}

module.exports = {
  compiler,
  declares,
  definitionWith,
  emptyMutation,
  hashTree,
  observedTriple,
  openAgentProject,
  readRecord,
  request,
  sha256,
};
