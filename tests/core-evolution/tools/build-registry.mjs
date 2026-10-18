/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Builds docs/research/core-evolution-registry.v1.json from the pinned
// research inventory, the re-derived upstream keys, the upstream emission
// probes, BCD data, the Alpha 1 property policy and the authored CE-00.1
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

// BCD prefix and alternative-name statements: name -> [{target, via}].
const bcdAliases = new Map();
for (const [key, value] of Object.entries(bcdProps)) {
  for (const statements of Object.values(value.__compat?.support ?? {})) {
    for (const s of [statements].flat()) {
      const alias = s.prefix ? s.prefix + key : s.alternative_name;
      if (!alias || alias === key) continue;
      const list = bcdAliases.get(alias) ?? [];
      if (!list.some((item) => item.target === key)) {
        list.push({
          target: key,
          via: s.prefix ? 'bcd-prefix' : 'bcd-alternative-name',
        });
      }
      bcdAliases.set(alias, list);
    }
  }
}

// ---------------------------------------------------------------------------
// Classification.

const curatedGroups = [
  ['incompatibleRuntime', 'incompatible-runtime-requirement', null],
  ['systemResources', 'system-resource', null],
  ['nonCssSyntax', 'non-css-syntax', null],
  ['platformExtensions', 'scoped-platform-extension', null],
  ['aliases', 'normalized-alias', null],
  ['deprecated', 'deprecated-or-experimental', 'deprecated'],
  ['abandonedDraft', 'deprecated-or-experimental', 'abandoned-draft'],
  [
    'unimplementedSpecification',
    'deprecated-or-experimental',
    'unimplemented-specification',
  ],
  ['experimental', 'deprecated-or-experimental', 'experimental'],
  ['nonstandard', 'deprecated-or-experimental', 'nonstandard'],
];
const curated = new Map();
for (const [group, disposition, subkind] of curatedGroups) {
  for (const [name, record] of Object.entries(rules[group])) {
    if (!names.has(name))
      fail(`curated ${group} entry ${name} is not an inventory name`);
    if (curated.has(name)) fail(`${name} is curated twice`);
    curated.set(name, { group, disposition, subkind, record });
  }
}
for (const name of Object.keys(rules.notes)) {
  if (!names.has(name)) fail(`note for unknown inventory name ${name}`);
}

const VENDOR = /^-(webkit|moz|ms|o|khtml)-/;
const OBSOLETE_ENGINE = /^-(ms|o|khtml)-/;
const memo = new Map();

function classify(name, stack = []) {
  if (memo.has(name)) return memo.get(name);
  if (stack.includes(name))
    throw new Error(`alias cycle ${[...stack, name].join(' -> ')}`);
  const result = classifyUncached(name, [...stack, name]);
  memo.set(name, result);
  return result;
}

function inherit(target, via, stack) {
  const base = classify(target, stack);
  if (
    base.disposition === 'canonical-property' ||
    base.disposition === 'scoped-platform-extension'
  ) {
    return {
      disposition: 'normalized-alias',
      canonical: target,
      aliasKind: via,
      familyKey: target,
    };
  }
  if (base.disposition === 'deprecated-or-experimental') {
    return {
      disposition: 'deprecated-or-experimental',
      subkind: base.subkind,
      replacement: base.replacement ?? null,
      variantOf: target,
      basis: via,
      familyKey: base.familyKey ?? target,
    };
  }
  return null;
}

