/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Class-level regression matrix for the budget gate:
//
//   node tools/baselines/gate-regression.mjs
//
// Every case runs the real gate (budgets.mjs `gate`) on the committed
// baseline runs, mutated in a temporary directory, or on a temporary clone
// whose Git history is changed. Classes: control and environment identity,
// planned-observation accounting, and budgets/policy provenance. Every
// negative case must end in its expected non-pass verdict; the positive
// controls must keep `pass` (null comparisons, honest next version) and
// `fail` (injected slowdown). Versioned cases are relative to the budgets
// version in force at HEAD. Exits non-zero on any mismatch.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO, mulberry32, readJson, sha256 } from './lib.mjs';
import {
  deriveBudgets,
  gate,
  gitSource,
  inForceBudgets,
  judge,
  policyChainProblems,
  prepareGate,
} from './budgets.mjs';

const R = 'benchmarks/core-evolution/results';
const FINAL = [1, 2].map((n) => `${R}/alpha1-final-${n}/raw.json`);
const SLOW = `${R}/gate-injected-slowdown/raw.json`;
// Cases are relative to the budgets version in force at HEAD (N), its
// predecessors (1..N) and the next version (N+1), never to a fixed version.
// Mutation cases start from the baseline evidence of version N.
const budgetsPath = (n) => `benchmarks/core-evolution/budgets.v${n}.json`;
const policyPath = (n) => `benchmarks/core-evolution/budget-policy.v${n}.json`;
const BUDGETS = inForceBudgets(gitSource('HEAD'));
const VERSION = Number(/\.v(\d+)\.json$/.exec(BUDGETS)[1]);
const POLICY = policyPath(VERSION);
const NEXT = VERSION + 1;
const CHAIN = Array.from({ length: VERSION }, (_, i) => i + 1);
const evidenceOf = (n) =>
  readJson(path.join(REPO, budgetsPath(n))).baseline.results.map((r) => r.path);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ce003-gate-regression-'));
// The base runs are the baseline evidence of the version in force: a null
// comparison is only expected to pass under the budgets derived from its own
// host and conditions (v2 absolute memory limits are bound to its host).
const originals = evidenceOf(VERSION).map((f) => readJson(path.join(REPO, f)));
// The version 1 evidence, for probes at revisions where version 1 is in force.
const v1Final = () => FINAL.map((f) => readJson(path.join(REPO, f)));
const slowRun = readJson(path.join(REPO, SLOW));
let written = 0;

function files(raws) {
  return raws.map((raw) => {
    const file = path.join(work, `run-${written++}.json`);
    fs.writeFileSync(file, JSON.stringify(raw));
    return file;
  });
}

const fresh = () => structuredClone(originals);
const each = (raws, fn) => {
  for (const raw of raws) for (const s of raw.samples) fn(s, raw);
  return raws;
};
const fixture = (s, kind = 'compile') =>
  s.workload === 'alpha1-valid-fixture' && s.kind === kind;
const control = (raws) =>
  raws.map((r) => r.epochs.find((e) => e.name === 'alpha1'));
const replay = (raws) =>
  raws.map((r) => r.epochs.find((e) => e.name === 'alpha1-replay'));

const cases = [];
const add = (klass, name, expected, run) =>
  cases.push({ klass, name, expected, run });
const gateOn = (raws, options = {}) =>
  gate({
    rawFiles: files(raws),
    candidate: options.candidate ?? 'alpha1-replay',
    budgetsFile: options.budgets ?? null,
    rev: options.rev ?? 'HEAD',
    root: options.root ?? REPO,
  });

// ------------------------------------------------------- positive controls
add('control', 'null comparison (alpha1-replay) at HEAD', 'pass', () =>
  gateOn(fresh()),
);
add('control', 'injected 30% compiler slowdown', 'fail', () =>
  gateOn([structuredClone(slowRun)], { candidate: 'injected-slowdown' }),
);
add(
  'control',
  `committed in-force budgets (v${VERSION}) passed explicitly stay in release mode`,
  'pass',
  () => gateOn(fresh(), { budgets: path.join(REPO, BUDGETS) }),
);
add(
  'control',
  'candidate regression with an intact control still fails',
  'fail',
  () =>
    gateOn(
      each(
        fresh(),
        (s) =>
          s.epoch === 'alpha1-replay' &&
          fixture(s) &&
          (s.result.full.totalMs *= 3),
      ),
    ),
);

// ------------------------------------------- control and environment identity
add(
  'identity',
  'control installed tree digest forged (review probe)',
  'fail',
  () => {
    const raws = fresh();
    control(raws).forEach(
      (e) => (e.installedPandamstyle.sha256 = '0'.repeat(64)),
    );
    return gateOn(raws);
  },
);
add(
  'identity',
  'both epochs slowed 30% with forged installed digests (review probe)',
  'fail',
  () => {
    const raws = fresh();
    raws.forEach((r) =>
      r.epochs.forEach((e) => (e.installedPandamstyle.sha256 = '0'.repeat(64))),
    );
    return gateOn(
      each(
        raws,
        (s) =>
          s.kind === 'compile' &&
          s.result.full &&
          (s.result.full.totalMs *= 1.3),
      ),
    );
  },
);
add('identity', 'control lock integrity changed (review probe)', 'fail', () => {
  const raws = fresh();
  control(raws).forEach(
    (e) => (e.packages['@pandamstyle/compiler'].integrity = 'changed'),
  );
  return gateOn(raws);
});
add('identity', 'control closure lockfile digest changed', 'fail', () => {
  const raws = fresh();
  control(raws).forEach((e) => (e.packageLockSha256 = '1'.repeat(64)));
  return gateOn(raws);
});
add('identity', 'control host version changed', 'fail', () => {
  const raws = fresh();
  control(raws).forEach((e) => (e.hosts.vite = '8.3.2'));
  return gateOn(raws);
});
add(
  'identity',
  'control identity taken from another epoch (slowed candidate)',
  'fail',
  () => {
    const raws = fresh();
    const other = slowRun.epochs.find((e) => e.name === 'injected-slowdown');
    raws.forEach(
      (r) =>
        (r.epochs[r.epochs.findIndex((e) => e.name === 'alpha1')] = {
          ...structuredClone(other),
          name: 'alpha1',
        }),
    );
    return gateOn(raws);
  },
);
add('identity', 'control epoch record missing', 'inconclusive', () => {
  const raws = fresh();
  raws.forEach((r) => (r.epochs = r.epochs.filter((e) => e.name !== 'alpha1')));
  return gateOn(raws);
});
add('identity', 'control epoch recorded twice', 'inconclusive', () => {
  const raws = fresh();
  raws.forEach((r) => r.epochs.push(structuredClone(r.epochs[0])));
  return gateOn(raws);
});
add('identity', 'Node binary digest missing', 'inconclusive', () => {
  const raws = fresh();
  raws.forEach((r) => delete r.environment.nodeBinarySha256);
  return gateOn(raws);
});
add('identity', 'Node version differs from the pin', 'inconclusive', () => {
  const raws = fresh();
  raws.forEach((r) => (r.environment.node = 'v24.21.0'));
  return gateOn(raws);
});
add('identity', 'candidate identity not recorded', 'inconclusive', () => {
  const raws = fresh();
  replay(raws).forEach((e) => delete e.installedPandamstyle);
  return gateOn(raws);
});
add('identity', 'workloads record digest differs', 'inconclusive', () => {
  const raws = fresh();
  raws.forEach((r) => (r.workloadsRecord.sha256 = '2'.repeat(64)));
  return gateOn(raws);
});
add('identity', 'plan repetitions reduced', 'inconclusive', () => {
  const raws = fresh();
  raws.forEach((r) => (r.plan.repetitions['alpha1-valid-fixture'].compile = 5));
  return gateOn(raws);
});
add(
  'identity',
  'harness digest differs from the evaluated revision',
  'inconclusive',
  () => {
    const raws = fresh();
    raws.forEach((r) => (r.harness['sample.mjs'] = '3'.repeat(64)));
    return gateOn(raws);
  },
);
add(
  'identity',
  'run measured with an uncommitted harness',
  'inconclusive',
  () => {
    const raws = fresh();
    raws.forEach((r) => (r.repositoryDirty = true));
    return gateOn(raws);
  },
);

