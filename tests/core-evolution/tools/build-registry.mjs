/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Builds docs/research/core-evolution-registry.v1.json. It collects the
// per-entry upstream facts from the re-derived upstream keys, the emission
// probes, BCD data and the Alpha 1 property policy, then derives everything
// else with derive-registry.mjs from those facts and the authored CE-00.1
// rules, profiles, capability dispositions and scope decisions. The output is
// generated; edit the authored inputs and rebuild instead.
//
//   node tests/core-evolution/tools/build-registry.mjs \
//     --keys <extraction> --stylex-probe <file> --panda-probe <file> \
//     --bcd-data <data.json> --out docs/research/core-evolution-registry.v1.json
//
// Repository inputs are read from their fixed paths relative to the repo root.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseJs } from 'hermes-parser';
import { deriveRegistry } from './derive-registry.mjs';
import { fileDigest, parseArgs, readJson, run, writeJson } from './lib.mjs';

const options = parseArgs(process.argv.slice(2), [
  'keys',
  'stylex-probe',
  'panda-probe',
  'bcd-data',
  'out',
]);
const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const rel = (p) => path.join(repo, p);
const INPUTS = {
  inventory: 'docs/research/core-evolution-inventory.json',
  evidenceLock: 'docs/research/core-evolution-evidence.json',
  reviewEvidence: 'docs/research/core-evolution-review-evidence.json',
  observations: 'docs/research/core-evolution-upstream-observations.v1.json',
  plan: 'docs/architecture/core-evolution-plan.md',
  coverage: 'docs/architecture/core-evolution-coverage.md',
  review: 'docs/architecture/core-evolution-review.md',
  alpha1Policy: 'packages/compiler/src/design-system/policy/properties.js',
  rules: 'tests/core-evolution/classification-rules.v1.json',
  profiles: 'tests/core-evolution/profiles.v1.json',
  capabilities: 'tests/core-evolution/capabilities.v1.json',
  decisions: 'tests/core-evolution/scope-decisions.v1.json',
};
const errors = [];
const fail = (message) => errors.push(message);

const inventory = readJson(rel(INPUTS.inventory));
const rules = readJson(rel(INPUTS.rules));
const profiles = readJson(rel(INPUTS.profiles));
const capSpec = readJson(rel(INPUTS.capabilities));
const decisions = readJson(rel(INPUTS.decisions));
const keys = readJson(options.keys);
const stylexProbe = readJson(options['stylex-probe']);
const pandaProbe = readJson(options['panda-probe']);
const bcd = JSON.parse(fs.readFileSync(options['bcd-data'], 'utf8'));
const bcdProps = bcd.css.properties;

const COLUMNS = inventory.columns;
const rows = inventory.properties.map((row) =>
  Object.fromEntries(COLUMNS.map((column, i) => [column, row[i]])),
);
const names = new Set(rows.map((row) => row.name));
if (names.size !== rows.length) fail('inventory names are not unique');

// ---------------------------------------------------------------------------
// Alpha 1 policy, parsed from source rather than imported.

function alpha1Policy() {
  const ast = parseJs(fs.readFileSync(rel(INPUTS.alpha1Policy), 'utf8'), {
    sourceType: 'module',
  });
  const tables = {};
  for (const node of ast.body) {
    if (node.type !== 'VariableDeclaration') continue;
    for (const decl of node.declarations) {
      tables[decl.id.name] = decl.init;
    }
  }
  const literal = (node) => {
    if (node.type === 'Literal') return node.value;
    if (node.type === 'UnaryExpression' && node.operator === '-')
      return -literal(node.argument);
    if (node.type === 'Identifier' && node.name === 'Infinity')
      return 'Infinity';
    throw new Error(`Unexpected policy literal ${node.type}`);
  };
  const keyOf = (prop) =>
    prop.key.type === 'Identifier' ? prop.key.name : prop.key.value;
  const policy = new Map();
  for (const prop of tables.PROPERTY_CATEGORY.properties) {
    policy.set(keyOf(prop), {
      kind: 'token-category',
      category: literal(prop.value),
    });
  }
  for (const prop of tables.STRUCTURAL.properties) {
    const arg = prop.value.arguments[0];
    let values;
    if (arg.type === 'ArrayExpression') {
      values = arg.elements.map(literal);
    } else {
      // repeat(N, minmax(0, 1fr)) for N in 1..6, written as a map call.
      const items = arg.callee.object.elements.map(literal);
      values = items.map((n) => `repeat(${n}, minmax(0, 1fr))`);
    }
    policy.set(keyOf(prop), { kind: 'finite-set', values });
  }
  for (const prop of tables.STRUCTURAL_NUMBER_RANGES.properties) {
    const range = Object.fromEntries(
      prop.value.properties.map((p) => [keyOf(p), literal(p.value)]),
    );
    policy.set(keyOf(prop), { kind: 'numeric-range', range });
  }
  const composite = tables.COMPOSITE_FORMS.arguments[0].elements.map(literal);
  return { policy, composite };
}

