/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Parent side of the untrusted-code sandbox (see sandbox.mjs).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX = path.join(HERE, 'sandbox.mjs');
// The sandbox's own (trusted) HTML parser, imported before agent code runs.
const HTML_PARSER = path.join(HERE, '../html.mjs');

/** Nearest node_modules directory the workspace resolves packages from. */
export function resolveNodeModules(fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Read allowances for one sandbox run: the workspace copy, the trusted
 * dependency tree (with the real targets of symlinked packages, as in a
 * workspace install) and the sandbox entry file. Ancestor package.json files
 * are readable because module format detection walks up to them.
 */
export function sandboxReadPaths(workspaceDir) {
  const paths = new Set([fs.realpathSync(workspaceDir), SANDBOX, HTML_PARSER]);
  const nodeModules = resolveNodeModules(workspaceDir);
  if (nodeModules != null) {
    const real = fs.realpathSync(nodeModules);
    paths.add(real);
    const scan = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.name.startsWith('@') && entry.isDirectory()) scan(abs);
        else if (entry.isSymbolicLink()) {
          try {
            paths.add(fs.realpathSync(abs));
          } catch {
            // A dangling link resolves nowhere; nothing to allow.
          }
        }
      }
    };
    scan(real);
  }
  for (
    let dir = path.dirname(fs.realpathSync(workspaceDir));
    ;
    dir = path.dirname(dir)
  ) {
    paths.add(path.join(dir, 'package.json'));
    if (path.dirname(dir) === dir) break;
  }
  return [...paths];
}

function decode(hex) {
  let out = '';
  for (let i = 0; i + 4 <= hex.length; i += 4)
    out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return out;
}

/**
 * Runs one sandboxed request. Returns `{ ok, payload, calls, error }`. Any
 * output not tagged with this run's nonce is ignored; zero or several tagged
 * lines are an error.
 */
export function runSandbox(request, { timeoutMs = 60000 } = {}) {
  const nonce = crypto.randomBytes(24).toString('hex');
  const args = [
    '--permission',
    // Agent code can never construct code from strings (eval, Function and
    // its aliases or `.constructor` forms); attempts surface as EvalError.
    '--disallow-code-generation-from-strings',
    ...sandboxReadPaths(request.workspaceDir).map(
      (p) => `--allow-fs-read=${p}`,
    ),
    SANDBOX,
  ];
  const child = spawnSync(process.execPath, args, {
    input: JSON.stringify({ ...request, nonce }),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { NODE_ENV: 'production', PATH: process.env.PATH ?? '' },
  });
  const prefix = `PMS-SANDBOX ${nonce} `;
  const lines = (child.stdout ?? '')
    .split('\n')
    .filter((l) => l.startsWith(prefix));
  if (lines.length !== 1) {
    const why =
      child.error?.code === 'ETIMEDOUT' || child.signal
        ? `timed out or killed (${child.signal ?? child.error?.code})`
        : `${lines.length} tagged results`;
    return {
      ok: false,
      error: `PMS_SANDBOX_NO_RESULT: ${why}; stderr: ${(child.stderr ?? '').slice(-800)}`,
    };
  }
  const fields = {};
  for (const part of lines[0].slice(prefix.length).split(' ')) {
    const eq = part.indexOf('=');
    fields[part.slice(0, eq)] = decode(part.slice(eq + 1));
  }
  if (fields.status !== 'ok')
    return { ok: false, error: fields.error || 'sandbox error' };
  return { ok: true, payload: fields.payload };
}

export const CODE_GENERATION_ERROR = /Code generation from strings disallowed/;

/** Loads a definition module in the sandbox and returns its data. */
export function loadDefinitionData(workspaceDir, definition) {
  const r = runSandbox({ mode: 'definition', workspaceDir, definition });
  if (!r.ok) return { error: r.error };
  try {
    return { data: JSON.parse(r.payload) };
  } catch (error) {
    return { error: `definition payload is not JSON: ${error.message}` };
  }
}