function classifyUncached(name, stack) {
  const c = curated.get(name);
  if (c) {
    const r = c.record;
    return {
      disposition: c.disposition,
      subkind: c.subkind ?? undefined,
      basis: `curated:${c.group}`,
      canonical:
        r.canonical && c.disposition === 'normalized-alias'
          ? r.canonical
          : undefined,
      aliasKind: r.aliasKind,
      replacement: r.replacement,
      reason: r.reason ?? r.note ?? r.evidence,
      familyKey: r.family
        ? null
        : r.canonical && c.disposition === 'normalized-alias'
          ? r.canonical
          : (r.replacement ?? name),
      family: r.family,
      curated: r,
    };
  }
  const bcdEntry = bcdKeys.get(name);
  const status = bcdStatusKind(bcdEntry?.status);
  const aliasTargets = bcdAliases.get(name) ?? [];
  if (OBSOLETE_ENGINE.test(name)) {
    const base = name.replace(VENDOR, '');
    const equivalent =
      aliasTargets[0]?.target ?? (names.has(base) ? base : null);
    return {
      disposition: 'deprecated-or-experimental',
      subkind: 'obsolete-engine-prefix',
      basis: aliasTargets.length
        ? aliasTargets.map((a) => a.via).join('+')
        : 'name-prefix',
      replacement: equivalent,
      equivalents:
        aliasTargets.length > 1 ? aliasTargets.map((a) => a.target) : undefined,
      limitation: 'LIM-05',
      familyKey: equivalent ?? name,
    };
  }
  if (status === 'standard') {
    return {
      disposition: 'canonical-property',
      basis: 'bcd-standard-track',
      familyKey: name,
    };
  }
  if (status) {
    const alt = aliasTargets[0]?.target ?? null;
    return {
      disposition: 'deprecated-or-experimental',
      subkind: status,
      basis: `bcd-${status}`,
      replacement: alt,
      familyKey: VENDOR.test(name) ? name.replace(VENDOR, '') : name,
    };
  }
  if (aliasTargets.length) {
    const inherited = inherit(
      aliasTargets[0].target,
      aliasTargets[0].via,
      stack,
    );
    if (inherited) return { ...inherited, basis: aliasTargets[0].via };
  }
  if (VENDOR.test(name)) {
    const base = name.replace(VENDOR, '');
    if (names.has(base)) {
      const inherited = inherit(base, 'vendor-prefix-name-derivation', stack);
      if (inherited)
        return { ...inherited, basis: 'vendor-prefix-name-derivation' };
    }
    return {
      disposition: 'deprecated-or-experimental',
      subkind: 'nonstandard',
      basis: 'vendor-only-without-bcd-record',
      familyKey: base,
    };
  }
  throw new Error(`unclassified inventory entry ${name}`);
}

const familyMatchers = rules.families.map((family) => ({
  ...family,
  regexes: (family.patterns ?? []).map((p) => new RegExp(p)),
}));
const familyById = new Map(familyMatchers.map((f) => [f.id, f]));
function familyFor(result) {
  if (result.family) {
    if (!familyById.has(result.family)) fail(`unknown family ${result.family}`);
    return familyById.get(result.family);
  }
  const key = result.familyKey;
  return familyMatchers.find(
    (f) => (f.names ?? []).includes(key) || f.regexes.some((r) => r.test(key)),
  );
}

// ---------------------------------------------------------------------------
// Coverage matrix: capability rows, Work lots and request traceability.

function coverageTables() {
  const text = fs.readFileSync(rel(INPUTS.coverage), 'utf8');
  const caps = new Map();
  for (const line of text.split('\n')) {
    const m = /^\| (CAP-\d\d) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \|$/.exec(
      line,
    );
    if (m) {
      const lots = m[5]
        .replace(/^CE-/, '')
        .split('/')
        .map((n) => `CE-${n}`);
      caps.set(m[1], {
        capability: m[2],
        alpha1Status: m[3],
        requiredOutcome: m[4],
        work: m[5],
        lots,
      });
    }
  }
  const section = text
    .split('## Initial request traceability')[1]
    .split('## Required proof record')[0];
  const requests = [];
  for (const line of section.split('\n')) {
    const m = /^\| (.+?) \| (.+?) \|$/.exec(line);
    if (m && m[1] !== 'Request' && !m[1].startsWith('---'))
      requests.push({ request: m[1], acceptance: m[2] });
  }
  return { caps, requests };
}
const coverage = coverageTables();
if (coverage.caps.size !== 48)
  fail(
    `coverage matrix has ${coverage.caps.size} capability rows, expected 48`,
  );

const lotIssues = capSpec.lotIssues;
const capById = new Map(capSpec.capabilities.map((c) => [c.id, c]));
const profileIds = profiles.profiles.map((p) => p.id);
const decisionIds = new Set(decisions.decisions.map((d) => d.id));

// ---------------------------------------------------------------------------
// Entries.

const APPLICATION_PROFILES = new Set(
  profiles.profiles.filter((p) => p.kind === 'application').map((p) => p.id),
);
const REQUIRED_DISPOSITIONS = new Set([
  'canonical-property',
  'scoped-platform-extension',
  'system-resource',
]);
const NONCANONICAL_OWNERS = new Set(['CE-01', 'CE-02', 'CE-11']);
const MAJOR = ['chrome', 'firefox', 'safari'];
const entries = [];
const reconciliation = {
  sourceFlagMismatches: [],
  bcdStatusMismatches: [],
  alpha1Mismatches: [],
};

