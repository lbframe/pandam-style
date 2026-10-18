/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Deterministic, dependency-free glob matching for permitted-write policies.
// Supported syntax: `**` (any number of path segments), `*` (within one
// segment), `?` (one character within a segment) and `{a,b}` alternatives.
// Paths are POSIX, relative to the workspace root, without a leading `./`.

function escapeRegex(char) {
  return /[.+^$()|[\]\\]/.test(char) ? `\\${char}` : char;
}

export function globToRegExp(glob) {
  if (
    glob.startsWith('/') ||
    glob.startsWith('./') ||
    glob.split('/').includes('..')
  ) {
    throw new Error(`Glob must be workspace-relative and normalized: ${glob}`);
  }
  let out = '';
  let i = 0;
  let braceDepth = 0;
  while (i < glob.length) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        const atSegmentStart = i === 0 || glob[i - 1] === '/';
        const followedBySlash = glob[i + 2] === '/';
        if (atSegmentStart && followedBySlash) {
          out += '(?:[^/]+/)*';
          i += 3;
          continue;
        }
        if (atSegmentStart && i + 2 === glob.length) {
          out += '.*';
          i += 2;
          continue;
        }
        throw new Error(`'**' must be a whole path segment in ${glob}`);
      }
      out += '[^/]*';
    } else if (char === '?') {
      out += '[^/]';
    } else if (char === '{') {
      braceDepth += 1;
      out += '(?:';
    } else if (char === '}' && braceDepth > 0) {
      braceDepth -= 1;
      out += ')';
    } else if (char === ',' && braceDepth > 0) {
      out += '|';
    } else {
      out += escapeRegex(char);
    }
    i += 1;
  }
  if (braceDepth !== 0) throw new Error(`Unbalanced braces in ${glob}`);
  return new RegExp(`^${out}$`, 'u');
}

export function compileGlobs(globs) {
  const compiled = globs.map((glob) => [glob, globToRegExp(glob)]);
  return {
    match(relPath) {
      return compiled.find(([, re]) => re.test(relPath))?.[0] ?? null;
    },
  };
}

export function matchesAny(globs, relPath) {
  return compileGlobs(globs).match(relPath) != null;
}
