/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Pure judgement of reference-check measurements, shared by the checker
// (check-references.mjs), which measures in Chromium, and the validator
// (validate-corpus.mjs), which recomputes every verdict from the recorded
// measurement. Each result kind has a strict measurement shape; a verdict is
// never read from the report.

export const TOLERANCE = 0.5;
// A focus indicator must change at least this many pixels in the indicator
// ring around the focused element (a text caret alone changes fewer).
export const INDICATOR_MIN_PIXELS = 40;

// Result kinds that the reference page cannot evaluate, with their reason.
export const NOT_EVALUATED_KINDS = Object.freeze({
  forcedColorsVisible: 'needs-forced-colors-pixel-comparison',
  sameBoxAsReference: 'compares-a-build-with-the-reference',
  computedUnchanged: 'compares-a-build-with-the-reference',
});
// The only assertions allowed to stay not evaluated.
export const NOT_EVALUATED_ASSERTIONS = Object.freeze([
  'SHELL-A4',
  'FORMS-A3',
  'NOTICES-A4',
  'GRID-A3',
  'MEDIA-A3',
  'STATES-A3',
  'MEDIA-L4',
  'SSR-L3',
  'SSR-S1',
]);

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const int = (v) => Number.isInteger(v) && v >= 0;
const bool = (v) => typeof v === 'boolean';
const str = (v, max = 512) => typeof v === 'string' && v.length <= max;
const obj = (v, keys) =>
  v != null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => k in v);
const pair = (v) => Array.isArray(v) && v.length === 2 && v.every(num);
const near = (a, b) => Math.abs(a - b) <= TOLERANCE;

const STYLE_KEYS = [
  'outlineStyle',
  'outlineWidth',
  'outlineOffset',
  'outlineColor',
  'boxShadow',
  'borders',
];
const style = (v) =>
  obj(v, STYLE_KEYS) &&
  STYLE_KEYS.slice(0, 5).every((k) => str(v[k])) &&
  Array.isArray(v.borders) &&
  v.borders.length === 4 &&
  v.borders.every(
    (b) =>
      obj(b, ['style', 'width', 'color']) &&
      str(b.style) &&
      str(b.width) &&
      str(b.color),
  );
const stop = (v) =>
  obj(v, ['focused', 'unfocused', 'changedRingPixels']) &&
  Array.isArray(v.focused) &&
  v.focused.length >= 1 &&
  v.focused.length <= 2 &&
  Array.isArray(v.unfocused) &&
  v.unfocused.length === v.focused.length &&
  v.focused.every(style) &&
  v.unfocused.every(style) &&
  int(v.changedRingPixels);
const computedValues = (v) =>
  Array.isArray(v) &&
  v.length >= 1 &&
  v.every(
    (e) =>
      e != null &&
      typeof e === 'object' &&
      !Array.isArray(e) &&
      Object.values(e).every((x) => str(x)),
  );