for (const row of rows) {
  const name = row.name;
  const result = classify(name);
  const family = familyFor(result);
  if (!family) {
    fail(`no family matches ${name} (key ${result.familyKey})`);
    continue;
  }
  const record = result.curated ?? {};
  const capability = record.requirementCarrier ?? family.cap;
  let owner = record.owner;
  if (!owner && result.disposition === 'normalized-alias')
    owner = rules.aliasOwner;
  if (!owner && result.disposition === 'incompatible-runtime-requirement')
    owner = 'CE-02';
  if (!owner && result.subkind) owner = rules.ownerBySubkind[result.subkind];
  if (!owner) owner = family.owner;
  const capRow = coverage.caps.get(capability);
  if (!capRow) {
    fail(`${name}: unknown capability ${capability}`);
    continue;
  }
  const ownerAllowed =
    capRow.lots.includes(owner) ||
    capability === 'CAP-01' ||
    (result.disposition !== 'canonical-property' &&
      NONCANONICAL_OWNERS.has(owner));
  if (!ownerAllowed)
    fail(
      `${name}: owner ${owner} is not a Work lot of ${capability} (${capRow.work})`,
    );

  // Reconcile the inventory row with the re-derived sources.
  const flags = {
    stylexTypeOccurrence: stylexKeys.has(name),
    pandaTypeOccurrence: pandaTypeKeys.has(name),
    pandaBaseUtilityOccurrence: pandaUtilityKeys.has(name),
  };
  for (const [column, actual] of Object.entries(flags)) {
    if (row[column] !== actual)
      reconciliation.sourceFlagMismatches.push({
        name,
        column,
        inventory: row[column],
        derived: actual,
      });
  }
  const bcdEntry = bcdKeys.get(name);
  const status = bcdStatusKind(bcdEntry?.status);
  if (row.bcdStatus !== status)
    reconciliation.bcdStatusMismatches.push({
      name,
      inventory: row.bcdStatus,
      derived: status,
    });
  const policy = alpha1ByName.get(name);
  const alpha1Kind = policy?.kind ?? 'unsupported';
  if (
    row.alpha1DomainKind !== alpha1Kind ||
    (row.alpha1TokenCategory ?? null) !== (policy?.category ?? null)
  ) {
    reconciliation.alpha1Mismatches.push({
      name,
      inventory: [row.alpha1DomainKind, row.alpha1TokenCategory],
      derived: [alpha1Kind, policy?.category ?? null],
    });
  }

  let requiredIn = [];
  if (REQUIRED_DISPOSITIONS.has(result.disposition)) {
    requiredIn = [
      ...(record.requiredIn ??
        (result.disposition === 'canonical-property' ? family.requiredIn : [])),
    ];
  }
  if (
    result.disposition === 'canonical-property' &&
    requiredIn.some((p) => APPLICATION_PROFILES.has(p))
  ) {
    for (const [overlay, rule] of Object.entries(rules.overlayRequirements)) {
      const hit =
        rule.names.includes(name) ||
        rule.patterns.some((p) => new RegExp(p).test(name));
      if (hit && !requiredIn.includes(overlay)) requiredIn.push(overlay);
    }
  }
  requiredIn.sort((a, b) => profileIds.indexOf(a) - profileIds.indexOf(b));
  for (const id of requiredIn)
    if (!profileIds.includes(id)) fail(`${name}: unknown profile ${id}`);

  const engines = bcdEntry ? engineSummary(bcdProps[name].__compat) : null;
  let targetDecision = null;
  if (requiredIn.length) {
    if (result.disposition === 'scoped-platform-extension') {
      targetDecision = {
        decision: 'D-BP-03',
        reason: 'platform-scoped extension; exact engine evidence required',
      };
    } else if (!engines) {
      targetDecision = {
        decision: 'D-BP-06',
        enginesWithoutUnprefixedRelease: MAJOR,
        reason: 'no BCD record',
      };
    } else {
      const missing = MAJOR.filter(
        (engine) => !/^\d[\d.]*( partial)?$/.test(String(engines[engine])),
      );
      const partial = MAJOR.filter((engine) =>
        / partial$/.test(String(engines[engine])),
      );
      if (missing.length || partial.length) {
        targetDecision = {
          decision: MAJOR.some((engine) =>
            / via /.test(String(engines[engine])),
          )
            ? 'D-BP-07'
            : 'D-BP-06',
          enginesWithoutUnprefixedRelease: missing,
          partialEngines: partial.length ? partial : undefined,
        };
      }
    }
  }

  let requirement;
  if (requiredIn.length) {
    requirement =
      alpha1Kind === 'unsupported'
        ? 'required-gap'
        : 'required-requalification-and-expansion';
  } else if (record.requirementCarrier) {
    requirement = 'carried-by-capability';
  } else {
    requirement = 'disposition-only';
  }

  let evidence;
  if (requiredIn.length) evidence = ['E2', 'E3', 'E4'];
  else if (
    result.disposition === 'normalized-alias' ||
    result.disposition === 'non-css-syntax'
  )
    evidence = ['E2', 'E3'];
  else if (result.disposition === 'system-resource') evidence = ['E2', 'E3'];
  else if (result.subkind === 'experimental') evidence = ['E1', 'E2'];
  else evidence = ['E2'];

  const sx = stylexEmission.get(name);
  const pd = pandaEmission.get(name);
  // The probed key is recorded only when it is not the source's own key.
  const upstream = {
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
  };
  const divergence = [];
  if (result.disposition === 'canonical-property') {
    if (sx.kind !== 'passthrough') divergence.push(`stylex:${sx.kind}`);
    if (pd.kind !== 'passthrough') divergence.push(`panda:${pd.kind}`);
  }

  const entry = {
    name,
    disposition: result.disposition,
    ...(result.subkind ? { subkind: result.subkind } : {}),
    basis: result.basis,
    ...(result.canonical
      ? { canonical: result.canonical, aliasKind: result.aliasKind }
      : {}),
    ...(result.replacement ? { replacement: result.replacement } : {}),
    ...(result.variantOf ? { variantOf: result.variantOf } : {}),
    ...(result.equivalents ? { equivalents: result.equivalents } : {}),
    ...(record.resourceKind ? { resourceKind: record.resourceKind } : {}),
    ...(record.canonical && result.disposition !== 'normalized-alias'
      ? { canonicalProperties: record.canonical }
      : {}),
    ...(record.syntaxKind
      ? { syntaxKind: record.syntaxKind, equivalent: record.equivalent }
      : {}),
    ...(record.platform
      ? { platform: record.platform, scope: record.scope }
      : {}),
    ...(result.limitation || record.limitation
      ? { limitation: result.limitation ?? record.limitation }
      : {}),
    family: family.id,
    capability,
    owner,
    requiredIn,
    requirement,
    ...(record.requirementCarrier
      ? { carriedBy: record.requirementCarrier }
      : {}),
    ...(targetDecision ? { targetDecision } : {}),
    proof: {
      fixtureId: `CE-FX-PROP-${name.replace(/^-+/, '')}`,
      evidenceClasses: evidence,
    },
    sources: Object.fromEntries(
      [
        ['stylexType', stylexKeys.get(name)?.key],
        ['pandaType', pandaTypeKeys.get(name)?.key],
        ['pandaUtility', pandaUtilityKeys.get(name)?.key],
        ['bcd', bcdEntry ? name : null],
      ].filter(([, value]) => value != null),
    ),
    bcd: bcdEntry ? { status, engines } : null,
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
    upstream,
    ...(divergence.length ? { upstreamDivergence: divergence } : {}),
    ...(rules.notes[name] || result.reason
      ? { note: rules.notes[name] ?? result.reason }
      : {}),
  };
  entries.push(entry);
}

