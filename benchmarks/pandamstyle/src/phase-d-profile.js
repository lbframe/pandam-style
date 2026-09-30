/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - the Phase D measurement driver.
 *
 * WHY THIS EXISTS SEPARATELY FROM `agent-loop.js`
 *
 * Phase D's first rule is that the c10000 phase attribution must be captured
 * BEFORE the algorithm changes, and the last rule is that a c10000 campaign has
 * to leave no per-revision structural growth behind. Both are disk questions
 * as much as they are attribution questions: one c10000 cell materialises an
 * 84 MB project, so a campaign that keeps every cell's copy alive needs two
 * gigabytes of scratch before it has measured anything.
 *
 * `agent-loop.js` keeps every cell's project under `<out-dir>/scratch`, which is
 * the right default for c1000 and the wrong one here. So this driver spawns the
 * SAME cell process `agent-loop.js` spawns - one process per cell, no shared
 * session state, no shared module cache - and deletes the project directory
 * after the cell's rows have been read.
 *
 * It changes nothing about what a cell does. It is a loop and a cleanup, and
 * the loop deliberately contains no timing of its own: every reported interval
 * is the session's own stamp, taken inside the process being measured.
 *
 * The environment is recorded next to the rows, because a number without the
 * machine and the free disk it was taken on is not evidence, and because a
 * campaign that ran out of disk would otherwise look like a campaign that ran.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const AGENT_LOOP = path.join(__dirname, 'agent-loop.js');

const DEFAULT_SCENARIOS = [
  'one_file_existing_atoms',
  'one_file_new_atom',
  'five_files_batch',
  'import_change',
  'module_add',
  'module_remove',
  'file_rename',
  'reexport_change',
];

function parseArgs(argv) {
  const out = {
    iterations: 3,
    variants: ['compact_agent_result'],
    scenarios: DEFAULT_SCENARIOS,
    label: 'phase-d',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--corpus') out.corpus = argv[++i];
    else if (a === '--corpus-name') out.corpusName = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--iterations') out.iterations = Number(argv[++i]);
    else if (a === '--scenarios') out.scenarios = argv[++i].split(',');
    else if (a === '--variants') out.variants = argv[++i].split(',');
    else if (a === '--label') out.label = argv[++i];
    else if (a === '--scratch') out.scratch = argv[++i];
  }
  return out;
}

/**
 * Everything a reader needs to decide whether two numbers are comparable.
 *
 * `diskAvailBytesBefore` is the one field that is not about the program. A
 * campaign whose cells start failing because the filesystem filled is a
 * campaign about the filesystem, and the only honest way to tell is to have
 * written the free space down before the run.
 */
function environment(corpusName, label) {
  const stat = fs.statfsSync(path.resolve(__dirname, '../../..'));
  return {
    label,
    corpus: corpusName,
    node: process.version,
    platform: `${os.platform()}-${os.arch()}`,
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    diskAvailBytesBefore: stat.bavail * stat.bsize,
    diskTotalBytes: stat.blocks * stat.bsize,
  };
}

function runCell(cell) {
  const args = [
    AGENT_LOOP,
    '--cell',
    '--corpus',
    cell.corpus,
    '--corpus-name',
    cell.corpusName,
    '--variant',
    cell.variant,
    '--scenario',
    cell.scenario,
    '--iteration',
    String(cell.iteration),
    '--project-dir',
    cell.projectDir,
    '--rows-out',
    cell.rowsOut,
  ];
  const started = process.hrtime.bigint();
  const child = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 60 * 60 * 1000,
  });
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  const cells = {
    ...cell,
    projectDir: undefined,
    rowsOut: undefined,
    wallClockMs: wallMs,
    childExitStatus: child.status,
  };
  const rows = [];
  if (child.status === 0 && fs.existsSync(cell.rowsOut)) {
    for (const line of fs.readFileSync(cell.rowsOut, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      rows.push(JSON.parse(line));
    }
  }
  return { cells, rows };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.corpus == null || args.out == null) {
    process.stderr.write('phase-d-profile: --corpus and --out are required\n');
    process.exit(2);
  }
  const corpusName = args.corpusName ?? path.basename(args.corpus);
  const scratch =
    args.scratch ??
    path.join(__dirname, '../../../.pms-bench/phase-d-scratch', args.label);
  fs.mkdirSync(scratch, { recursive: true });
  fs.mkdirSync(path.dirname(args.out), { recursive: true });

  const env = environment(corpusName, args.label);
  const cells = [];
  const rows = [];
  let failures = 0;

  for (const variant of args.variants) {
    for (const scenario of args.scenarios) {
      for (let iteration = 0; iteration < args.iterations; iteration += 1) {
        const projectDir = path.join(scratch, 'cell');
        const rowsOut = path.join(scratch, 'cell.jsonl');
        fs.rmSync(rowsOut, { force: true });
        const cell = {
          corpus: args.corpus,
          corpusName,
          variant,
          scenario,
          iteration,
          projectDir,
          rowsOut,
        };
        const result = runCell(cell);
        cells.push(result.cells);
        rows.push(...result.rows);
        if (result.cells.childExitStatus !== 0) failures += 1;
        // The project's bytes are the campaign's largest cost at c10000 and
        // nothing downstream of the rows needs them.
        fs.rmSync(projectDir, { recursive: true, force: true });
        process.stderr.write(
          `phase-d ${corpusName} ${variant} ${scenario} i${iteration}: ` +
            `${result.rows.length} rows, exit ${result.cells.childExitStatus}, ` +
            `${(result.cells.wallClockMs / 1000).toFixed(1)}s\n`,
        );
      }
    }
  }

  fs.writeFileSync(
    args.out,
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  const stat = fs.statfsSync(path.resolve(__dirname, '../../..'));
  const summary = {
    environment: env,
    diskAvailBytesAfter: stat.bavail * stat.bsize,
    cells,
    rows: rows.length,
    cellFailures: failures,
    metrics: [...new Set(rows.map((r) => r.metric))].sort(),
  };
  fs.writeFileSync(
    args.out.replace(/\.jsonl$/, '-summary.json'),
    JSON.stringify(summary, null, 2) + '\n',
  );
  fs.rmSync(scratch, { recursive: true, force: true });
  process.stderr.write(
    `phase-d: ${rows.length} rows from ${cells.length} cells, ` +
      `${failures} failed cells -> ${args.out}\n`,
  );
  if (failures > 0) process.exit(1);
}

main();
