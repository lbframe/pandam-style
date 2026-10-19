#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Fake `claude` / `codex` executable for adapter fixtures (DESIGN.md section
// 9.1). It never contacts a provider. It replays the scenario named by
// PMS_FAKE_SCENARIO: emitting recorded or synthetic JSONL events, and
// performing real workspace actions (commands, writes) so the runner's
// parsing, event triggers, workspace deltas, credential export and grading
// run on real effects. `${REQUESTED_MODEL}`, `${SESSION}` and `${N}` in
// emitted events are substituted.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const scenario = JSON.parse(
  fs.readFileSync(process.env.PMS_FAKE_SCENARIO, 'utf8'),
);
const cli =
  process.env.PMS_FAKE_CLI ??
  path.basename(process.argv[1]).replace(/^fake-|\.mjs$/g, '');
const argv = process.argv.slice(2);
const modelFlag = cli === 'codex' ? '-m' : '--model';
const requestedModel = argv[argv.indexOf(modelFlag) + 1] ?? null;
const session = argv.includes('--session-id')
  ? argv[argv.indexOf('--session-id') + 1]
  : '01a152b3-0000-7000-8000-000000000000';
const credentialDir = process.env.PMS_FAKE_CREDENTIAL_DIR ?? null;

if (scenario.ignoreSignals) {
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => {});
}

let counter = 0;
function subst(value) {
  return JSON.parse(
    JSON.stringify(value)
      .replaceAll('${REQUESTED_MODEL}', requestedModel ?? '')
      .replaceAll('${SESSION}', session),
  );
}
function emit(event) {
  process.stdout.write(`${JSON.stringify(subst(event))}\n`);
}

function emitCommand(command, run) {
  counter += 1;
  const id = `tool_${counter}`;
  if (cli === 'codex') {
    emit({
      type: 'item.started',
      item: {
        id,
        type: 'command_execution',
        command,
        aggregated_output: '',
        exit_code: null,
        status: 'in_progress',
      },
    });
    const r = run();
    emit({
      type: 'item.completed',
      item: {
        id,
        type: 'command_execution',
        command,
        aggregated_output: r.output,
        exit_code: r.status,
        status: r.status === 0 ? 'completed' : 'failed',
      },
    });
  } else {
    emit({
      type: 'assistant',
      message: {
        id: `msg_${id}`,
        model: requestedModel,
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      session_id: session,
    });
    const r = run();
    emit({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            is_error: r.status !== 0,
            content: r.output,
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: session,
    });
  }
}

function emitWrite(file, content) {
  counter += 1;
  const id = `tool_${counter}`;
  const abs = path.resolve(process.cwd(), file);
  if (cli === 'codex') {
    emit({
      type: 'item.started',
      item: {
        id,
        type: 'file_change',
        changes: [{ path: file, kind: 'update' }],
        status: 'in_progress',
      },
    });
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    let ok = true;
    try {
      fs.writeFileSync(abs, content);
    } catch {
      ok = false;
    }
    emit({
      type: 'item.completed',
      item: {
        id,
        type: 'file_change',
        changes: [{ path: file, kind: 'update' }],
        status: ok ? 'completed' : 'failed',
      },
    });
  } else {
    emit({
      type: 'assistant',
      message: {
        id: `msg_${id}`,
        model: requestedModel,
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id,
            name: 'Write',
            input: { file_path: file, content },
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      session_id: session,
    });
    let ok = true;
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    } catch {
      ok = false;
    }
    emit({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            is_error: !ok,
            content: ok ? 'ok' : 'EROFS',
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: session,
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  for (const step of scenario.steps) {
    if (step.emit) emit(step.emit);
    else if (step.emitRaw != null) process.stdout.write(step.emitRaw);
    else if (step.run != null)
      // `as`: the command text the stream shows while `run` really executes
      // (an opaque wrapper such as `npm run verify` around a script).
      emitCommand(step.as ?? step.run, () => {
        const r = spawnSync('sh', ['-c', step.run], {
          cwd: process.cwd(),
          encoding: 'utf8',
        });
        return { status: r.status ?? 1, output: `${r.stdout}${r.stderr}` };
      });
    else if (step.fakeRun != null)
      // A command event without execution: the command text, status and
      // output are synthetic (for commands a test must not really run).
      emitCommand(step.fakeRun.command, () => ({
        status: step.fakeRun.exitCode ?? 0,
        output: step.fakeRun.output ?? '',
      }));
    else if (step.write) emitWrite(step.write.path, step.write.content);
    else if (step.touchHostCredential) {
      // Test-only: the user's own CLI refreshing the host file meanwhile.
      fs.writeFileSync(
        process.env.PMS_FAKE_HOST_CREDENTIAL,
        step.touchHostCredential,
      );
    } else if (step.sleep) await sleep(step.sleep);
    else if (step.refreshCredential) {
      // Simulates a CLI refreshing its login inside the tmpfs.
      const file = path.join(credentialDir, step.refreshCredential.file);
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      let node = doc;
      const keys = step.refreshCredential.path;
      for (const k of keys.slice(0, -1)) node = node[k];
      node[keys.at(-1)] = step.refreshCredential.value;
      fs.writeFileSync(file, JSON.stringify(doc));
    } else if (step.tamperCredential) {
      const file = path.join(credentialDir, step.tamperCredential.file);
      fs.rmSync(file, { force: true });
      if (step.tamperCredential.kind === 'symlink')
        fs.symlinkSync('/etc/hostname', file);
      else if (step.tamperCredential.kind === 'fifo')
        spawnSync('mkfifo', [file]);
      else if (step.tamperCredential.kind === 'oversize')
        fs.writeFileSync(file, 'x'.repeat(200 * 1024));
      else if (step.tamperCredential.kind === 'invalid-json')
        fs.writeFileSync(file, '{not json');
      else if (step.tamperCredential.kind === 'shape')
        fs.writeFileSync(file, '{"unexpected":true}');
    } else if (step.printCredential) {
      // A misbehaving agent echoing its credential into its final message.
      const file = path.join(credentialDir, step.printCredential.file);
      emit({ type: 'note', leaked: fs.readFileSync(file, 'utf8') });
    } else if (step.leakChild) {
      // A child process holding this process's stdout writes a replacement
      // stream (fixture F22): inherited descriptors are not a boundary.
      const child = spawn(
        process.execPath,
        ['-e', `process.stdout.write(${JSON.stringify(step.leakChild.text)})`],
        { stdio: ['ignore', 'inherit', 'inherit'] },
      );
      await new Promise((r) => child.on('exit', r));
    } else if (step.waitForever)
      // A timer keeps the event loop alive; a bare pending promise does not.
      await new Promise(() => setInterval(() => {}, 1 << 30));
    else if (step.selfKill) process.kill(process.pid, step.selfKill);
    else if (step.exit != null) process.exit(step.exit);
  }
}

main().then(() => process.exit(scenario.exitCode ?? 0));
