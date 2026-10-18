/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Private files (the redaction key, position maps) must stay outside the
// repository. Containment is decided on real paths with proper boundary
// semantics, so `<repo>/..private` is inside and a symlink cannot redirect a
// private file into the repository.

import fs from 'node:fs';
import path from 'node:path';

function lexists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Real path of a file or, for a new file, of its nearest existing parent. */
export function realPathOf(file) {
  let current = path.resolve(file);
  const rest = [];
  while (!lexists(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    rest.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...rest);
}

export function isOutside(file, root) {
  const relative = path.relative(fs.realpathSync(root), realPathOf(file));
  return (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}

/** Returns the resolved file; throws if it is inside `root` or a symlink. */
export function privateFile(file, root, name = 'file') {
  const resolved = path.resolve(file);
  if (lexists(resolved) && fs.lstatSync(resolved).isSymbolicLink())
    throw new Error(`--${name} must not be a symbolic link`);
  if (!isOutside(resolved, root))
    throw new Error(`--${name} must be outside the repository`);
  return resolved;
}
