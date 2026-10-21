/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CE-02.1 Alpha 1 equivalence, through the public Project Service of two
// built compilers.
//
//   node tools/policy/alpha1-equivalence.mjs --alpha1 <closure> [--candidate <lib/index.mjs>]
//
// `<closure>` is an installed Alpha 1 closure, such as `<store>/closure` of the
// CE-00.3 baseline store (read only). The candidate defaults to this
// workspace's built compiler.
//
// One project, one page per probe group, one `create()` call per probe: the
// probes the Jest equivalence test runs against the pinned Alpha 1 policy,
// here compiled by both compilers end to end. For each call it compares the
// diagnostic codes and rules. The only accepted differences are the CE-02.1
// deltas: an unsupported-property rule gains a suffix.
//
// Prints a JSON summary; exits 1 on any other difference.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(new URL('../..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (name) => {
  const index = argv.indexOf(name);
  return index < 0 ? null : argv[index + 1];
};
if (arg('--alpha1') == null) {
  process.stderr.write(
    'usage: alpha1-equivalence.mjs --alpha1 <closure> [--candidate <lib/index.mjs>]\n',
  );
  process.exit(2);
}
const ALPHA1 = path.join(
  path.resolve(arg('--alpha1')),
  'node_modules/@pandamstyle/compiler/lib/index.mjs',
);
const CANDIDATE = path.resolve(
  arg('--candidate') ?? path.join(REPO, 'packages/compiler/lib/index.mjs'),
);

const REGISTRY = JSON.parse(
  fs.readFileSync(
    path.join(REPO, 'docs/research/core-evolution-registry.v1.json'),
    'utf8',
  ),
);
const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const CATEGORIES = [
  'colors',
  'spacing',
  'radii',
  'fontFamilies',
  'fontSizes',
  'fontWeights',
  'lineHeights',
  'letterSpacings',
  'shadows',
  'durations',
  'easings',
  'sizes',
];
const DEFINITION = `export default {
  systemId: 'ce021-equivalence',
  tokens: {
${CATEGORIES.map(
  (c) =>
    `    ${c}: { a: { value: '1px', visibility: 'public' }, p: { value: '2px', visibility: 'private' } },`,
).join('\n')}
  },
};
`;

// Probe values as source text. Literals the compiler resolves statically.
const COMMON = [
  "'x'",
  "''",
  "'auto'",
  "'inherit'",
  "'calc(1px)'",
  "'0'",
  '0',
  '1',
  '0.5',
  '-1',
  '2',
  '1e308',
  "'0.5'",
  ...CATEGORIES.flatMap((c) => [
    `token('${c}.a')`,
    `token('${c}.p')`,
    `token('${c}.missing')`,
  ]),
];

function probes() {
  const out = [];
  for (const entry of REGISTRY.entries) {
    const key = camel(entry.name);
    if (!/^[A-Za-z]\w*$/.test(key)) continue;
    const values =
      entry.alpha1.kind === 'unsupported'
        ? ["'x'", '0', "token('colors.a')"]
        : [
            ...COMMON,
            ...(entry.alpha1.values ?? []).map((v) => JSON.stringify(v)),
          ];
    for (const value of values) out.push({ key, value, entry });
  }
  for (const key of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    for (const value of ["'x'", "token('colors.a')"]) {
      out.push({ key, value, entry: null });
    }
  }
  return out;
}

async function run(libPath, root, groups) {
  const compiler = await import(pathToFileURL(libPath).href);
  const definition = (
    await import(pathToFileURL(path.join(root, 'design.mjs')).href)
  ).default;
  const session = compiler.createProjectSession({
    rootDir: root,
    definition,
    roots: ['src'],
    outDir: path.join(root, 'generated'),
    designSystemFile: 'design.pandamstyle.js',
  });
  const byLine = new Map();
  try {
    const init = await session.initialize();
    const validation = await session.validate(init.revision);
    for (const d of validation.diagnostics ?? []) {
      const file = d.location?.file ?? d.source?.file;
      const line = d.location?.line ?? d.source?.line;
      const k = `${path.basename(file ?? '?')}:${line}`;
      if (!byLine.has(k)) byLine.set(k, []);
      byLine.get(k).push([d.code, d.rule]);
    }
  } finally {
    await session.close?.();
  }
  return groups.map((group, g) =>
    group.map((_, i) => byLine.get(`p${g}.js:${i + 2}`) ?? []),
  );
}

const all = probes();
const groups = [];
for (let i = 0; i < all.length; i += 400) groups.push(all.slice(i, i + 400));

function project(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ce021-eq-${label}-`));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'design.mjs'), DEFINITION);
  groups.forEach((group, g) => {
    fs.writeFileSync(
      path.join(root, 'src', `p${g}.js`),
      [
        "import { create, token } from '../generated/design.pandamstyle';",
        ...group.map(
          (p, i) =>
            `export const s${i} = create({ n: { ${p.key}: ${p.value} } });`,
        ),
        '',
      ].join('\n'),
    );
  });
  return root;
}

async function main() {
  const alpha1Root = project('alpha1');
  const candidateRoot = project('candidate');
  const alpha1 = await run(ALPHA1, alpha1Root, groups);
  const candidate = await run(CANDIDATE, candidateRoot, groups);
  fs.rmSync(alpha1Root, { recursive: true, force: true });
  fs.rmSync(candidateRoot, { recursive: true, force: true });

  const intended = (a, c) =>
    a.length === c.length &&
    a.every(
      ([code, rule], i) =>
        code === c[i][0] &&
        (rule === c[i][1] ||
          (rule === 'supported-properties' &&
            c[i][1].startsWith('supported-properties.'))),
    );
  const differences = [];
  const prototypeKeys = [];
  let accepted = 0;
  let rejected = 0;
  groups.forEach((group, g) =>
    group.forEach((p, i) => {
      const a = alpha1[g][i];
      const c = candidate[g][i];
      if (p.entry == null) {
        prototypeKeys.push({
          key: p.key,
          value: p.value,
          alpha1: a,
          candidate: c,
        });
        return;
      }
      if (a.length === 0) accepted += 1;
      else rejected += 1;
      if (!intended(a, c)) {
        differences.push({
          key: p.key,
          value: p.value,
          alpha1: a,
          candidate: c,
        });
      }
    }),
  );
  const summary = {
    alpha1: path.relative(process.cwd(), ALPHA1),
    candidate: path.relative(process.cwd(), CANDIDATE),
    probes: all.length - prototypeKeys.length,
    accepted,
    rejected,
    differences: differences.length,
    firstDifferences: differences.slice(0, 20),
    prototypeKeys,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = differences.length === 0 ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 2;
});
