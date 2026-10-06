/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import net from 'node:net';
import { createHash } from 'node:crypto';

// Output exclusion only: no compiler state or canonical artifact identity.
// Linux abstract Unix sockets are OS-held and disappear on process death.
// Their full output-path hash avoids the old finite TCP-port collision domain.
// Other platforms retain the conservative Phase 10 TCP fallback.
export async function acquireProcessOutputLease(canonicalOutput) {
  const hash = createHash('sha256').update(canonicalOutput).digest('hex');
  const port = 10000 + (parseInt(hash.slice(0, 8), 16) % 20000);
  const address =
    process.platform === 'linux'
      ? { path: '\0pandamstyle-output-' + hash, exclusive: true }
      : { host: '127.0.0.1', port, exclusive: true };
  const server = net.createServer((socket) => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, resolve);
    });
    server.unref();
  } catch (error) {
    server.close();
    throw error;
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
