/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CE-02.2 (#47): how many corpus and workload tokens the token numeric
// checks (scalar constraints, note §3.5) refuse.
//
//   node tools/policy/numeric-token-report.mjs [<workload id> ...]
//
// Run after `yarn build`. For each frozen CE-00.3 workload (default: all;
// `ce-corpus` carries the CE-00.2 corpus tokens, `alpha1-valid-fixture` the
// conformance system the CE-00.2 negatives use), it materializes the project
// (digest-checked), then reports:
//
//   potential  per token: the admitted rows its category may be used on
//              (the system's effective domains) whose scalar refuses its base
//              or theme value
//   actual     the diagnostics a full validation of the workload's own source
//              raises for a token value (`token-value-out-of-domain`,
//              `non-finite`) through the built Project Service
//
// It prints JSON and exits 0; it reports, it does not judge.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { loadWorkloads, materialize } from '../baselines/workloads.mjs';

const REPO = path.resolve(new URL('../..', import.meta.url).pathname);
const require = createRequire(import.meta.url);
const inspection = require(
  path.join(REPO, '.pms-test-support/compiler-inspection.cjs'),
);

const ids = process.argv.slice(2);
const record = loadWorkloads();
const workloads =
  ids.length === 0
    ? record.workloads
    : ids.map((id) => record.workloads.find((w) => w.id === id));

// Materialized projects live under the repository so that
// `@pandamstyle/compiler/config` resolves to this workspace's build.
fs.mkdirSync(path.join(REPO, 'out-pandamstyle'), { recursive: true });
const scratch = fs.mkdtempSync(
  path.join(REPO, 'out-pandamstyle', 'ce022-token-report-'),
);

function potential(definition) {
  const ds = inspection.buildDesignSystem(definition);
  const rows = Object.values(ds.snapshot.properties.descriptors).filter(
    (row) => row.domain != null && row.domain.tokens.length > 0,
  );
  const tokens = Object.keys(ds.registry.tokens);
  const refused = [];
  let withFacts = 0;
  for (const tokenId of tokens) {
    if (inspection.numericFactsOf(ds.registry, tokenId).length > 0) {
      withFacts += 1;
    }
    const { category } = ds.registry.tokens[tokenId];
    const on = [];
    for (const row of rows) {
      if (!row.domain.tokens.includes(category)) continue;
      const verdict = inspection.tokenValueRefusal(
        ds.registry,
        row.key,
        tokenId,
      );
      if (verdict != null) {
        on.push({
          property: row.key,
          reason: verdict.reason,
          cause: verdict.cause ?? null,
          theme: verdict.theme,
        });
      }
    }
    if (on.length > 0) refused.push({ tokenId, category, on });
  }
  return { tokens: tokens.length, withFacts, refused };
}

async function actual(lib, root, definition) {
  const session = lib.createProjectSession({
    rootDir: root,
    definition,
    roots: ['src'],
    outDir: path.join(root, 'generated'),
    designSystemFile: 'design.pandamstyle.js',
  });
  try {
    const init = await session.initialize();
    const validation = await session.validate(init.revision);
    const diagnostics = validation.diagnostics ?? [];
    const tokenValue = diagnostics.filter((d) =>
      ['token-value-out-of-domain', 'non-finite'].includes(d.context?.reason),
    );
    const byCode = {};
    for (const d of diagnostics) {
      const key = `${d.code}/${d.rule}`;
      byCode[key] = (byCode[key] ?? 0) + 1;
    }
    return {
      ok: validation.ok,
      diagnostics: diagnostics.length,
      byCode,
      tokenValueRefusals: tokenValue.length,
      examples: tokenValue.slice(0, 5).map((d) => ({
        file: path.relative(root, d.location?.file ?? ''),
        line: d.location?.line ?? null,
        property: d.context.property,
        tokenId: d.context.tokenId,
        reason: d.context.reason,
      })),
    };
  } finally {
    await session.close?.();
  }
}

async function main() {
  const lib = await import(
    pathToFileURL(path.join(REPO, 'packages/compiler/lib/index.mjs')).href
  );
  const report = [];
  try {
    for (const workload of workloads) {
      const root = path.join(scratch, workload.id);
      fs.mkdirSync(root, { recursive: true });
      const { digest } = materialize(workload, path.join(root, 'p'));
      const project = path.join(root, 'p');
      const definition = (
        await import(pathToFileURL(path.join(project, 'design.mjs')).href)
      ).default;
      report.push({
        workload: workload.id,
        digest,
        potential: potential(definition),
        actual: await actual(lib, project, definition),
      });
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  process.stdout.write(
    `${JSON.stringify({ node: process.version, report }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exit(1);
});