// ---------------------------------------------- planned-observation accounting
for (const mode of ['failed', 'null']) {
  add(
    'observations',
    `control ${mode} on 15 rounds, candidate tripled there (review probe)`,
    'inconclusive',
    () =>
      gateOn(
        each(fresh(), (s) => {
          if (!fixture(s) || s.round < 5) return;
          if (s.epoch === 'alpha1-replay') s.result.full.totalMs *= 3;
          else if (mode === 'failed') s.result.ok = false;
          else s.result.full.totalMs = null;
        }),
      ),
  );
}
for (const [label, value] of [
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['a string', '180'],
  ['zero', 0],
  ['negative', -1],
])
  add('observations', `control value ${label}`, 'inconclusive', () =>
    gateOn(
      each(
        fresh(),
        (s) =>
          s.epoch === 'alpha1' &&
          fixture(s) &&
          s.round === 3 &&
          (s.result.full.totalMs = value),
      ),
    ),
  );
add('observations', 'candidate value null', 'inconclusive', () =>
  gateOn(
    each(
      fresh(),
      (s) =>
        s.epoch === 'alpha1-replay' &&
        fixture(s) &&
        s.round === 3 &&
        (s.result.full.totalMs = null),
    ),
  ),
);
add('observations', 'candidate value NaN', 'inconclusive', () =>
  gateOn(
    each(
      fresh(),
      (s) =>
        s.epoch === 'alpha1-replay' &&
        fixture(s) &&
        s.round === 3 &&
        (s.result.full.totalMs = NaN),
    ),
  ),
);
add('observations', 'candidate sample failed', 'fail', () =>
  gateOn(
    each(
      fresh(),
      (s) =>
        s.epoch === 'alpha1-replay' &&
        fixture(s) &&
        s.round === 3 &&
        (s.result.ok = false),
    ),
  ),
);
add('observations', 'candidate result without its fields', 'inconclusive', () =>
  gateOn(
    each(
      fresh(),
      (s) =>
        s.epoch === 'alpha1-replay' &&
        fixture(s) &&
        s.round === 3 &&
        (s.result = { ok: true }),
    ),
  ),
);
const duplicate = (epoch) => () => {
  const raws = fresh();
  const s = raws[0].samples.find(
    (x) => x.epoch === epoch && fixture(x) && x.round === 4,
  );
  raws[0].samples.push({ ...structuredClone(s), index: 100000 });
  return gateOn(raws);
};
add(
  'observations',
  'candidate sample duplicated',
  'inconclusive',
  duplicate('alpha1-replay'),
);
add(
  'observations',
  'control sample duplicated',
  'inconclusive',
  duplicate('alpha1'),
);
add('observations', 'candidate sample removed', 'inconclusive', () => {
  const raws = fresh();
  raws[0].samples = raws[0].samples.filter(
    (s) => !(s.epoch === 'alpha1-replay' && fixture(s) && s.round === 7),
  );
  return gateOn(raws);
});
add('observations', 'sample outside the planned rounds', 'inconclusive', () => {
  const raws = fresh();
  const s = raws[0].samples.find(
    (x) => x.epoch === 'alpha1-replay' && fixture(x),
  );
  raws[0].samples.push({ ...structuredClone(s), round: 99, index: 100001 });
  return gateOn(raws);
});
add('observations', 'pair not adjacent in run order', 'inconclusive', () =>
  gateOn(
    each(
      fresh(),
      (s) =>
        s.epoch === 'alpha1-replay' &&
        fixture(s) &&
        s.round === 2 &&
        (s.index += 50),
    ),
  ),
);
add('observations', 'no control samples (review probe)', 'inconclusive', () =>
  gateOn(
    fresh().map((r) => ({
      ...r,
      samples: r.samples.filter((s) => s.epoch !== 'alpha1'),
    })),
  ),
);
add('observations', 'only rounds 0-1 kept (review probe)', 'inconclusive', () =>
  gateOn(
    fresh().map((r) => ({
      ...r,
      samples: r.samples.filter((s) => s.kind === 'consistency' || s.round < 2),
    })),
  ),
);
add('observations', 'deterministic candidate value null', 'inconclusive', () =>
  gateOn(
    each(
      fresh(),
      (s) =>
        s.epoch === 'alpha1-replay' &&
        fixture(s) &&
        s.round === 1 &&
        (s.result.output.css.bytes = null),
    ),
  ),
);
add('observations', 'deterministic control value changed', 'fail', () =>
  gateOn(
    each(
      fresh(),
      (s) =>
        s.epoch === 'alpha1' && fixture(s) && (s.result.output.css.bytes += 1),
    ),
  ),
);
add(
  'observations',
  'consistency candidate sample missing',
  'inconclusive',
  () =>
    gateOn(
      fresh().map((r) => ({
        ...r,
        samples: r.samples.filter(
          (s) => !(s.epoch === 'alpha1-replay' && s.kind === 'consistency'),
        ),
      })),
    ),
);
add(
  'observations',
  'absolute memory candidate value null',
  'inconclusive',
  () =>
    gateOn(
      each(
        fresh(),
        (s) =>
          s.epoch === 'alpha1-replay' &&
          fixture(s) &&
          s.round === 1 &&
          (s.result.afterFull.maxRssBytes = null),
      ),
    ),
);
add('observations', 'CSS regression (review probe)', 'fail', () =>
  gateOn(
    each(
      fresh(),
      (s) =>
        s.epoch === 'alpha1-replay' &&
        fixture(s) &&
        (s.result.output.css.bytes = 2790),
    ),
  ),
);
add('observations', 'noisy control (review probe)', 'inconclusive', () =>
  gateOn(
    each(
      fresh(),
      (s) =>
        fixture(s) &&
        (s.result.full.totalMs =
          s.epoch === 'alpha1' ? (s.round % 2 ? 100 : 200) : 100),
    ),
  ),
);
// Paired ratios alternate between limit + 0.1 and limit - 0.1, so the median
// sits on the in-force limit and the interval straddles it.
const fixtureTotalLimit = readJson(path.join(REPO, BUDGETS)).budgets.find(
  (b) => b.workload === 'alpha1-valid-fixture' && b.metric === 'full.totalMs',
).limit.maxRatio;
add(
  'observations',
  `interval straddling the v${VERSION} limit ${fixtureTotalLimit} (review probe)`,
  'inconclusive',
  () =>
    gateOn(
      each(
        fresh(),
        (s) =>
          fixture(s) &&
          (s.result.full.totalMs =
            s.epoch === 'alpha1'
              ? 100
              : 100 * (fixtureTotalLimit + (s.round % 2 ? 0.1 : -0.1))),
      ),
    ),
);
add('observations', 'no run given', 'inconclusive', () => gateOn([]));
add(
  'observations',
  'same run given twice (doubled pairs)',
  'inconclusive',
  () => {
    const raws = fresh();
    return gateOn([raws[0], structuredClone(raws[0])]);
  },
);
add('observations', 'corrupt run file', 'inconclusive', () => {
  const file = path.join(work, `corrupt-${written++}.json`);
  fs.writeFileSync(file, '{"label": "truncated", "samples": [');
  return gate({ rawFiles: [file], candidate: 'alpha1-replay' });
});
add(
  'identity',
  'control is not the budgets baseline epoch',
  'inconclusive',
  () =>
    gate({
      rawFiles: files(fresh()),
      candidate: 'alpha1',
      reference: 'alpha1-replay',
    }),
);
add('identity', 'candidate equals the control', 'inconclusive', () =>
  gate({ rawFiles: files(fresh()), candidate: 'alpha1' }),
);

