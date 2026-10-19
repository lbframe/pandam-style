/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Gate self-check fixture, not a product change:
//
//   node make-candidate.mjs <alpha1 closure> <dest closure>
//
// Builds a candidate closure identical to alpha1 except for a deliberately
// slower @pandamstyle/compiler: initialize, validate, compile and
// applyChanges each busy-wait for 30% of their own duration. Every other
// package is a symlink to the alpha1 closure. The gate must fail it.

import fs from 'node:fs';
import path from 'node:path';

const [source, dest] = process.argv.slice(2).map((p) => path.resolve(p));
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(path.join(dest, 'node_modules/@pandamstyle'), { recursive: true });
for (const file of ['package.json', 'package-lock.json'])
  fs.copyFileSync(path.join(source, file), path.join(dest, file));
const modules = path.join(source, 'node_modules');
for (const entry of fs.readdirSync(modules))
  if (entry !== '@pandamstyle')
    fs.symlinkSync(
      path.join(modules, entry),
      path.join(dest, 'node_modules', entry),
    );
for (const entry of fs.readdirSync(path.join(modules, '@pandamstyle'))) {
  const from = path.join(modules, '@pandamstyle', entry);
  const to = path.join(dest, 'node_modules/@pandamstyle', entry);
  if (entry === 'compiler') fs.cpSync(from, to, { recursive: true });
  else fs.symlinkSync(from, to);
}
const index = path.join(
  dest,
  'node_modules/@pandamstyle/compiler/lib/index.mjs',
);
const text = fs.readFileSync(index, 'utf8');
const exportLine = /export \{([^}]*)\bcreateProjectSession\b([^}]*)\};\s*$/;
if (!exportLine.test(text)) throw new Error('unexpected compiler export shape');
fs.writeFileSync(
  index,
  text.replace(
    exportLine,
    'export {$1__slowCreateProjectSession as createProjectSession$2};\n',
  ) +
    `
// CE-00.3 gate self-check: injected slowdown of 30% per session call.
function __slowCreateProjectSession(config) {
  const session = createProjectSession(config);
  const slowed = new Set(['initialize', 'validate', 'compile', 'applyChanges']);
  const spin = (ms) => {
    const end = performance.now() + ms;
    while (performance.now() < end);
  };
  // The session is frozen; return a copy whose slowed methods wrap the
  // originals (session methods do not depend on \`this\`).
  const wrapped = {};
  for (const key of Reflect.ownKeys(session)) {
    const value = session[key];
    wrapped[key] =
      typeof value === 'function' && slowed.has(key)
        ? async (...args) => {
            const start = performance.now();
            const result = await value(...args);
            spin(0.3 * (performance.now() - start));
            return result;
          }
        : value;
  }
  return Object.freeze(wrapped);
}
`,
);
console.log(`slowed candidate closure written to ${dest}`);
