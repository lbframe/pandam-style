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

import { STREAM_METHOD, estimate, unknown } from './measured.mjs';

// Transcript-derived values come from the CLI stream, which is not attested
// (section 0.4): their method carries the stream label.
const METHOD = `${STREAM_METHOD}+transcript-heuristic/v1`;
const UNATTESTED = { integrity: 'cli-unattested' };

export const COMMAND_TABLE_VERSION = 'command-classes/v1';

// Shell operators, substitutions and redirections make a command opaque.
const SHELL_SYNTAX = /[;&|<>`$(){}\n]|\\$/;

// Single-purpose commands that execute no project code. Each entry checks
// the argv after the program name.
const TRANSPARENT = {
  ls: () => true,
  cat: () => true,
  head: () => true,
  tail: () => true,
  wc: () => true,
  grep: () => true,
  rg: (args) => !args.some((a) => a === '--pre' || a.startsWith('--pre=')),
  find: (args) =>
    !args.some((a) =>
      ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint'].includes(a),
    ),
  stat: () => true,
  file: () => true,
  tree: () => true,
  pwd: () => true,
  echo: () => true,
  sed: (args) =>
    args.includes('-n') &&
    !args.some((a) => a === '-i' || a.startsWith('-i') || a.includes('w ')),
  git: (args) =>
    ['status', 'diff', 'log', 'show', 'ls-files', 'rev-parse'].includes(
      args.find((a) => !a.startsWith('-')),
    ) && !args.some((a) => a.startsWith('--output') || a === '-o'),
};

// Verification commands: compile, build, typecheck or test invocations.
const VERIFY = [
  /^(npm|pnpm|yarn)( run)? (build|typecheck|test|lint|check)\b/,
  /^(npm|pnpm|yarn) test\b/,
  /^(npx |pnpm (exec |dlx )?|yarn (dlx )?)?(vite|next|rsbuild|webpack|tsc|pandamstyle|pms)\b/,
  /^node_modules\/\.bin\/(vite|next|rsbuild|webpack|tsc|pandamstyle)\b/,
];

/** Splits a simple command line into words; returns null when not simple. */
export function simpleWords(command) {
  const text = String(command ?? '').trim();
  if (text === '' || SHELL_SYNTAX.test(text)) return null;
  const words = [];
  const re = /'([^']*)'|"([^"\\]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(text)) != null) words.push(m[1] ?? m[2] ?? m[3]);
  return words;
}

export function classifyCommand(command) {
  const text = String(command ?? '').trim();
  const verify = VERIFY.some((re) => re.test(text));
  const words = simpleWords(text);
  if (words == null || words.length === 0)
    return { class: 'opaque', verify, reason: 'shell syntax' };
  const program = words[0].split('/').pop();
  const check = TRANSPARENT[program];
  if (check != null && words[0] === program && check(words.slice(1)))
    return { class: 'transparent', verify, reason: null };
  return { class: 'opaque', verify, reason: `program ${program}` };
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
export function analyzeTimeline({ toolCalls, deltas, taskSuccess }) {
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