// --------------------------------------------- budgets and policy provenance
const committed = readJson(path.join(REPO, BUDGETS));
const writeBudgets = (budgets) => {
  const file = path.join(work, `budgets-${written++}.json`);
  fs.writeFileSync(file, `${JSON.stringify(budgets, null, 2)}\n`);
  return file;
};
const weak = () => {
  const b = structuredClone(committed);
  b.budgets.find(
    (x) => x.workload === 'alpha1-valid-fixture' && x.metric === 'css.bytes',
  ).limit.maxValue *= 2;
  return b;
};
const cssRegression = () =>
  each(
    fresh(),
    (s) =>
      s.epoch === 'alpha1-replay' &&
      fixture(s) &&
      (s.result.output.css.bytes = 2790),
  );
add(
  'provenance',
  `untracked weakened copy of v${VERSION} (review probe)`,
  'not-release',
  () => gateOn(cssRegression(), { budgets: writeBudgets(weak()) }),
);
add(
  'provenance',
  `untracked v${NEXT} reusing the v${VERSION} baseline (review probe)`,
  'not-release',
  () => {
    const b = weak();
    b.policyVersion = NEXT;
    b.supersedes = {
      path: BUDGETS,
      sha256: sha256(fs.readFileSync(path.join(REPO, BUDGETS))),
    };
    return gateOn(cssRegression(), { budgets: writeBudgets(b) });
  },
);
add(
  'provenance',
  `untracked v${NEXT} with fabricated evidence and a relaxation (review probe)`,
  'not-release',
  () => {
    const b = weak();
    b.policyVersion = NEXT;
    b.supersedes = {
      path: BUDGETS,
      sha256: sha256(fs.readFileSync(path.join(REPO, BUDGETS))),
    };
    b.baseline.results = b.baseline.results.map((r, i) => ({
      ...r,
      sha256: String(i + 1).repeat(64),
    }));
    b.relaxations = [
      {
        workload: 'alpha1-valid-fixture',
        metric: 'css.bytes',
        justification: 'claims a new baseline without measured evidence',
      },
    ];
    return gateOn(cssRegression(), { budgets: writeBudgets(b) });
  },
);
add('provenance', 'revision without committed budgets', 'fail', () =>
  gateOn(fresh(), { rev: '172b5bf' }),
);

// Git-history cases run the gate against a temporary clone.
function clone(name) {
  const dir = path.join(work, `clone-${name}`);
  execFileSync('git', ['clone', '--quiet', '--shared', REPO, dir]);
  execFileSync(
    'git',
    [
      'checkout',
      '--quiet',
      '--detach',
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: REPO,
        encoding: 'utf8',
      }).trim(),
    ],
    { cwd: dir },
  );
  return dir;
}
const commit = (dir, message) => {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=gate-regression',
      '-c',
      'user.email=gate-regression@invalid',
      'commit',
      '--quiet',
      '--no-verify',
      '-m',
      message,
    ],
    { cwd: dir },
  );
};
const writeIn = (dir, file, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};
const gateIn = (dir, raws = fresh(), options = {}) =>
  gateOn(raws, { ...options, root: dir });

