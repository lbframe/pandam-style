/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - the Phase D oracle.
 *
 * WHAT IT IS
 *
 * The correctness gate for the incremental coverage graph and the incremental
 * design-system views, driven from a real generated corpus rather than from a
 * fixture, and reported as a document that goes into the evidence directory.
 *
 * It is a SEPARATE TOOL from the unit tests on purpose. The tests assert that a
 * named property holds; this asserts the whole contract - after a trace that
 * mixes every mutation this phase is about, the incremental closure equals a
 * FRESH closure and the incremental views equal FRESH views - on a corpus big
 * enough that a graph which quietly retained a stale node would show up as a
 * count rather than as a coincidence.
 *
 * FOR EVERY REVISION OF EVERY TRACE
 *
 *   verifyCoverageGraph()          covered set, origins, CANONICAL ORDER,
 *                                  unresolved edges, external requests and
 *                                  relay edges, recomputed from the module
 *                                  summaries with no reuse of the
 *                                  incremental structure
 *   verifyDesignSystemViews()      digest, relay chain and therefore the
 *                                  recognized design-system module and the
 *                                  compiler's binding recognition, recomputed
 *                                  from scratch with no memo and no relay cache
 *
 * AND, RECORDED BUT NOT ASSERTED
 *
 *   the revision's own verdict and diagnostics. Whether a revision SHOULD be
 *   accepted is a property of the fixture, not of incrementality: a revision
 *   that becomes acceptable is a fixture bug. It is asserted where it belongs -
 *   `agent-loop.js` fails a cell whose verdict is not the one its scenario
 *   declared - and here it is a fact recorded next to the equality verdict, so
 *   a reader can see the two together.
 *
 * THE TRACES
 *
 *   style_only_edit           five consecutive revisions, none of which
 *                             changes an import or a re-export
 *   five_style_only_edits     one revision naming five files
 *   import_added              a local import that resolves
 *   import_removed            a local import that stops resolving
 *   re_export_added           a re-export appears on a relay
 *   re_export_removed         a re-export disappears from a relay
 *   module_added              a new page under the root
 *   module_removed            a page deleted
 *   module_renamed            a page moved
 *   unresolved_becomes_known   a negative resolution repaired by a new file
 *   known_becomes_unresolved  a resolved import whose target is deleted
 *   diamond_parent_removed    a module with two covered parents loses one
 *   alternate_path_added      the second path appears afterwards
 *   root_file_removed         a declared root stops containing a file
 *   global_config_fallback    an engine option changes
 *   design_system_fallback    the design system itself changes
 *
 * A trace's last revision may legitimately be REFUSED - that is what an
 * unresolved local import is - and a refusal is a verdict, not a failure. What
 * is never acceptable is a divergence between the incremental answer and the
 * fresh one, and this tool exits non-zero when there is one.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const COMPILER_PKG = path.resolve(
  __dirname,
  '../../../packages/@pandamstyle/compiler',
);

/** Plain modules. The graph does not care what a covered file contains. */
const PLAIN = (body) => `${body}\n`;

function corpusProject(corpusDir) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-phase-d-oracle-'));
  const walk = (from, base = corpusDir) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const abs = path.join(from, entry.name);
      const rel = path.relative(base, abs);
      if (rel.split(path.sep)[0] === 'node_modules') continue;
      if (rel.startsWith('.pandamstyle')) continue;
      if (entry.isDirectory()) walk(abs, base);
      else if (entry.isFile()) {
        const to = path.join(dir, rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(abs, to);
      }
    }
  };
  walk(corpusDir);
  const scope = path.join(dir, 'node_modules', '@pandamstyle');
  fs.mkdirSync(scope, { recursive: true });
  const link = path.join(scope, 'compiler');
  if (!fs.existsSync(link)) fs.symlinkSync(COMPILER_PKG, link, 'dir');
  return dir;
}

/**
 * A trace: an ordered list of revisions, each of which PREPARES ITS OWN WRITES
 * and then declares them.
 *
 * The preparation is per revision and not up front, deliberately. A trace that
 * wrote every file before its first revision would be measured against a
 * project that already contained the result of the trace - and under
 * `verified-explicit` a file nobody declared is invisible, so the trace would
 * report a sequence of no-ops and the oracle would pass over revisions that
 * never happened. That is the exact shape of a green test that proves nothing,
 * and it is why `prepare` runs where it does.
 */
