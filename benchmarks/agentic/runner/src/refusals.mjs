/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Durable provider refusals (DESIGN.md section 4.6). A credential export
// failure, a write-back conflict, an unverified container cleanup or a
// failed crash recovery refuses that provider in every later matrix until
// the operator resolves it (`pms-agentic-runner resolve-refusal <provider>`
// after checking the login and the leftover resources).

import fs from 'node:fs';
import path from 'node:path';
import { RedactionSet } from './redact.mjs';
import { nowIso, writeFileAtomic } from './util.mjs';

const dirOf = (stateDir) => path.join(stateDir, 'refusals');

export function recordRefusal(
  stateDir,
  provider,
  { reason, attempt = null, redaction = null },
) {
  if (stateDir == null)
    throw new Error('a state directory is required to record a refusal');
  fs.mkdirSync(dirOf(stateDir), { recursive: true, mode: 0o700 });
  const file = path.join(dirOf(stateDir), `${provider}.json`);
  const prior = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : { provider, events: [] };
  // Reasons can carry exception text: redacted like every persisted file.
  const red = redaction ?? new RedactionSet();
  prior.events.push({
    at: nowIso(),
    reason: red.redactText(String(reason)),
    attempt,
  });
  writeFileAtomic(file, `${JSON.stringify(prior, null, 2)}\n`, { mode: 0o600 });
}

/** Active refusals by provider: `{ claude: { events } }`. */
export function activeRefusals(stateDir) {
  const dir = dirOf(stateDir);
  if (stateDir == null || !fs.existsSync(dir)) return {};
  const out = {};
  for (const f of fs.readdirSync(dir))
    if (f.endsWith('.json'))
      out[f.slice(0, -5)] = JSON.parse(
        fs.readFileSync(path.join(dir, f), 'utf8'),
      );
  return out;
}

export function resolveRefusal(stateDir, provider) {
  const file = path.join(dirOf(stateDir), `${provider}.json`);
  const existed = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  return { provider, resolved: existed };
}