// Every committed version of the chain, not only the one in force, must stay
// as first committed, with its policy and evidence.
const weakened = (dir, n) => {
  const b = readJson(path.join(dir, budgetsPath(n)));
  b.budgets.find(
    (x) => x.workload === 'alpha1-valid-fixture' && x.metric === 'css.bytes',
  ).limit.maxValue *= 2;
  return `${JSON.stringify(b, null, 2)}\n`;
};
for (const n of CHAIN) {
  add('provenance', `v${n} budgets weakened and re-committed`, 'fail', () => {
    const dir = clone(`recommit-v${n}`);
    writeIn(dir, budgetsPath(n), weakened(dir, n));
    commit(dir, `weaken v${n}`);
    return gateIn(dir, cssRegression());
  });
  add(
    'provenance',
    `v${n} budgets deleted, then re-added weakened`,
    'fail',
    () => {
      const dir = clone(`readd-v${n}`);
      const text = weakened(dir, n);
      fs.rmSync(path.join(dir, budgetsPath(n)));
      commit(dir, `remove v${n}`);
      writeIn(dir, budgetsPath(n), text);
      commit(dir, `re-add v${n}`);
      return gateIn(dir, cssRegression());
    },
  );
  add('provenance', `v${n} policy edited after the freeze`, 'fail', () => {
    const dir = clone(`policy-v${n}`);
    const policy = readJson(path.join(dir, policyPath(n)));
    policy.thresholdRule.deterministic.growth.default = 0.5;
    writeIn(dir, policyPath(n), `${JSON.stringify(policy, null, 2)}\n`);
    commit(dir, `edit v${n} policy`);
    return gateIn(dir);
  });
  add(
    'provenance',
    `v${n} baseline evidence file edited after the freeze`,
    'fail',
    () => {
      const dir = clone(`evidence-v${n}`);
      const file = evidenceOf(n)[0];
      const raw = readJson(path.join(dir, file));
      raw.samples[0].result.wallMs += 1;
      writeIn(dir, file, `${JSON.stringify(raw, null, 2)}\n`);
      commit(dir, `edit v${n} evidence`);
      return gateIn(dir);
    },
  );
}
add('provenance', 'alpha1 manifest edited after the freeze', 'fail', () => {
  const dir = clone('manifest');
  const file = 'benchmarks/core-evolution/epochs/alpha1/manifest.v1.json';
  writeIn(dir, file, `${fs.readFileSync(path.join(dir, file), 'utf8')} `);
  commit(dir, 'edit manifest');
  return gateIn(dir);
});
const nextBudgets = (dir, mutate) => {
  const b = weak();
  b.policyVersion = NEXT;
  b.supersedes = {
    path: BUDGETS,
    sha256: sha256(fs.readFileSync(path.join(dir, BUDGETS))),
  };
  b.policy = {
    path: policyPath(NEXT),
    sha256: '4'.repeat(64),
  };
  b.relaxations = [
    {
      workload: 'alpha1-valid-fixture',
      metric: 'css.bytes',
      justification: 'claims a new baseline without measured evidence',
    },
  ];
  mutate?.(b);
  writeIn(dir, budgetsPath(NEXT), `${JSON.stringify(b, null, 2)}\n`);
};
add(
  'provenance',
  `committed v${NEXT} budgets without a v${NEXT} policy`,
  'fail',
  () => {
    const dir = clone('next-no-policy');
    nextBudgets(
      dir,
      (b) =>
        (b.baseline.results = b.baseline.results.map((r, i) => ({
          ...r,
          sha256: String(i + 5).repeat(64),
        }))),
    );
    commit(dir, `v${NEXT} without policy`);
    return gateIn(dir, cssRegression());
  },
);
add(
  'provenance',
  `committed v${NEXT} policy and budgets whose evidence files are absent`,
  'fail',
  () => {
    const dir = clone('next-no-evidence');
    const policy = {
      ...readJson(path.join(dir, POLICY)),
      policyVersion: NEXT,
      justification: `a version ${NEXT} that names results never committed`,
    };
    writeIn(dir, policyPath(NEXT), `${JSON.stringify(policy, null, 2)}\n`);
    nextBudgets(dir, (b) => {
      b.policy.sha256 = sha256(
        fs.readFileSync(path.join(dir, policyPath(NEXT))),
      );
      b.baseline.results = [
        {
          path: `${R}/never-measured/raw.json`,
          sha256: '6'.repeat(64),
          label: 'never-measured',
        },
      ];
    });
    commit(dir, `v${NEXT} without evidence`);
    return gateIn(dir, cssRegression());
  },
);

// An honest next version (N+1): its own policy, new committed evidence (the
// in-force baseline runs re-labelled, so new files with new digests), and
// budgets derived from them. The gate must accept it in release mode, and
// refuse to treat any superseded version as release budgets.
// With `mutate`, the committed policy is the mutated one while the budgets are
// derived from the unmutated rules and bound to the mutated policy's digest:
// the gate's own re-derivation must then judge the mutated policy. With
// `deriveMutated`, the budgets are derived from the mutated policy itself.
function honestNext(dir, mutate, { deriveMutated = false } = {}) {
  const policyFile = policyPath(NEXT);
  const policy = {
    ...readJson(path.join(dir, POLICY)),
    policyVersion: NEXT,
    supersedes: {
      path: BUDGETS,
      sha256: sha256(fs.readFileSync(path.join(dir, BUDGETS))),
    },
    justification: `Regression-matrix version ${NEXT} resting on new committed baseline evidence.`,
    relaxations: [],
  };
  const committedPolicy = mutate ? mutate(structuredClone(policy)) : policy;
  writeIn(dir, policyFile, `${JSON.stringify(committedPolicy, null, 2)}\n`);
  const refs = [];
  const raws = [];
  for (const [n, file] of evidenceOf(VERSION).entries()) {
    const raw = readJson(path.join(dir, file));
    raw.label = `alpha1-v${NEXT}-${n + 1}`;
    const target = `${R}/alpha1-v${NEXT}-${n + 1}/raw.json`;
    const text = `${JSON.stringify(raw, null, 2)}\n`;
    writeIn(dir, target, text);
    refs.push({ path: target, sha256: sha256(text), label: raw.label });
    raws.push(raw);
  }
  const policyBytes = fs.readFileSync(path.join(dir, policyFile));
  const manifest = fs.readFileSync(
    path.join(dir, 'benchmarks/core-evolution/epochs/alpha1/manifest.v1.json'),
  );
  const budgets = deriveBudgets(
    {
      ...(deriveMutated ? committedPolicy : policy),
      __path: policyFile,
      __sha256: sha256(policyBytes),
    },
    raws,
    refs,
    { manifestSha256: sha256(manifest) },
  );
  writeIn(dir, budgetsPath(NEXT), `${JSON.stringify(budgets, null, 2)}\n`);
  commit(dir, `honest v${NEXT}`);
}
add(
  'provenance',
  `honest committed v${NEXT} with new evidence (positive control)`,
  'pass',
  () => {
    const dir = clone('next-honest');
    honestNext(dir);
    return gateIn(dir);
  },
);
for (const n of CHAIN)
  add(
    'provenance',
    `superseded v${n} passed while v${NEXT} is in force`,
    'not-release',
    () => {
      const dir = clone(`next-older-v${n}`);
      honestNext(dir);
      return gateIn(dir, fresh(), { budgets: path.join(dir, budgetsPath(n)) });
    },
  );

