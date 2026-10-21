/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CE-01.1 default-profile impact and unknowns report.
//
//   node tools/targets/impact.mjs [--profiles <json>] [--out <file>]
//
// Evaluates every declaration of the CE-00.2 corpus and of both Wacando
// declaration sets, plus the CSS the compiler emits for the frozen CE-00.3
// workloads, under a target configuration (default: none, so the default
// profile). Every feature is treated as REQUIRED: the corpus and the Wacando
// sets carry no design-system enhancement policy. A declaration counts as an
// error when one of its features is `incompatible` or `unknown` on a profile,
// exactly as the compiler's target evaluation decides.
//
// The report lists every `unknown` with its reason and attribution, so a
// recognition gap of the catalog or extractor cannot hide behind a count.

import fs from 'node:fs';
import { collectFeatureUses, loadInspection } from './corpus-features.mjs';

export async function impact({ targets = null } = {}) {
  const { sources } = await collectFeatureUses();
  const t = loadInspection().targets;
  const { record: resolution, diagnostics } = t.resolveTargets(targets);
  // Without `targets` the compiler is advisory: the same failing units are
  // reported as warnings, never errors.
  const enforcement = t.enforcementOf(resolution);
  const outcomeCache = new Map();
  const outcomeOf = (record) => {
    if (!outcomeCache.has(record.feature)) {
      outcomeCache.set(record.feature, t.profileOutcomes(record, resolution));
    }
    return outcomeCache.get(record.feature);
  };
  const groups = {};
  const unknowns = new Map();
  const incompatibles = new Map();
  for (const source of sources) {
    const group = (groups[source.group] ??= {
      declarations: new Set(),
      failing: new Set(),
      unknownDeclarations: new Set(),
      warnings: new Set(),
      features: new Set(),
    });
    for (const use of source.uses) {
      const unit =
        use.attribution.declaration ??
        `${source.id}:${use.context.selector ?? ''}{${use.context.property ?? ''}}`;
      group.declarations.add(unit);
      // A fallback written in the value (font stacks) degrades with a
      // warning, exactly like an enhancement; it never errors.
      if (use.record.fallback != null) {
        if (outcomeOf(use.record).some((p) => p.state !== 'native')) {
          group.warnings.add(unit);
        }
        continue;
      }
      for (const profile of outcomeOf(use.record)) {
        const failing = profile.engines.filter(
          (o) => o.state === 'incompatible' || o.state === 'unknown',
        );
        if (failing.length === 0) continue;
        group.failing.add(unit);
        group.features.add(use.feature);
        for (const outcome of failing) {
          const bucket = outcome.state === 'unknown' ? unknowns : incompatibles;
          const key = `${use.feature}|${outcome.reason}`;
          if (!bucket.has(key)) {
            bucket.set(key, {
              feature: use.feature,
              reason: outcome.reason,
              engines: new Set(),
              groups: new Set(),
              examples: [],
            });
          }
          const entry = bucket.get(key);
          entry.engines.add(outcome.engine);
          entry.groups.add(source.group);
          if (
            entry.examples.length < 3 &&
            !entry.examples.some((e) => e.unit === unit)
          ) {
            entry.examples.push({
              unit,
              denominator: use.attribution.denominator ?? null,
              selector: use.context.selector ?? null,
              property: use.context.property ?? null,
              value: use.context.value ?? null,
            });
          }
          if (outcome.state === 'unknown') group.unknownDeclarations.add(unit);
        }
      }
    }
  }
  const listOf = (bucket) =>
    [...bucket.values()]
      .map((e) => ({
        ...e,
        engines: [...e.engines].sort(),
        groups: [...e.groups].sort(),
      }))
      .sort((a, b) =>
        a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0,
      );
  return {
    kind: 'pandamstyle-target-impact',
    schemaVersion: 1,
    enforcement,
    resolution: {
      digest: resolution.digest,
      profiles: resolution.profiles.map((p) => ({
        ref: p.ref,
        query: p.query,
        engines: p.engines.map((e) => `${e.engine} ${e.floor}`),
      })),
      warnings: diagnostics.map((d) => d.rule),
    },
    groups: Object.fromEntries(
      Object.entries(groups)
        .sort()
        .map(([name, g]) => [
          name,
          {
            units: g.declarations.size,
            failingUnits: g.failing.size,
            errorUnits: enforcement === 'enforced' ? g.failing.size : 0,
            unknownUnits: g.unknownDeclarations.size,
            warningUnits:
              g.warnings.size +
              (enforcement === 'advisory' ? g.failing.size : 0),
            enhancementWarningUnits: g.warnings.size,
            failingFeatures: [...g.features].sort(),
          },
        ]),
    ),
    unknowns: listOf(unknowns),
    incompatibles: listOf(incompatibles),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const pIndex = argv.indexOf('--profiles');
  const targets = pIndex === -1 ? null : JSON.parse(argv[pIndex + 1]);
  const result = await impact({ targets });
  const oIndex = argv.indexOf('--out');
  if (oIndex !== -1) {
    fs.writeFileSync(argv[oIndex + 1], JSON.stringify(result, null, 2) + '\n');
  }
  process.stdout.write(`enforcement: ${result.enforcement}\n`);
  for (const [name, g] of Object.entries(result.groups)) {
    process.stdout.write(
      `${name.padEnd(28)} units=${g.units} failing=${g.failingUnits} errors=${g.errorUnits} unknown=${g.unknownUnits} warnings=${g.warningUnits}\n`,
    );
  }
  process.stdout.write(`unknown features: ${result.unknowns.length}\n`);
  for (const u of result.unknowns) {
    process.stdout.write(
      `  ${u.feature} ${u.reason} [${u.engines.join(',')}] ${u.groups.join(',')}\n`,
    );
  }
  process.stdout.write(
    `incompatible features: ${result.incompatibles.length}\n`,
  );
  for (const u of result.incompatibles) {
    process.stdout.write(
      `  ${u.feature} ${u.reason} [${u.engines.join(',')}] ${u.groups.join(',')}\n`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
