#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Command-line entry point of the agentic evaluation corpus.
//
//   validate [--json]                 schema + semantic + coverage + lock checks
//   lock                              rewrite corpus.lock.json after a reviewed change
//   list [--epoch e]                  task ids with workflow, case and classification
//   prompt <task> [--docs-path p]     full prompt for the evaluated agent
//   materialize <task> <dest> [--files-only]  starting workspace of a task
//   prepare <task> <dest>             prepare steps + baseline commit (after install)
//   event <task> <eventId> <dest>     apply a concurrent-edit event (exit 3: not applied)
//   evaluate <task> --baseline d --workspace d [--response f] [--transcript f]
//            [--observations f] [--epoch e] [--host-commands]
//            [--trusted-node-modules d] [--out f]
//   oracle-fixtures [--task id] [--scratch d] [--verbose]  prove oracles discriminate
//   heldout manifest|seal|unseal|verify|guard [--dest d]
//
// Held-out tasks are resolved from --heldout-dir (an unsealed location) only.

import fs from 'node:fs';
import path from 'node:path';
import {
  CORPUS_ROOT,
  computeLock,
  findTask,
  loadCorpus,
  validateCorpus,
} from '../src/corpus.mjs';
import {
  applyEvent,
  buildPrompt,
  materializeFiles,
  prepareWorkspace,
} from '../src/materialize.mjs';
import { evaluateTask } from '../src/oracles/evaluate.mjs';
import {
  listOracleFixtures,
  runOracleFixture,
} from '../src/oracle-fixtures.mjs';
import {
  buildManifest,
  guard,
  seal,
  unseal,
  verify,
  writeManifest,
} from '../src/heldout.mjs';

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next == null || next.startsWith('--')) flags[a.slice(2)] = true;
      else {
        flags[a.slice(2)] = next;
        i += 1;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

function load(flags) {
  return loadCorpus(CORPUS_ROOT, {
    heldoutTasksDir: flags['heldout-dir'] ?? null,
  });
}

function requireTask(loaded, id) {
  const entry = findTask(loaded, id);
  if (entry == null)
    throw new Error(`unknown task ${id} (held-out tasks need --heldout-dir)`);
  return entry;
}

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parse(rest);
  switch (command) {
    case 'validate': {
      const { errors, summary } = validateCorpus(load(flags));
      if (flags.json)
        process.stdout.write(
          `${JSON.stringify({ ok: errors.length === 0, errors, summary }, null, 2)}\n`,
        );
      else {
        for (const e of errors) process.stderr.write(`ERROR ${e}\n`);
        process.stdout.write(
          `corpus ${summary.corpusVersion} (${summary.referenceEpoch}): ${summary.development} development tasks, ` +
            `${summary.heldoutListed} held-out listed, ${summary.fixtures} fixtures, hosts ${summary.hosts.join(',')}\n` +
            `classifications ${JSON.stringify(summary.classifications)}\n${errors.length === 0 ? 'OK' : `${errors.length} error(s)`}\n`,
        );
      }
      process.exitCode = errors.length === 0 ? 0 : 1;
      break;
    }
    case 'lock': {
      const lock = computeLock(load(flags));
      fs.writeFileSync(
        path.join(CORPUS_ROOT, 'corpus.lock.json'),
        `${JSON.stringify(lock, null, 2)}\n`,
      );
      process.stdout.write(
        `corpus.lock.json written (${Object.keys(lock.development).length} development tasks)\n`,
      );
      break;
    }
    case 'list': {
      const loaded = load(flags);
      const epoch = flags.epoch ?? loaded.corpus.referenceEpoch;
      for (const t of [...loaded.development, ...loaded.heldout]) {
        const exp = t.task.expectations?.[epoch];
        process.stdout.write(
          `${t.task.split}\t${t.name}\t${t.task.workflow}\t${t.task.caseType}\t${exp?.classification ?? 'not-evaluable'}\t${exp?.intendedOutcome.kind ?? '-'}\n`,
        );
      }
      break;
    }
    case 'prompt': {
      const loaded = load(flags);
      process.stdout.write(
        buildPrompt({
          corpusRoot: CORPUS_ROOT,
          taskEntry: requireTask(loaded, positional[0]),
          docsPath: flags['docs-path'],
        }),
      );
      break;
    }
    case 'materialize': {
      const loaded = load(flags);
      const entry = requireTask(loaded, positional[0]);
      const fixture = loaded.fixtures.get(entry.task.workspace.fixture);
      const dest = path.resolve(positional[1]);
      materializeFiles({ taskEntry: entry, fixture, dest });
      // --files-only stops before dependency installation so the runner can
      // install candidate packages, then call `prepare`.
      if (!flags['files-only'])
        prepareWorkspace({ taskEntry: entry, fixture, dest });
      process.stdout.write(`${dest}\n`);
      break;
    }
    case 'prepare': {
      const loaded = load(flags);
      const entry = requireTask(loaded, positional[0]);
      prepareWorkspace({
        taskEntry: entry,
        fixture: loaded.fixtures.get(entry.task.workspace.fixture),
        dest: path.resolve(positional[1]),
      });
      process.stdout.write(`${path.resolve(positional[1])}\n`);
      break;
    }
    case 'event': {
      const loaded = load(flags);
      const entry = requireTask(loaded, positional[0]);
      const r = applyEvent({
        taskEntry: entry,
        fixture: loaded.fixtures.get(entry.task.workspace.fixture),
        eventId: positional[1],
        dest: path.resolve(positional[2]),
      });
      process.stdout.write(`${JSON.stringify(r)}\n`);
      process.exitCode = r.applied ? 0 : 3;
      break;
    }
    case 'evaluate': {
      const loaded = load(flags);
      const entry = requireTask(loaded, positional[0]);
      const res = await evaluateTask({
        task: entry.task,
        fixture: loaded.fixtures.get(entry.task.workspace.fixture).meta,
        epoch: flags.epoch ?? loaded.corpus.referenceEpoch,
        baselineDir: path.resolve(flags.baseline),
        workspaceDir: path.resolve(flags.workspace),
        responseText: flags.response
          ? fs.readFileSync(flags.response, 'utf8')
          : null,
        transcript: flags.transcript ? readJsonl(flags.transcript) : null,
        observations: flags.observations
          ? JSON.parse(fs.readFileSync(flags.observations, 'utf8'))
          : null,
        scratchRoot: flags.scratch ? path.resolve(flags.scratch) : undefined,
        options: {
          hostCommands: flags['host-commands'] === true,
          trustedNodeModules: flags['trusted-node-modules']
            ? path.resolve(flags['trusted-node-modules'])
            : null,
        },
      });
      const out = `${JSON.stringify(res, null, 2)}\n`;
      if (flags.out) fs.writeFileSync(flags.out, out);
      else process.stdout.write(out);
      break;
    }
    case 'oracle-fixtures': {
      const loaded = load(flags);
      const scratch = path.resolve(
        flags.scratch ??
          path.join(CORPUS_ROOT, '../../.pms-bench/agentic-oracle-fixtures'),
      );
      fs.mkdirSync(scratch, { recursive: true });
      let failures = 0;
      for (const entry of [...loaded.development, ...loaded.heldout]) {
        if (flags.task && flags.task !== entry.name) continue;
        for (const fixture of listOracleFixtures(entry)) {
          const r = await runOracleFixture({
            loaded,
            taskEntry: entry,
            fixture,
            scratchRoot: scratch,
          });
          failures += r.mismatches.length > 0 ? 1 : 0;
          process.stdout.write(
            `${r.mismatches.length === 0 ? 'ok  ' : 'FAIL'} ${r.task}/${r.fixture} -> ${r.verdict}\n`,
          );
          for (const m of r.mismatches) process.stdout.write(`       ${m}\n`);
          if (flags.verbose)
            process.stdout.write(
              `${JSON.stringify(r.result.checks, null, 2)}\n`,
            );
        }
      }
      process.exitCode = failures === 0 ? 0 : 1;
      break;
    }
    case 'heldout': {
      const sub = positional[0];
      if (sub === 'manifest') {
        writeManifest(CORPUS_ROOT, buildManifest(CORPUS_ROOT));
        process.stdout.write(
          'heldout/MANIFEST.json written from plaintext staging\n',
        );
      } else if (sub === 'seal') {
        const m = seal(CORPUS_ROOT);
        process.stdout.write(
          `sealed ${m.tasks.length} tasks, archive sha256 ${m.sealed.archiveSha256}\n`,
        );
      } else if (sub === 'unseal') {
        process.stdout.write(
          `${unseal(CORPUS_ROOT, { dest: flags.dest ?? null })}\n`,
        );
      } else if (sub === 'verify') {
        const r = verify(CORPUS_ROOT);
        process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
        process.exitCode = r.problems.length === 0 ? 0 : 1;
      } else if (sub === 'guard') {
        const r = guard(CORPUS_ROOT);
        for (const p of r.problems) process.stderr.write(`GUARD ${p}\n`);
        process.exitCode = r.problems.length === 0 ? 0 : 1;
      } else throw new Error(`unknown heldout subcommand ${sub}`);
      break;
    }
    default:
      process.stderr.write(
        'usage: pms-agentic validate|lock|list|prompt|materialize|evaluate|heldout ...\n',
      );
      process.exitCode = 2;
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
