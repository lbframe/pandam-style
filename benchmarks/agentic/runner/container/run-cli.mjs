/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Starts the CLI with the stream on this process's stdout (the `docker exec`
// stream read by the runner). An optional `--env-file` (in the agent tmpfs)
// supplies access-only credentials without `docker run -e`.
// Usage: run-cli.mjs [--env-file f] -- <cli> <args...>

import fs from 'node:fs';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const opts = argv.slice(0, sep);
const cmd = argv.slice(sep + 1);
const env = { ...process.env };
const envFile = opts[opts.indexOf('--env-file') + 1];
if (opts.includes('--env-file') && fs.existsSync(envFile)) {
  Object.assign(env, JSON.parse(fs.readFileSync(envFile, 'utf8')));
  fs.rmSync(envFile, { force: true });
}
const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', env });
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
