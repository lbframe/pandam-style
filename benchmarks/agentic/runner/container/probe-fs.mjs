/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Isolation self-test filesystem and privilege probe. Prints one JSON object.
// Usage: probe-fs.mjs '{"write":["/workspace/a"],"rename":[["src","dst"]],"remove":["p"],"exists":["/node_modules"]}'

import fs from 'node:fs';

const spec = JSON.parse(process.argv[2] ?? '{}');
const out = { write: {}, rename: {}, remove: {}, exists: {} };
const status = fs.readFileSync('/proc/self/status', 'utf8');
out.uid = Number(/^Uid:\s+(\d+)/m.exec(status)[1]);
out.capEff = /^CapEff:\s+([0-9a-f]+)/m.exec(status)[1];
out.noNewPrivs = /^NoNewPrivs:\s+(\d)/m.exec(status)[1];
for (const p of spec.write ?? []) {
  try {
    fs.appendFileSync(p, 'x');
    out.write[p] = 'allowed';
  } catch (e) {
    out.write[p] = e.code;
  }
}
for (const [a, b] of spec.rename ?? []) {
  try {
    fs.writeFileSync(a, 'y');
    fs.renameSync(a, b);
    out.rename[b] = 'allowed';
  } catch (e) {
    out.rename[b] = e.code;
  }
}
for (const p of spec.remove ?? []) {
  try {
    fs.rmSync(p);
    out.remove[p] = 'allowed';
  } catch (e) {
    out.remove[p] = e.code;
  }
}
for (const p of spec.exists ?? []) out.exists[p] = fs.existsSync(p);
out.modes = {};
for (const p of spec.modes ?? []) {
  try {
    const st = fs.statSync(p);
    out.modes[p] = `${(st.mode & 0o777).toString(8)}:${st.uid}`;
  } catch (e) {
    out.modes[p] = e.code;
  }
}
process.stdout.write(`${JSON.stringify(out)}\n`);