for (const [field, list] of Object.entries(reconciliation)) {
  if (list.length)
    fail(`reconciliation ${field}: ${JSON.stringify(list.slice(0, 5))}`);
}
if (entries.length !== rows.length)
  fail(
    `registry has ${entries.length} entries for ${rows.length} inventory rows`,
  );
for (const name of alpha1ByName.keys()) {
  if (!names.has(name))
    fail(`Alpha 1 property ${name} missing from the inventory`);
}

// ---------------------------------------------------------------------------
// Capabilities, limitations, profiles and decisions.

const limitationIds = new Set(capSpec.limitations.map((l) => l.id));
for (const entry of entries) {
  if (entry.limitation && !limitationIds.has(entry.limitation))
    fail(`${entry.name}: unknown limitation ${entry.limitation}`);
}
const capabilities = [];
for (const [id, row] of coverage.caps) {
  const spec = capById.get(id);
  if (!spec) {
    fail(`capability ${id} has no authored disposition`);
    continue;
  }
  if (!row.lots.includes(spec.primaryOwner))
    fail(`${id}: primary owner ${spec.primaryOwner} not in Work ${row.work}`);
  if (!row.lots.includes(spec.closingLot))
    fail(`${id}: closing lot ${spec.closingLot} not in Work ${row.work}`);
  const existing = /^Existing\b|^Vite, Next|^Alpha 1 package/.test(
    row.alpha1Status,
  );
  if ((spec.disposition === 'existing-requalification') !== existing) {
    fail(
      `${id}: disposition ${spec.disposition} disagrees with Alpha 1 status "${row.alpha1Status}"`,
    );
  }
  for (const lim of spec.limitations)
    if (!limitationIds.has(lim)) fail(`${id}: unknown limitation ${lim}`);
  const requiredBy = profiles.profiles
    .filter((p) => p.requiredCapabilities.includes(id))
    .map((p) => p.id);
  if (!requiredBy.length) fail(`${id} is required by no profile`);
  const mapped = entries.filter((e) => e.capability === id);
  capabilities.push({
    id,
    ...row,
    disposition: spec.disposition,
    primaryOwner: spec.primaryOwner,
    closingLot: spec.closingLot,
    issues: [...new Set(row.lots.flatMap((lot) => lotIssues[lot] ?? []))].sort(
      (a, b) => a - b,
    ),
    requiredByProfiles: requiredBy,
    limitations: spec.limitations,
    proofRecord: spec.proofRecord,
    inventoryEntries: id === 'CAP-01' ? entries.length : mapped.length,
    requiredInventoryEntries: (id === 'CAP-01' ? entries : mapped).filter(
      (e) => e.requiredIn.length,
    ).length,
    requestCases: capSpec.requestCases
      .filter((r) => r.capabilities.includes(id))
      .map((r) => r.id),
  });
}
for (const id of capById.keys())
  if (!coverage.caps.has(id))
    fail(`authored capability ${id} is not in the coverage matrix`);

