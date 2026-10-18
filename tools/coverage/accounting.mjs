/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Corpus accounting: every declaration of every reference stylesheet of the
// CE-00.2 corpus, classified against the Alpha 1 policy and bound to its
// CE-00.1 registry entry. The result is committed as accounting.v1.json and
// re-derived by the corpus validator.

import fs from 'node:fs';
import path from 'node:path';
import { REPO, tally } from './classify.mjs';
import { countSet, extractSet } from './declaration-set.mjs';

export const CORPUS = 'tests/core-evolution/corpus/corpus.v1.json';
export const ACCOUNTING = 'tests/core-evolution/corpus/accounting.v1.json';

// `overrides` maps a repository path to replacement text (validator self-test).
export function buildAccounting(corpus, policy, registry, overrides = {}) {
  const stylesheets = [];
  for (const fixture of corpus.fixtures) {
    for (const file of fixture.expectedCss.stylesheets) {
      const css =
        overrides?.[file] ?? fs.readFileSync(path.join(REPO, file), 'utf8');
      const set = extractSet({
        css,
        inputId: `${fixture.id}/${path.basename(file, '.css')}`,
        sourcePath: file,
        header: {},
        policy,
        registry,
      });
      stylesheets.push({
        fixtureId: fixture.id,
        path: file,
        sha256: set.input.sha256,
        counts: set.counts,
        declarations: set.declarations,
      });
    }
  }
  const all = stylesheets.flatMap((s) => s.declarations);
  const capabilityOf = (d) =>
    d.registry.entry == null
      ? null
      : registry.byName.get(d.registry.entry).capability;
  return {
    schemaVersion: 1,
    kind: 'core-evolution-corpus-accounting',
    task: 'CE-00.2',
    generatedBy: 'node tools/coverage/cli.mjs corpus',
    statement:
      'Every declaration of every corpus reference stylesheet, classified against the pinned Alpha 1 policy and bound to its CE-00.1 registry entry. Expressible is a policy statement, not compiler acceptance or rendering evidence.',
    registryVersion: registry.version,
    totals: {
      ...countSet(all),
      registryEntriesExercised: tally(all, (d) => d.registry.entry ?? null),
      capabilitiesExercised: tally(all, capabilityOf),
    },
    stylesheets,
  };
}

export function serializeAccounting(accounting) {
  const { stylesheets, ...header } = accounting;
  const head = JSON.stringify(header, null, 2).replace(/\n\}$/, '');
  const sheets = stylesheets.map((s) => {
    const { declarations, ...meta } = s;
    const metaText = JSON.stringify(meta, null, 2)
      .replace(/\n\}$/, '')
      .replace(/\n/g, '\n    ');
    const body = declarations
      .map((d) => `        ${JSON.stringify(d)}`)
      .join(',\n');
    return `    ${metaText},\n      "declarations": [\n${body}\n      ]\n    }`;
  });
  return `${head},\n  "stylesheets": [\n${sheets.join(',\n')}\n  ]\n}\n`;
}
