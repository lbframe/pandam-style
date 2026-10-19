/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Credential exporter (DESIGN.md section 4.6 step 3): O_NOFOLLOW, regular
// file only, at most 64 KiB; writes base64 on stdout or an error code on
// stderr with exit 3. Runs after every agent-UID process was killed.

import fs from 'node:fs';

const file = process.argv[2];
const MAX = 64 * 1024;
let fd;
try {
  fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
} catch (error) {
  process.stderr.write(
    error.code === 'ELOOP'
      ? 'symlink'
      : error.code === 'ENOENT'
        ? 'missing'
        : 'open-failed',
  );
  process.exit(3);
}
const st = fs.fstatSync(fd);
if (!st.isFile()) {
  process.stderr.write('not-regular');
  process.exit(3);
}
if (st.size > MAX) {
  process.stderr.write('oversize');
  process.exit(3);
}
const buf = Buffer.alloc(st.size);
fs.readSync(fd, buf, 0, st.size, 0);
process.stdout.write(buf.toString('base64'));
