/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BRIDGE_VERSION,
  CEILINGS,
  DESCRIPTOR_BOUNDS,
  validFrame,
} from './frames.js';
import { AGENT_PROTOCOL_VERSION } from '../../protocol/envelope.js';
import { stringBytes } from '../schema.js';

/**
 * AG-02.1 names, descriptor and key (§3.4). The descriptor is discovery data:
 * it holds no secret and grants nothing. The key file is the credential. The
 * endpoint name is derived; a descriptor naming anything else is invalid.
 */

export const h16 = (text) =>
  crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

export const nameOf = (rootDir, outDir) => `${h16(rootDir)}-${h16(outDir)}`;
export const rootPrefixOf = (rootDir) => `${h16(rootDir)}-`;
export const endpointOf = (name) => `${name}.sock`;
export const keyIdOf = (keyText) => h16(keyText);

let version;
/** The installed compiler version, or `null` when it cannot be read. */
export function compilerVersion() {
  if (version !== undefined) return version;
  version = null;
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 6; depth += 1) {
      const file = path.join(dir, 'package.json');
      if (fs.existsSync(file)) {
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (manifest?.name === '@pandamstyle/compiler') {
          const value = manifest.version;
          version =
            typeof value === 'string' &&
            stringBytes(value) <= DESCRIPTOR_BOUNDS.compilerVersion
              ? value
              : null;
          break;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    version = null;
  }
  return version;
}

export function buildDescriptor({
  projectId,
  sessionId,
  rootDir,
  outDir,
  keyText,
  host,
  pid = process.pid,
  createdAt = new Date().toISOString(),
  version = compilerVersion(),
}) {
  const name = nameOf(rootDir, outDir);
  return {
    format: 'pandamstyle-owner-descriptor',
    formatVersion: 1,
    bridgeVersions: [BRIDGE_VERSION],
    protocolVersions: [AGENT_PROTOCOL_VERSION],
    projectId,
    sessionId,
    rootDir,
    outDir,
    endpoint: endpointOf(name),
    keyId: keyIdOf(keyText),
    owner: { kind: 'attached', host, pid },
    compilerVersion: version,
    createdAt,
  };
}

/** `null` when `value` is a valid descriptor for `name`, else the reason. */
export function descriptorProblem(value, name) {
  if (!validFrame('descriptor', value)) return 'descriptor-invalid';
  if (nameOf(value.rootDir, value.outDir) !== name) return 'descriptor-invalid';
  if (value.endpoint !== endpointOf(name)) return 'descriptor-invalid';
  if (!/^[0-9a-f]{16}$/.test(value.keyId)) return 'descriptor-invalid';
  return null;
}

/** Reads and checks `name.json` through the runtime directory handle. */
export function readDescriptor(handle, name) {
  const { missing, bytes } = handle.read(`${name}.json`, CEILINGS.descriptor);
  if (missing) return { problem: 'owner-absent' };
  if (bytes == null) return { problem: 'descriptor-invalid' };
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { problem: 'descriptor-invalid' };
  }
  const problem = descriptorProblem(value, name);
  return problem == null ? { descriptor: value } : { problem };
}

/** The key file: exactly 44 bytes of base64 for 32 bytes. */
export function readKey(handle, name) {
  const { bytes } = handle.read(`${name}.key`, CEILINGS.key);
  if (bytes == null || bytes.length !== CEILINGS.key) return null;
  const text = bytes.toString('latin1');
  if (!/^[A-Za-z0-9+/]{43}=$/.test(text)) return null;
  return { text, bytes: Buffer.from(text, 'base64') };
}
