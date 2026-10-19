/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The pinned compat data, loaded once and only when a target is evaluated.
 *
 * The bytes are compiler-owned generated data
 * (`tools/targets/build-compat-data.mjs`): the BCD 8.1.6 statements CE-00.1
 * pins, restricted to what the compiler can emit, and bundled with the
 * compiler. The digest is taken over the exact bytes, so every resolution
 * record names the data it was computed from.
 */

import crypto from 'crypto';
// Resolved by the compiler build: the generated JSON travels as one shared
// asset next to the bundles and this import returns its text.
import compatDataText from 'pandamstyle:compat-data';

let cache = null;

function indexChildren(paths) {
  const children = new Map();
  for (const key of paths) {
    const cut = key.lastIndexOf('.');
    if (cut === -1) continue;
    const parent = key.slice(0, cut);
    const name = key.slice(cut + 1);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(name);
  }
  return children;
}

const QUOTE = 34;
const BACKSLASH = 92;
const OPEN_BRACE = 123;
const CLOSE_BRACE = 125;
const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;
const COLON = 58;
const COMMA = 44;

/** Index just past the JSON string starting at `start` (a quote). */
function skipString(text, start) {
  for (let i = start + 1; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === BACKSLASH) i += 1;
    else if (code === QUOTE) return i + 1;
  }
  return -1;
}

/** Index just past the JSON object or array starting at `start`. */
function skipComposite(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === QUOTE) {
      i = skipString(text, i) - 1;
      if (i < 0) return -1;
    } else if (code === OPEN_BRACE || code === OPEN_BRACKET) depth += 1;
    else if (code === CLOSE_BRACE || code === CLOSE_BRACKET) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function skipSpace(text, i) {
  while (i < text.length && text.charCodeAt(i) <= 32) i += 1;
  return i;
}

// A path key: the data holds `css.*` paths only, and no value holds a string
// starting with `css.` followed by an object, so these matches are exactly
// the keys of `paths`.
const PATH_KEY = /"(css\.[^"\\]*)":\{/g;

/**
 * Locates every entry of the `paths` object without parsing it: path -> the
 * [start, end) of its value. Returns null when the text is not shaped as
 * expected, and the caller parses it whole instead.
 */
function scanPaths(text) {
  const key = text.indexOf('"paths"');
  if (key === -1) return null;
  let i = skipSpace(text, key + 7);
  if (text.charCodeAt(i) !== COLON) return null;
  i = skipSpace(text, i + 1);
  if (text.charCodeAt(i) !== OPEN_BRACE) return null;
  const objectStart = i;
  const starts = [];
  PATH_KEY.lastIndex = objectStart;
  for (let match; (match = PATH_KEY.exec(text)) != null; ) {
    starts.push([match[1], match.index, PATH_KEY.lastIndex - 1]);
  }
  if (starts.length === 0) return null;
  const offsets = new Map();
  for (let k = 0; k < starts.length; k += 1) {
    const [path, , valueStart] = starts[k];
    // A value ends at the comma before the next key, or for the last one at
    // the end of its own braces, which must also close `paths`.
    let valueEnd;
    if (k + 1 < starts.length) {
      valueEnd = starts[k + 1][1];
      while (text.charCodeAt(valueEnd - 1) <= 32) valueEnd -= 1;
      if (text.charCodeAt(valueEnd - 1) !== COMMA) return null;
      valueEnd -= 1;
      while (text.charCodeAt(valueEnd - 1) <= 32) valueEnd -= 1;
      if (text.charCodeAt(valueEnd - 1) !== CLOSE_BRACE) return null;
    } else {
      valueEnd = skipComposite(text, valueStart);
      if (valueEnd === -1) return null;
    }
    offsets.set(path, [valueStart, valueEnd]);
  }
  const last = starts.at(-1);
  const close = skipSpace(text, offsets.get(last[0])[1]);
  if (text.charCodeAt(close) !== CLOSE_BRACE) return null;
  return { offsets, objectStart, objectEnd: close + 1 };
}

/**
 * The data, parsed lazily: an evaluation reads the few paths its emitted CSS
 * uses, so entries are located once and each is parsed on first use. The
 * digest is still taken over the exact bytes.
 */
function load(text) {
  const scanned = scanPaths(text);
  const raw =
    scanned == null
      ? JSON.parse(text)
      : JSON.parse(
          text.slice(0, scanned.objectStart) +
            '{}' +
            text.slice(scanned.objectEnd),
        );
  if (
    raw.kind !== 'pandamstyle-compat-data' ||
    raw.schemaVersion !== 1 ||
    raw.paths == null
  ) {
    throw new Error('pandamstyle: the bundled compat data is not schema 1.');
  }
  const offsets =
    scanned == null
      ? new Map(Object.keys(raw.paths).map((path) => [path, null]))
      : scanned.offsets;
  const parsed = new Map();
  const entry = (bcdPath) => {
    if (!offsets.has(bcdPath)) return null;
    let value = parsed.get(bcdPath);
    if (value === undefined) {
      const span = offsets.get(bcdPath);
      value =
        span == null
          ? raw.paths[bcdPath]
          : JSON.parse(text.slice(span[0], span[1]));
      parsed.set(bcdPath, value);
    }
    return value;
  };
  let children = null;
  return Object.freeze({
    sources: raw.sources,
    digest: 'sha256:' + crypto.createHash('sha256').update(text).digest('hex'),
    has: (bcdPath) => offsets.has(bcdPath),
    entry,
    childrenOf: (bcdPath) => {
      children ??= indexChildren(offsets.keys());
      return children.get(bcdPath) ?? [];
    },
    /**
     * Whether the entry's raw text contains `needle`, without parsing it. A
     * cheap pre-check for scans that look for one name among many entries.
     */
    mentions: (bcdPath, needle) => {
      if (!offsets.has(bcdPath)) return false;
      const span = offsets.get(bcdPath);
      return span == null
        ? JSON.stringify(raw.paths[bcdPath]).includes(needle)
        : text.slice(span[0], span[1]).includes(needle);
    },
    /** [path, entry] in file order for entries recording an alternative name. */
    alternativeNameEntries: () => {
      const out = [];
      for (const [path, span] of offsets) {
        const recordsName =
          span == null
            ? JSON.stringify(raw.paths[path]).includes('"n":')
            : text.slice(span[0], span[1]).includes('"n":');
        if (recordsName) out.push([path, entry(path)]);
      }
      return out;
    },
  });
}

/** The bundled data. */
export function compatData() {
  if (cache == null) cache = load(compatDataText());
  return cache;
}

/** Test seam: the same loader over other bytes, never installed globally. */
export function compatDataFromText(text) {
  return load(text);
}