// --------------------------------------- round-2 review probes (explicit)
const r2 = (name, expected, mutate, options = {}) =>
  add('review-r2', name, expected, () => {
    const raws = fresh();
    mutate?.(raws);
    return gateOn(raws, options);
  });
const fixtureOf = (s) => s.workload === 'alpha1-valid-fixture';
const replayFixture = (raw, kind) =>
  raw.samples.filter(
    (s) => fixtureOf(s) && s.kind === kind && s.epoch === 'alpha1-replay',
  );
r2('null', 'pass');
r2('workload-content-mismatch', 'inconclusive', (raws) =>
  raws.forEach((x) => (x.workloads[0].contentSha256 = '0'.repeat(64))),
);
r2('failed-visible', 'fail', (raws) =>
  replayFixture(raws[0], 'compile').forEach((s) => (s.result.ok = false)),
);
r2('failed-hidden-workload', 'fail', (raws) => {
  replayFixture(raws[0], 'compile').forEach((s) => (s.result.ok = false));
  raws[0].workloads = raws[0].workloads.filter(
    (w) => w.id !== 'alpha1-valid-fixture',
  );
});
r2('css-visible', 'fail', (raws) =>
  replayFixture(raws[0], 'compile').forEach(
    (s) => (s.result.output.css.bytes *= 3),
  ),
);
r2('css-hidden-workload', 'fail', (raws) => {
  replayFixture(raws[0], 'compile').forEach(
    (s) => (s.result.output.css.bytes *= 3),
  );
  raws[0].workloads = raws[0].workloads.filter(
    (w) => w.id !== 'alpha1-valid-fixture',
  );
});
r2('dirty-harness', 'inconclusive', (raws) =>
  raws.forEach((x) => (x.repositoryDirty = true)),
);
r2('different-harness', 'inconclusive', (raws) =>
  raws.forEach((x) => (x.harness['sample.mjs'] = '0'.repeat(64))),
);
r2('workloads-record-mismatch', 'inconclusive', (raws) =>
  raws.forEach((x) => (x.workloadsRecord.sha256 = '0'.repeat(64))),
);
r2('empty-canonical-evidence', 'inconclusive', (raws) =>
  raws.forEach((x) =>
    x.samples
      .filter((s) => s.kind === 'consistency' && s.epoch === 'alpha1-replay')
      .forEach((s) => (s.result.canonical = [{ equal: {} }])),
  ),
);
r2('missing-incremental-iterations', 'inconclusive', (raws) =>
  raws.forEach((x) =>
    x.samples
      .filter((s) => s.kind === 'compile')
      .forEach((s) =>
        s.result.incremental.forEach(
          (e) => (e.iterations = e.iterations.filter((i) => i.iteration < 2)),
        ),
      ),
  ),
);
r2('null-incremental-iteration', 'inconclusive', (raws) =>
  raws.forEach((x) =>
    x.samples
      .filter((s) => s.kind === 'compile')
      .forEach((s) =>
        s.result.incremental.forEach((e) => {
          if (e.iterations[2]) e.iterations[2].totalMs = null;
        }),
      ),
  ),
);
r2('missing-cpu-component', 'inconclusive', (raws) =>
  raws.forEach((x) =>
    x.samples
      .filter((s) => fixtureOf(s) && s.kind === 'compile')
      .forEach((s) => (s.result.afterFull.systemCpuMs = null)),
  ),
);

// CPU times may legitimately be zero (tick-based kernel accounting); every
// other invalid value of every CPU field of every usage record stays a
// reconciliation error. One candidate compile sample carries both records.
const cpuVictim = (raws) =>
  raws[0].samples.find(
    (s) => fixtureOf(s) && s.kind === 'compile' && s.epoch === 'alpha1-replay',
  );
for (const record of ['afterFull', 'final'])
  for (const field of ['userCpuMs', 'systemCpuMs']) {
    add('cpu-time', `${record}.${field} zero is accepted`, 'pass', () => {
      const raws = fresh();
      cpuVictim(raws).result[record][field] = 0;
      return gateOn(raws);
    });
    for (const [name, value] of [
      ['negative', -1],
      ['NaN (null in the run file)', Number.NaN],
      ['missing', undefined],
    ])
      add(
        'cpu-time',
        `${record}.${field} ${name} is rejected`,
        'inconclusive',
        () => {
          const raws = fresh();
          const usage = cpuVictim(raws).result[record];
          if (value === undefined) delete usage[field];
          else usage[field] = value;
          return gateOn(raws);
        },
      );
  }
// Per-budget statistic. `min` (absolute peak-RSS budgets only) absorbs
// garbage-collector high-mode rounds but not a shift of every round; the gate
// refuses `min` anywhere else and any unknown statistic, whether it comes from
// a committed policy (re-derivation) or from a budgets file.
const committedBudgets = readJson(path.join(REPO, BUDGETS));
const minBudgets = committedBudgets.budgets.filter(
  (b) => b.limit.statistic === 'min',
);
const SOURCE = {
  'full.maxRssBytes': 'afterFull',
  'session.maxRssBytes': 'final',
};
const expectStatus = (report, budget, status) => {
  const r = report.results?.find(
    (x) => x.workload === budget.workload && x.metric === budget.metric,
  );
  return r?.status === status
    ? report
    : { ...report, verdict: `${budget.metric} ${r?.status ?? 'missing'}` };
};
const expectProblem = (report, text) =>
  [...(report.problems ?? []), ...(report.provenance?.problems ?? [])].some(
    (p) => p.includes(text),
  )
    ? report
    : { ...report, verdict: `no "${text}" problem` };