if (capSpec.requestCases.length !== coverage.requests.length) {
  fail(
    `request cases ${capSpec.requestCases.length} vs coverage rows ${coverage.requests.length}`,
  );
}
const requestCases = capSpec.requestCases.map((req, i) => {
  const row = coverage.requests[i];
  if (!row || row.request !== req.request)
    fail(`request case ${req.id} text differs from coverage row ${i + 1}`);
  for (const lot of req.lots)
    if (
      !row?.acceptance.includes(lot.slice(3)) &&
      !row?.acceptance.includes(lot)
    )
      fail(`${req.id}: lot ${lot} not named in "${row?.acceptance}"`);
  return { ...req, acceptance: row?.acceptance ?? null };
});

for (const profile of profiles.profiles) {
  for (const id of profile.requiredCapabilities)
    if (!coverage.caps.has(id)) fail(`${profile.id}: unknown ${id}`);
  for (const d of [
    profile.browserTargetDecision,
    ...profile.additionalBrowserDecisions,
    ...profile.sourceFormatDecisions,
  ]) {
    if (d !== 'inherits-application-profile' && !decisionIds.has(d))
      fail(`${profile.id}: unknown decision ${d}`);
  }
}
for (const decision of decisions.decisions) {
  for (const p of decision.affects.profiles)
    if (!profileIds.includes(p)) fail(`${decision.id}: unknown profile ${p}`);
  for (const c of decision.affects.capabilities)
    if (!coverage.caps.has(c)) fail(`${decision.id}: unknown ${c}`);
}

// ---------------------------------------------------------------------------
// Counts. These are tracking denominators, never support scores.