/** Strict measurement shape per result kind. */
export const MEASUREMENT_SHAPES = Object.freeze({
  box: (v) => obj(v, ['width', 'height']) && num(v.width) && num(v.height),
  minBox: (v) => obj(v, ['width', 'height']) && num(v.width) && num(v.height),
  maxBox: (v) => obj(v, ['width', 'height']) && num(v.width) && num(v.height),
  noHorizontalOverflow: (v) =>
    obj(v, ['scrollWidth', 'clientWidth']) &&
    int(v.scrollWidth) &&
    int(v.clientWidth),
  scrollable: (v) => obj(v, ['x', 'y']) && bool(v.x) && bool(v.y),
  stuckAfterScroll: (v) =>
    obj(v, ['scrolled', 'offset']) && num(v.scrolled) && num(v.offset),
  fixedToViewport: (v) =>
    obj(v, ['right', 'bottom']) && num(v.right) && num(v.bottom),
  topmostAt: (v) =>
    obj(v, ['hit', 'scrolled']) && bool(v.hit) && pair(v.scrolled),
  columns: int,
  edgeOffset: num,
  lineCount: int,
  preservesBreaks: (v) =>
    obj(v, ['lines', 'authorBreaksHonored']) &&
    int(v.lines) &&
    Array.isArray(v.authorBreaksHonored) &&
    v.authorBreaksHonored.every(bool),
  balancedLines: (v) =>
    obj(v, ['lines', 'ratio']) && int(v.lines) && num(v.ratio),
  truncated: (v) =>
    obj(v, ['overflow', 'textOverflow']) &&
    bool(v.overflow) &&
    str(v.textOverflow, 32),
  noOverflow: (v) =>
    obj(v, ['scrollWidth', 'clientWidth', 'textRight', 'right']) &&
    int(v.scrollWidth) &&
    int(v.clientWidth) &&
    num(v.textRight) &&
    num(v.right),
  writingMode: (v) => str(v, 32),
  direction: (v) => str(v, 8),
  computed: computedValues,
  animationNone: (v) =>
    Array.isArray(v) && v.length >= 1 && v.every((x) => str(x, 64)),
  focusOrder: (v) =>
    Array.isArray(v) && v.length >= 1 && v.every((x) => str(x, 64)),
  focusVisible: (v) => Array.isArray(v) && v.length >= 1 && v.every(bool),
  paintedIndicator: (v) => Array.isArray(v) && v.length >= 1 && v.every(stop),
  activates: (v) =>
    obj(v, ['checked', 'computed']) &&
    bool(v.checked) &&
    computedValues([v.computed]),
  scrollsWithKeys: (v) =>
    obj(v, ['focused', 'before', 'after']) &&
    (v.focused === null || str(v.focused, 64)) &&
    pair(v.before) &&
    pair(v.after),
  role: (v) => str(v, 64),
  name: (v) => str(v, 256),
  contrastMin: (v) =>
    obj(v, ['fg', 'bg', 'image']) &&
    Array.isArray(v.fg) &&
    v.fg.length === 3 &&
    v.fg.every(num) &&
    Array.isArray(v.bg) &&
    v.bg.length === 3 &&
    v.bg.every(num) &&
    bool(v.image),
  targetSizeMin: (v) =>
    obj(v, ['width', 'height']) && num(v.width) && num(v.height),
  visuallyHiddenButExposed: (v) =>
    obj(v, ['width', 'height', 'ignored']) &&
    num(v.width) &&
    num(v.height) &&
    bool(v.ignored),
  violations: (v) => Array.isArray(v) && v.every((x) => str(x, 256)),
  styleElements: int,
  styleAttributes: int,
  runtimeStyleInsertions: int,
  inlineCustomProperties: int,
  completeFirstPaint: (v) =>
    obj(v, ['links', 'loaded', 'scripts']) &&
    int(v.links) &&
    int(v.loaded) &&
    int(v.scripts),
});

function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// Alpha of a computed CSS color; 0 for transparent, null when unknown.
export function colorAlpha(color) {
  const c = color.trim().toLowerCase();
  if (c === 'transparent') return 0;
  const rgb = /^rgba?\(([^)]*)\)$/.exec(c);
  if (rgb == null) return null;
  const parts = rgb[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length === 3) return 1;
  if (parts.length === 4) return parseFloat(parts[3]);
  return null;
}

// Splits a computed box-shadow list at top-level commas.
function shadows(value) {
  if (value === 'none') return [];
  const out = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out.map((s) => {
    const color = /(rgba?\([^)]*\)|transparent)/.exec(s)?.[1] ?? '';
    const lengths = s
      .replace(color, '')
      .replace('inset', '')
      .trim()
      .split(/\s+/)
      .map((x) => parseFloat(x))
      .filter((x) => Number.isFinite(x));
    return { color, lengths };
  });
}

/** Extent in px of a style's indicator outside the border box. */
export function indicatorExtent(s) {
  const outline = ['none', 'hidden'].includes(s.outlineStyle)
    ? 0
    : parseFloat(s.outlineWidth) + Math.max(0, parseFloat(s.outlineOffset));
  const shadow = Math.max(
    0,
    ...shadows(s.boxShadow).map(
      ({ lengths: [x = 0, y = 0, blur = 0, spread = 0] }) =>
        Math.abs(x) + Math.abs(y) + blur + Math.max(0, spread),
    ),
  );
  return Math.max(0, outline, shadow);
}

