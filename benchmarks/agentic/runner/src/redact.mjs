/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Redaction (DESIGN.md sections 4.6 step 7 and 6.4). The redaction set holds
// the exact secret values of the original and the exported credential, in raw,
// JSON-escaped, base64 and URL-encoded forms; token patterns and the host
// user's home path and name are redacted too. It must be complete before any
// artifact of an attempt is persisted.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MIN_SECRET_LENGTH = 16;
const SECRET_KEY = /token|secret|key|password|credential|auth|session/i;

const PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g,
];

export const MARKER = '[REDACTED]';

/** Leaf string values of a credential document that may be secrets. */
export function secretLeaves(doc, keyPath = []) {
  const out = [];
  if (typeof doc === 'string') {
    const key = keyPath.at(-1) ?? '';
    if (doc.length >= MIN_SECRET_LENGTH || SECRET_KEY.test(String(key)))
      if (doc.length >= 8) out.push(doc);
    return out;
  }
  if (Array.isArray(doc))
    doc.forEach((v, i) => out.push(...secretLeaves(v, [...keyPath, i])));
  else if (doc != null && typeof doc === 'object')
    for (const [k, v] of Object.entries(doc))
      out.push(...secretLeaves(v, [...keyPath, k]));
  return out;
}

export function encodings(secret) {
  const forms = new Set([secret]);
  forms.add(JSON.stringify(secret).slice(1, -1));
  forms.add(Buffer.from(secret).toString('base64'));
  forms.add(Buffer.from(secret).toString('base64url'));
  forms.add(encodeURIComponent(secret));
  return [...forms].filter((f) => f.length >= 8);
}

export class RedactionSet {
  /**
   * `parent`: a longer-lived set (the matrix's) that receives every secret
   * the moment it is learned, so that any later persistence, including
   * error messages on exceptional exits, is redacted with it (section 4.6).
   */
  constructor({
    home = os.homedir(),
    user = os.userInfo().username,
    parent = null,
  } = {}) {
    this.secrets = new Set();
    this.home = home;
    this.user = user;
    this.parent = parent;
    this.sealed = false;
  }

  addSecret(value) {
    if (this.sealed) throw new Error('redaction set already sealed');
    if (typeof value === 'string' && value.length >= 8) {
      for (const form of encodings(value)) this.secrets.add(form);
      this.parent?.addKnown(value);
    }
  }

  /** Adds a secret learned elsewhere; never sealed (matrix-level sets). */
  addKnown(value) {
    if (typeof value === 'string' && value.length >= 8)
      for (const form of encodings(value)) this.secrets.add(form);
  }

  addCredentialDocument(text) {
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      // Not JSON (for example a bare token): the whole value is the secret.
      this.addSecret(String(text).trim());
      return;
    }
    for (const leaf of secretLeaves(doc)) this.addSecret(leaf);
  }

  /** No more secrets may be added once artifacts start being persisted. */
  seal() {
    this.sealed = true;
  }

  list() {
    return [...this.secrets].sort((a, b) => b.length - a.length);
  }

  redactText(text) {
    let out = String(text);
    for (const s of this.list()) out = out.split(s).join(MARKER);
    for (const re of PATTERNS) out = out.replace(re, MARKER);
    if (this.home && this.home.length > 1) out = out.split(this.home).join('~');
    // The user name in home-directory paths of any form (`/home/<user>`,
    // `/Users/<user>`); a word or a repository directory that merely equals
    // the name (a CI user called `runner`) is left intact.
    if (this.user && this.user.length > 2)
      out = out.replace(
        new RegExp(
          `/(home|Users|var/home)/${escapeRe(this.user)}(?=/|$|[^A-Za-z0-9_.-])`,
          'gm',
        ),
        '/$1/<user>',
      );
    return out;
  }

  /** Returns the findings of a scan of persisted text. */
  scanText(text, { patterns = true } = {}) {
    const findings = [];
    for (const s of this.list()) if (text.includes(s)) findings.push('secret');
    if (!patterns) return findings;
    for (const re of PATTERNS) {
      re.lastIndex = 0;
      if (re.test(text)) findings.push(`pattern:${re.source.slice(0, 12)}`);
    }
    return findings;
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Patterns need at most this many bytes of context across a chunk border.
const PATTERN_OVERLAP = 4096;

/** Scans one file in bounded chunks; returns whether anything was found. */
export function scanFile(file, redaction, { patterns = true } = {}) {
  const secrets = redaction.list().map((x) => Buffer.from(x));
  const overlap = Math.max(PATTERN_OVERLAP, ...secrets.map((b) => b.length));
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buf = Buffer.alloc(1 << 20);
    let tail = Buffer.alloc(0);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) return false;
      const window = Buffer.concat([tail, buf.subarray(0, n)]);
      if (secrets.some((b) => window.includes(b))) return true;
      if (patterns) {
        const text = window.toString('latin1');
        for (const re of PATTERNS) {
          re.lastIndex = 0;
          if (re.test(text)) return true;
        }
      }
      tail = window.subarray(Math.max(0, window.length - overlap));
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Post-write scan of an attempt directory: any artifact still containing a
 * secret or a token pattern is deleted and reported. Evidence blobs are
 * workspace bytes: only exact secrets are searched there, since a pattern
 * match in project content is not a credential. Files are read in bounded
 * chunks.
 */
export function scanAndPurge(dir, redaction) {
  const removed = [];
  function rec(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) rec(abs);
      else if (entry.isFile()) {
        const evidenceBlob = abs.split(path.sep).includes('blobs');
        if (scanFile(abs, redaction, { patterns: !evidenceBlob })) {
          fs.rmSync(abs);
          removed.push(path.relative(dir, abs));
        }
      }
    }
  }
  if (fs.existsSync(dir)) rec(dir);
  return removed;
}
