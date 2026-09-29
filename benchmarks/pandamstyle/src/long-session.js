#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - the long-session memory trace (Spike 2).
 *
 * Answers one question with a measurement rather than an argument: does a
 * project session that has survived a thousand revisions still hold what it
 * held at revision ten?
 *
 * The mix is deliberately hostile. A trace of nothing but valid one-file edits
 * would grow nothing and prove nothing. Every ten revisions it also does:
 *
 *   - an invalid revision (a policy violation that must be refused);
 *   - the repair of that violation;
 *   - a module added and a module removed;
 *   - a file renamed;
 *   - a global fallback (a design-system change) and a revision after it;
 *   - a no-change revision, which is the one that would be free if the session
 *     leaked nothing and O(project) if it re-derived something per revision.
 *
 * Memory is sampled with a FORCED collection where the runtime allows it, and
 * the structural counts - file states, resolution keys, design-system
 * consumers - are recorded next to it, because they are the quantities a leak
 * would move and RSS is a noisy witness.
 *
 * Usage:
 *   node long-session.js --corpus <dir> --edits 1000 --out <file.json>
 *   node --expose-gc long-session.js ...   # enables the collected samples
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const COMPILER_PKG = path.join(
  REPO_ROOT,
  'packages',
  '@pandamstyle',
  'compiler',
);

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const eq = argv[i].indexOf('=');
    if (eq !== -1) out[argv[i].slice(2, eq)] = argv[i].slice(eq + 1);
    else {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function nowNs() {
  return Number(process.hrtime.bigint());
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}
function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function materialise(sourceDir, projectDir) {
  rmrf(projectDir);
  fs.mkdirSync(projectDir, { recursive: true });
  const walk = (dir, base = sourceDir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(base, abs);
      if (entry.isDirectory()) {
        if (rel.split(path.sep)[0] === 'node_modules') continue;
        walk(abs, base);
      } else if (entry.isFile()) {
        if (rel.split(path.sep)[0] === 'node_modules') continue;
        if (rel.startsWith('.pandamstyle')) continue;
        const to = path.join(projectDir, rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(abs, to);
      }
    }
  };
  walk(sourceDir);
  return projectDir;
}

function linkCompiler(projectDir) {
  const scope = path.join(projectDir, 'node_modules', '@pandamstyle');
  fs.mkdirSync(scope, { recursive: true });
  const link = path.join(scope, 'compiler');
  if (fs.existsSync(link)) fs.rmSync(link, { recursive: true });
  fs.symlinkSync(COMPILER_PKG, link, 'dir');
}

const CAN_COLLECT = typeof global.gc === 'function';

function sample(session, label, revision, compiler) {
  if (CAN_COLLECT) global.gc();
  const mem = process.memoryUsage();
  const stats = session.stats();
  // The Phase B state, when this session has one. A long session that grows its
  // rule records, its owner index or its owner SETS without bound is the failure
  // this trace exists to catch, and none of it is visible in RSS.
  const css = session.cssState?.() ?? null;
  // The module graph's process-wide caches. Not session state, so they are the
  // first place to look when a long session's heap grows and none of the
  // session's own structures do.
  const cacheStats = compiler?.moduleGraphCacheStats?.() ?? null;
  return {
    label,
    revision,
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    heapTotalBytes: mem.heapTotal,
    externalBytes: mem.external,
    collected: CAN_COLLECT,
    ...stats,
    ...(cacheStats == null
      ? {}
      : {
          parseCacheEntries: cacheStats.parseCache.entries,
          parseCacheBytes: cacheStats.parseCache.approxBytes,
          resolutionCacheEntries: cacheStats.resolutionCache.entries,
          resolutionCacheBytes: cacheStats.resolutionCache.approxBytes,
          designSystemCacheEntries: cacheStats.designSystemCache.entries,
          designSystemCacheBytes: cacheStats.designSystemCache.approxBytes,
        }),
    ...(css == null
      ? {}
      : {
          cssRuleRecords: css.stats.ruleRecords,
          cssOwners: css.stats.ownerCount,
          cssOwnerMemberships: Object.values(css.ownership).reduce(
            (n, v) => n + v.length,
            0,
          ),
          cssOrdered: css.orderedClassNames.length,
        }),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const corpusDir = path.resolve(args.corpus ?? '/tmp/pms-long-session-corpus');
  const edits = Number(args.edits ?? 1000);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-long-session-'));
  const projectDir = materialise(corpusDir, path.join(workDir, 'project'));
  linkCompiler(projectDir);

  const { pathToFileURL } = require('url');
  const configPath = path.join(projectDir, 'pandamstyle.config.js');
  const config = require(configPath);
  const definitionPath = path.resolve(projectDir, config.definition);
  let nonce = 0;
  const loadDefinition = async () => {
    nonce += 1;
    const href = pathToFileURL(definitionPath).href;
    const mod = await import(`${href}?pmsLongSession=${nonce}`);
    return mod != null && mod.default != null ? mod.default : mod;
  };

  const compiler = require(path.join(COMPILER_PKG, 'lib', 'index.js'));
  const options = (definition) => ({
    definition,
    roots: (config.roots ?? []).map((r) => path.resolve(projectDir, r)),
    outDir: path.resolve(projectDir, config.outDir),
    runtimeModule: config.runtimeModule,
    designSystemFile: config.designSystemFile,
    engineOptions: config.engineOptions,
    useCSSLayers: config.useCSSLayers === true,
    // Which publication strategy this long session drives, and therefore
    // whether it has a CSS state whose retention is part of the question.
    publishVariant: args.variant ?? 'session_incremental_publish',
  });

  let definition = await loadDefinition();
  const session = compiler.createProjectSession(options(definition));

  const componentDir = path.join(projectDir, 'src', 'components');
  const componentNames = fs
    .readdirSync(componentDir)
    .filter((n) => n.endsWith('.tsx'))
    .sort();
  // The edited component is LOCATED, not assumed. A trace that silently edits
  // nothing is a trace that measures nothing, and "the corpus generator
  // changed and now Component0 has no padding" is exactly the kind of failure
  // that would look like a very fast session.
  const paddingRe = /(padding|marginTop): token\('[^']+'\),/;
  const targetName = componentNames.find((n) =>
    paddingRe.test(read(path.join(componentDir, n))),
  );
  if (targetName == null) {
    throw new Error(
      'no component in the corpus declares a padding or marginTop token, so ' +
        'the long-session trace has nothing to edit and would measure a no-op',
    );
  }
  const target = path.join(componentDir, targetName);
  const targetOriginal = read(target);
  const scratch = path.join(componentDir, 'LongSessionScratch.tsx');
  const scratchSource =
    "import { create, token, props } from '../../.pandamstyle/design.pandamstyle.js';\n" +
    "const s = create({ r: { padding: token('spacing.md') } });\n" +
    'export const Scratch = () => <div {...props(s.r)} />;\n';
  const samples = [];
  const memoryTrace = [];
  const phases = [];
  const counters = {
    revisions: 0,
    published: 0,
    refused: 0,
    fullFallbacks: 0,
    adds: 0,
    removes: 0,
    renames: 0,
    noChange: 0,
    localEdits: 0,
  };

  session.initialize();
  session.validate();
  session.compile();
  counters.published += 1;
  samples.push(sample(session, 'cold', 1, compiler));
  // Sampled periodically, not only at the end: "the state is flat at revision
  // 1000" and "the state is flat throughout" are different claims, and only the
  // second one says a session does not grow without bound.
  const SAMPLE_EVERY = Number(args['sample-every'] ?? 100);

  for (let i = 0; i < edits; i++) {
    if (i > 0 && i % SAMPLE_EVERY === 0) {
      samples.push(sample(session, `revision-${i}`, i + 1, compiler));
    }
    const kind = i % 10;
    let label;
    let sessionChanges = {};
    switch (kind) {
      case 0:
      case 1:
      case 2: {
        // a real local edit, reverted on the next pass so the file ends valid
        const m = paddingRe.exec(read(target));
        if (m != null) {
          write(
            target,
            read(target).replace(m[0], `${m[0]}\n    opacity: 0.5,`),
          );
        }
        label = 'local-edit';
        counters.localEdits += 1;
        break;
      }
      case 3:
        // a policy violation: this revision MUST be refused and MUST NOT
        // publish, and the session must still be usable afterwards
        {
          const m = paddingRe.exec(read(target));
          if (m != null) {
            write(target, read(target).replace(m[0], `${m[1]}: '17px',`));
          }
        }
        label = 'invalid-edit';
        break;
      case 4:
        write(target, targetOriginal);
        label = 'repair';
        break;
      case 5:
        rmrf(scratch);
        sessionChanges = { removedFiles: [scratch] };
        label = 'module-remove';
        counters.removes += 1;
        break;
      case 6:
        write(scratch, scratchSource);
        sessionChanges = { addedFiles: [scratch] };
        label = 'module-add';
        counters.adds += 1;
        break;
      case 7: {
        // a rename: the old name must leave the covered set and the new one
        // must enter it, in one revision
        const from = scratch;
        const to = path.join(componentDir, 'LongSessionRenamed.tsx');
        if (fs.existsSync(from)) {
          fs.renameSync(from, to);
          sessionChanges = { addedFiles: [to], removedFiles: [from] };
          counters.renames += 1;
          label = 'file-rename';
        } else {
          label = 'no-change';
          counters.noChange += 1;
        }
        break;
      }
      case 8: {
        // a global fallback: the design system changed
        const before = read(definitionPath);
        const after = before.replace(/(value: ")(\d+)(px")/, (all, a, n, b) =>
          Number(n) % 2 === 0
            ? `${a}${Number(n) + 1}${b}`
            : `${a}${Number(n) + 2}${b}`,
        );
        if (after !== before) {
          write(definitionPath, after);
          definition = await loadDefinition();
          sessionChanges = { definition };
          counters.fullFallbacks += 1;
          label = 'design-change-fallback';
        } else {
          label = 'no-change';
          counters.noChange += 1;
        }
        break;
      }
      default:
        label = 'no-change';
        counters.noChange += 1;
        break;
    }

    const t0 = nowNs();
    session.applyChanges(sessionChanges);
    const validation = session.validate();
    let published = false;
    if (validation.ok) {
      session.compile();
      published = true;
      counters.published += 1;
    } else {
      counters.refused += 1;
    }
    counters.revisions += 1;
    // A LIGHT trace, without a forced collection, so the RSS TREND is visible:
    // a session that leaks grows on every sample, and a session that merely
    // made V8 grow its heap plateaus. Only the three heavyweight samples force
    // a collection, because a forced collection everywhere would flatten the
    // very trend the trace exists to show.
    if (i % 10 === 0 || i === edits - 1) {
      const m = process.memoryUsage();
      memoryTrace.push({
        revision: i + 2,
        kind: label,
        rssBytes: m.rss,
        heapUsedBytes: m.heapUsed,
        fileStateCount: session.stats().fileStateCount,
        resolutionKeyCount: session.stats().resolutionKeyCount,
      });
    }
    // Sampled on two different phases so BOTH the dominant case (a local
    // edit) and the control (no change at all) appear in the phase table; one
    // phase would have characterised the session by whichever kind it caught.
    if (i % 10 === 9 || i % 100 === 0 || i === edits - 1) {
      phases.push({
        revision: i + 2,
        kind: label,
        ok: validation.ok,
        published,
        ms: (nowNs() - t0) / 1e6,
        filesChanged: validation.counters.filesChanged,
        filesReparsed: validation.counters.filesReparsed,
        filesRecompiled: validation.counters.filesRecompiled,
        filesReused: validation.counters.filesReused,
        fullFallbackReason: validation.counters.fullFallbackReason,
      });
    }
  }
  samples.push(sample(session, 'warm-after-1000', edits + 1, compiler));
  // A no-change revision at the end, sampled on its own: the number that says
  // what a session costs when nothing happened, after a thousand revisions.
  const t0 = nowNs();
  session.applyChanges();
  const finalValidation = session.validate();
  session.compile();
  const finalMs = (nowNs() - t0) / 1e6;
  samples.push(sample(session, 'final-no-change', edits + 2, compiler));

  const cold = samples[0];
  const warm = samples[samples.length - 1];
  const report = {
    documentKind: 'pandamstyle-long-session-memory-trace',
    batch: 'spike-3',
    publishVariant: args.variant ?? 'session_incremental_publish',
    corpus: path.basename(corpusDir),
    corpusManifestHash: (() => {
      try {
        return JSON.parse(read(path.join(corpusDir, 'corpus-manifest.json')))
          .contentHash;
      } catch {
        return null;
      }
    })(),
    edits,
    gcExposed: CAN_COLLECT,
    mix: counters,
    finalNoChangeRevisionMs: finalMs,
    finalNoChangeOk: finalValidation.ok,
    memory: {
      coldRssBytes: cold.rssBytes,
      warmRssBytes: warm.rssBytes,
      rssGrowthBytes: warm.rssBytes - cold.rssBytes,
      coldHeapUsedBytes: cold.heapUsedBytes,
      warmHeapUsedBytes: warm.heapUsedBytes,
      heapGrowthBytes: warm.heapUsedBytes - cold.heapUsedBytes,
      peakRssBytes: Math.max(...samples.map((s) => s.rssBytes)),
    },
    // The retention question, stated as a first/last comparison rather than a
    // growth rate: a session that churns for a thousand revisions must end with
    // about the state it started with, and the trend is what says whether it
    // does.
    retention: (() => {
      const first = samples[0];
      const last = samples[samples.length - 1];
      const mid = samples[Math.floor(samples.length / 2)];
      const hasCss = first.cssRuleRecords != null;
      return {
        samples: samples.length,
        rss: {
          firstBytes: first.rssBytes,
          midBytes: mid?.rssBytes ?? null,
          lastBytes: last.rssBytes,
          growthBytes: last.rssBytes - first.rssBytes,
        },
        heapUsed: {
          firstBytes: first.heapUsedBytes,
          midBytes: mid?.heapUsedBytes ?? null,
          lastBytes: last.heapUsedBytes,
          growthBytes: last.heapUsedBytes - first.heapUsedBytes,
        },
        fileStates: {
          first: first.fileStates ?? null,
          last: last.fileStates ?? null,
        },
        ...(hasCss
          ? {
              cssRuleRecords: {
                first: first.cssRuleRecords,
                mid: mid?.cssRuleRecords ?? null,
                last: last.cssRuleRecords,
              },
              cssOwners: {
                first: first.cssOwners,
                mid: mid?.cssOwners ?? null,
                last: last.cssOwners,
              },
              // The total number of (owner, rule) memberships. This is the one
              // that can leak: dropping a file has to decrement the owners of
              // every rule it held, and a missed decrement is invisible in the
              // rule count.
              cssOwnerMemberships: {
                first: first.cssOwnerMemberships,
                mid: mid?.cssOwnerMemberships ?? null,
                last: last.cssOwnerMemberships,
              },
            }
          : {}),
      };
    })(),
    structural: {
      coldFileStateCount: cold.fileStateCount,
      warmFileStateCount: warm.fileStateCount,
      coldResolutionKeyCount: cold.resolutionKeyCount,
      warmResolutionKeyCount: warm.resolutionKeyCount,
      coldDsConsumerModuleCount: cold.dsConsumerModuleCount,
      warmDsConsumerModuleCount: warm.dsConsumerModuleCount,
      supersededRevisions: warm.supersededRevisions,
    },
    samples,
    memory_trace: memoryTrace,
    phases,
  };
  report.stable =
    warm.fileStateCount <= cold.fileStateCount + 2 &&
    warm.resolutionKeyCount <= cold.resolutionKeyCount + 8 &&
    warm.dsConsumerModuleCount <= cold.dsConsumerModuleCount + 4;
  report.digest = crypto
    .createHash('sha256')
    .update(JSON.stringify(report))
    .digest('hex');

  const out = args.out
    ? path.resolve(args.out)
    : path.join(workDir, 'long-session.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(
    `${JSON.stringify(
      {
        out,
        edits,
        stable: report.stable,
        coldRssBytes: report.memory.coldRssBytes,
        warmRssBytes: report.memory.warmRssBytes,
        rssGrowthBytes: report.memory.rssGrowthBytes,
        warmFileStateCount: report.structural.warmFileStateCount,
        finalNoChangeRevisionMs: finalMs,
      },
      null,
      2,
    )}\n`,
  );
  session.close();
  rmrf(workDir);
  process.exit(report.stable ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${String(err?.stack ?? err)}\n`);
    process.exit(2);
  });
}