// A visible indicator on one node: a non-transparent outline of non-zero
// width, a visible box shadow that focus added or changed, or a changed
// non-transparent border side of non-zero width.
export function visibleIndicator(focused, unfocused) {
  const outline =
    !['none', 'hidden'].includes(focused.outlineStyle) &&
    parseFloat(focused.outlineWidth) > 0 &&
    (colorAlpha(focused.outlineColor) ?? 0) > 0;
  const shadow =
    focused.boxShadow !== unfocused.boxShadow &&
    shadows(focused.boxShadow).some(
      ({ color, lengths: [x = 0, y = 0, blur = 0, spread = 0] }) =>
        (colorAlpha(color) ?? 0) > 0 &&
        (x !== 0 || y !== 0 || blur > 0 || spread > 0),
    );
  const border = focused.borders.some((b, i) => {
    const u = unfocused.borders[i];
    return (
      (b.style !== u.style || b.width !== u.width || b.color !== u.color) &&
      !['none', 'hidden'].includes(b.style) &&
      parseFloat(b.width) > 0 &&
      (colorAlpha(b.color) ?? 0) > 0
    );
  });
  return outline || shadow || border;
}

export function stopOk(s) {
  return (
    s.focused.some((f, i) => visibleIndicator(f, s.unfocused[i])) &&
    s.changedRingPixels >= INDICATOR_MIN_PIXELS
  );
}

/** Verdict of one result from its measurement and the expectation. */
export function judge(kind, want, measured) {
  switch (kind) {
    case 'box':
      return Object.entries(want).every(([d, v]) => near(measured[d], v));
    case 'minBox':
      return Object.entries(want).every(
        ([d, v]) => measured[d] >= v - TOLERANCE,
      );
    case 'maxBox':
      return Object.entries(want).every(
        ([d, v]) => measured[d] <= v + TOLERANCE,
      );
    case 'noHorizontalOverflow':
      return measured.scrollWidth <= measured.clientWidth + 1;
    case 'scrollable':
      return want === 'both'
        ? measured.x && measured.y
        : measured[want] === true;
    case 'stuckAfterScroll':
      return measured.scrolled > 0 && near(measured.offset, want.value);
    case 'fixedToViewport':
      return (
        near(measured.right, want.right) && near(measured.bottom, want.bottom)
      );
    case 'topmostAt':
      return measured.hit === true;
    case 'columns':
      return measured === want;
    case 'edgeOffset':
      return near(measured, want.value);
    case 'lineCount':
      return typeof want === 'number'
        ? measured === want
        : measured >= want.min;
    case 'preservesBreaks':
      return (
        measured.lines >= want.minLines &&
        measured.authorBreaksHonored.length > 0 &&
        measured.authorBreaksHonored.every(Boolean)
      );
    case 'balancedLines':
      return measured.lines > 1 && measured.ratio >= 0.6;
    case 'truncated':
      return measured.overflow === want && measured.textOverflow === 'ellipsis';
    case 'noOverflow':
      return (
        measured.scrollWidth <= measured.clientWidth + 1 &&
        measured.textRight <= measured.right + 1
      );
    case 'writingMode':
    case 'direction':
      return measured === want;
    case 'computed':
      return measured.every((values) =>
        Object.entries(want).every(([p, v]) => values[p] === v),
      );
    case 'animationNone':
      return measured.every((n) => n === 'none');
    case 'focusOrder':
      return JSON.stringify(measured) === JSON.stringify(want);
    case 'focusVisible':
      return measured.every(Boolean);
    case 'paintedIndicator':
      return measured.length === want && measured.every(stopOk);
    case 'activates':
      return (
        measured.checked === want.then.checked &&
        Object.entries(want.then.computed).every(
          ([p, v]) => measured.computed[p] === v,
        )
      );
    case 'scrollsWithKeys':
      return (
        measured.focused === want.target &&
        measured.after[0] > measured.before[0] &&
        measured.after[1] > measured.before[1]
      );
    case 'role':
      return measured === ({ img: 'image' }[want] ?? want);
    case 'name':
      return measured === want;
    case 'contrastMin':
      return !measured.image && contrastRatio(measured.fg, measured.bg) >= want;
    case 'targetSizeMin':
      return (
        measured.width >= want - TOLERANCE &&
        measured.height >= want - TOLERANCE
      );
    case 'visuallyHiddenButExposed':
      return measured.width <= 1 && measured.height <= 1 && !measured.ignored;
    case 'violations':
      return measured.length === want;
    case 'styleElements':
    case 'styleAttributes':
    case 'runtimeStyleInsertions':
    case 'inlineCustomProperties':
      return measured === want;
    case 'completeFirstPaint':
      return (
        measured.links > 0 &&
        measured.loaded === measured.links &&
        measured.scripts === 0
      );
    default:
      return false;
  }
}

