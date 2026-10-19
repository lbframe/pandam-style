/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Credential handling (DESIGN.md section 4.6, user decision Q1: copies of
// the user's existing login files). Mode A (access-only) gives a container no
// refresh token; mode B (refresh-capable copy) exports the possibly refreshed
// file before the tmpfs is destroyed, validates it as untrusted input and
// writes it back to the host file only by compare-and-swap, with a backup.
//
// The credential source is a required run-config input per provider: a
// configuration directory and an account label, recorded in every attempt.
// There is no default: in particular the runner never falls back to
// ~/.claude (Claude runs use the claude-team-2 account's directory).
//
// The layout of the login files was not read during the design (only names
// and modes were). The key paths below are therefore UNVERIFIED assumptions;
// every function fails closed (mode B, or no write-back) when they do not
// match, and the smoke run confirms them.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from './util.mjs';

export const MAX_CREDENTIAL_BYTES = 64 * 1024;
export const CREDENTIAL_MODES = ['access-only', 'refresh-capable-copy', 'none'];

export const PROVIDERS = {
  claude: {
    // Inside CLAUDE_CONFIG_DIR, as the CLI itself stores it.
    sourceFile: '.credentials.json',
    containerFile: '.claude/.credentials.json',
    accessToken: ['claudeAiOauth', 'accessToken'],
    refreshToken: ['claudeAiOauth', 'refreshToken'],
    expiresAt: ['claudeAiOauth', 'expiresAt'],
    accessOnlyEnv: 'CLAUDE_CODE_OAUTH_TOKEN',
    layoutVerified: false,
  },
  codex: {
    // Inside CODEX_HOME.
    sourceFile: 'auth.json',
    containerFile: 'auth.json',
    accessToken: ['tokens', 'access_token'],
    refreshToken: ['tokens', 'refresh_token'],
    expiresAt: null,
    accessOnlyLogin: ['login', '--with-access-token'],
    layoutVerified: false,
  },
};

function expandHome(p, home) {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/** The home directory replaced by `~`, for recorded paths. */
export function tildePath(p, home = os.homedir()) {
  if (p === home) return '~';
  return p.startsWith(home + path.sep) ? `~/${p.slice(home.length + 1)}` : p;
}

/**
 * Validates the `credentials` entry of one provider (section 4.6). Returns
 * a list of errors; an absent or incomplete source is an error, never a
 * default.
 */
export function credentialConfigErrors(provider, entry, { kind }) {
  const errors = [];
  if (PROVIDERS[provider] == null)
    return [`credentials: unknown provider ${provider}`];
  if (entry == null || typeof entry !== 'object')
    return [
      `credentials.${provider} is required (mode and source; there is no default)`,
    ];
  if (!CREDENTIAL_MODES.includes(entry.mode))
    errors.push(
      `credentials.${provider}.mode must be one of ${CREDENTIAL_MODES.join(', ')}`,
    );
  if (kind === 'provider-backed' && entry.mode === 'none')
    errors.push(
      `credentials.${provider}: provider-backed matrices need a credential`,
    );
  if (
    entry.fallback != null &&
    !(entry.mode === 'access-only' && entry.fallback === 'refresh-capable-copy')
  )
    errors.push(
      `credentials.${provider}.fallback is only refresh-capable-copy after access-only`,
    );
  if (entry.mode === 'none') {
    if (entry.source != null)
      errors.push(`credentials.${provider}.source must be null with mode none`);
    return errors;
  }
  const src = entry.source;
  if (src == null || typeof src !== 'object')
    errors.push(
      `credentials.${provider}.source is required: { configDir, account } (no default directory)`,
    );
  else {
    if (
      typeof src.configDir !== 'string' ||
      !(src.configDir.startsWith('/') || src.configDir.startsWith('~/'))
    )
      errors.push(
        `credentials.${provider}.source.configDir must be an absolute or ~/ path`,
      );
    if (typeof src.account !== 'string' || src.account.length === 0)
      errors.push(
        `credentials.${provider}.source.account must name the account`,
      );
  }
  return errors;
}

/**
 * Resolves the credential of one provider from the run configuration. Returns
 * null for mode `none`. Throws when the entry is missing or incomplete.
 */
export function credentialFromConfig(
  config,
  provider,
  { stateDir, home = os.homedir() } = {},
) {
  const entry = config.credentials?.[provider];
  const errors = credentialConfigErrors(provider, entry, { kind: config.kind });
  if (errors.length > 0) throw coded('credential-config', errors.join('; '));
  if (entry.mode === 'none') return null;
  const configDir = path.resolve(expandHome(entry.source.configDir, home));
  return {
    provider,
    mode: entry.mode,
    fallback: entry.fallback ?? null,
    hostPath: path.join(configDir, PROVIDERS[provider].sourceFile),
    backupDir: path.join(
      stateDir ?? path.join(home, '.local/state/pandamstyle-agentic'),
      'credential-backups',
      provider,
    ),
    source: {
      configDir: tildePath(configDir, home),
      file: PROVIDERS[provider].sourceFile,
      account: entry.source.account,
    },
  };
}

/**
 * Matrix-start check of a credential source: the file must exist and be a
 * regular file (lstat only: names and modes, never contents).
 */
export function checkCredentialSource(credential) {
  let st;
  try {
    st = fs.lstatSync(credential.hostPath);
  } catch (error) {
    throw coded(
      'credential-source',
      `credential source of ${credential.provider} (${credential.source.account}) missing: ${credential.source.configDir}/${credential.source.file} (${error.code})`,
    );
  }
  if (!st.isFile())
    throw coded(
      'credential-source',
      `credential source of ${credential.provider} is not a regular file: ${credential.source.configDir}/${credential.source.file}`,
    );
  return { mode: st.mode & 0o777 };
}

/**
 * Reads a credential file as untrusted input: no link following, regular
 * file only, bounded size. Throws a coded error otherwise.
 */
export function readCredentialFile(
  file,
  { maxBytes = MAX_CREDENTIAL_BYTES } = {},
) {
  let fd;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    throw coded(
      error.code === 'ELOOP'
        ? 'symlink'
        : error.code === 'ENOENT'
          ? 'missing'
          : 'open-failed',
      `cannot open credential: ${error.code}`,
    );
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile())
      throw coded('not-regular', 'credential is not a regular file');
    if (st.size > maxBytes)
      throw coded('oversize', 'credential exceeds the size bound');
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    // A file that grew after fstat is truncated at the bound, not trusted.
    return {
      bytes: buf.subarray(0, off),
      sha256: sha256(buf.subarray(0, off)),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function coded(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function getPath(doc, keys) {
  let v = doc;
  for (const k of keys) {
    if (v == null || typeof v !== 'object') return undefined;
    v = v[k];
  }
  return v;
}

/** Structure of a JSON document: key sets and value types, never values. */
export function shapeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return ['array', ...value.map(shapeOf)];
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = shapeOf(value[k]);
    return out;
  }
  return typeof value;
}

function parseJson(bytes) {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return undefined;
  }
}

function jwtExpiryMs(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    );
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Mode A: derive a credential with no refresh token. Returns
 * `{ mode: 'access-only', delivery }` or `{ mode: null, reason }` (then the
 * runner uses mode B). The attempt may start only if the remaining lifetime
 * exceeds `minLifetimeMs` (attempt budget plus a margin).
 */
export function deriveAccessOnly(
  provider,
  bytes,
  { now = Date.now(), minLifetimeMs },
) {
  const p = PROVIDERS[provider];
  const doc = parseJson(bytes);
  if (doc === undefined)
    return { mode: null, reason: 'credential is not JSON' };
  const token = getPath(doc, p.accessToken);
  if (typeof token !== 'string' || token.length === 0)
    return { mode: null, reason: 'no access token at the expected path' };
  let expires = p.expiresAt ? getPath(doc, p.expiresAt) : jwtExpiryMs(token);
  if (typeof expires === 'number' && expires < 1e12) expires *= 1000;
  if (!Number.isFinite(expires))
    return { mode: null, reason: 'access token lifetime unknown' };
  if (expires - now < minLifetimeMs)
    return {
      mode: null,
      reason: 'access token lifetime below the attempt budget',
    };
  const delivery =
    p.accessOnlyEnv != null
      ? { kind: 'env', name: p.accessOnlyEnv, value: token }
      : { kind: 'login-stdin', args: p.accessOnlyLogin, value: token };
  return {
    mode: 'access-only',
    delivery,
    expiresAt: expires,
    secrets: [token],
  };
}

/**
 * Validates an exported credential against the original copy (section 4.6
 * step 4). Never returns secret values.
 */
export function validateExport(provider, originalBytes, exportedBytes) {
  const p = PROVIDERS[provider];
  const original = parseJson(originalBytes);
  const exported = parseJson(exportedBytes);
  if (exported === undefined) return { ok: false, reason: 'invalid-json' };
  if (original === undefined) return { ok: false, reason: 'original-not-json' };
  if (JSON.stringify(shapeOf(original)) !== JSON.stringify(shapeOf(exported)))
    return { ok: false, reason: 'shape-mismatch' };
  const before = getPath(original, p.refreshToken);
  const after = getPath(exported, p.refreshToken);
  if (typeof after !== 'string' || after.length === 0)
    return { ok: false, reason: 'no-refresh-token' };
  return { ok: true, refreshChanged: before !== after };
}

/**
 * Compare-and-swap of the host credential file (section 4.6 step 5). Writes
 * only if the host file still has the bytes copied at attempt start.
 */
export function casWriteBack({
  hostPath,
  originalSha256,
  exportedBytes,
  backupDir,
  keep = 3,
}) {
  let current;
  try {
    current = readCredentialFile(hostPath);
  } catch (error) {
    return { outcome: 'conflict-not-written', reason: `host ${error.code}` };
  }
  if (current.sha256 !== originalSha256)
    return {
      outcome: 'conflict-not-written',
      reason: 'host file changed during the attempt',
    };
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.basename(hostPath);
  const backup = path.join(
    backupDir,
    `${base}.${stamp}.${crypto.randomBytes(3).toString('hex')}`,
  );
  fs.writeFileSync(backup, current.bytes, { mode: 0o600, flag: 'wx' });
  const backups = fs
    .readdirSync(backupDir)
    .filter((f) => f.startsWith(`${base}.`))
    .sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - keep)))
    fs.rmSync(path.join(backupDir, old), { force: true });

  const dir = path.dirname(hostPath);
  const tmp = path.join(
    dir,
    `.${base}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, exportedBytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, hostPath);
  try {
    const dfd = fs.openSync(dir, 'r');
    fs.fsyncSync(dfd);
    fs.closeSync(dfd);
  } catch {
    // Directory fsync is best effort.
  }
  return { outcome: 'host-replaced', backup };
}

/**
 * The teardown export decision for mode B, given the exporter's result.
 * `exported` is `{ bytes }` or `{ error: code }`.
 */
export function decideWriteBack({
  provider,
  original,
  exported,
  hostPath,
  backupDir,
}) {
  if (exported.error != null)
    return { outcome: 'failed', reason: exported.error, haltProvider: true };
  const v = validateExport(provider, original.bytes, exported.bytes);
  if (!v.ok) return { outcome: 'failed', reason: v.reason, haltProvider: true };
  if (!v.refreshChanged) return { outcome: 'unchanged', haltProvider: false };
  const r = casWriteBack({
    hostPath,
    originalSha256: original.sha256,
    exportedBytes: exported.bytes,
    backupDir,
  });
  return { ...r, haltProvider: r.outcome !== 'host-replaced' };
}

/**
 * Non-secret state of a mode-B attempt, written at attempt start so that a
 * crashed runner can still export and write back (section 4.6, crash
 * recovery): the structure of the original, its file digest and the digest
 * of its refresh token. No secret value is stored.
 */
export function recoveryState(provider, original) {
  const doc = parseJson(original.bytes);
  const refresh =
    doc === undefined
      ? undefined
      : getPath(doc, PROVIDERS[provider].refreshToken);
  return {
    provider,
    originalSha256: original.sha256,
    shape: doc === undefined ? null : shapeOf(doc),
    refreshSha256: typeof refresh === 'string' ? sha256(refresh) : null,
  };
}

export function decideRecoveryWriteBack({
  state,
  exported,
  hostPath,
  backupDir,
}) {
  if (exported.error != null)
    return { outcome: 'failed', reason: exported.error, haltProvider: true };
  const doc = parseJson(exported.bytes);
  if (doc === undefined)
    return { outcome: 'failed', reason: 'invalid-json', haltProvider: true };
  if (JSON.stringify(shapeOf(doc)) !== JSON.stringify(state.shape))
    return { outcome: 'failed', reason: 'shape-mismatch', haltProvider: true };
  const refresh = getPath(doc, PROVIDERS[state.provider].refreshToken);
  if (typeof refresh !== 'string' || refresh.length === 0)
    return {
      outcome: 'failed',
      reason: 'no-refresh-token',
      haltProvider: true,
    };
  if (sha256(refresh) === state.refreshSha256)
    return { outcome: 'unchanged', haltProvider: false };
  const r = casWriteBack({
    hostPath,
    originalSha256: state.originalSha256,
    exportedBytes: exported.bytes,
    backupDir,
  });
  return { ...r, haltProvider: r.outcome !== 'host-replaced' };
}