const kebab = (key) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const alpha1 = alpha1Policy();
const alpha1ByName = new Map(
  [...alpha1.policy].map(([key, value]) => [kebab(key), { key, ...value }]),
);
const compositeByName = new Set(alpha1.composite.map(kebab));

// ---------------------------------------------------------------------------
// Upstream facts.

const bySource = (list) => new Map(list.map((item) => [item.name, item]));
const stylexKeys = bySource(keys.stylex.keys);
const pandaTypeKeys = bySource(keys.pandaTypes.keys);
const pandaUtilityKeys = bySource(keys.pandaUtilities.keys);
const bcdKeys = bySource(keys.bcd.keys);
const stylexEmission = bySource(stylexProbe.entries);
const pandaEmission = bySource(pandaProbe.entries);

function bcdStatusKind(status) {
  if (status == null) return null;
  if (status.deprecated) return 'deprecated';
  if (status.experimental) return 'experimental';
  if (!status.standard_track) return 'nonstandard';
  return 'standard';
}

const ENGINES = [
  'chrome',
  'edge',
  'firefox',
  'safari',
  'safari_ios',
  'webview_android',
];
function engineSummary(compat) {
  const out = {};
  for (const engine of ENGINES) {
    const statements = [compat.support[engine] ?? []].flat();
    const usable = statements.filter(
      (s) => !s.flags && s.version_removed == null,
    );
    const native = usable.find(
      (s) =>
        !s.prefix &&
        !s.alternative_name &&
        typeof s.version_added === 'string' &&
        s.version_added !== 'preview',
    );
    const prefixed = usable.find(
      (s) =>
        (s.prefix || s.alternative_name) &&
        typeof s.version_added === 'string' &&
        s.version_added !== 'preview',
    );
    if (native) {
      out[engine] =
        native.version_added +
        (native.partial_implementation ? ' partial' : '');
    } else if (prefixed) {
      out[engine] =
        `${prefixed.version_added} via ${prefixed.prefix ?? prefixed.alternative_name}`;
    } else if (statements.some((s) => s.version_added === 'preview')) {
      out[engine] = 'preview';
    } else {
      out[engine] = false;
    }
  }
  return out;
}

// BCD prefix and alternative-name statements relating an inventory name to
// another property, with the caveats those statements carry.
const decode = (text) =>
  text
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
const relationStatements = new Map();
for (const [key, value] of Object.entries(bcdProps)) {
  for (const [engine, statements] of Object.entries(
    value.__compat?.support ?? {},
  )) {
    for (const s of [statements].flat()) {
      const alias = s.prefix ? s.prefix + key : s.alternative_name;
      if (!alias || alias === key || !names.has(alias)) continue;
      const byTarget = relationStatements.get(alias) ?? new Map();
      const via = s.prefix ? 'bcd-prefix' : 'bcd-alternative-name';
      const relation = byTarget.get(key) ?? { target: key, via, list: [] };
      relation.list.push({ engine, s });
      byTarget.set(key, relation);
      relationStatements.set(alias, byTarget);
    }
  }
}
function bcdRelations(name) {
  const byTarget = relationStatements.get(name);
  if (!byTarget) return [];
  return [...byTarget.values()].map(({ target, via, list }) => {
    const groups = new Map();
    for (const { engine, s } of list) {
      const notes = [s.notes ?? []].flat().map(decode);
      const partial = Boolean(s.partial_implementation);
      const flags = Boolean(s.flags);
      if (!notes.length && !partial && !flags) continue;
      const id = JSON.stringify([partial, flags, notes]);
      const group = groups.get(id) ?? { engines: [], partial, flags, notes };
      group.engines.push(engine);
      groups.set(id, group);
    }
    const caveats = [...groups.values()]
      .map((g) => ({ ...g, engines: g.engines.sort() }))
      .sort((a, b) => (a.engines[0] < b.engines[0] ? -1 : 1));
    return {
      target,
      via,
      statements: list.length,
      shipping: list.some(
        ({ s }) =>
          !s.flags &&
          s.version_removed == null &&
          typeof s.version_added === 'string' &&
          s.version_added !== 'preview',
      ),
      caveats,
    };
  });
}