/**
 * The results a row must hold for an assertion's expectation: one per
 * expectation kind (modifiers excluded), plus paintedIndicator next to
 * focusVisible. Returns [kind, want] pairs.
 */
export function requiredResults(expect) {
  const out = [];
  for (const [kind, want] of Object.entries(expect ?? {})) {
    if (kind === 'on' || kind === 'pseudoElement') continue;
    out.push([kind, want]);
    if (kind === 'focusVisible' && 'focusOrder' in expect)
      out.push(['paintedIndicator', expect.focusOrder.length]);
  }
  return out;
}

/** Row status from its results. */
export function rowStatus(assertionCase, results) {
  const evaluated = results.filter((r) => r.ok !== null);
  if (evaluated.length === 0) return 'not-evaluated';
  const allPass = evaluated.every((r) => r.ok === true);
  if (assertionCase === 'negative') return allPass ? 'fail' : 'pass';
  return allPass ? 'pass' : 'fail';
}

/**
 * Problems of one recorded row: exact result kinds, strict measurement
 * shapes, verdicts recomputed from measurements, the fixed not-evaluated
 * list and a status derived from the results.
 */
export function rowProblems(row, assertion, target) {
  const problems = [];
  const results = Array.isArray(row.results) ? row.results : [];
  if (results.length === 0) return ['has no result evidence'];
  const required = requiredResults(target.expect);
  const kinds = results.map((r) => r.kind);
  const wanted = required.map(([k]) => k);
  if (JSON.stringify([...kinds].sort()) !== JSON.stringify([...wanted].sort()))
    problems.push(
      `results ${kinds.join(',')} are not exactly ${wanted.join(',')}`,
    );
  for (const r of results) {
    const want = required.find(([k]) => k === r.kind)?.[1];
    if (r.ok === null) {
      const reason = NOT_EVALUATED_KINDS[r.kind];
      if (
        reason == null ||
        r.reason !== reason ||
        !NOT_EVALUATED_ASSERTIONS.includes(assertion.id) ||
        Object.keys(r).sort().join() !== 'kind,ok,reason'
      )
        problems.push(`${r.kind} is not evaluated without the fixed reason`);
      continue;
    }
    if (Object.keys(r).sort().join() !== 'kind,measured,ok')
      problems.push(`${r.kind} result has fields ${Object.keys(r).join(',')}`);
    const shape = MEASUREMENT_SHAPES[r.kind];
    if (shape == null || !shape(r.measured)) {
      problems.push(`${r.kind} measurement does not have its strict shape`);
      continue;
    }
    if (want === undefined) continue;
    if (judge(r.kind, want, r.measured) !== r.ok)
      problems.push(`${r.kind} verdict does not follow from its measurement`);
  }
  if (
    NOT_EVALUATED_ASSERTIONS.includes(assertion.id) !==
    (row.status === 'not-evaluated')
  )
    problems.push('not-evaluated status outside the documented assertions');
  if (rowStatus(assertion.case, results) !== row.status)
    problems.push('status is not derived from its results (forged)');
  return problems;
}