for (const budget of minBudgets) {
  const candidateSamples = (raws) =>
    raws
      .flatMap((r) => r.samples)
      .filter(
        (s) =>
          s.workload === budget.workload &&
          s.kind === 'compile' &&
          s.epoch === 'alpha1-replay',
      );
  const usage = (s) => s.result[SOURCE[budget.metric]];
  add(
    'statistic',
    `${budget.metric} min: every round but the lowest in the high mode passes`,
    'pass',
    () => {
      const raws = fresh();
      const samples = candidateSamples(raws);
      const lowest = samples.reduce((a, b) =>
        usage(b).maxRssBytes < usage(a).maxRssBytes ? b : a,
      );
      for (const s of samples) if (s !== lowest) usage(s).maxRssBytes *= 2;
      return expectStatus(gateOn(raws), budget, 'pass');
    },
  );
  add(
    'statistic',
    `${budget.metric} min: every round in the high mode fails`,
    'fail',
    () => {
      const raws = fresh();
      for (const s of candidateSamples(raws)) usage(s).maxRssBytes *= 2;
      return expectStatus(gateOn(raws), budget, 'fail');
    },
  );
  add(
    'statistic',
    `${budget.metric} min: every round +15% fails`,
    'fail',
    () => {
      const raws = fresh();
      for (const s of candidateSamples(raws))
        usage(s).maxRssBytes = Math.round(usage(s).maxRssBytes * 1.15);
      return expectStatus(gateOn(raws), budget, 'fail');
    },
  );
}
const timingBudget = committedBudgets.budgets.find(
  (b) => b.class === 'timing' && b.limit.mode === 'paired-ratio',
);
const ratioBudget = committedBudgets.budgets.find(
  (b) => b.class === 'runtime' && b.limit.mode === 'paired-ratio',
);
const withOverride = (budget, statistic) => (policy) => {
  policy.thresholdRule.statistic.overrides.push({
    workload: budget.workload,
    metric: budget.metric,
    statistic,
  });
  return policy;
};
for (const [name, budget, statistic, text] of [
  [
    'min on a timing budget',
    timingBudget,
    'min',
    'statistic min is allowed only',
  ],
  [
    'min on a paired-ratio runtime budget',
    ratioBudget,
    'min',
    'statistic min is allowed only',
  ],
  [
    'an unknown statistic',
    minBudgets[0] ?? timingBudget,
    'p95',
    'unknown statistic',
  ],
]) {
  add(
    'statistic',
    `committed v${NEXT} policy with ${name} is refused`,
    'fail',
    () => {
      const dir = clone(`statistic-${statistic}-${budget.metric}`);
      honestNext(dir, (policy) => {
        policy.thresholdRule.statistic ??= { default: 'median', overrides: [] };
        if (statistic === 'p95')
          policy.thresholdRule.statistic.overrides =
            policy.thresholdRule.statistic.overrides.filter(
              (o) =>
                !(o.workload === budget.workload && o.metric === budget.metric),
            );
        return withOverride(budget, statistic)(policy);
      });
      return expectProblem(gateIn(dir), text);
    },
  );
  add('statistic', `budgets file with ${name} is refused`, 'fail', () => {
    const b = structuredClone(committedBudgets);
    const entry = b.budgets.find(
      (x) => x.workload === budget.workload && x.metric === budget.metric,
    );
    entry.limit.statistic = statistic;
    return expectProblem(gateOn(fresh(), { budgets: writeBudgets(b) }), text);
  });
}
// An explicit `median` override behaves exactly like no override, for every
// budget class; duplicate and unmatched overrides are refused whatever their
// statistic.
const overrideOf = (budget, statistic) => ({
  workload: budget.workload,
  metric: budget.metric,
  statistic,
});
const addOverrides =
  (...overrides) =>
  (policy) => {
    policy.thresholdRule.statistic ??= { default: 'median', overrides: [] };
    policy.thresholdRule.statistic.overrides.push(...overrides);
    return policy;
  };
for (const [klass, budget] of [
  [
    'memory',
    committedBudgets.budgets.find(
      (b) =>
        b.class === 'memory' &&
        b.limit.mode === 'absolute' &&
        !b.limit.statistic,
    ),
  ],
  ['timing', timingBudget],
  [
    'deterministic',
    committedBudgets.budgets.find((b) => b.class === 'deterministic'),
  ],
])
  add(
    'statistic',
    `explicit median override on a ${klass} budget (${budget.metric}) derives and gates like no override`,
    'pass',
    () => {
      const dir = clone(`statistic-median-${klass}`);
      honestNext(dir, addOverrides(overrideOf(budget, 'median')), {
        deriveMutated: true,
      });
      const report = gateIn(dir);
      const derived = readJson(path.join(dir, budgetsPath(NEXT))).budgets;
      return JSON.stringify(derived) ===
        JSON.stringify(committedBudgets.budgets)
        ? report
        : { ...report, verdict: 'budgets differ from no override' };
    },
  );
for (const [name, mutate, text] of [
  [
    'a duplicate override',
    addOverrides(
      overrideOf(timingBudget, 'median'),
      overrideOf(timingBudget, 'median'),
    ),
    'statistic given twice',
  ],
  [
    'an unmatched median override',
    addOverrides({
      workload: 'no-such-workload',
      metric: timingBudget.metric,
      statistic: 'median',
    }),
    'matches no derived budget',
  ],
  [
    'an unmatched min override',
    addOverrides({
      workload: 'no-such-workload',
      metric: 'full.maxRssBytes',
      statistic: 'min',
    }),
    'matches no derived budget',
  ],
])
  add(
    'statistic',
    `committed v${NEXT} policy with ${name} is refused`,
    'fail',
    () => {
      const dir = clone(`statistic-${name.replaceAll(' ', '-')}`);
      honestNext(dir, mutate);
      return expectProblem(gateIn(dir), text);
    },
  );
// Loosening: a statistic change counts, an explicit `median` equals no
// statistic, a raised maxMin counts, an unchanged min limit does not.
const loosening = (previous, next) => {
  const entry = (limit) => ({
    workload: 'w',
    metric: 'session.maxRssBytes',
    limit,
  });
  const problems = policyChainProblems(
    {
      policyVersion: 2,
      justification: 'regression-matrix loosening probe, no relaxations listed',
      supersedes: { path: 'previous', sha256: 'digest' },
      baseline: { results: [{ sha256: 'new' }] },
      budgets: [entry(next)],
      relaxations: [],
      unknown: [],
    },
    () => ({
      policyVersion: 1,
      baseline: { results: [{ sha256: 'old' }] },
      budgets: [entry(previous)],
      unknown: [],
    }),
    () => 'digest',
  );
  if (problems.some((p) => p.includes('loosened')))
    return { verdict: 'loosened' };
  return problems.length > 0
    ? { verdict: `other problems: ${problems.join('; ')}` }
    : { verdict: 'not-loosened' };
};
const absoluteMedian = { mode: 'absolute', maxMedian: 100, factor: 1.1 };
const absoluteMin = (maxMin) => ({
  mode: 'absolute',
  statistic: 'min',
  maxMin,
  factor: 1.1,
});
for (const [name, previous, next, expected] of [
  [
    'median -> min, even with a lower number',
    absoluteMedian,
    absoluteMin(90),
    'loosened',
  ],
  ['min -> median', absoluteMin(90), absoluteMedian, 'loosened'],
  ['min, raised maxMin', absoluteMin(100), absoluteMin(101), 'loosened'],
  [
    'min -> min, same maxMin',
    absoluteMin(100),
    absoluteMin(100),
    'not-loosened',
  ],
  [
    'min -> min, lower maxMin',
    absoluteMin(100),
    absoluteMin(99),
    'not-loosened',
  ],
  [
    'no statistic -> explicit median, same maxMedian',
    absoluteMedian,
    { ...absoluteMedian, statistic: 'median' },
    'not-loosened',
  ],
])
  add('statistic', `loosening: ${name}`, expected, () =>
    loosening(previous, next),
  );