// ---------------------------------------------------------------------------
// Facts per inventory entry. Everything else is derived.

for (const name of alpha1ByName.keys()) {
  if (!names.has(name))
    fail(`Alpha 1 property ${name} missing from the inventory`);
}
const facts = rows.map(({ name }) => {
  const bcdEntry = bcdKeys.get(name);
  const policy = alpha1ByName.get(name);
  const sx = stylexEmission.get(name);
  const pd = pandaEmission.get(name);
  return {
    name,
    sources: Object.fromEntries(
      [
        ['stylexType', stylexKeys.get(name)?.key],
        ['pandaType', pandaTypeKeys.get(name)?.key],
        ['pandaUtility', pandaUtilityKeys.get(name)?.key],
        ['bcd', bcdEntry ? name : null],
      ].filter(([, value]) => value != null),
    ),
    bcd: bcdEntry
      ? {
          status: bcdStatusKind(bcdEntry.status),
          engines: engineSummary(bcdProps[name].__compat),
        }
      : null,
    bcdRelations: bcdRelations(name),
    alpha1: policy
      ? {
          kind: policy.kind,
          ...(policy.category ? { category: policy.category } : {}),
          ...(policy.values ? { values: policy.values } : {}),
          ...(policy.range ? { range: policy.range } : {}),
        }
      : {
          kind: compositeByName.has(name)
            ? 'rejected-composite-form'
            : 'unsupported',
        },
    // The probed key is recorded only when it is not the source's own key.
    upstream: {
      stylex: {
        ...(sx.keySource === 'stylex-type' ? {} : { probeKey: sx.key }),
        emission: sx.kind,
        emitted: sx.properties ?? [],
        ...(sx.throwModeError ? { throwModeError: sx.throwModeError } : {}),
      },
      panda: {
        ...(pd.keySource.startsWith('panda-') ? {} : { probeKey: pd.key }),
        emission: pd.kind,
        emitted: pd.properties ?? [],
        ...(pd.value !== 'initial' && pd.value != null
          ? { probeValue: pd.value }
          : {}),
        ...(pd.kind === 'selector-helper' ? { selectors: pd.selectors } : {}),
        ...(pd.atRules?.length ? { atRules: pd.atRules } : {}),
      },
    },
  };
});

const derived = deriveRegistry({
  inventory,
  rules,
  profiles,
  capSpec,
  decisions,
  coverageText: fs.readFileSync(rel(INPUTS.coverage), 'utf8'),
  facts,
});
errors.push(...derived.errors);
if (errors.length) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exit(1);
}

const digests = Object.fromEntries(
  Object.entries(INPUTS)
    .filter(([, p]) => fs.existsSync(rel(p)))
    .map(([k, p]) => [k, { path: p, sha256: fileDigest(rel(p)) }]),
);
const registry = derived.registry;
registry.inputs = {
  ...digests,
  upstreamKeyExtraction: {
    sha256: fileDigest(options.keys),
    counts: {
      stylex: keys.stylex.keys.length,
      pandaTypes: keys.pandaTypes.keys.length,
      pandaUtilities: keys.pandaUtilities.keys.length,
      bcd: keys.bcd.keys.length,
    },
  },
  stylexEmissionProbe: {
    sha256: fileDigest(options['stylex-probe']),
    versions: stylexProbe.versions,
  },
  pandaEmissionProbe: {
    sha256: fileDigest(options['panda-probe']),
    versions: pandaProbe.versions,
  },
  bcdData: {
    sha256: fileDigest(options['bcd-data']),
    version: bcd.__meta?.version ?? null,
  },
};
run(async () => {
  await writeJson(path.resolve(options.out), registry);
  process.stdout.write(
    `registry entries=${registry.entries.length} capabilities=${registry.capabilities.length}\n`,
  );
});
