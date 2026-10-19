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
// controls must keep `pass` (null comparison, honest version 2) and `fail`
// (injected slowdown). Exits non-zero on any mismatch.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO, readJson, sha256 } from './lib.mjs';
import { deriveBudgets, gate } from './budgets.mjs';

const R = 'benchmarks/core-evolution/results';
const FINAL = [1, 2].map((n) => `${R}/alpha1-final-${n}/raw.json`);
const SLOW = `${R}/gate-injected-slowdown/raw.json`;
const BUDGETS = 'benchmarks/core-evolution/budgets.v1.json';
const POLICY = 'benchmarks/core-evolution/budget-policy.v1.json';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ce003-gate-regression-'));
const originals = FINAL.map((f) => readJson(path.join(REPO, f)));
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
  'committed budgets passed explicitly stay in release mode',
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
add('identity', 'Node binary digest missing', 'fail', () => {
  const raws = fresh();
  raws.forEach((r) => delete r.environment.nodeBinarySha256);
  return gateOn(raws);
});
add('identity', 'Node version differs from the pin', 'fail', () => {
  const raws = fresh();
  raws.forEach((r) => (r.environment.node = 'v24.21.0'));
  return gateOn(raws);
});
add('identity', 'candidate identity not recorded', 'inconclusive', () => {
  const raws = fresh();
  replay(raws).forEach((e) => delete e.installedPandamstyle);
  return gateOn(raws);
});
add('identity', 'workloads record digest differs', 'fail', () => {
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
add(
  'observations',
  'interval straddling the limit (review probe)',
  'inconclusive',
  () =>
    gateOn(
      each(
        fresh(),
        (s) =>
          fixture(s) &&
          (s.result.full.totalMs =
            s.epoch === 'alpha1' ? 100 : s.round % 2 ? 120 : 100),
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
add('observations', 'corrupt run file', 'fail', () => {
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
  'untracked weakened copy of v1 (review probe)',
  'not-release',
  () => gateOn(cssRegression(), { budgets: writeBudgets(weak()) }),
);
add(
  'provenance',
  'untracked v2 reusing the v1 baseline (review probe)',
  'not-release',
  () => {
    const b = weak();
    b.policyVersion = 2;
    b.supersedes = {
      path: BUDGETS,
      sha256: sha256(fs.readFileSync(path.join(REPO, BUDGETS))),
    };
    return gateOn(cssRegression(), { budgets: writeBudgets(b) });
  },
);
add(
  'provenance',
  'untracked v2 with fabricated evidence and a relaxation (review probe)',
  'not-release',
  () => {
    const b = weak();
    b.policyVersion = 2;
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

add('provenance', 'v1 budgets weakened and re-committed', 'fail', () => {
  const dir = clone('recommit');
  writeIn(dir, BUDGETS, `${JSON.stringify(weak(), null, 2)}\n`);
  commit(dir, 'weaken v1');
  return gateIn(dir, cssRegression());
});
add('provenance', 'v1 budgets deleted, then re-added weakened', 'fail', () => {
  const dir = clone('readd');
  fs.rmSync(path.join(dir, BUDGETS));
  commit(dir, 'remove v1');
  writeIn(dir, BUDGETS, `${JSON.stringify(weak(), null, 2)}\n`);
  commit(dir, 're-add v1');
  return gateIn(dir, cssRegression());
});
add('provenance', 'v1 policy edited after the freeze', 'fail', () => {
  const dir = clone('policy');
  const policy = readJson(path.join(dir, POLICY));
  policy.thresholdRule.deterministic.growth.default = 0.5;
  writeIn(dir, POLICY, `${JSON.stringify(policy, null, 2)}\n`);
  commit(dir, 'edit policy');
  return gateIn(dir);
});
add('provenance', 'alpha1 manifest edited after the freeze', 'fail', () => {
  const dir = clone('manifest');
  const file = 'benchmarks/core-evolution/epochs/alpha1/manifest.v1.json';
  writeIn(dir, file, `${fs.readFileSync(path.join(dir, file), 'utf8')} `);
  commit(dir, 'edit manifest');
  return gateIn(dir);
});
add(
  'provenance',
  'baseline evidence file edited after the freeze',
  'fail',
  () => {
    const dir = clone('evidence');
    const raw = readJson(path.join(dir, FINAL[0]));
    raw.samples[0].result.wallMs += 1;
    writeIn(dir, FINAL[0], `${JSON.stringify(raw, null, 2)}\n`);
    commit(dir, 'edit evidence');
    return gateIn(dir);
  },
);
const v2Budgets = (dir, mutate) => {
  const b = weak();
  b.policyVersion = 2;
  b.supersedes = {
    path: BUDGETS,
    sha256: sha256(fs.readFileSync(path.join(dir, BUDGETS))),
  };
  b.policy = {
    path: 'benchmarks/core-evolution/budget-policy.v2.json',
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
  writeIn(
    dir,
    'benchmarks/core-evolution/budgets.v2.json',
    `${JSON.stringify(b, null, 2)}\n`,
  );
};
add('provenance', 'committed v2 budgets without a v2 policy', 'fail', () => {
  const dir = clone('v2-no-policy');
  v2Budgets(
    dir,
    (b) =>
      (b.baseline.results = b.baseline.results.map((r, i) => ({
        ...r,
        sha256: String(i + 5).repeat(64),
      }))),
  );
  commit(dir, 'v2 without policy');
  return gateIn(dir, cssRegression());
});
add(
  'provenance',
  'committed v2 policy and budgets whose evidence files are absent',
  'fail',
  () => {
    const dir = clone('v2-no-evidence');
    const policy = {
      ...readJson(path.join(dir, POLICY)),
      policyVersion: 2,
      justification: 'a version 2 that names results never committed',
    };
    writeIn(
      dir,
      'benchmarks/core-evolution/budget-policy.v2.json',
      `${JSON.stringify(policy, null, 2)}\n`,
    );
    v2Budgets(dir, (b) => {
      b.policy.sha256 = sha256(
        fs.readFileSync(
          path.join(dir, 'benchmarks/core-evolution/budget-policy.v2.json'),
        ),
      );
      b.baseline.results = [
        {
          path: `${R}/never-measured/raw.json`,
          sha256: '6'.repeat(64),
          label: 'never-measured',
        },
      ];
    });
    commit(dir, 'v2 without evidence');
    return gateIn(dir, cssRegression());
  },
);

// An honest version 2: its own policy, new committed evidence (the baseline
// runs re-labelled, so new files with new digests), and budgets derived from
// them. The gate must accept it in release mode, and refuse to treat the
// superseded v1 as release budgets.
function honestV2(dir) {
  const policyFile = 'benchmarks/core-evolution/budget-policy.v2.json';
  const policy = {
    ...readJson(path.join(dir, POLICY)),
    policyVersion: 2,
    supersedes: {
      path: BUDGETS,
      sha256: sha256(fs.readFileSync(path.join(dir, BUDGETS))),
    },
    justification:
      'Regression-matrix version 2 resting on new committed baseline evidence.',
  };
  writeIn(dir, policyFile, `${JSON.stringify(policy, null, 2)}\n`);
  const refs = [];
  const raws = [];
  for (const [n, file] of FINAL.entries()) {
    const raw = readJson(path.join(dir, file));
    raw.label = `alpha1-v2-${n + 1}`;
    const target = `${R}/alpha1-v2-${n + 1}/raw.json`;
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
    { ...policy, __path: policyFile, __sha256: sha256(policyBytes) },
    raws,
    refs,
    { manifestSha256: sha256(manifest) },
  );
  writeIn(
    dir,
    'benchmarks/core-evolution/budgets.v2.json',
    `${JSON.stringify(budgets, null, 2)}\n`,
  );
  commit(dir, 'honest v2');
}
add(
  'provenance',
  'honest committed v2 with new evidence (positive control)',
  'pass',
  () => {
    const dir = clone('v2-honest');
    honestV2(dir);
    return gateIn(dir);
  },
);
add(
  'provenance',
  'superseded v1 passed while v2 is in force',
  'not-release',
  () => {
    const dir = clone('v2-older');
    honestV2(dir);
    return gateIn(dir, fresh(), { budgets: path.join(dir, BUDGETS) });
  },
);

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
fs.rmSync(work, { recursive: true, force: true });
if (failures > 0) process.exitCode = 1;