add(
  'review-r2',
  'stale-revision-harness-same (identical committed inputs at f4a7106, v1 evidence)',
  'pass',
  () => gateOn(v1Final(), { rev: 'f4a7106' }),
);
r2('revision-before-budgets', 'fail', null, { rev: '172b5bf' });
r2('head-budget-before-budgets', 'inconclusive', null, {
  rev: '172b5bf',
  budgets: path.join(REPO, BUDGETS),
});
r2('empty-candidate-identity', 'inconclusive', (raws) =>
  raws.forEach((x) => {
    const e = x.epochs.find((y) => y.name === 'alpha1-replay');
    e.packages = {};
    e.packageLockSha256 = '';
    e.installedPandamstyle.sha256 = '';
  }),
);
r2('mixed-candidate-identities', 'inconclusive', (raws) => {
  raws[1].epochs.find(
    (e) => e.name === 'alpha1-replay',
  ).installedPandamstyle.sha256 = '0'.repeat(64);
});
r2('canonical-visible-failure', 'fail', (raws) =>
  raws.forEach((x) =>
    replayFixture(x, 'consistency').forEach(
      (s) => (s.result.canonical[0].equal.css = false),
    ),
  ),
);
r2('canonical-hidden-failure', 'inconclusive', (raws) =>
  raws.forEach((x) =>
    replayFixture(x, 'consistency').forEach((s) => {
      s.result.canonical[0].equal.css = false;
      s.result.canonical = s.result.canonical.filter(
        (c) => c.id !== 'local-style',
      );
    }),
  ),
);
const slowLocal = (raws) =>
  raws.forEach((x) =>
    replayFixture(x, 'compile').forEach((s) =>
      s.result.incremental
        .find((e) => e.id === 'local-style')
        .iterations.forEach((i) => {
          if (i.iteration >= 2) i.totalMs *= 3;
        }),
    ),
  );
r2('incremental-visible-slowdown', 'fail', slowLocal);
r2('incremental-hidden-slowdown', 'inconclusive', (raws) => {
  slowLocal(raws);
  raws.forEach((x) =>
    x.samples
      .filter((s) => fixtureOf(s) && s.kind === 'compile')
      .forEach((s) => {
        const e = s.result.incremental.find((y) => y.id === 'local-style');
        e.iterations = e.iterations.filter((i) => i.iteration < 2);
      }),
  );
});

// ------------------------------------------- omission/perturbation fuzzer
//
// Starts from a passing base (the null comparison) and failing bases (the
// injected slowdown, and the null comparison with one schema-valid failed
// candidate sample), and applies with a fixed seed: deletion of object keys
// and array elements, null/NaN/negative/string substitution of leaves and
// duplication of array elements. Every node outside `samples`, and every
// normalized key path (array indices folded, samples keyed by kind and
// epochs by name) with every applicable mutation, is covered at least once;
// a seeded random sample of concrete mutations is added. Invariants: a
// failing base never becomes `pass`; a passing base stays `pass` only for a
// mutation that is verdict- and budget-invariant: the mutated path is an
// informational one (free-text, environment description and load-record
// fields, not a budget input) and the verdict and every budget result are
// identical to the unmutated base's, compared field by field. The gate does
// read some of these paths: `label` for duplicate-run detection, and
// `load.before`, which it copies into its report.

const INFORMATIONAL =
  /^(label|startedAt|finishedAt|samples\[\d+\]\.startedAt|environment\.(os|kernel|architecture|cpu|filesystem|nodeBinary|scalingGovernor|boost)|epochs\[\d+\]\.closure|quietRule\.description|load\.before(\[\d+\](\.at)?)?|load\.after\.at)$/;
const TYPES = ['delete', 'null', 'NaN', 'negative', 'string', 'duplicate'];

function nodesOf(raws) {
  const nodes = [];
  const walk = (value, parent, key, at, norm, r) => {
    if (parent != null)
      nodes.push({
        r,
        parent,
        key,
        at,
        norm,
        leaf: value === null || typeof value !== 'object',
        inArray: Array.isArray(parent),
      });
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value))
      value.forEach((v, i) => {
        const label =
          at === 'samples'
            ? `samples<${v?.kind}>`
            : at === 'epochs'
              ? `epochs<${v?.name === 'alpha1' ? 'control' : 'candidate'}>`
              : `${norm}[]`;
        walk(v, value, i, `${at}[${i}]`, label, r);
      });
    else
      for (const [k, v] of Object.entries(value))
        walk(
          v,
          value,
          k,
          at === '' ? k : `${at}.${k}`,
          norm === '' ? k : `${norm}.${k}`,
          r,
        );
  };
  raws.forEach((raw, r) => walk(raw, null, null, '', '', r));
  return nodes;
}

function applicable(node, type) {
  if (type === 'delete') return true;
  if (type === 'duplicate') return node.inArray;
  if (!node.leaf) return false;
  const value = node.parent[node.key];
  if (type === 'null') return value !== null;
  return true;
}

function apply(node, type) {
  const { parent, key } = node;
  if (type === 'delete') {
    if (Array.isArray(parent)) {
      const [removed] = parent.splice(key, 1);
      return () => parent.splice(key, 0, removed);
    }
    const entries = Object.entries(parent);
    delete parent[key];
    return () => {
      for (const k of Object.keys(parent)) delete parent[k];
      for (const [k, v] of entries) parent[k] = v;
    };
  }
  if (type === 'duplicate') {
    parent.splice(key, 0, structuredClone(parent[key]));
    return () => parent.splice(key, 1);
  }
  const old = parent[key];
  parent[key] =
    type === 'null'
      ? null
      : type === 'NaN'
        ? NaN
        : type === 'negative'
          ? -Math.abs(typeof old === 'number' ? old : 1) - 1
          : typeof old === 'string'
            ? `${old}-mutated`
            : 'mutated';
  return () => (parent[key] = old);
}