function tally(list, key) {
  const out = {};
  for (const item of list) {
    const values = [key(item)].flat();
    for (const value of values) out[value] = (out[value] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}
const counts = {
  entries: entries.length,
  byDisposition: tally(entries, (e) => e.disposition),
  bySubkind: tally(
    entries.filter((e) => e.subkind),
    (e) => `${e.disposition}/${e.subkind}`,
  ),
  byOwner: tally(entries, (e) => e.owner),
  byCapability: tally(entries, (e) => e.capability),
  byFamily: tally(entries, (e) => e.family),
  byRequirement: tally(entries, (e) => e.requirement),
  requiredByProfile: Object.fromEntries(
    profileIds.map((p) => [
      p,
      entries.filter((e) => e.requiredIn.includes(p)).length,
    ]),
  ),
  requiredGapsByProfile: Object.fromEntries(
    profileIds.map((p) => [
      p,
      entries.filter(
        (e) => e.requiredIn.includes(p) && e.requirement === 'required-gap',
      ).length,
    ]),
  ),
  targetDecisions: tally(
    entries.filter((e) => e.targetDecision),
    (e) => e.targetDecision.decision,
  ),
  alpha1: tally(entries, (e) => e.alpha1.kind),
  sources: {
    stylexTypeNames: entries.filter((e) => e.sources.stylexType).length,
    pandaTypeNames: entries.filter((e) => e.sources.pandaType).length,
    pandaBaseUtilityKeys: entries.filter((e) => e.sources.pandaUtility).length,
    bcdPropertyKeys: entries.filter((e) => e.sources.bcd).length,
    alpha1AdmittedPropertyNames: entries.filter(
      (e) =>
        !['unsupported', 'rejected-composite-form'].includes(e.alpha1.kind),
    ).length,
  },
  stylexEmission: tally(entries, (e) => e.upstream.stylex.emission),
  pandaEmission: tally(entries, (e) => e.upstream.panda.emission),
  canonicalWithUpstreamDivergence: entries.filter((e) => e.upstreamDivergence)
    .length,
};
for (const [field, expected] of Object.entries(inventory.counts)) {
  const actual =
    field === 'propertyEntries' ? counts.entries : counts.sources[field];
  if (actual !== expected)
    fail(`count ${field}: registry ${actual}, inventory ${expected}`);
}

if (errors.length) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exit(1);
}

const digests = Object.fromEntries(
  Object.entries(INPUTS)
    .filter(([, p]) => fs.existsSync(rel(p)))
    .map(([k, p]) => [k, { path: p, sha256: fileDigest(rel(p)) }]),
);
run(async () => {
  await writeJson(path.resolve(options.out), {
    schemaVersion: 1,
    kind: 'core-evolution-registry',
    registryVersion: '1.0.0',
    task: 'CE-00.1',
    status: 'scope-contract-not-qualification',
    generatedBy: 'tests/core-evolution/tools/build-registry.mjs',
    baselineCommit: inventory.baselineCommit,
    comparator: { stylex: '0.19.1', panda: '2.2.0', bcd: '8.1.6' },
    inputs: {
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
    },
    lotIssues,
    proofStatus:
      'All entry fixtures and capability proof records are planned; none was executed by CE-00.1.',
    policy: [
      'Every one of the 1,108 research-inventory entries has exactly one disposition, one owner lot, one capability family and a proof-fixture requirement. No entry leaves the denominator.',
      'Counts are tracking denominators. No support percentage is derived from type occurrence, registry or profile counts.',
      'A required entry is stable in-profile work until its proof record closes with the listed evidence classes. Upstream emission observations are comparator evidence (E1), not PandamStyle qualification.',
      'Runtime-unbounded needs and unsupported platforms stay visible as limitations.',
    ],
    dispositions: rules.dispositionDefinitions ?? undefined,
    procedure: rules.procedure,
    evidenceClasses: profiles.evidenceClasses,
    counts,
    reconciliation: {
      inventoryEntries: rows.length,
      registryEntries: entries.length,
      inventoryCounts: inventory.counts,
      derivedSourceCounts: counts.sources,
      sourceFlagMismatches: 0,
      bcdStatusMismatches: 0,
      alpha1Mismatches: 0,
      method:
        'Each inventory row is compared with keys re-derived from the pinned StyleX, Panda and BCD sources and with the Alpha 1 policy tables parsed from source. Any mismatch fails the build.',
    },
    capabilities,
    limitations: capSpec.limitations,
    requestCases,
    entries,
  });
  process.stdout.write(
    `registry entries=${entries.length} capabilities=${capabilities.length}\n`,
  );
});
