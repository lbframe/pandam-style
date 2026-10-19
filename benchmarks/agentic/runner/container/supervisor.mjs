/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Container supervisor (DESIGN.md section 4.6). Runs under the container's
// init (docker --init reaps orphans) as the harness UID, so agent-UID
// processes cannot signal it, and keeps the container (and its tmpfs) alive
// until the runner has exported the credential and removed the container.

setInterval(() => {}, 1 << 30);
process.on('SIGTERM', () => process.exit(0));
