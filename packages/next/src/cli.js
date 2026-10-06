#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { spawn } from 'node:child_process';
import { createSupervisor, resolveInstalledNext } from './supervisor.js';
import transport from './transport-client.cjs';

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (
    !['dev', 'build'].includes(command) ||
    !args.includes('--turbopack') ||
    args.includes('--webpack') ||
    args.includes('--turbo')
  )
    throw transport.transportError(
      'PMS_UNSUPPORTED_FEATURE',
      'Run pandamstyle-next dev --turbopack or pandamstyle-next build --turbopack explicitly.',
    );
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--turbopack') continue;
    if (command === 'dev' && /^--(?:port|hostname)=.+$/.test(argument))
      continue;
    if (
      command === 'dev' &&
      ['--port', '-p', '--hostname', '-H'].includes(argument) &&
      typeof args[index + 1] === 'string' &&
      !args[index + 1].startsWith('-')
    ) {
      index += 1;
      continue;
    }
    throw transport.transportError(
      'PMS_UNSUPPORTED_FEATURE',
      'The qualified command uses the current consumer directory. Only --turbopack and dev --port/--hostname options are supported; positional directories and other Next flags require qualification.',
    );
  }
  const next = await resolveInstalledNext(process.cwd());
  const supervisor = await createSupervisor(process.cwd(), { command });
  let child;
  let requestedSignal;
  let failure;
  const forward = (signal) => {
    requestedSignal = signal;
    child?.kill(signal);
  };
  const terminate = () => forward('SIGTERM');
  const interrupt = () => forward('SIGINT');
  process.on('SIGTERM', terminate);
  process.on('SIGINT', interrupt);
  try {
    const env = {
      ...process.env,
      PMS_NEXT_COORDINATOR_FILE: supervisor.credentialFile,
    };
    delete env.NODE_PATH;
    child = spawn(process.execPath, [next.binary, command, ...args], {
      cwd: supervisor.root,
      env,
      stdio: 'inherit',
    });
    const outcome = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    await supervisor.owner?.recordNextProcessExit?.({
      exitCode: outcome.code,
      signal: outcome.signal,
      childPid: child.pid,
    });
    if (outcome.code === 0 && command === 'build')
      await supervisor.finishSuccessfulProduction({
        exitCode: outcome.code,
        signal: outcome.signal,
      });
    process.exitCode =
      outcome.code ??
      ((outcome.signal ?? requestedSignal) === 'SIGINT' ? 130 : 143);
  } catch (error) {
    failure = error;
  } finally {
    process.removeListener('SIGTERM', terminate);
    process.removeListener('SIGINT', interrupt);
    try {
      await supervisor.close();
    } catch (error) {
      if (supervisor.productionCompleted && process.exitCode === 0)
        process.stderr.write(
          `PMS_HOST_CLEANUP: ${error.message}. The completed production receipt remains valid.\n`,
        );
      else failure ??= error;
    }
  }
  if (failure != null) throw failure;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
