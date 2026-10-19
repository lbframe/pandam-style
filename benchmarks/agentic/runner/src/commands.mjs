/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Command classes, repair cycles, first-pass success and compiler
// attribution (DESIGN.md sections 0.4 and 2.4). The allowlist of transparent
// commands is closed: anything not on it is opaque, and any opaque command
// makes first-pass success unknown.

import path from 'node:path';
import { STREAM_METHOD, estimate, unknown } from './measured.mjs';

// Transcript-derived values come from the CLI stream, which is not attested
// (section 0.4): their method carries the stream label.
const METHOD = `${STREAM_METHOD}+transcript-heuristic/v1`;
const UNATTESTED = { integrity: 'cli-unattested' };

export const COMMAND_TABLE_VERSION = 'command-classes/v3';

// Shell operators, substitutions and redirections make a command opaque.
const SHELL_SYNTAX = /[;&|<>`$(){}\n\\]/;

/**
 * Whether any argument names a forbidden option, conservatively:
 * - a long option (`--name`, `--name=v`) that is a forbidden name **or any
 *   prefix of one** (getopt_long accepts unambiguous abbreviations);
 * - a short-option token (`-x…`, not `--`) containing a forbidden letter
 *   **anywhere**: options combine (`-zm1`) and take attached values
 *   (`-o/tmp/out`), and a letter inside an attached value only makes the
 *   command opaque, never transparent;
 * - an exact match of a single-dash long option.
 */
function hasOption(args, longs = [], shorts = '') {
  return args.some((a) => {
    if (a.startsWith('--')) {
      const name = a.split('=')[0];
      return name.length > 2 && longs.some((l) => l.startsWith(name));
    }
    if (a.startsWith('-') && a.length > 1)
      return (
        [...a.slice(1)].some((c) => shorts.includes(c)) || longs.includes(a)
      );
    return false;
  });
}

// The closed allowlist (section 2.4): single-purpose programs that execute
// no code and load no project code, each with the options that would
// execute or load code, or write files, excluded. Audited per program:
// - ls, cat, head, tail, wc, grep, stat, pwd, echo: no option executes code.
// - rg: --pre/--pre-glob run a preprocessor, -z/--search-zip run
//   decompressors, --hostname-bin runs a program.
// - find: -exec/-execdir/-ok/-okdir run programs; -delete, -fprint*, -fls
//   write (find takes no abbreviations or combined options).
// - file: -z/-Z/--uncompress run decompressors; -C/--compile writes.
// - tree: -o/--output writes a file.
// - sed: only `-n '<address>p'` (GNU sed's e, w, s///e, r and -f execute,
//   write or load scripts).
// - git is never transparent: its configuration (system, global, XDG,
//   includes, GIT_CONFIG_* environment, repository) can define external
//   diff drivers, textconv filters, pagers, aliases and hooks, and some of
//   those sources are agent-writable in every run.
// Configuration files the remaining programs read are only reachable
// through a write outside the workspace, which makes coverage incomplete
// (analyzeTimeline).
const TRANSPARENT = {
  ls: () => true,
  cat: () => true,
  head: () => true,
  tail: () => true,
  wc: () => true,
  grep: () => true,
  stat: () => true,
  pwd: () => true,
  echo: () => true,
  rg: (args) =>
    !hasOption(
      args,
      ['--pre', '--pre-glob', '--search-zip', '--hostname-bin'],
      'z',
    ),
  find: (args) =>
    !args.some((a) =>
      [
        '-exec',
        '-execdir',
        '-ok',
        '-okdir',
        '-delete',
        '-fprint',
        '-fprint0',
        '-fprintf',
        '-fls',
      ].includes(a),
    ),
  file: (args) =>
    !hasOption(
      args,
      ['--uncompress', '--uncompress-noreport', '--compile'],
      'zZC',
    ),
  tree: (args) => !hasOption(args, ['--output'], 'o'),
  sed: (args) =>
    args.length >= 2 &&
    args[0] === '-n' &&
    /^(\d+|\$)(,(\d+|\$))?p$/.test(args[1]) &&
    args.slice(2).every((f) => !f.startsWith('-')),
};

// Verification commands: compile, build, typecheck or test invocations.
const VERIFY = [
  /^(npm|pnpm|yarn)( run)? (build|typecheck|test|lint|check)\b/,
  /^(npm|pnpm|yarn) test\b/,
  /^(npx |pnpm (exec |dlx )?|yarn (dlx )?)?(vite|next|rsbuild|webpack|tsc|pandamstyle|pms)\b/,
  /^node_modules\/\.bin\/(vite|next|rsbuild|webpack|tsc|pandamstyle)\b/,
];

/**
 * Splits a simple command line into words as a POSIX shell would, or returns
 * null when it is not simple: shell syntax, escapes, a quote adjacent to
 * other characters (the shell would join them), or an unquoted word starting
 * with a glob character (its expansion can inject options from
 * agent-controlled file names).
 */
export function simpleWords(command) {
  const text = String(command ?? '').trim();
  if (text === '' || SHELL_SYNTAX.test(text)) return null;
  const words = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i += 1;
      continue;
    }
    const q = text[i];
    if (q === "'" || q === '"') {
      const end = text.indexOf(q, i + 1);
      if (end === -1) return null;
      if (end + 1 < text.length && !/\s/.test(text[end + 1])) return null;
      words.push(text.slice(i + 1, end));
      i = end + 1;
    } else {
      let j = i;
      while (j < text.length && !/\s/.test(text[j])) j += 1;
      const w = text.slice(i, j);
      if (/['"]/.test(w) || /^[*?[~]/.test(w)) return null;
      words.push(w);
      i = j;
    }
  }
  return words;
}

export function classifyCommand(command) {
  const text = String(command ?? '').trim();
  const verify = VERIFY.some((re) => re.test(text));
  const words = simpleWords(text);
  if (words == null || words.length === 0)
    return { class: 'opaque', verify, reason: 'not a simple command' };
  const program = words[0].split('/').pop();
  const check = Object.hasOwn(TRANSPARENT, program)
    ? TRANSPARENT[program]
    : null;
  if (check != null && words[0] === program && check(words.slice(1)))
    return { class: 'transparent', verify, reason: null };
  return { class: 'opaque', verify, reason: `program ${program}` };
}

/**
 * Whether a file-tool path stays inside the workspace: relative paths
 * resolve against it; an absolute path must lie beneath it. An unknown
 * workspace root or path is outside (conservative).
 */
export function insideWorkspace(p, workspaceRoot) {
  if (typeof p !== 'string' || p === '' || workspaceRoot == null) return false;
  const root = path.posix.resolve(workspaceRoot);
  const abs = path.posix.resolve(root, p);
  return abs === root || abs.startsWith(`${root}/`);
}

/**
 * Repair cycles and first-pass success from the tool-call timeline.
 *
 * @param {object[]} toolCalls adapter tool calls (kind, command, status,
 *   exitCode, index)
 * @param {(string|null)[]} deltas workspace tree digest recorded after each
 *   tool result (same index as toolCalls); null when the sample failed
 * @param {boolean|null} taskSuccess
 */
export function analyzeTimeline({
  toolCalls,
  deltas,
  taskSuccess,
  workspaceRoot = null,
}) {
  const reasons = [];
  let opaque = 0;
  let repairCycles = 0;
  let pendingFailedVerify = false;
  let changedSinceFailure = false;
  let previousDigest = null;
  const verifyCommands = [];

  toolCalls.forEach((call, i) => {
    const digest = deltas?.[i] ?? null;
    if (deltas != null && digest == null)
      reasons.push(`workspace-delta-missing:${i}`);
    if (call.status === 'unfinished' || call.status === 'in-progress')
      reasons.push(`unfinished:${i}`);
    if (call.status === 'unknown') reasons.push(`unknown-status:${i}`);
    // A file written outside the workspace can configure the programs the
    // transparent class trusts (shell startup files, ~/.gitconfig, ~/.magic,
    // tool configuration): coverage is incomplete (section 2.4).
    if (
      call.kind === 'file-write' &&
      (!Array.isArray(call.paths) ||
        call.paths.length === 0 ||
        call.paths.some((p) => !insideWorkspace(p, workspaceRoot)))
    )
      reasons.push(`write-outside-workspace:${i}`);
    const changedByThis =
      (digest != null && previousDigest != null && digest !== previousDigest) ||
      (call.kind === 'file-write' && call.status === 'completed');
    let isVerify = false;
    if (call.kind === 'command') {
      const c = classifyCommand(call.command);
      call.commandClass = c.class;
      call.verify = c.verify;
      if (c.class === 'opaque') {
        opaque += 1;
        reasons.push(`opaque:${i}`);
      }
      if (c.verify) {
        isVerify = true;
        verifyCommands.push(call);
        const failed =
          call.status === 'failed' ||
          (Number.isInteger(call.exitCode) && call.exitCode !== 0);
        if (pendingFailedVerify && changedSinceFailure) {
          repairCycles += 1;
          pendingFailedVerify = false;
        }
        if (failed) {
          // Output written by the failing check itself is not a repair.
          pendingFailedVerify = true;
          changedSinceFailure = false;
        }
      }
    }
    if (!isVerify && changedByThis) changedSinceFailure = true;
    if (digest != null) previousDigest = digest;
  });

  const coverageComplete = reasons.length === 0;
  let firstPassSuccess;
  if (taskSuccess === false || repairCycles > 0) firstPassSuccess = false;
  else if (taskSuccess === true && coverageComplete) firstPassSuccess = true;
  else firstPassSuccess = 'unknown';

  // Compiler attribution: transparent verify commands only (section 2.4).
  const attributable = verifyCommands.filter(
    (c) => c.commandClass === 'transparent',
  );
  return {
    tableVersion: COMMAND_TABLE_VERSION,
    repairCycles: estimate(
      repairCycles,
      'transcript+workspace-deltas',
      METHOD,
      'cycles',
      {
        ...UNATTESTED,
        lowerBound: repairCycles,
      },
    ),
    firstPassSuccess,
    coverage: { complete: coverageComplete, reasons },
    opaqueCommands: opaque,
    compiler: {
      verifyCommands: estimate(
        verifyCommands.length,
        'transcript',
        METHOD,
        'commands',
        UNATTESTED,
      ),
      attributedCommands:
        coverageComplete || attributable.length > 0
          ? estimate(
              attributable.length,
              'transcript',
              METHOD,
              'commands',
              UNATTESTED,
            )
          : unknown('transcript', 'commands', 'opaque commands present'),
      opaqueVerifyCommands: verifyCommands.length - attributable.length,
    },
  };
}
