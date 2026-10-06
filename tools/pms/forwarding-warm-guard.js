/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

// Small semantic-cost guard. Writes and initialization are outside the timer.
const fs = require('fs');
const {
  openProject,
} = require('../../packages/compiler/__tests__/pandamstyle/session-helpers');
const samples = {};
const named =
  "export { create, token, props, themes } from '../generated/design.pandamstyle';\n";
const renamed =
  "export { create as css, token, props, themes } from '../generated/design.pandamstyle';\n";
for (let repeat = 0; repeat < 3; repeat++) {
  const h = openProject('valid');
  const relay = h.src('src/guard-relay.js');
  fs.writeFileSync(relay, named);
  fs.writeFileSync(
    h.src('src/guard-consumer.js'),
    "import { create, token } from './guard-relay';\nexport const s = create({ a: { padding: token('spacing.md') } });\n",
  );
  h.session.initialize();
  h.session.validate();
  const measure = (name, file, text) => {
    fs.writeFileSync(file, text);
    const start = process.hrtime.bigint();
    h.session.applyAgentChanges({
      changed: [file],
      added: [],
      removed: [],
      renamed: [],
    });
    const validation = h.session.validate();
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    (samples[name] ??= []).push({ ms, ok: validation.ok });
  };
  const page = h.src('src/page.tsx');
  measure(
    'direct_local_style_edit',
    page,
    fs.readFileSync(page, 'utf8').replace('spacing.md', 'spacing.sm'),
  );
  measure(
    'named_relay_edit',
    relay,
    named.replace('themes }', 'themes, manifest }'),
  );
  measure('renamed_relay_edit', relay, renamed);
  measure('relay_removal', relay, 'export const ordinary = 1;\n');
  measure('relay_restoration', relay, named);
}
const result = Object.fromEntries(
  Object.entries(samples).map(([name, runs]) => [
    name,
    {
      runs,
      medianMs: runs.map((r) => r.ms).sort((a, b) => a - b)[1],
    },
  ]),
);
process.stdout.write(
  JSON.stringify(
    {
      boundary: 'applyAgentChanges + validate; warm session; no publication',
      repetitions: 3,
      samples: result,
    },
    null,
    2,
  ) + '\n',
);
