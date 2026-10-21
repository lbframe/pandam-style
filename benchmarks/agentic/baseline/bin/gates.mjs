#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Gate record tooling of POLICY.md section 6 (independent of
// pms-agentic-runner; it only reads matrix directories).
//
//   gates derive <baseline matrix dir> [--out gates.v1.json]
//   gates check <gates.v1.json> <candidate matrix dir> [--control <dir>] [--out f]
//
// derive: exit 0 with the record written (its `freeze.status` says whether
// it can be frozen); an existing different --out file is never overwritten.
// check: exit 0 when the verdict is `pass`, 2 when it is
// `insufficient-reference` or `block`. Exit 1: a refused input or an error.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GatesRefusal, checkGates, deriveGates, serialize } from '../gates.mjs';

const USAGE = `usage:
  gates derive <baseline matrix dir> [--out gates.v1.json]
  gates check <gates.v1.json> <candidate matrix dir> [--control <dir>] [--out f]
`;

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      if (!['out', 'control'].includes(name))
        throw new GatesRefusal(`unknown option --${name}`);
      const value = eq < 0 ? argv[(i += 1)] : a.slice(eq + 1);
      if (value == null || value === '')
        throw new GatesRefusal(`--${name} needs a value`);
      flags[name] = value;
    } else positional.push(a);
  }
  return { positional, flags };
}

function write(out, text, { immutable }) {
  if (out == null) {
    process.stdout.write(text);
    return;
  }
  if (immutable && fs.existsSync(out) && fs.readFileSync(out, 'utf8') !== text)
    throw new GatesRefusal(
      `${out} exists with other content: a gate record is never overwritten`,
    );
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, text);
}

/** Returns the exit status. */
export function main(argv, { stderr = process.stderr } = {}) {
  const [command, ...rest] = argv;
  const { positional, flags } = parse(rest);
  if (command === 'derive' && positional.length === 1) {
    const record = deriveGates(positional[0]);
    write(flags.out ?? null, serialize(record), { immutable: true });
    const f = record.freeze;
    stderr.write(
      `gates derive: ${f.status}${f.reasons.length ? ` (${f.reasons.join('; ')})` : ''}\n`,
    );
    for (const c of f.recollectCells)
      stderr.write(
        `  re-collect ${c.taskId} / ${c.modelKey} (${c.gates.join(', ')})\n`,
      );
    return 0;
  }
  if (command === 'check' && positional.length === 2) {
    const record = JSON.parse(fs.readFileSync(positional[0], 'utf8'));
    const result = checkGates(record, positional[1], {
      controlDir: flags.control ?? null,
    });
    write(flags.out ?? null, serialize(result), { immutable: false });
    stderr.write(`gates check: ${result.verdict} (${result.verdictReason})\n`);
    for (const g of result.gates)
      if (g.outcome !== 'pass')
        stderr.write(
          `  ${g.modelKey} ${g.gate}: ${g.outcome}${g.blocking ? '' : ' (not blocking)'}${g.pValue == null ? '' : ` p=${g.pValue}`}\n`,
        );
    return result.verdict === 'pass' ? 0 : 2;
  }
  stderr.write(USAGE);
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      error instanceof GatesRefusal
        ? `gates: refused: ${error.message}\n`
        : `${error?.stack ?? error}\n`,
    );
    process.exitCode = 1;
  }
}