// The first path at which two values differ, or null when they are equal
// field by field (NaN equals NaN; key order is ignored).
function firstDifference(a, b, at = '') {
  if (Object.is(a, b)) return null;
  if (
    a === null ||
    b === null ||
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return at || '(root)';
  if (Array.isArray(a) && a.length !== b.length) return `${at}.length`;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(k in a) || !(k in b)) return at === '' ? k : `${at}.${k}`;
    const d = firstDifference(a[k], b[k], at === '' ? k : `${at}.${k}`);
    if (d != null) return d;
  }
  return null;
}

// Verdict- and budget-invariance against the unmutated base's report.
const invariance = (report, base) =>
  report.verdict !== base.verdict
    ? 'verdict'
    : firstDifference(report.results ?? [], base.results ?? [], 'results');

function fuzz({ samples = 1500, seed = 307 } = {}) {
  const prepared = prepareGate({ rev: 'HEAD' });
  const failedOne = fresh();
  const victim = failedOne[0].samples.find(
    (s) =>
      s.epoch === 'alpha1-replay' &&
      s.kind === 'compile' &&
      s.workload === 'ce-corpus',
  );
  victim.result = { ok: false, error: 'injected failure' };
  const bases = [
    {
      name: 'pass: null comparison',
      raws: fresh(),
      candidate: 'alpha1-replay',
      expect: 'pass',
    },
    {
      name: 'fail: injected slowdown',
      raws: [structuredClone(slowRun)],
      candidate: 'injected-slowdown',
      expect: 'fail',
    },
    {
      name: 'fail: one failed candidate sample',
      raws: failedOne,
      candidate: 'alpha1-replay',
      expect: 'fail',
    },
  ];
  const random = mulberry32(seed);
  const summary = [];
  let violations = 0;
  for (const base of bases) {
    const baseReport = judge(prepared, base.raws, {
      candidate: base.candidate,
    });
    if (baseReport.verdict !== base.expect)
      throw new Error(`${base.name}: base verdict ${baseReport.verdict}`);
    const snapshot = JSON.stringify(base.raws);
    const nodes = nodesOf(base.raws);
    const plan = [];
    // Every node outside samples, every applicable type.
    for (const node of nodes)
      if (!node.at.startsWith('samples'))
        for (const type of TYPES)
          if (applicable(node, type)) plan.push([node, type]);
    // Every normalized sample path and type at least once (a seeded instance).
    const byPath = new Map();
    for (const node of nodes)
      if (node.at.startsWith('samples'))
        byPath.set(node.norm, [...(byPath.get(node.norm) ?? []), node]);
    for (const instances of byPath.values())
      for (const type of TYPES) {
        const eligible = instances.filter((n) => applicable(n, type));
        if (eligible.length > 0)
          plan.push([eligible[Math.floor(random() * eligible.length)], type]);
      }
    // A seeded random sample of concrete mutations anywhere.
    const sampleNodes = nodes.filter((n) => n.at.startsWith('samples'));
    for (let i = 0; i < samples; ) {
      const node = sampleNodes[Math.floor(random() * sampleNodes.length)];
      const type = TYPES[Math.floor(random() * TYPES.length)];
      if (!applicable(node, type)) continue;
      plan.push([node, type]);
      i++;
    }
    const table = Object.fromEntries(TYPES.map((t) => [t, {}]));
    let invariantPasses = 0;
    const invariantPaths = new Set();
    for (const [node, type] of plan) {
      const undo = apply(node, type);
      const report = judge(prepared, base.raws, { candidate: base.candidate });
      undo();
      table[type][report.verdict] = (table[type][report.verdict] ?? 0) + 1;
      if (report.verdict !== 'pass') continue;
      const difference =
        base.expect === 'pass' && INFORMATIONAL.test(node.at)
          ? invariance(report, baseReport)
          : 'not an informational path of a passing base';
      if (difference == null) {
        invariantPasses++;
        invariantPaths.add(`${type} ${node.norm}`);
      } else {
        violations++;
        console.log(
          `VIOLATION ${base.name}: ${type} ${node.at} -> pass (${difference})`,
        );
      }
    }
    if (JSON.stringify(base.raws) !== snapshot)
      throw new Error(`${base.name}: base not restored after mutations`);
    summary.push({
      base: base.name,
      mutations: plan.length,
      normalizedSamplePaths: byPath.size,
      nodes: nodes.length,
      byType: table,
      passesVerdictAndBudgetInvariant: invariantPasses,
      invariantPaths: [...invariantPaths].sort(),
    });
  }
  return { summary, violations };
}

// ------------------------------------------------------------------- run
let failures = 0;
const rows = [];
for (const c of cases) {
  let verdict;
  let reason = '';
  try {
    const report = c.run();
    verdict = report.verdict;
    reason =
      report.problems?.[0] ??
      report.refusals?.[0] ??
      report.results?.find((r) => r.status !== 'pass')?.reason ??
      '';
    if (reason === '' && report.counts) reason = JSON.stringify(report.counts);
  } catch (error) {
    verdict = `error: ${error.message}`;
  }
  const ok = verdict === c.expected;
  if (!ok) failures++;
  rows.push(
    `${ok ? 'ok  ' : 'FAIL'} [${c.klass}] ${c.name}: ${verdict}${ok ? '' : ` (expected ${c.expected})`} — ${String(reason).slice(0, 110)}`,
  );
}
console.log(rows.join('\n'));
console.log(
  `gate regression matrix: ${cases.length - failures}/${cases.length} cases as expected`,
);
const fuzzIndex = process.argv.indexOf('--fuzz-samples');
const fuzzed = process.argv.includes('--no-fuzz')
  ? null
  : fuzz({
      samples: fuzzIndex >= 0 ? Number(process.argv[fuzzIndex + 1]) : 1500,
    });
if (fuzzed != null) {
  for (const s of fuzzed.summary) console.log(JSON.stringify(s));
  console.log(`fuzzer: ${fuzzed.violations} invariant violations`);
}
fs.rmSync(work, { recursive: true, force: true });
if (failures > 0 || (fuzzed?.violations ?? 0) > 0) process.exitCode = 1;
