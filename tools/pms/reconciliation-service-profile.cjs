/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

async function main() {
  const repo = path.resolve(__dirname, '../..');
  const corpus = path.resolve(process.argv[2]);
  const evidence = path.resolve(process.argv[3]);
  const root = path.join(repo, '.pms-bench/reconciliation-service-project');
  fs.rmSync(root, { recursive: true, force: true });
  fs.cpSync(corpus, root, { recursive: true });
  const scope = path.join(root, 'node_modules/@pandamstyle');
  fs.mkdirSync(scope, { recursive: true });
  fs.symlinkSync(
    path.join(repo, 'packages/compiler'),
    path.join(scope, 'compiler'),
  );
  const compiler = require(
    path.join(repo, '.pms-test-support/compiler-inspection.cjs'),
  );
  const raw = require(path.join(root, 'pandamstyle.config.js'));
  const input = await import(
    pathToFileURL(path.resolve(root, raw.definition)).href
  );
  const definition = input.default ?? input;
  const out = path.resolve(root, raw.outDir);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(corpus, 'corpus-manifest.json'), 'utf8'),
  );
  const durations = {};
  const counts = {};
  const collector = {
    addDuration(name, ns) {
      durations[name] = (durations[name] ?? 0) + ns;
    },
    addCount(name, n = 1) {
      counts[name] = (counts[name] ?? 0) + n;
    },
    addParse() {},
    sampleMemory() {},
  };
  const stop = compiler.installPerfCollector(collector);
  const measurements = [];
  async function timed(scenario, operation, fn) {
    for (const key of Object.keys(durations)) delete durations[key];
    for (const key of Object.keys(counts)) delete counts[key];
    const start = process.hrtime.bigint();
    const value = await fn();
    measurements.push({
      scenario,
      operation,
      wallMs: Number(process.hrtime.bigint() - start) / 1e6,
      counters: { ...counts },
      durationsMs: Object.fromEntries(
        Object.entries(durations).map(([k, v]) => [k, v / 1e6]),
      ),
    });
    return value;
  }
  const project = compiler.createPublicProjectSession({
    ...raw,
    projectId: 'reconciliation-c10000',
    rootDir: root,
    roots: raw.roots.map((r) => path.resolve(root, r)),
    definition,
    outDir: out,
  });
  const host = compiler.createHostBridge(project);
  try {
    const initial = await project.initialize();
    assert.equal((await project.validate(initial.revision)).ok, true);
    await project.compile(initial.revision);
    const page = path.join(root, 'src/components/Component0.tsx');
    const before = fs.readFileSync(page, 'utf8');
    const from = before.match(/token\('(spacing\.[^']+)'\)/)?.[1];
    const to = Object.keys(definition.tokens.spacing)
      .map((key) => `spacing.${key}`)
      .find(
        (id) =>
          id !== from &&
          definition.tokens.spacing[id.slice(8)].visibility !== 'private',
      );
    assert.ok(from != null && to != null);
    const after = before.replace(`token('${from}')`, `token('${to}')`);
    assert.notEqual(after, before);
    fs.writeFileSync(page, after);
    const transaction = (baseRevision, extras = {}) => ({
      baseRevision,
      mode: 'verified-explicit',
      changed: [],
      added: [],
      removed: [],
      renamed: [],
      ...extras,
    });
    const applied = await timed('local-style', 'applyChanges', () =>
      project.applyChanges(
        transaction(initial.revision, {
          changed: ['src/components/Component0.tsx'],
        }),
      ),
    );
    const validated = await timed('local-style', 'validate', () =>
      project.validate(applied.revision),
    );
    assert.equal(validated.ok, true);
    await timed('local-style', 'readArtifact', () =>
      host.readArtifact(applied.revision, 'src/components/Component0.tsx'),
    );
    const prepared = await timed('local-style', 'preparePublication', () =>
      host.preparePublication(applied.revision),
    );
    const localReceipt = await timed('local-style', 'commitPrepared', () =>
      host.commitPrepared(prepared),
    );
    const key = Object.keys(definition.tokens.spacing).find(
      (name) =>
        definition.tokens.spacing[name].value != null &&
        definition.tokens.spacing[name].visibility !== 'private',
    );
    assert.ok(key != null);
    const changedDefinition = {
      ...definition,
      tokens: {
        ...definition.tokens,
        spacing: {
          ...definition.tokens.spacing,
          [key]: { ...definition.tokens.spacing[key], value: '999px' },
        },
      },
    };
    const global = await timed('global-ds', 'applyChanges', () =>
      project.applyChanges(
        transaction(applied.revision, { definition: changedDefinition }),
      ),
    );
    assert.equal(global.revision.revisionId, applied.revision.revisionId + 1);
    const globalValidation = await timed('global-ds', 'validate', () =>
      project.validate(global.revision),
    );
    assert.equal(globalValidation.ok, true);
    const ticket = await timed('global-ds', 'preparePublication', () =>
      host.preparePublication(global.revision),
    );
    const globalReceipt = await timed('global-ds', 'commitPrepared', () =>
      host.commitPrepared(ticket),
    );
    assert.ok(globalReceipt.generationId > localReceipt.generationId);
    const globalCounts = {};
    const globalTimes = {};
    for (const m of measurements.filter((v) => v.scenario === 'global-ds')) {
      for (const [name, n] of Object.entries(m.counters))
        globalCounts[name] = (globalCounts[name] ?? 0) + n;
      for (const [name, n] of Object.entries(m.durationsMs))
        globalTimes[name] = (globalTimes[name] ?? 0) + n;
    }
    assert.equal(globalCounts.design_system_builds, 1);
    assert.equal(globalCounts.full_fallback, 1);
    assert.equal(globalCounts.generation_materialized, 1);
    const metadata = JSON.parse(
      fs.readFileSync(path.join(out, 'artifacts.json'), 'utf8'),
    );
    const contents = Object.fromEntries(
      Object.entries(metadata.artifacts).map(([name, r]) => [
        name,
        fs.readFileSync(path.join(out, r.file), 'utf8'),
      ]),
    );
    assert.equal(compiler.validateArtifactSet(metadata, contents), true);
    const bytes = Object.fromEntries(
      Object.entries(metadata.artifacts).map(([name, r]) => [name, r.bytes]),
    );
    bytes.artifactMetadata = fs.statSync(path.join(out, 'artifacts.json')).size;
    fs.mkdirSync(evidence, { recursive: true });
    const identity = {
      testedCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim(),
      testedTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim(),
    };
    const report = {
      documentKind: 'pandamstyle-reconciliation-public-service-performance',
      ...identity,
      corpus: {
        name: manifest.name,
        contentHash: manifest.contentHash,
        parameters: manifest.parameters,
        counts: manifest.counts,
      },
      iterations: 1,
      measurements,
      global: {
        rebuilds: globalCounts.design_system_builds,
        fullFallbacks: globalCounts.full_fallback,
        commits: globalCounts.generation_materialized,
        snapshotBuildMs: globalTimes.ds_snapshot_build_ms,
        declarationGenerationMs: globalTimes.ds_types_codegen_ms,
        artifactSetGenerationMs: globalTimes.ds_artifact_set_ms,
        phaseTimesMs: globalTimes,
        bytes,
        totalCanonicalBytes: Object.values(bytes).reduce((a, b) => a + b, 0),
        receipt: globalReceipt,
        artifactSet: metadata,
      },
      limitations: [
        'One public service sample for local style and global DS mutation; no wrapper confidence interval or causal timing claim.',
        'Canonical set validation reads a bounded five-member set before commit; it does not scan the page output tree.',
      ],
    };
    fs.writeFileSync(
      path.join(evidence, 'service-performance.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
    for (const [name, r] of Object.entries(metadata.artifacts))
      fs.copyFileSync(
        path.join(out, r.file),
        path.join(evidence, `${name}.txt`),
      );
    fs.copyFileSync(
      path.join(out, 'artifacts.json'),
      path.join(evidence, 'artifact-set.json'),
    );
  } finally {
    await project.close();
    stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
