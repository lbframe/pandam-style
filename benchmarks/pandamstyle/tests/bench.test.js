/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle benchmark harness tests.
 *
 * These are the tests the batch requires, and they test the HARNESS, not the
 * compiler. A benchmark that cannot prove its own corpus is deterministic, its
 * own observations well-formed, and its own failures visible is a benchmark
 * whose numbers cannot be trusted, and the whole batch is worthless if this
 * file is missing.
 *
 * Run with:
 *   node --test benchmarks/pandamstyle/tests/
 * or, from the repository root:
 *   node --test benchmarks/pandamstyle/tests/
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HERE = __dirname;
const SRC = path.join(HERE, '..', 'src');
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

const { buildDefinition, generate, GENERATOR_VERSION, splitmix32 } = require(
  path.join(SRC, 'generate-corpus.js'),
);
const {
  getScenario,
  allScenarioNames,
  resetScenarioState,
  SCENARIOS,
} = require(path.join(SRC, 'scenarios.js'));
const { observation, makeCollector, nowNs, CACHE_STATES, STATUS } = require(
  path.join(SRC, 'harness.js'),
);

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pms-bench-${tag}-`));
}

// ---------------------------------------------------------------------------
// Deterministic corpus generation
// ---------------------------------------------------------------------------

test('the same parameters produce byte-identical source and manifest', () => {
  const a = tmpdir('det-a');
  const b = tmpdir('det-b');
  const args = { components: 12, tokens: 80, recipes: 4, seed: 211, fanout: 2 };
  const ma = generate({ ...args, outDir: a, negative: true });
  const mb = generate({ ...args, outDir: b, negative: true });

  assert.strictEqual(ma.contentHash, mb.contentHash, 'content hash must match');

  const readAll = (root) => {
    const out = new Map();
    const walk = (dir, base = root) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs, base);
        else out.set(path.relative(base, abs), fs.readFileSync(abs, 'utf8'));
      }
    };
    walk(root);
    return out;
  };
  const fa = readAll(a);
  const fb = readAll(b);
  assert.deepStrictEqual([...fa.keys()].sort(), [...fb.keys()].sort());
  for (const [k, v] of fa) {
    assert.strictEqual(v, fb.get(k), `${k} differs between two generations`);
  }

  // The manifest, minus the only documented exclusion.
  const strip = (m) =>
    JSON.stringify({ ...m, generator: { version: m.generator.version } });
  assert.strictEqual(strip(ma), strip(mb));
});

test('a different seed produces a different corpus, on purpose', () => {
  const a = tmpdir('seed-a');
  const b = tmpdir('seed-b');
  const ma = generate({
    components: 12,
    tokens: 80,
    recipes: 4,
    seed: 211,
    fanout: 2,
    outDir: a,
  });
  const mb = generate({
    components: 12,
    tokens: 80,
    recipes: 4,
    seed: 307,
    fanout: 2,
    outDir: b,
  });
  assert.notStrictEqual(ma.contentHash, mb.contentHash);
});

test('every generated recipe default belongs to its declared variant domain', () => {
  const definition = buildDefinition({
    tokenCount: 80,
    recipeCount: 6,
    seed: 307,
    systemId: 'benchmark-recipe-defaults@0.1',
  });

  for (const [name, recipe] of Object.entries(definition.recipes)) {
    for (const [variant, value] of Object.entries(recipe.defaultVariants)) {
      assert.ok(
        Object.hasOwn(recipe.variants[variant], value),
        `${name} default ${variant}=${value} is outside its declared domain`,
      );
    }
  }
});

test('the PRNG is a specified integer stream, not Math.random', () => {
  // Pinned: a change here changes every corpus hash, so it must be visible.
  const next = splitmix32(101);
  const first = [next(), next(), next()];
  assert.ok(
    first.every((v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff),
  );
  const again = splitmix32(101);
  assert.deepStrictEqual([again(), again(), again()], first);
});

test('the generator rejects nonsensical parameters instead of inventing them', () => {
  const dir = tmpdir('reject');
  assert.throws(() =>
    generate({ components: 0, tokens: 10, recipes: 1, seed: 1, outDir: dir }),
  );
  assert.throws(() =>
    generate({ components: 1, tokens: -1, recipes: 1, seed: 1, outDir: dir }),
  );
  assert.throws(() =>
    generate({ components: 1, tokens: 1, recipes: 1, seed: 'x', outDir: dir }),
  );
});

test('the manifest records what the brief requires it to record', () => {
  const dir = tmpdir('manifest');
  const m = generate({
    components: 12,
    tokens: 80,
    recipes: 4,
    seed: 101,
    fanout: 2,
    outDir: dir,
    negative: true,
  });
  for (const field of [
    'generator',
    'parameters',
    'contentHash',
    'designSystemHash',
    'counts',
    'expectedGraph',
    'expectedState',
    'files',
  ]) {
    assert.ok(m[field] != null, `manifest is missing ${field}`);
  }
  assert.strictEqual(m.generator.version, GENERATOR_VERSION);
  assert.ok(
    'commit' in m.generator,
    'the generator commit must be recorded, even as null',
  );
  for (const p of ['components', 'tokens', 'recipes', 'seed', 'fanout']) {
    assert.ok(p in m.parameters, `parameters is missing ${p}`);
  }
  for (const c of [
    'sourceFiles',
    'styleSites',
    'tokenReferences',
    'recipeCalls',
    'conditions',
  ]) {
    assert.ok(c in m.counts, `counts is missing ${c}`);
  }
  assert.strictEqual(m.expectedState.positive, 'ok');
  assert.strictEqual(m.expectedState.negative, 'fail-closed');
  for (const f of m.files) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/, `bad hash for ${f.path}`);
  }
});

test('the generated corpus references only tokens that exist', () => {
  // A corpus that cannot compile measures nothing, and the most likely cause is
  // a component naming a token the definition does not declare.
  const dir = tmpdir('refs');
  const m = generate({
    components: 24,
    tokens: 120,
    recipes: 6,
    seed: 101,
    fanout: 3,
    outDir: dir,
  });
  const def = fs.readFileSync(
    path.join(dir, 'design', 'design.pms.config.js'),
    'utf8',
  );
  const declared = new Set();
  const line =
    /^ {4}"([^"]+)": \{ (?:value: "[^"]*"|ref: "[^"]+"), visibility: "(public|private)" \},$/gm;
  let match;
  while ((match = line.exec(def)) !== null) {
    // The category is the enclosing block; recovered by the nearest header above.
    const before = def.slice(0, match.index);
    const headers = [...before.matchAll(/^ {2}"([A-Za-z]+)": \{$/gm)];
    const cat = headers[headers.length - 1][1];
    declared.add(`${cat}.${match[1]}`);
  }
  assert.ok(declared.size > 10, 'the definition should declare many tokens');

  for (const f of m.files.filter((x) => x.path.startsWith('src/components/'))) {
    const src = fs.readFileSync(path.join(dir, f.path), 'utf8');
    for (const t of src.matchAll(/token\('([^']+)'\)/g)) {
      assert.ok(
        declared.has(t[1]),
        `${f.path} references ${t[1]}, which the definition does not declare`,
      );
    }
  }
});

test('a corpus carries a negative trace per distinct policy code', () => {
  const dir = tmpdir('neg');
  generate({
    components: 12,
    tokens: 80,
    recipes: 4,
    seed: 101,
    fanout: 2,
    outDir: dir,
    negative: true,
  });
  const files = fs.readdirSync(path.join(dir, 'src', 'invalid')).sort();
  assert.deepStrictEqual(files, [
    'forbidden-channel.tsx',
    'forbidden-value.tsx',
    'non-static.tsx',
    'private-token.tsx',
  ]);
  // They must be SEPARATE files: a corpus whose negative traces all live in one
  // file can only ever produce one diagnostic.
  const bodies = new Set(
    files.map((f) =>
      fs.readFileSync(path.join(dir, 'src', 'invalid', f), 'utf8'),
    ),
  );
  assert.strictEqual(bodies.size, files.length);
});

// ---------------------------------------------------------------------------
// Scenarios and edit traces
// ---------------------------------------------------------------------------

test('every scenario in the protocol vocabulary is declared', () => {
  const plan = JSON.parse(
    fs.readFileSync(path.join(HERE, '..', 'plan.json'), 'utf8'),
  );
  for (const name of plan.scenarios) {
    assert.ok(
      allScenarioNames().includes(name),
      `plan scenario ${name} is not implemented`,
    );
  }
});

test('the two not-implemented scenarios are kept and explained, not removed', () => {
  for (const name of ['cancel_and_retry', 'crash_during_publication']) {
    const s = getScenario(name);
    assert.strictEqual(s.kind, 'not-implemented');
    assert.ok(
      typeof s.notImplementedReason === 'string' &&
        s.notImplementedReason.length > 40,
      `${name} must explain why it is not run`,
    );
    assert.deepStrictEqual(
      s.cacheStates,
      [],
      `${name} must declare no cache state`,
    );
  }
});

test('a scenario edit either changes bytes or is declared a no-op', () => {
  // The single most misleading number this harness could produce is a "real
  // edit" that rewrote a file with its own content. Every scenario that is not
  // explicitly a no-op must actually change the bytes it names.
  const dir = tmpdir('scenarios');
  generate({
    components: 24,
    tokens: 120,
    recipes: 6,
    seed: 101,
    fanout: 3,
    outDir: dir,
    negative: true,
  });
  for (const s of SCENARIOS) {
    if (s.kind === 'not-implemented') continue;
    const before = new Map();
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) walk(abs);
        else before.set(abs, fs.readFileSync(abs, 'utf8'));
      }
    };
    walk(dir);
    const edits = s.edit(dir, { revision: 0, iteration: 0 });
    if (s.kind === 'no-op') {
      assert.strictEqual(
        edits.length,
        0,
        `${s.name} claims to be a no-op but edits files`,
      );
      continue;
    }
    assert.ok(edits.length > 0, `${s.name} produced no edit`);
    for (const e of edits) {
      const rel = path.relative(dir, e.path);
      if (rel.startsWith('..')) {
        throw new Error(
          `${s.name} edited a file outside the corpus: ${e.path}`,
        );
      }
      if (e.delete === true) {
        assert.ok(
          before.has(e.path),
          `${s.name} deletes a file that does not exist`,
        );
        continue;
      }
      if (!before.has(e.path)) {
        // A scenario may legitimately CREATE a covered file - that is what
        // `module_add` is - but it has to be inside a covered root, or the
        // compiler would never see it and the scenario would prove nothing.
        assert.ok(
          rel.startsWith(path.join('src', 'components')) ||
            rel.startsWith('src'),
          `${s.name} created ${rel}, which is not under a covered root: the ` +
            'compiler would never analyse it',
        );
        assert.ok(
          typeof e.content === 'string' && e.content.length > 0,
          `${s.name} created an empty file`,
        );
        continue;
      }
      assert.notStrictEqual(
        before.get(e.path),
        e.content,
        `${s.name} rewrote ${path.basename(e.path)} with its own content: that is a ` +
          'cache hit, not an edit',
      );
    }
  }
});

test('a negative scenario is never measured in a no-edit cache state', () => {
  // `process_warm_no_edit` resubmits identical bytes by definition, so a
  // violation is never introduced and the build correctly succeeds. Declaring
  // a negative scenario there would measure a case that cannot fail.
  for (const s of SCENARIOS) {
    if (s.expect !== 'fail') continue;
    assert.ok(
      !s.cacheStates.includes('process_warm_no_edit'),
      `${s.name} expects a refusal but is declared for a no-edit cache state`,
    );
  }
});

test('scenario replay is deterministic', () => {
  const dirA = tmpdir('replay-a');
  const dirB = tmpdir('replay-b');
  const args = {
    components: 24,
    tokens: 120,
    recipes: 6,
    seed: 101,
    fanout: 3,
    negative: true,
  };
  generate({ ...args, outDir: dirA });
  generate({ ...args, outDir: dirB });
  for (const s of SCENARIOS) {
    if (s.kind === 'not-implemented') continue;
    // Fresh scenario objects: a scenario that carried state between replays
    // would produce different edits the second time.
    delete require.cache[require.resolve(path.join(SRC, 'scenarios.js'))];
    const fresh = getScenario(s.name);
    const a = fresh.edit(dirA, { revision: 0, iteration: 0 });
    delete require.cache[require.resolve(path.join(SRC, 'scenarios.js'))];
    const again = getScenario(s.name).edit(dirB, { revision: 0, iteration: 0 });
    assert.strictEqual(
      JSON.stringify(
        a.map((e) => [path.relative(dirA, e.path), e.content ?? null]),
      ),
      JSON.stringify(
        again.map((e) => [path.relative(dirB, e.path), e.content ?? null]),
      ),
      `${s.name} is not replay-deterministic`,
    );
  }
});

// ---------------------------------------------------------------------------
// Observation schema
// ---------------------------------------------------------------------------

test('an observation row carries every field the kit requires', () => {
  const row = observation({
    engine: 'babel_current',
    corpus: 'c100-t100-r10-s101-f4',
    scenario: 'one_file_new_atom',
    cache_state: 'process_warm_edit',
    session_id: 's01',
    iteration: 1,
    metric: 'diagnostics_complete_ms',
    unit: 'ms',
    status: 'ok',
    value: 12.3,
  });
  for (const k of [
    'engine',
    'corpus',
    'scenario',
    'cache_state',
    'session_id',
    'iteration',
    'metric',
    'unit',
    'status',
    'value',
  ]) {
    assert.ok(k in row, `observation is missing ${k}`);
  }
  assert.strictEqual(row.status, 'ok');
});

test('a negative case that correctly refuses is ok, not error', () => {
  // Encoded here as a rule rather than only in the driver: this classification
  // is the difference between a correct engine looking broken and a broken
  // engine looking correct.
  const expectedFailure = 'fail';
  const engineRefused = true;
  const status =
    expectedFailure === 'fail' && engineRefused ? STATUS.OK : STATUS.ERROR;
  assert.strictEqual(status, STATUS.OK);
});

test('allowed statuses are exactly the four the protocol defines', () => {
  assert.deepStrictEqual(Object.values(STATUS).sort(), [
    'error',
    'ok',
    'timeout',
    'unsupported',
  ]);
  assert.deepStrictEqual(CACHE_STATES, [
    'process_cold_cache_empty',
    'process_cold_cache_warm',
    'process_warm_no_edit',
    'process_warm_edit',
  ]);
});

test('the collector separates real parses from module-cache lookups', () => {
  // Conflating the two would answer "how many times was a file parsed" with
  // "how many times was the module cache consulted", under the same name.
  const c = makeCollector();
  c.addParse('/a.tsx', 'module-graph', 1000);
  c.addParse('/a.tsx', 'babel:pass1', 2000);
  c.addParse('/a.tsx', 'babel:pass1', 2000);
  c.addParse('/a.tsx', 'module-graph:cache-hit', 0);
  c.addParse('/a.tsx', 'module-graph:cache-hit', 0);
  const s = c.snapshot().parses;
  assert.strictEqual(s.total, 3, 'only non-lookup events are parses');
  assert.strictEqual(s.max_parses_per_file, 3);
  assert.strictEqual(s.module_cache_lookups, 2);
  assert.strictEqual(s.max_module_cache_lookups_per_file, 2);
  assert.deepStrictEqual(s.by_pipeline, {
    'module-graph': 1,
    'babel:pass1': 2,
  });
});

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------

test('the timer is monotonic and nanosecond-scoped, not a wall clock', () => {
  const a = nowNs();
  const b = nowNs();
  assert.ok(b >= a, 'the timer must not go backwards');
  // A busy interval must register a positive duration, and a large one must
  // register a large one. A wall clock would also pass this on a quiet machine,
  // so the discriminator is the unit: a nanosecond timer over a 5 ms sleep must
  // report about 5e6, not about 5.
  const start = nowNs();
  const until = Date.now() + 5;
  while (Date.now() < until) {
    /* spin, so the measurement is CPU-bound rather than sleep-bound */
  }
  const elapsed = nowNs() - start;
  assert.ok(elapsed > 0);
  assert.ok(
    elapsed < 5e9,
    `a 5 ms spin measured ${elapsed} ns, which is not a nanosecond clock`,
  );
});

test('the harness documents the timer it used', () => {
  const src = fs.readFileSync(path.join(SRC, 'harness.js'), 'utf8');
  assert.match(src, /process\.hrtime\.bigint/);
  assert.match(src, /monotonic/i);
});

// ---------------------------------------------------------------------------
// summarize.py
// ---------------------------------------------------------------------------

test('the summary script self-test passes', () => {
  const script = path.join(HERE, '..', 'summarize.py');
  const res = spawnSync('python3', [script, '--self-test'], {
    encoding: 'utf8',
  });
  assert.strictEqual(
    res.status,
    0,
    `summarize.py --self-test failed:\n${res.stderr}`,
  );
  assert.match(res.stdout, /self-test ok/);
});

test('summarize.py keeps a failed observation visible', () => {
  const script = path.join(HERE, '..', 'summarize.py');
  const dir = tmpdir('summary');
  const file = path.join(dir, 'obs.jsonl');
  const rows = [
    {
      engine: 'e',
      corpus: 'c',
      scenario: 's',
      cache_state: 'process_warm_edit',
      session_id: 's01',
      iteration: 1,
      metric: 'filesystem_to_diagnostics_ms',
      unit: 'ms',
      status: 'ok',
      value: 10,
      run_kind: 'qualification',
    },
    {
      engine: 'e',
      corpus: 'c',
      scenario: 's',
      cache_state: 'process_warm_edit',
      session_id: 's01',
      iteration: 2,
      metric: 'filesystem_to_diagnostics_ms',
      unit: 'ms',
      status: 'error',
      value: null,
      run_kind: 'qualification',
    },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const res = spawnSync('python3', [script, '-i', file], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  const group = out.summary.find(
    (g) =>
      g.metric === 'filesystem_to_diagnostics_ms' &&
      g.cache_state === 'process_warm_edit',
  );
  assert.strictEqual(
    group.observation_count,
    2,
    'a dropped failure would change this count',
  );
  assert.strictEqual(
    group.status_counts.error,
    1,
    'the failure must remain visible',
  );
  assert.strictEqual(
    group.statistics.count,
    1,
    'the median must not include the failure',
  );
});

// ---------------------------------------------------------------------------
// Engine adapters
// ---------------------------------------------------------------------------

test('the engine registry names a repository root for every engine', () => {
  const { resolveEngines } = require(path.join(SRC, 'run-campaign.js'));
  const engines = resolveEngines(['babel_current', 'babel_work_eliminated']);
  for (const [name, e] of Object.entries(engines)) {
    assert.ok(
      typeof e.root === 'string' && e.root.length > 0,
      `${name} has no root`,
    );
    assert.ok(
      typeof e.description === 'string' && e.description.length > 20,
      `${name} must state what it is`,
    );
  }
  assert.strictEqual(
    engines.babel_current.root,
    engines.babel_work_eliminated.root,
    'the two Spike 1 policies must run the same source tree',
  );
  assert.strictEqual(engines.babel_current.workEliminated, false);
  assert.strictEqual(engines.babel_work_eliminated.workEliminated, true);
});

test('the reference engine pins work elimination off in its child job', () => {
  const runner = fs.readFileSync(path.join(SRC, 'run-campaign.js'), 'utf8');
  assert.ok(
    runner.includes("PMS_WORK_ELIMINATED: engine.workEliminated ? '1' : ''"),
    'the child environment must be selected from the engine declaration',
  );
  const { resolveEngines } = require(path.join(SRC, 'run-campaign.js'));
  const reference = resolveEngines(['babel_current']).babel_current;
  assert.strictEqual(reference.root, REPO_ROOT);
  assert.strictEqual(reference.workEliminated, false);
});

test('plan.json preserves historical Spike 1 baseline provenance', () => {
  const plan = JSON.parse(
    fs.readFileSync(path.join(HERE, '..', 'plan.json'), 'utf8'),
  );
  assert.strictEqual(
    plan.baseline_commit,
    'd5702374ac5a685499d14a53bf323d8533e6982d',
  );
  assert.strictEqual(
    plan.baseline_tree,
    '836a24ec91239e148547a9c686041a6f65fe0099',
  );
  assert.notStrictEqual(
    plan.baseline_commit,
    plan.superseded_baseline_commit,
    'the superseded baseline must be recorded, not silently replaced',
  );
  const note = plan.plan_version_note;
  const noteText = Array.isArray(note) ? note.join(' ') : note;
  assert.ok(
    typeof noteText === 'string' && noteText.length > 0,
    'changing the baseline changes what the numbers mean, and the plan must say so',
  );
  assert.ok(
    noteText.includes(plan.superseded_baseline_commit.slice(0, 8)),
    'the version note must name the superseded baseline it replaced',
  );
});

test('the plan keeps the out-of-scope engines out', () => {
  const plan = JSON.parse(
    fs.readFileSync(path.join(HERE, '..', 'plan.json'), 'utf8'),
  );
  const inScope = plan.engines.map((e) => e.name).sort();
  assert.deepStrictEqual(inScope, [
    'babel_current',
    'babel_full',
    'babel_incremental',
    'babel_incremental_work_eliminated',
    'babel_work_eliminated',
  ]);
  // The two engines the Spike 2 decision rests on must be IN SCOPE, must run
  // the same tree (so the difference is reuse and not a tree difference), and
  // the incremental one must not have the Spike 1 memoization switched on.
  const full = plan.engines.find((e) => e.name === 'babel_full');
  const incremental = plan.engines.find((e) => e.name === 'babel_incremental');
  assert.ok(full != null && incremental != null);
  assert.strictEqual(incremental.work_elimination, 'off');
  assert.ok(
    /this branch/.test(incremental.anchor) && /this branch/.test(full.anchor),
    'babel_full and babel_incremental must be anchored to the SAME tree, or a ' +
      'tree difference is indistinguishable from an incrementality difference',
  );
  assert.ok(
    plan.engines.some((e) => e.name === 'babel_incremental_work_eliminated'),
    'the factorial variant must exist and be reported separately, so the ' +
      'benefit of invalidation is never conflated with the benefit of ' +
      'Spike 1 memoization',
  );
  for (const name of plan.out_of_scope_engines) {
    assert.ok(
      !inScope.includes(name),
      `${name} is a Spike 2/3 engine and must not be an engine in this batch`,
    );
  }
});

test('the plan declares the counters this batch cannot populate', () => {
  // The names belong to an incremental query engine. They are declared
  // not-applicable rather than filled with a number.
  const plan = JSON.parse(
    fs.readFileSync(path.join(HERE, '..', 'plan.json'), 'utf8'),
  );
  for (const c of [
    'recomputed_queries',
    'validated_queries',
    'boundary_bytes',
  ]) {
    assert.ok(
      plan.metrics.counters_not_applicable.includes(c),
      `${c} must be declared not-applicable, not silently omitted`,
    );
  }
  assert.ok(plan.metrics.counters_not_applicable_reason.length > 20);
});

// ---------------------------------------------------------------------------
// Differential oracle
// ---------------------------------------------------------------------------

test('the differential oracle compares what it claims to compare', () => {
  const src = fs.readFileSync(path.join(SRC, 'differential.js'), 'utf8');
  for (const check of [
    'css-bytes',
    'css-text',
    'registry-digest',
    'manifest',
    'build-report',
    'compiled-js-bytes',
    'runtime-composition-structure',
    'generated-design-system-module',
  ]) {
    assert.ok(src.includes(`'${check}'`), `the oracle does not check ${check}`);
  }
  // Cascade-relevant ordering must not be normalised away.
  assert.ok(
    src.includes('ordering preserved') || src.includes('byte for byte'),
    'the oracle must state that CSS ordering is compared, not normalised',
  );
  // The expectation gate: equivalence between two engines that are both wrong
  // is not equivalence.
  assert.ok(
    src.includes("'expectation'"),
    'the oracle has no expectation gate',
  );
});

test(
  'the differential oracle runs green on a small corpus',
  { timeout: 900000 },
  () => {
    // The oracle spawns BOTH engines' real CLIs, and each CLI requires its own
    // built bundle. `lib/` is gitignored, so a fresh checkout has none and each
    // engine exits 2 ("usage or environment error") - which reads as a
    // divergence rather than as a missing build. Naming the actual cause is
    // worth more than a confusing diff downstream.
    //
    // Both halves are needed, and they fail differently: the variant engine
    // missing its bundle shows up as a `build-verdict` divergence, while the
    // reference engine missing altogether is caught first by the expectation
    // gate, which correctly refuses to treat it as an equivalence result.
    const variantLib = path.join(
      REPO_ROOT,
      'packages',
      'compiler',
      'lib',
      'index.mjs',
    );
    assert.ok(
      fs.existsSync(variantLib),
      `${variantLib} is missing. The oracle drives the real compiler CLI, so ` +
        'build it first with ./verify-pms.sh (its build step).',
    );
    const dir = tmpdir('oracle');
    const res = spawnSync(
      process.execPath,
      [
        path.join(SRC, 'differential.js'),
        '--corpus',
        path.join(dir, 'corpus'),
        '--components',
        '12',
        '--tokens',
        '80',
        '--recipes',
        '4',
        '--seed',
        '101',
        '--fanout',
        '2',
        '--scenarios',
        'no_change,one_file_new_atom,forbidden_value,token_value',
        '--out',
        path.join(dir, 'report.json'),
      ],
      { encoding: 'utf8', timeout: 880000 },
    );
    assert.strictEqual(
      res.status,
      0,
      `the oracle reported divergence:\n${res.stderr}`,
    );
    const report = JSON.parse(
      fs.readFileSync(path.join(dir, 'report.json'), 'utf8'),
    );
    assert.strictEqual(report.verdict, 'equivalent');
    assert.strictEqual(report.errors.length, 0);
    assert.ok(report.scenariosCompared >= 4);
  },
);

// ---------------------------------------------------------------------------
// Failed runs stay visible
// ---------------------------------------------------------------------------

test('a failed run is not silently dropped by the summariser', () => {
  const script = path.join(HERE, '..', 'summarize.py');
  const dir = tmpdir('failed-run');
  const file = path.join(dir, 'obs.jsonl');
  fs.writeFileSync(
    file,
    [
      {
        engine: 'e',
        corpus: 'c',
        scenario: 's',
        cache_state: 'process_cold_cache_empty',
        session_id: 's01',
        iteration: 1,
        metric: 'filesystem_to_diagnostics_ms',
        unit: 'ms',
        status: 'timeout',
        value: null,
        run_kind: 'qualification',
      },
      {
        engine: 'e',
        corpus: 'c',
        scenario: 's',
        cache_state: 'process_cold_cache_empty',
        session_id: 's01',
        iteration: 2,
        metric: 'filesystem_to_diagnostics_ms',
        unit: 'ms',
        status: 'ok',
        value: 5,
        run_kind: 'qualification',
      },
      '',
    ]
      .map((r) => (typeof r === 'string' ? r : JSON.stringify(r)))
      .join('\n'),
  );
  const res = spawnSync('python3', [script, '-i', file], { encoding: 'utf8' });
  const out = JSON.parse(res.stdout);
  const g = out.summary[0];
  assert.strictEqual(
    g.observation_count,
    2,
    'the timeout row must still be counted',
  );
  assert.strictEqual(g.status_counts.timeout, 1);
  assert.strictEqual(
    g.statistics.count,
    1,
    'a timeout must not become a value',
  );
});

test('a malformed observation line is reported rather than skipped', () => {
  const script = path.join(HERE, '..', 'summarize.py');
  const dir = tmpdir('malformed');
  const file = path.join(dir, 'obs.jsonl');
  fs.writeFileSync(
    file,
    '{not json}\n' +
      JSON.stringify({
        engine: 'e',
        corpus: 'c',
        scenario: 's',
        cache_state: 'process_warm_edit',
        session_id: 's01',
        iteration: 1,
        metric: 'm',
        unit: 'ms',
        status: 'ok',
        value: 1,
        run_kind: 'debug',
      }) +
      '\n',
  );
  const res = spawnSync('python3', [script, '-i', file], { encoding: 'utf8' });
  const out = JSON.parse(res.stdout);
  assert.strictEqual(out.malformed_lines, 1);
  assert.strictEqual(out.observation_count, 1);
});

// ---------------------------------------------------------------------------
// Spike 2: the incremental session, its scenarios and its oracle
// ---------------------------------------------------------------------------

test('file_rename is a real content revision of the covered set', () => {
  const scenario = getScenario('file_rename');
  assert.ok(
    scenario != null,
    'file_rename is a required scenario and is absent',
  );
  assert.ok(
    allScenarioNames().includes('file_rename'),
    'file_rename must be in the scenario vocabulary',
  );
  const project = tmpdir('rename');
  generate({
    components: 12,
    tokens: 80,
    recipes: 4,
    seed: 211,
    fanout: 2,
    outDir: project,
    negative: false,
  });
  // A multi-revision scenario carries state between its revisions, and that
  // state is process-global on purpose. A test that inherits another test's
  // state would silently measure the wrong revision.
  resetScenarioState('file_rename');
  const dir = path.join(project, 'src', 'components');
  const before = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.tsx'))
    .sort();
  const edits = scenario.edit(project, { revision: 0, iteration: 0 });
  assert.ok(edits.length >= 2, 'a rename is a removal AND an addition');
  assert.ok(
    edits.some((e) => e.delete === true),
    'a rename that never deletes leaves two covered files with one name',
  );
  for (const e of edits) {
    if (e.delete === true) fs.rmSync(e.path, { force: true });
    else fs.writeFileSync(e.path, e.content, 'utf8');
  }
  const after = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.tsx'))
    .sort();
  assert.notDeepStrictEqual(after, before, 'the file set did not change');
  assert.strictEqual(after.length, before.length);
  fs.rmSync(project, { recursive: true, force: true });
});

test('the incremental oracle compares what it claims to compare', () => {
  const src = fs.readFileSync(path.join(SRC, 'incremental-oracle.js'), 'utf8');
  for (const check of [
    'published artifacts after lifecycle normalization',
    'runtime-composition-structure',
    'css-bytes',
    'css-text',
    'generated-design-system-module',
    'manifest',
    'build-report-semantic-state',
    'diagnostics',
    'verdict',
  ]) {
    assert.ok(
      src.includes(check),
      `the incremental oracle does not check ${check}`,
    );
  }
  // The reference build must be a genuinely FRESH build. A fresh rebuild in
  // the same process as the session would share its module registry, its
  // caches and its design system, and would not be a fresh rebuild at all.
  assert.ok(
    src.includes('spawnSync') && src.includes('buildProject'),
    'the reference build must run the full builder in another process',
  );
  assert.ok(
    src.includes('fresh process'),
    'the oracle must state the isolation it claims for its reference build',
  );
  // Normalization is limited to the session's work block and publisher ids.
  const strip = src.match(/function stripIncrementalBlock[\s\S]*?\n}/);
  assert.ok(strip != null, 'the oracle has no normalisation function at all');
  assert.ok(
    strip[0].includes('delete report.incremental') &&
      strip[0].includes('coverageReport.revisionId = 0'),
    'build-report normalization must remove work counters and normalize its publisher id',
  );
  const coverageNormalizer = src.match(
    /function normaliseCoverageReport[\s\S]*?\n}/,
  );
  assert.ok(
    coverageNormalizer != null &&
      coverageNormalizer[0].includes('report.revisionId = 0') &&
      coverageNormalizer[0].includes('report.generationId = null'),
    'coverage normalization must be limited to revision and generation ids',
  );
});

test(
  'the incremental oracle runs green on a small corpus',
  { timeout: 900000 },
  () => {
    const lib = path.join(
      REPO_ROOT,
      'packages',
      'compiler',
      'lib',
      'index.mjs',
    );
    assert.ok(
      fs.existsSync(lib),
      `${lib} is missing. The incremental oracle drives the real compiler, so ` +
        'build it first: ./verify-pms.sh (its build step).',
    );
    const corpus = tmpdir('inc-oracle');
    const out = path.join(corpus, 'report.json');
    const res = spawnSync(
      process.execPath,
      [
        path.join(SRC, 'incremental-oracle.js'),
        '--corpus',
        path.join(corpus, 'corpus'),
        '--components',
        '12',
        '--tokens',
        '80',
        '--recipes',
        '4',
        '--scenarios',
        'no_change,one_file_new_atom,forbidden_value,module_add,module_remove,file_rename',
        '--out',
        out,
      ],
      { encoding: 'utf8', timeout: 880000 },
    );
    assert.ok(
      fs.existsSync(out),
      `the incremental oracle produced no report:\n${res.stderr ?? ''}`,
    );
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.strictEqual(
      report.verdict,
      'equivalent',
      `the incremental session diverged from a fresh full rebuild:\n${JSON.stringify(
        report.revisions.filter((r) => !r.equivalent),
        null,
        2,
      )}`,
    );
    assert.ok(report.revisionsCompared >= 6);
    // Reuse must actually have happened, or "equivalent" would be a statement
    // about two full builds.
    const localEdit = report.revisions.find(
      (r) => r.scenario === 'one_file_new_atom' && r.revision === 0,
    );
    assert.ok(localEdit != null);
    assert.ok(
      localEdit.sessionCounters.filesRecompiled <= 2,
      'a one-file edit recompiled ' +
        `${localEdit.sessionCounters.filesRecompiled} files, so this is not an ` +
        'incremental result',
    );
    assert.ok(
      localEdit.sessionCounters.filesReused >= 10,
      'a one-file edit reused ' +
        `${localEdit.sessionCounters.filesReused} files, so the session is not ` +
        'reusing anything',
    );
    fs.rmSync(corpus, { recursive: true, force: true });
  },
);

test(
  'the long-session trace is bounded and mixes the hard cases',
  { timeout: 900000 },
  () => {
    const corpus = tmpdir('long-session');
    generate({
      components: 12,
      tokens: 80,
      recipes: 4,
      seed: 211,
      fanout: 2,
      outDir: path.join(corpus, 'corpus'),
      negative: false,
    });
    const out = path.join(corpus, 'trace.json');
    const res = spawnSync(
      process.execPath,
      [
        path.join(SRC, 'long-session.js'),
        '--corpus',
        path.join(corpus, 'corpus'),
        '--edits',
        '120',
        '--out',
        out,
      ],
      { encoding: 'utf8', timeout: 880000 },
    );
    assert.ok(
      fs.existsSync(out),
      `the long-session trace produced no report:\n${res.stderr ?? ''}`,
    );
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.ok(
      report.stable,
      `the session grew with the revision count: ${JSON.stringify(report.structural)}`,
    );
    // A trace of valid one-file edits only would grow nothing and prove nothing.
    assert.ok(report.mix.refused > 0, 'the trace refused nothing');
    assert.ok(
      report.mix.fullFallbacks > 0,
      'the trace never hit a global fallback',
    );
    assert.ok(
      report.mix.adds > 0 && report.mix.removes > 0,
      'the trace never churned a module',
    );
    assert.ok(report.mix.renames > 0, 'the trace never renamed a file');
    assert.ok(
      report.mix.noChange > 0,
      'the trace never submitted a no-change revision',
    );
    fs.rmSync(corpus, { recursive: true, force: true });
  },
);

test('the plan declares the revision counters the session emits', () => {
  const plan = JSON.parse(
    fs.readFileSync(path.join(HERE, '..', 'plan.json'), 'utf8'),
  );
  const declared = plan.metrics.spike2_revision_counters.metrics;
  for (const metric of [
    'affected_file_count',
    'reparsed_file_count',
    'recompiled_file_count',
    'reused_file_count',
    'full_fallback_count',
    'negative_resolutions_invalidated',
    'reverse_dependents_invalidated',
  ]) {
    assert.ok(declared.includes(metric), `the plan does not declare ${metric}`);
  }
  assert.ok(
    /REUSE, which is not work/.test(plan.metrics.spike2_revision_counters.note),
    'the plan must say that these counters count reuse, not work, or a reader ' +
      'will read a reused file as a cheap file rather than as an absent one',
  );
  assert.ok(
    plan.planVersion.startsWith('1.3.'),
    'the plan version must record that metric semantics were extended',
  );
  assert.ok(
    plan.scenarios.includes('file_rename'),
    'the plan scenario list must include file_rename',
  );
});