function planFor(name, projectDir) {
  const abs = (rel) => path.join(projectDir, rel);
  const write = (rel, content) => {
    const to = abs(rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, content, 'utf8');
    return rel;
  };
  const append = (rel, text) =>
    write(rel, `${fs.readFileSync(abs(rel), 'utf8')}${text}`);
  const read = (rel) => fs.readFileSync(abs(rel), 'utf8');
  const remove = (rel) => {
    fs.rmSync(abs(rel));
    return rel;
  };
  const barrel = 'bridge/index.ts';
  const comps = fs
    .readdirSync(path.join(projectDir, 'src', 'components'))
    .filter((f) => /\.[cm]?[jt]sx?$/.test(f))
    .sort()
    .slice(0, 40)
    .map((f) => `src/components/${f}`);

  const changed = (rel) => ({ changed: [rel] });
  const added = (...rel) => ({ added: [...rel] });
  const removed = (...rel) => ({ removed: [...rel] });

  switch (name) {
    case 'style_only_edit': {
      // Five consecutive revisions, none of which touches an import or a
      // re-export. The trace that has to cost nothing.
      return [0, 1, 2, 3, 4].map((i) => ({
        name: `edit-${i}`,
        run: () => changed(append(comps[i], `\n// phase-d revision ${i}\n`)),
      }));
    }
    case 'five_style_only_edits':
      return [
        {
          name: 'five files in one revision',
          run: () =>
            changed(
              ...comps.slice(5, 10).map((rel) => append(rel, '\n// five\n')),
            ),
        },
      ];
    case 'style_only_edit_new_atom':
      return [
        {
          name: 'a declared property the generation did not have',
          run: () =>
            changed(
              write(
                comps[6],
                read(comps[6]).replace(
                  /(padding:\s*token\('[^']+'\),)/,
                  "borderColor: token('colors.primitive.alt'),\n    $1",
                ),
              ),
            ),
        },
      ];
    case 'import_added':
      return [
        {
          name: 'helper exists, nothing imports it',
          run: () => added('bridge/helper.ts'),
        },
        {
          name: 'a page imports it',
          run: () =>
            changed(
              append(
                comps[10],
                "\nimport { helped } from '../../bridge/helper';\nexport const h = helped;\n",
              ),
            ),
        },
      ];
    case 'import_removed':
      return [
        {
          name: 'a page imports a module that does not exist',
          run: () =>
            changed(
              append(
                comps[11],
                "\nimport { helped } from '../../bridge/never';\nexport const h = helped;\n",
              ),
            ),
        },
        {
          name: 'and then does not',
          run: () =>
            changed(
              write(
                comps[11],
                read(comps[11])
                  .replace(/^import \{ helped \}.*\n/m, '')
                  .replace(/^export const h = helped;\n/m, ''),
              ),
            ),
        },
      ];
    case 're_export_added':
      return [
        {
          name: 'the relay re-exports one more name',
          run: () =>
            changed(
              write(
                barrel,
                read(barrel).replace('  props,\n', '  props,\n  manifest,\n'),
              ),
            ),
        },
      ];
    case 're_export_removed':
      return [
        {
          name: 'add',
          run: () =>
            changed(
              write(
                barrel,
                read(barrel).replace('  props,\n', '  props,\n  manifest,\n'),
              ),
            ),
        },
        {
          name: 'remove',
          run: () =>
            changed(
              write(
                barrel,
                read(barrel).replace('  props,\n  manifest,\n', '  props,\n'),
              ),
            ),
        },
      ];
    case 'export_star_relay':
      return [
        {
          name: 'a star relay appears',
          run: () =>
            added(
              write(
                'bridge/star.ts',
                "export * from '../../.pandamstyle/design.pandamstyle';\n",
              ),
            ),
        },
        {
          name: 'and a page reaches the design system through it',
          run: () =>
            added(
              write(
                'src/components/OracleStar.tsx',
                PLAIN(
                  "import { create, token, props, themes } from '../../bridge/star';\n" +
                    "export const s = create({ a: { padding: token('spacing.md') } });\n" +
                    'export const p = props(themes.light, s.a);\n',
                ),
              ),
            ),
        },
      ];
    case 'relay_restored':
      return [
        {
          name: 'the relay stops reaching the design system',
          run: () => changed(write(barrel, PLAIN('export const nothing = 1;'))),
        },
        {
          name: 'and comes back',
          run: () =>
            changed(
              write(
                barrel,
                "export { create, token, recipes, themes, props } from '../.pandamstyle/design.pandamstyle';\n",
              ),
            ),
        },
      ];
    case 'module_added':
      return [
        {
          name: 'a new page',
          run: () =>
            added(
              write(
                'src/components/OracleAdded.tsx',
                read(comps[14]).replace(/Component\d+/g, 'OracleAdded'),
              ),
            ),
        },
      ];
    case 'module_removed':
      return [
        { name: 'a page is deleted', run: () => removed(remove(comps[15])) },
      ];
    case 'module_renamed':
      return [
        {
          name: 'a page moves',
          run: () => {
            fs.renameSync(
              abs(comps[16]),
              abs('src/components/OracleRenamed.tsx'),
            );
            return {
              renamed: [
                { from: comps[16], to: 'src/components/OracleRenamed.tsx' },
              ],
            };
          },
        },
      ];
    case 'unresolved_becomes_known':
      return [
        {
          name: 'an import that does not resolve',
          run: () =>
            changed(
              append(
                comps[17],
                "\nimport { later } from '../../bridge/later';\nexport const l = later;\n",
              ),
            ),
        },
        {
          name: 'the module appears',
          run: () =>
            added(write('bridge/later.ts', PLAIN('export const later = 1;'))),
        },
      ];
    case 'known_becomes_unresolved':
      return [
        {
          name: 'a module and its importer',
          run: () =>
            added(
              write('bridge/gone.ts', PLAIN('export const gone = 1;')),
              append(
                comps[18],
                "\nimport { gone } from '../../bridge/gone';\nexport const g = gone;\n",
              ),
            ),
        },
        {
          name: 'the module is deleted',
          run: () => removed(remove('bridge/gone.ts')),
        },
      ];
    case 'diamond_parent_removed':
      return [
        {
          name: 'a module outside every root exists',
          run: () =>
            added(
              write('bridge/diamond-base.ts', PLAIN('export const d = 1;')),
            ),
        },
        {
          name: 'two pages point at it',
          run: () =>
            added(
              write(
                'src/components/OracleDiamondA.tsx',
                PLAIN(
                  "import { d } from '../../bridge/diamond-base';\nexport const a = d;\n",
                ),
              ),
              write(
                'src/components/OracleDiamondB.tsx',
                PLAIN(
                  "import { d } from '../../bridge/diamond-base';\nexport const b = d;\n",
                ),
              ),
            ),
        },
        {
          name: 'one of them is deleted',
          run: () => removed(remove('src/components/OracleDiamondA.tsx')),
        },
      ];
    case 'alternate_path_added':
      return [
        {
          name: 'the shared module exists',
          run: () =>
            added(write('bridge/alt-base.ts', PLAIN('export const x = 1;'))),
        },
        {
          name: 'one path reaches it',
          run: () =>
            added(
              write(
                'src/components/OracleAltA.tsx',
                PLAIN(
                  "import { x } from '../../bridge/alt-base';\nexport const a = x;\n",
                ),
              ),
            ),
        },
        {
          name: 'that path goes',
          run: () => removed(remove('src/components/OracleAltA.tsx')),
        },
        {
          name: 'and a different one takes its place',
          run: () =>
            added(
              write(
                'src/components/OracleAltB.tsx',
                PLAIN(
                  "import { x } from '../../bridge/alt-base';\nexport const b = x;\n",
                ),
              ),
            ),
        },
      ];
    case 'root_file_removed':
      return [
        {
          name: 'a declared root loses a file',
          run: () => removed(remove(comps[19])),
        },
      ];
    case 'global_config_fallback':
      return [
        {
          name: 'an engine option changes',
          run: () => changed(append(comps[20], '\n// cfg\n')),
          config: { engineOptions: { maxRelayDepth: 8 } },
        },
      ];
    case 'design_system_fallback':
      return [
        {
          name: 'the design system itself changes',
          run: () => changed(append(comps[21], '\n// ds\n')),
          definition: true,
        },
      ];
    default:
      throw new Error(`phase-d-oracle: unknown trace ${name}`);
  }
}

const TRACES = [
  'style_only_edit',
  'five_style_only_edits',
  'style_only_edit_new_atom',
  'import_added',
  'import_removed',
  're_export_added',
  're_export_removed',
  'export_star_relay',
  'relay_restored',
  'module_added',
  'module_removed',
  'module_renamed',
  'unresolved_becomes_known',
  'known_becomes_unresolved',
  'diamond_parent_removed',
  'alternate_path_added',
  'root_file_removed',
  'global_config_fallback',
  'design_system_fallback',
];

function loadDefinition(projectDir, nonce) {
  const config = require(path.join(projectDir, 'pandamstyle.config.js'));
  const definitionPath = path.resolve(
    path.dirname(path.join(projectDir, 'pandamstyle.config.js')),
    config.definition,
  );
  if (nonce === undefined) return require(definitionPath);
  // The definition is an ES module in the generated corpus and Node's registry
  // has no public invalidation, so a definition revision needs a new module
  // IDENTITY. The nonce changes the identity and nothing else.
  const href = require('url').pathToFileURL(definitionPath).href;
  return import(`${href}?pmsPhaseD=${nonce}`).then(
    (mod) => mod?.default ?? mod,
  );
}

async function runTrace(compiler, corpusDir, trace) {
  const projectDir = corpusProject(corpusDir);
  const config = require(path.join(projectDir, 'pandamstyle.config.js'));
  const resolveIn = (p) => (path.isAbsolute(p) ? p : path.join(projectDir, p));
  let definition = loadDefinition(projectDir);
  if (definition?.then) definition = await definition;
  let nonce = 0;

  const args = () => ({
    definition,
    roots: (config.roots ?? []).map(resolveIn),
    outDir: resolveIn(config.outDir),
    runtimeModule: config.runtimeModule,
    designSystemFile: config.designSystemFile,
    engineOptions: config.engineOptions,
    useCSSLayers: config.useCSSLayers === true,
    publishVariant: 'session_incremental_publish',
    auditPolicy: 'reference',
  });

  const session = compiler.createProjectSession(args());
  const revisions = planFor(trace, projectDir);
  const observations = [];

  // Every declared path is made ABSOLUTE. The traces speak in corpus-relative
  // paths because that is what a manifest uses; the session resolves a declared
  // path against `process.cwd()`, and a relative one would send it looking for
  // `<repository>/src/components/...`. The transaction would still be a
  // well-formed declaration - of a file that does not exist - and every trace
  // would report a revision that touched nothing, as a fast correct answer.
  const abs = (rel) => path.resolve(projectDir, rel);
  const apply = (mutation) => {
    const out = {
      changed: [],
      added: [],
      removed: [],
      renamed: [],
      ...mutation,
    };
    out.changed = out.changed.map(abs);
    out.added = out.added.map(abs);
    out.removed = out.removed.map(abs);
    out.renamed = out.renamed.map((r) => ({
      from: abs(r.from),
      to: abs(r.to),
    }));
    return out;
  };

  session.applyAgentChanges(apply({}));
  session.validate();

  for (const rev of revisions) {
    const mutation = apply(rev.run());
    if (rev.config != null) {
      session.applyChanges({ config: rev.config, mutation });
    } else if (rev.definition === true) {
      const definitionPath = path.resolve(
        path.dirname(path.join(projectDir, 'pandamstyle.config.js')),
        config.definition,
      );
      const before = fs.readFileSync(definitionPath, 'utf8');
      // The FIRST hex literal in the definition, changed. Which one it is does
      // not matter - a design system is a design system - and deriving it from
      // the bytes rather than hard-coding a token is what keeps this working
      // when the generator's palette changes.
      const after = before.replace(/#[0-9a-fA-F]{6}/, (m) =>
        m === '#000000' ? '#010203' : '#000000',
      );
      if (after === before) {
        throw new Error(
          `phase-d-oracle: ${trace}/${rev.name}: the definition has no token ` +
            'value to change, so the revision would measure a no-op',
        );
      }
      fs.writeFileSync(definitionPath, after, 'utf8');
      nonce += 1;
      const reloaded = await loadDefinition(projectDir, nonce);
      session.applyChanges({
        definition: reloaded?.default ?? reloaded,
        mutation,
      });
      definition = reloaded?.default ?? reloaded;
    } else {
      session.applyAgentChanges(mutation);
    }
    const validation = session.validate();

    const closure = session.verifyCoverageGraph();
    const views = session.verifyDesignSystemViews();
    const counters = session.stats().counters;
    observations.push({
      revision: rev.name,
      ok: validation.ok,
      diagnostics: validation.diagnostics.map((d) => d.code),
      closureOracle: {
        ok: closure.ok,
        differences: closure.differences.slice(0, 6),
      },
      dsvOracle: { ok: views.ok, differences: views.differences.slice(0, 6) },
      graph: session.coverageGraph(),
      closure: {
        nodesExamined: counters.closure_nodes_examined ?? 0,
        nodesEntering: counters.closure_nodes_entering_coverage ?? 0,
        nodesLeaving: counters.closure_nodes_leaving_coverage ?? 0,
        fullWalk: counters.closure_full_walk ?? 0,
        fullFallback: counters.closure_full_fallback ?? 0,
        setDivergence: counters.closure_set_divergence ?? 0,
        propagationAborted: counters.closure_propagation_aborted ?? 0,
      },
      dsv: {
        examined: counters.dsv_files_examined ?? 0,
        recomputed: counters.dsv_files_recomputed ?? 0,
        reused: counters.dsv_files_reused ?? 0,
        consumersInvalidated: counters.dsv_consumers_invalidated ?? 0,
        fullFallback: counters.dsv_full_fallback ?? 0,
        relayWalks: counters.dsv_relay_walks ?? 0,
        relayHits: counters.dsv_relay_hits ?? 0,
        relayAnswers: session.stats().dsViewRelayAnswerCount,
      },
    });
    if (validation.ok) session.compile();
  }

  session.close();
  fs.rmSync(projectDir, { recursive: true, force: true });
  return observations;
}

async function main() {
  const argv = process.argv.slice(2);
  let corpus = null;
  let out = null;
  let traces = TRACES;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--corpus') corpus = argv[++i];
    else if (argv[i] === '--out') out = argv[++i];
    else if (argv[i] === '--traces') traces = argv[++i].split(',');
  }
  if (corpus == null || out == null) {
    process.stderr.write('phase-d-oracle: --corpus and --out are required\n');
    process.exit(2);
  }
  const compiler = require(path.join(COMPILER_PKG, 'lib', 'index.js'));
  const results = {};
  let failures = 0;
  for (const trace of traces) {
    const observations = await runTrace(compiler, corpus, trace);
    const bad = observations.filter(
      (o) => !o.closureOracle.ok || !o.dsvOracle.ok,
    );
    if (bad.length > 0) failures += 1;
    results[trace] = { ok: bad.length === 0, observations };
    process.stderr.write(
      `phase-d-oracle ${trace}: ${observations.length} revisions, ` +
        `${bad.length === 0 ? 'ok' : 'FAILED'}\n`,
    );
  }
  const document = {
    documentKind: 'pandamstyle-phase-d-oracle',
    schemaVersion: 1,
    corpus: path.basename(corpus),
    traces: traces.length,
    failedTraces: failures,
    verdict: failures === 0 ? 'equivalent' : 'divergent',
    results,
  };
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(path.resolve(out), JSON.stringify(document, null, 2) + '\n');
  process.stderr.write(
    `phase-d-oracle: ${traces.length - failures}/${traces.length} traces ` +
      `clean -> ${out}\n`,
  );
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`phase-d-oracle failed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
