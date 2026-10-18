/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Independent task oracles.
//
// `evaluateTask` observes a finished workspace and never trusts the evaluated
// agent: scope is a byte diff against the materialized baseline; compilation
// runs in a scratch copy through the public compiler SDK in a trusted process
// that never executes agent code; agent code (definitions, application
// modules) runs only in the permission-restricted sandbox, whose output is
// treated as untrusted data; and the agent's report only counts for what the
// agent claims to have diagnosed. Dependencies come from a trusted tree
// (`options.trustedNodeModules`), never from the agent-writable workspace.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  copyTree,
  diffSnapshots,
  fileDigest,
  listFiles,
  snapshotTree,
} from '../fs-tree.mjs';
import { compileGlobs, matchesAny } from '../glob.mjs';
import { computeStyle, parseCss } from '../css-cascade.mjs';
import { classList, elements, select } from '../html.mjs';
import { checkReport, extractReport } from './report.mjs';
import {
  CODE_GENERATION_ERROR,
  loadDefinitionData,
  runSandbox,
} from './run-sandbox.mjs';
import { flattenDefinition } from './vocabulary.mjs';
import {
  countByRule,
  findConstructs,
  inspectHostConfig,
} from './static-source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALWAYS_IGNORED = ['node_modules/**', '**/node_modules/**', '.git/**'];
const SCRATCH_EXCLUDE = [...ALWAYS_IGNORED, 'dist/**', 'build/**', '.next/**'];
const SOURCE_GLOB = '**/*.{js,jsx,ts,tsx,mjs,cjs}';
// Compiler-owned files whose bytes depend on the workspace path or session;
// they are verified against the generation's own digest list instead.
const PATH_DEPENDENT_GENERATED = new Set(['build-report.json']);

export const CHECK_CLASSES = [
  'scope',
  'integrity',
  'compile',
  'static',
  'rendered',
  'behavioral',
  'report',
  'transcript',
  'environment',
  'visual',
];

const result = (status, reason, evidence) => ({
  status,
  reason: reason ?? null,
  evidence: evidence ?? null,
});

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// The workspace's own node_modules is agent-writable and never used. Packages
// resolve from `trustedNodeModules` (a pristine install kept by the runner) or,
// when it is absent, from the scratch location's ancestors.
function prepareScratch(
  src,
  dest,
  extraExclude = [],
  trustedNodeModules = null,
) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  copyTree(src, dest, {
    exclude: [...SCRATCH_EXCLUDE, ...extraExclude],
    includeEmptyDirs: true,
    skipSymlinks: true,
  });
  if (trustedNodeModules != null) {
    fs.symlinkSync(
      path.resolve(trustedNodeModules),
      path.join(dest, 'node_modules'),
      'dir',
    );
  }
}

export function stateFileFor(outDir) {
  const parent = path.dirname(outDir);
  return path.join(
    parent === '.' ? '' : parent,
    `.${path.basename(outDir)}.pms-state.json`,
  );
}

function runWorker(request, scratchRoot, timeoutMs) {
  const requestPath = path.join(
    scratchRoot,
    `request-${process.pid}-${Date.now()}.json`,
  );
  const responsePath = `${requestPath}.out`;
  fs.writeFileSync(requestPath, JSON.stringify(request));
  const child = spawnSync(
    process.execPath,
    [path.join(HERE, 'project-worker.mjs'), requestPath, responsePath],
    {
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...process.env, NODE_ENV: 'production' },
    },
  );
  if (child.status !== 0 || !fs.existsSync(responsePath)) {
    return {
      error: `project worker failed (${child.status ?? child.signal}): ${(child.stderr ?? '').slice(-2000)}`,
    };
  }
  return JSON.parse(fs.readFileSync(responsePath, 'utf8'));
}

function renderKey(check) {
  const render = check.render;
  return JSON.stringify([
    render.module,
    render.export ?? 'default',
    render.props ?? {},
    render.theme ?? null,
    check.interactions ?? [],
  ]);
}

function collectTokenExpectations(checks) {
  const tokens = new Set();
  for (const check of checks) {
    for (const exp of Object.values(check.expect?.styles ?? {})) {
      if (exp.token) tokens.add(exp.token);
      if (exp.notToken) tokens.add(exp.notToken);
      for (const t of exp.oneOfTokens ?? []) tokens.add(t);
    }
  }
  return [...tokens].sort();
}

function elementChain(target) {
  const chain = [];
  for (
    let node = target;
    node != null && node.tag !== '#root';
    node = node.parent
  ) {
    chain.unshift({
      tag: node.tag,
      classes: classList(node),
      attributes: node.attributes,
    });
  }
  chain.unshift({ tag: 'html', classes: [], attributes: {}, isRoot: true });
  return chain;
}

// Compiler CSS is minified (`.5`, `repeat(2,minmax(0,1fr))`); expectations
// are written in ordinary CSS. Both sides are compared in one normal form.
export function normalizeCssValue(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*([,()])\s*/g, '$1')
    .replace(/(^|[^\d.])0+\.(\d)/g, '$1.$2');
}

function evaluateStyleExpectation(property, exp, computed, tokenVars) {
  if (Object.hasOwn(computed.unmeasuredProperties, property)) {
    return {
      status: 'unmeasured',
      detail: `${property}: ${computed.unmeasuredProperties[property]}`,
    };
  }
  const got = computed.properties[property];
  const tokenVar = (t) => tokenVars[t];
  if (exp.absent === true) {
    return got == null
      ? { status: 'pass' }
      : { status: 'fail', detail: `${property} is set to ${got.declared}` };
  }
  if (got == null) return { status: 'fail', detail: `${property} is not set` };
  const usesToken = (t) => {
    const v = tokenVar(t);
    return v != null && got.declared === `var(${v})`;
  };
  for (const t of [exp.token, exp.notToken, ...(exp.oneOfTokens ?? [])].filter(
    Boolean,
  )) {
    if (tokenVar(t) == null)
      return {
        status: 'fail',
        detail: `token ${t} is not a public token of the final design system`,
      };
  }
  if (exp.token != null && !usesToken(exp.token)) {
    return {
      status: 'fail',
      detail: `${property} is ${got.declared}, expected token ${exp.token}`,
    };
  }
  if (exp.oneOfTokens != null && !exp.oneOfTokens.some(usesToken)) {
    return {
      status: 'fail',
      detail: `${property} is ${got.declared}, expected one of ${exp.oneOfTokens.join(', ')}`,
    };
  }
  if (exp.notToken != null && usesToken(exp.notToken)) {
    return {
      status: 'fail',
      detail: `${property} must not use ${exp.notToken}`,
    };
  }
  if (exp.value != null) {
    if (got.unresolvedVariables.length > 0) {
      return {
        status: 'fail',
        detail: `${property} has unresolved variables ${got.unresolvedVariables.join(',')}`,
      };
    }
    if (normalizeCssValue(got.resolved) !== normalizeCssValue(exp.value)) {
      return {
        status: 'fail',
        detail: `${property} resolves to ${got.resolved}, expected ${exp.value}`,
      };
    }
  }
  return { status: 'pass' };
}

// --- Presentation -----------------------------------------------------------
//
// An element or text counts as presented only when nothing conceals it.
// Concealment decided soundly from markup and the static cascade fails the
// assertion; concealment the static cascade cannot decide (clipping, overflow,
// positioning, transforms, tiny boxes, filters) makes it `unmeasured`.

const FORM_CONTROLS = new Set([
  'button',
  'input',
  'select',
  'textarea',
  'option',
  'optgroup',
  'fieldset',
]);
const BENIGN_TRANSFORM = /^(none|translate[xy]?\(-?[0-2](\.\d+)?px\))$/;
const BENIGN_FILTER = /^(none|grayscale\(1\))$/;
const NAMED_COLORS = {
  white: [255, 255, 255, 1],
  black: [0, 0, 0, 1],
  transparent: [0, 0, 0, 0],
};

function parseColor(value) {
  const v = normalizeCssValue(value);
  if (Object.hasOwn(NAMED_COLORS, v)) return NAMED_COLORS[v];
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return [0, 2, 4]
      .map((i) => parseInt(h.slice(i, i + 2), 16))
      .concat(h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1);
  }
  m = /^rgba?\((\d+),(\d+),(\d+)(?:,([\d.]+))?\)$/.exec(v);
  if (m)
    return [
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
      m[4] == null ? 1 : Number(m[4]),
    ];
  return null;
}

function pxValue(value) {
  const v = normalizeCssValue(value);
  if (v === '0') return 0;
  const m = /^(-?[\d.]+)(px|rem|em|%|vw|vh)$/.exec(v);
  if (m == null) return null;
  if (Number(m[1]) === 0) return 0;
  return m[2] === 'px'
    ? Number(m[1])
    : m[2] === 'rem' || m[2] === 'em'
      ? Number(m[1]) * 16
      : null;
}

function styleOf(node, observed, context, cache) {
  if (!cache.has(node))
    cache.set(
      node,
      computeStyle(observed.cssRules, elementChain(node), context),
    );
  return cache.get(node);
}

function resolved(computed, property) {
  return computed.properties[property]?.resolved ?? null;
}

// Concealment caused by this element alone: { concealed, risk } reasons.
function ownConcealment(node, computed) {
  for (const property of [
    'display',
    'opacity',
    'font-size',
    'clip-path',
    'clip',
    'mask',
    'mask-image',
    'transform',
    'filter',
    'overflow',
    'position',
    'width',
    'height',
    'max-width',
    'max-height',
    ...EXTRA_CONCEALMENT,
  ]) {
    if (Object.hasOwn(computed.unmeasuredProperties, property)) {
      return {
        risk: `${property} on <${node.tag}> is not statically decidable`,
      };
    }
  }
  const display = resolved(computed, 'display');
  if (display != null && normalizeCssValue(display) === 'none')
    return { concealed: `display:none on <${node.tag}>` };
  const opacity = resolved(computed, 'opacity');
  if (opacity != null && Number(opacity) === 0)
    return { concealed: `opacity:0 on <${node.tag}>` };
  const fontSize = resolved(computed, 'font-size');
  if (fontSize != null && pxValue(fontSize) === 0)
    return { concealed: `font-size:0 on <${node.tag}>` };
  for (const property of ['clip-path', 'clip', 'mask', 'mask-image']) {
    if (resolved(computed, property) != null)
      return {
        risk: `${property} on <${node.tag}> (clipping is not measured)`,
      };
  }
  const transform = resolved(computed, 'transform');
  if (transform != null && !BENIGN_TRANSFORM.test(normalizeCssValue(transform)))
    return { risk: `transform:${transform} on <${node.tag}>` };
  const filter = resolved(computed, 'filter');
  if (filter != null && !BENIGN_FILTER.test(normalizeCssValue(filter)))
    return { risk: `filter:${filter} on <${node.tag}>` };
  const overflow = resolved(computed, 'overflow');
  if (overflow != null && normalizeCssValue(overflow) !== 'visible')
    return {
      risk: `overflow:${overflow} on <${node.tag}> (overflow clipping is not measured)`,
    };
  const position = resolved(computed, 'position');
  if (
    position != null &&
    ['absolute', 'fixed', 'sticky'].includes(normalizeCssValue(position))
  ) {
    return {
      risk: `position:${position} on <${node.tag}> (placement is not measured)`,
    };
  }
  for (const property of ['width', 'height', 'max-width', 'max-height']) {
    const v = resolved(computed, property);
    const px = v == null ? null : pxValue(v);
    if (px != null && px <= 1)
      return {
        risk: `${property}:${v} on <${node.tag}> (box size is not measured)`,
      };
  }
  const contentVisibility = resolved(computed, 'content-visibility');
  if (
    contentVisibility != null &&
    normalizeCssValue(contentVisibility) === 'hidden'
  ) {
    return { concealed: `content-visibility:hidden on <${node.tag}>` };
  }
  // Anything else that can move, clip, shrink or skip content is undecidable
  // without layout: unmeasured, never passed.
  for (const property of EXTRA_CONCEALMENT) {
    const v = resolved(computed, property);
    if (v == null) continue;
    const value = normalizeCssValue(v);
    if (BENIGN_VALUES[property]?.test(value)) continue;
    return { risk: `${property}:${v} on <${node.tag}> (not measured)` };
  }
  return {};
}

const EXTRA_CONCEALMENT = [
  'content-visibility',
  'scale',
  'translate',
  'rotate',
  'overflow-x',
  'overflow-y',
  'overflow-clip-margin',
  'text-indent',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'zoom',
  'contain',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'margin-inline',
  'margin-inline-start',
  'margin-inline-end',
  'margin-block',
  'margin-block-start',
  'margin-block-end',
  'inset',
  'top',
  'right',
  'bottom',
  'left',
  'z-index',
  'backface-visibility',
  'perspective',
  'mix-blend-mode',
  // Keyframes can conceal (opacity, transforms) for as long as they run.
  'animation-name',
  'animation',
];
// Values of those properties that cannot conceal content.
const BENIGN_VALUES = {
  'content-visibility': /^visible$/,
  scale: /^(none|1)$/,
  translate: /^(none|0(px)?)$/,
  rotate: /^(none|0(deg)?)$/,
  'overflow-x': /^visible$/,
  'overflow-y': /^visible$/,
  'text-indent': /^0(px)?$/,
  'line-height':
    /^(normal|[1-9][\d.]*|0?\.[1-9]\d*|[\d.]+(px|rem|em)|var\(.*\))$/,
  'letter-spacing': /^(normal|0(px)?|[\d.]+(px|rem|em))$/,
  'word-spacing': /^(normal|0(px)?|[\d.]+(px|rem|em))$/,
  zoom: /^(normal|1|100%)$/,
  contain: /^none$/,
  margin: /^[^-]*$/,
  'margin-top': /^[^-]*$/,
  'margin-right': /^[^-]*$/,
  'margin-bottom': /^[^-]*$/,
  'margin-left': /^[^-]*$/,
  'margin-inline': /^[^-]*$/,
  'margin-inline-start': /^[^-]*$/,
  'margin-inline-end': /^[^-]*$/,
  'margin-block': /^[^-]*$/,
  'margin-block-start': /^[^-]*$/,
  'margin-block-end': /^[^-]*$/,
  'backface-visibility': /^visible$/,
  'mix-blend-mode': /^normal$/,
  // A negative z-index can paint an element below its parent's background.
  'z-index': /^(auto|\d+)$/,
  'animation-name': /^none$/,
  animation: /^none$/,
};

// Elements whose content is never presented as text.
// (The user agent style sheet hides them: display:none.)
const UNRENDERED = new Set([
  'template',
  'script',
  'noscript',
  'style',
  'title',
  'head',
  'meta',
  'base',
  'link',
  'area',
  'param',
  'rp',
  'noembed',
  'noframes',
]);
// Content whose presentation depends on rendering the static cascade cannot
// decide (form controls, embedded content).
const UNDECIDABLE_CONTENT = new Set([
  'select',
  'option',
  'optgroup',
  'datalist',
  'textarea',
  'iframe',
  'object',
  'embed',
  'canvas',
  'video',
  'audio',
  'picture',
  'slot',
  'marquee',
  // SVG and MathML only render text in specific elements and positions.
  'svg',
  'math',
]);

function undecidableReason(node) {
  if (Object.hasOwn(node.attributes ?? {}, 'popover'))
    return `popover on <${node.tag}> (popover state is not measured)`;
  if (UNDECIDABLE_CONTENT.has(node.tag))
    return `content of <${node.tag}> is not measured`;
  return null;
}

function structuralConcealment(node, child) {
  if (UNRENDERED.has(node.tag)) return `inside <${node.tag}> (not rendered)`;
  if (Object.hasOwn(node.attributes, 'hidden'))
    return `hidden attribute on <${node.tag}>`;
  if (Object.hasOwn(node.attributes, 'inert'))
    return `inert attribute on <${node.tag}>`;
  if (node.tag === 'dialog' && !Object.hasOwn(node.attributes, 'open'))
    return 'inside a closed <dialog>';
  if (
    node.tag === 'details' &&
    !Object.hasOwn(node.attributes, 'open') &&
    child != null &&
    child.tag !== 'summary'
  ) {
    return 'inside a closed <details>';
  }
  return null;
}

// Nearest declared value of an inherited property along the chain.
function inherited(chain, property, observed, context, cache) {
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const v = resolved(styleOf(chain[i], observed, context, cache), property);
    if (v != null) return v;
  }
  return null;
}

function colorConcealment(chain, observed, context, cache) {
  const color =
    inherited(chain, 'color', observed, context, cache) ?? '#000000';
  let background = null;
  for (let i = chain.length - 1; i >= 0 && background == null; i -= 1) {
    const v = resolved(
      styleOf(chain[i], observed, context, cache),
      'background-color',
    );
    const parsed = v == null ? null : parseColor(v);
    if (v != null && parsed == null)
      return { risk: `background-color ${v} is not comparable` };
    if (parsed != null && parsed[3] === 0) continue;
    if (parsed != null && parsed[3] < 1)
      return { risk: `translucent background-color ${v}` };
    if (parsed != null) background = parsed;
  }
  background ??= NAMED_COLORS.white;
  const fg = parseColor(color);
  if (fg == null) return { risk: `color ${color} is not comparable` };
  // Text painted through its background (background-clip:text) or carried by
  // a shadow is visible even with a transparent or matching color.
  for (const node of chain) {
    const style = styleOf(node, observed, context, cache);
    const clip = resolved(style, 'background-clip');
    if (clip != null && /\btext\b/.test(normalizeCssValue(clip)))
      return { risk: `background-clip:${clip} on <${node.tag}>` };
  }
  const shadow = inherited(chain, 'text-shadow', observed, context, cache);
  const shadowed = shadow != null && normalizeCssValue(shadow) !== 'none';
  if (fg[3] === 0)
    return shadowed
      ? { risk: 'transparent text color with a text shadow' }
      : { concealed: 'transparent text color' };
  if (
    !shadowed &&
    fg[3] === 1 &&
    fg[0] === background[0] &&
    fg[1] === background[1] &&
    fg[2] === background[2]
  ) {
    return { concealed: `text color equals its background (${color})` };
  }
  return {};
}

function ancestorsOf(node) {
  const chain = [];
  for (let n = node; n != null && n.tag !== '#root'; n = n.parent)
    chain.unshift(n);
  return chain;
}

/** Whether `target` itself is presented: { visible: true|false|null, reason }. */
function presentation(target, observed, context, cache) {
  const chain = ancestorsOf(target);
  for (let i = 0; i < chain.length; i += 1) {
    const structural = structuralConcealment(chain[i], chain[i + 1] ?? null);
    if (structural != null) return { visible: false, reason: structural };
  }
  let risk = null;
  for (const node of chain) {
    risk ??= undecidableReason(node);
    const own = ownConcealment(node, styleOf(node, observed, context, cache));
    if (own.concealed) return { visible: false, reason: own.concealed };
    risk ??= own.risk ?? null;
  }
  const visibility = inherited(chain, 'visibility', observed, context, cache);
  if (
    visibility != null &&
    ['hidden', 'collapse'].includes(normalizeCssValue(visibility))
  ) {
    return { visible: false, reason: `visibility:${visibility}` };
  }
  if (observed.positionedRisk != null) risk ??= observed.positionedRisk;
  return risk == null ? { visible: true } : { visible: null, reason: risk };
}

/**
 * Text the user can perceive inside `node`, as `{ strict, lenient }`.
 * Soundly concealed descendants contribute to neither. Content whose
 * presentation cannot be decided (popovers, form controls, clipping, overflow,
 * transforms, uncomparable colors) contributes only to `lenient`: an
 * assertion that holds on `strict` passes, one that only holds on `lenient`
 * is unmeasured, and one that holds on neither fails.
 */
function presentedText(
  node,
  observed,
  context,
  cache,
  chain = ancestorsOf(node),
  decided = true,
) {
  let strict = '';
  let lenient = '';
  for (const child of node.children ?? []) {
    if (child.tag === '#text') {
      const visibility = inherited(
        chain,
        'visibility',
        observed,
        context,
        cache,
      );
      const hidden =
        visibility != null &&
        ['hidden', 'collapse'].includes(normalizeCssValue(visibility));
      if (!hidden && child.text.trim() !== '') {
        const color = colorConcealment(chain, observed, context, cache);
        if (!color.concealed) {
          lenient += child.text;
          if (decided && !color.risk) strict += child.text;
        }
      }
      continue;
    }
    if (
      structuralConcealment(child, null) != null ||
      structuralConcealment(node, child) != null
    )
      continue;
    const own = ownConcealment(child, styleOf(child, observed, context, cache));
    if (own.concealed) continue;
    const childDecided =
      decided && own.risk == null && undecidableReason(child) == null;
    const inner = presentedText(
      child,
      observed,
      context,
      cache,
      [...chain, child],
      childDecided,
    );
    strict += ` ${inner.strict} `;
    lenient += ` ${inner.lenient} `;
  }
  return { strict, lenient };
}

function disabledReason(node) {
  for (let n = node; n != null && n.tag !== '#root'; n = n.parent) {
    if (FORM_CONTROLS.has(n.tag) && Object.hasOwn(n.attributes, 'disabled')) {
      if (n === node || n.tag === 'fieldset') return `disabled <${n.tag}>`;
    }
  }
  return null;
}

function evaluateRender(check, observed) {
  const rendered = observed.renders?.[check.renderId];
  if (rendered == null) return result('error', 'render was not requested');
  const dynamic = rendered.violations ?? [];
  if (rendered.error != null) {
    return result(
      'fail',
      `render failed: ${rendered.error}`,
      dynamic.length > 0 ? { dynamic } : null,
    );
  }
  let tree;
  try {
    tree = committedTree(rendered.tree);
  } catch (error) {
    return result('fail', `committed DOM is not readable: ${error.message}`);
  }
  const matches = select(tree, check.select);
  const expect = check.expect ?? {};
  const failures = [];
  const unmeasured = (rendered.unmeasured ?? []).map(
    (u) => `committed DOM not fully compared: ${u}`,
  );
  if (dynamic.length > 0)
    failures.push(
      `runtime DOM/style activity: ${dynamic.slice(0, 5).join('; ')}`,
    );
  const expectedCount = expect.count ?? 1;
  if (matches.length !== expectedCount) {
    return result(
      'fail',
      `selector ${JSON.stringify(check.select)} matched ${matches.length}, expected ${expectedCount}`,
    );
  }
  const context = check.context ?? {};
  const cache = new Map();
  // Any positioned element can overlay or displace others; the static
  // cascade cannot measure that, so presentation becomes unmeasured.
  let positionedRisk = null;
  for (const el of elements(tree)) {
    const position = resolved(
      styleOf(el, observed, context, cache),
      'position',
    );
    if (
      position != null &&
      ['absolute', 'fixed', 'sticky'].includes(normalizeCssValue(position))
    ) {
      positionedRisk = `position:${position} on <${el.tag}> in the rendered tree (overlap is not measured)`;
      break;
    }
  }
  observed = { ...observed, positionedRisk };
  if (expect.visible !== false) {
    for (const match of matches) {
      const v = presentation(match, observed, context, cache);
      if (v.visible === false) failures.push(`not presented: ${v.reason}`);
      if (v.visible === null)
        unmeasured.push(`presentation unknown: ${v.reason}`);
    }
  }
  const textOf = (node) => {
    const t = presentedText(node, observed, context, cache);
    return {
      strict: t.strict.replace(/\s+/g, ' ').trim(),
      lenient: t.lenient.replace(/\s+/g, ' ').trim(),
    };
  };
  // Pass on strict text, unmeasured when only the undecidable content makes
  // the assertion hold, fail otherwise.
  const assertText = (t, ok, describe) => {
    if (ok(t.strict)) return;
    if (ok(t.lenient))
      unmeasured.push(
        `presented text unknown: ${describe(t.lenient)} relies on content whose presentation is not measured`,
      );
    else failures.push(describe(t.strict));
  };
  if (expect.texts != null) {
    if (expect.texts.length !== matches.length)
      failures.push(
        `texts lists ${expect.texts.length} patterns for ${matches.length} matches`,
      );
    matches.forEach((match, i) => {
      if (expect.texts[i] == null) return;
      const re = new RegExp(expect.texts[i], 'i');
      assertText(
        textOf(match),
        (t) => re.test(t),
        (t) =>
          `match ${i} presented text ${JSON.stringify(t)} does not match /${expect.texts[i]}/i`,
      );
    });
  }
  // Interactions: the target is the single presented, enabled rendered
  // element with the test id; only its dispatch counts.
  const callCounts = {};
  for (const wanted of check.interactions ?? []) {
    const observedInteraction = (rendered.interactions ?? []).find(
      (i) => i.testId === wanted.testId && i.event === wanted.event,
    );
    // Candidates are the committed elements with the test id, in document
    // order; the sandbox dispatched natively on each one.
    const byIndex = new Map(
      (observedInteraction?.candidates ?? []).map((c) => [c.index, c]),
    );
    const nodes = select(tree, { testId: wanted.testId });
    // The sandbox dispatched on the committed elements with the test id, in
    // document order; they must be exactly the markup's elements.
    if (
      observedInteraction != null &&
      observedInteraction.candidates.length !== nodes.length
    ) {
      failures.push(
        `${wanted.event} on ${wanted.testId}: ${observedInteraction.candidates.length} dispatch candidates for ${nodes.length} elements in the committed markup`,
      );
      continue;
    }
    const eligible = [];
    const reasons = [];
    for (const node of nodes) {
      const v = presentation(node, observed, context, cache);
      const disabled = disabledReason(node);
      const pointer = inherited(
        ancestorsOf(node),
        'pointer-events',
        observed,
        context,
        cache,
      );
      if (v.visible === false) reasons.push(v.reason);
      else if (disabled != null) reasons.push(disabled);
      else if (pointer != null && normalizeCssValue(pointer) === 'none')
        reasons.push('pointer-events:none');
      else {
        if (v.visible === null)
          unmeasured.push(
            `interaction target presentation unknown: ${v.reason}`,
          );
        eligible.push(node);
      }
    }
    if (eligible.length !== 1) {
      failures.push(
        `${wanted.event} on ${wanted.testId}: ${eligible.length} eligible rendered targets (${nodes.length} rendered${reasons.length ? `; ${reasons.join(', ')}` : ''})`,
      );
      continue;
    }
    const outcome = byIndex.get(nodes.indexOf(eligible[0]));
    if (outcome == null) {
      failures.push(`${wanted.event} on ${wanted.testId}: not dispatched`);
      continue;
    }
    for (const [name, n] of Object.entries(outcome.calls ?? {}))
      callCounts[name] = (callCounts[name] ?? 0) + n;
  }
  for (const [name, exp] of Object.entries(expect.callbacks ?? {})) {
    const got = callCounts[name] ?? 0;
    if (got !== exp.calls)
      failures.push(
        `callback ${name} called ${got} time(s) by the interaction, expected ${exp.calls}`,
      );
    const outside = rendered.outside?.[name] ?? 0;
    if (outside !== 0)
      failures.push(`callback ${name} called ${outside} time(s) during render`);
  }
  if (expectedCount === 0) {
    return failures.length > 0
      ? result('fail', failures.join('; '))
      : result('pass', null, { matched: 0 });
  }
  const target = matches[check.index ?? 0];
  const targetText = textOf(target);
  const text = targetText.strict;
  if (expect.text != null) {
    assertText(
      targetText,
      (t) => t === expect.text,
      (t) => `presented text is ${JSON.stringify(t)}`,
    );
  }
  if (expect.textMatches != null) {
    const re = new RegExp(expect.textMatches, 'i');
    assertText(
      targetText,
      (t) => re.test(t),
      (t) =>
        `presented text ${JSON.stringify(t)} does not match /${expect.textMatches}/i`,
    );
  }
  for (const [name, value] of Object.entries(expect.attributes ?? {})) {
    const has = Object.hasOwn(target.attributes, name);
    if (
      value === null
        ? has
        : !has || (value !== true && target.attributes[name] !== value)
    ) {
      failures.push(
        `attribute ${name}=${JSON.stringify(target.attributes[name] ?? null)}, expected ${JSON.stringify(value)}`,
      );
    }
  }
  let computed = null;
  if (expect.styles != null) {
    computed = styleOf(target, observed, context, cache);
    for (const [property, exp] of Object.entries(expect.styles)) {
      const r = evaluateStyleExpectation(
        property,
        exp,
        computed,
        observed.tokenVars ?? {},
      );
      if (r.status === 'fail') failures.push(r.detail);
      if (r.status === 'unmeasured') unmeasured.push(r.detail);
    }
  }
  const evidence = {
    classes: classList(target),
    text: text.slice(0, 200),
    callbacks: Object.keys(callCounts).length > 0 ? callCounts : undefined,
    styles:
      computed == null
        ? undefined
        : Object.fromEntries(
            Object.keys(expect.styles ?? {}).map((p) => [
              p,
              computed.properties[p]?.declared ?? null,
            ]),
          ),
  };
  if (failures.length > 0) return result('fail', failures.join('; '), evidence);
  if (unmeasured.length > 0)
    return result('unmeasured', [...new Set(unmeasured)].join('; '), evidence);
  return result('pass', null, evidence);
}

function evaluateDefinitionDiff(check, before, after) {
  if (before?.error || after?.error)
    return result(
      'fail',
      `definition not loadable: ${before?.error ?? after?.error}`,
    );
  const added = Object.keys(after)
    .filter((k) => !Object.hasOwn(before, k))
    .sort();
  const removed = Object.keys(before)
    .filter((k) => !Object.hasOwn(after, k))
    .sort();
  const changed = Object.keys(after)
    .filter((k) => Object.hasOwn(before, k) && before[k] !== after[k])
    .sort();
  const failures = [];
  const compare = (label, actual, patterns = [], allowExtra = false) => {
    const globs = compileGlobs(patterns.map((p) => p.replaceAll('/', '∕')));
    for (const key of actual) {
      if (!allowExtra && globs.match(key.replaceAll('/', '∕')) == null)
        failures.push(`unexpected ${label} ${key}`);
    }
    for (const p of patterns) {
      if (
        !actual.some((key) =>
          matchesAny([p.replaceAll('/', '∕')], key.replaceAll('/', '∕')),
        )
      ) {
        failures.push(`expected ${label} ${p} not found`);
      }
    }
  };
  compare('added', added, check.added ?? [], check.allowExtraAdded === true);
  compare('removed', removed, check.removed ?? []);
  compare('changed', changed, check.changed ?? []);
  const evidence = { added, removed, changed };
  return failures.length > 0
    ? result('fail', failures.join('; '), evidence)
    : result('pass', null, evidence);
}

function sourceFiles(root, exclude) {
  return listFiles(root, { exclude: [...ALWAYS_IGNORED, ...exclude] }).filter(
    (f) => matchesAny([SOURCE_GLOB], f),
  );
}

function evaluateForbidden(check, ctx, observed = {}) {
  const rules = new Set(check.rules);
  const globs = check.files ?? [SOURCE_GLOB];
  const exclude = [
    ctx.project?.outDir ? `${ctx.project.outDir}/**` : '.pandamstyle/**',
    'dist/**',
    '.next/**',
  ];
  const files = sourceFiles(ctx.workspaceDir, exclude).filter((f) =>
    matchesAny(globs, f),
  );
  const introduced = [];
  for (const rel of files) {
    const isDefinition = ctx.project?.definition === rel;
    const after = findConstructs(
      readText(path.join(ctx.workspaceDir, rel)),
      rel,
      { isDefinition },
    ).filter((f) => rules.has(f.rule) || f.rule === 'parse-error');
    if (after.length === 0) continue;
    const baseText = readText(path.join(ctx.baselineDir, rel));
    const baseCounts =
      baseText == null
        ? {}
        : countByRule(findConstructs(baseText, rel, { isDefinition }));
    const afterCounts = countByRule(after);
    for (const [rule, count] of Object.entries(afterCounts)) {
      if (count > (baseCounts[rule] ?? 0)) {
        introduced.push({
          file: rel,
          rule,
          count: count - (baseCounts[rule] ?? 0),
          lines: after.filter((f) => f.rule === rule).map((f) => f.line),
        });
      }
    }
  }
  // The dynamic trace of every sandboxed render is part of this evidence:
  // runtime style or DOM activity fails the bypass check even when no static
  // pattern matched.
  if (rules.has('runtime-style-injection')) {
    for (const [id, r] of Object.entries(observed.renders ?? {})) {
      const dynamic = r.violations ?? [];
      if (dynamic.length > 0)
        introduced.push({
          file: `(dynamic trace ${id})`,
          rule: 'runtime-style-injection',
          count: dynamic.length,
          lines: dynamic.slice(0, 5),
        });
    }
  }
  return introduced.length > 0
    ? result(
        'fail',
        introduced.map((i) => `${i.file}: ${i.rule} x${i.count}`).join('; '),
        introduced,
      )
    : result('pass', null, { filesInspected: files.length });
}

function evaluateHostConfig(check, ctx) {
  const after = readText(path.join(ctx.workspaceDir, check.file));
  if (after == null) return result('fail', `${check.file} not found`);
  const inspected = inspectHostConfig(after, check.file);
  if (!inspected.found)
    return result(
      'fail',
      `no @pandamstyle host integration call in ${check.file}`,
    );
  const call = inspected.calls.find((c) => c.module === check.module) ?? null;
  if (call == null)
    return result(
      'fail',
      `integration is not imported from ${check.module}`,
      inspected.calls,
    );
  const failures = [];
  const options = call.options ?? {};
  for (const [key, expected] of Object.entries(check.expect ?? {})) {
    const actual = options[key];
    const norm = (v) =>
      typeof v === 'string' ? v.replace(/^\.\//, '').replace(/\/$/, '') : v;
    const ok = Array.isArray(expected)
      ? Array.isArray(actual) &&
        actual.length === expected.length &&
        expected.every((e) => actual.map(norm).includes(norm(e)))
      : norm(actual) === norm(expected);
    if (!ok)
      failures.push(
        `${key} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
      );
  }
  for (const key of check.forbidOptions ?? []) {
    if (Object.hasOwn(options, key))
      failures.push(`option ${key} must not be set`);
  }
  if (check.preservePlugins === true) {
    const before = readText(path.join(ctx.baselineDir, check.file));
    const basePlugins =
      before == null ? [] : inspectHostConfig(before, check.file).plugins;
    for (const p of basePlugins) {
      if (!inspected.plugins.includes(p))
        failures.push(`existing plugin ${p} was removed`);
    }
  }
  return failures.length > 0
    ? result('fail', failures.join('; '), {
        options,
        plugins: inspected.plugins,
      })
    : result('pass', null, { options, plugins: inspected.plugins });
}

function evaluatePackageJson(check, ctx) {
  const after = JSON.parse(
    readText(path.join(ctx.workspaceDir, check.file ?? 'package.json')) ??
      'null',
  );
  const before = JSON.parse(
    readText(path.join(ctx.baselineDir, check.file ?? 'package.json')) ??
      'null',
  );
  if (after == null) return result('fail', 'package.json missing');
  const failures = [];
  const sections = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ];
  const specOf = (pkg, name) => {
    for (const s of sections)
      if (pkg?.[s]?.[name] != null) return { section: s, spec: pkg[s][name] };
    return null;
  };
  const specs = [];
  for (const req of check.require ?? []) {
    const found = specOf(after, req.name);
    if (found == null) {
      failures.push(`${req.name} is not declared`);
      continue;
    }
    if (req.section != null && found.section !== req.section)
      failures.push(
        `${req.name} is in ${found.section}, expected ${req.section}`,
      );
    if (req.spec != null && !new RegExp(req.spec).test(found.spec))
      failures.push(`${req.name}@${found.spec} does not match /${req.spec}/`);
    specs.push(found.spec);
  }
  if (check.sameSpec === true && new Set(specs).size > 1)
    failures.push(
      `PandamStyle packages use different specs: ${[...new Set(specs)].join(', ')}`,
    );
  for (const name of check.forbid ?? []) {
    if (specOf(after, name) != null)
      failures.push(`${name} must not be declared`);
  }
  if (check.preserveExisting === true && before != null) {
    for (const s of sections) {
      for (const [name, spec] of Object.entries(before[s] ?? {})) {
        const now = specOf(after, name);
        if (now == null || now.spec !== spec)
          failures.push(`existing dependency ${name}@${spec} changed`);
      }
    }
    for (const [name, script] of Object.entries(before.scripts ?? {})) {
      if (
        after.scripts?.[name] !== script &&
        !(check.allowScriptChanges ?? []).includes(name)
      ) {
        failures.push(`existing script ${name} changed`);
      }
    }
  }
  return failures.length > 0
    ? result('fail', failures.join('; '))
    : result('pass');
}

function inventory(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const rel of listFiles(dir)) out[rel] = fileDigest(path.join(dir, rel));
  return out;
}

function readJsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Generated-output integrity. References come only from places the agent
// cannot edit: the harness's baseline snapshot and a fresh trusted
// recompilation of the final sources. The workspace's own generation state is
// never trusted as an inventory.
//   - Path inventories (output directory files plus the state file) are
//     compared exactly: missing, added and renamed files all count.
//   - Deterministic files must be byte-identical. The build report and the
//     state file embed paths and session identities, so they are compared in
//     a normal form that keeps every path-independent field.
//   - must-match: the workspace generation is the fresh generation.
//   - no-hand-edits: it is byte-identical to the baseline generation (never
//     touched), or the fresh generation, or absent when the baseline had none.
//     Deleting a baseline generation is never "never generated".
const REPORT_FIELDS = [
  'documentKind',
  'schemaVersion',
  'contractVersion',
  'systemId',
  'registryDigest',
  'coveredFileCount',
  'analysedFileCount',
  'designSystemRuleCount',
  'consumerRuleCount',
  'ruleCount',
  'cssBytes',
  'coverageSummary',
  'coverageConsistency',
  'externalRequests',
];

function readGeneration(root, outDir, statePath) {
  const files = inventory(path.join(root, outDir));
  const stateFile = path.join(root, statePath);
  const stateExists = fs.existsSync(stateFile);
  return {
    files,
    stateExists,
    stateDigest: stateExists ? fileDigest(stateFile) : null,
    state: stateExists ? readJsonOrNull(stateFile) : null,
    report:
      files['build-report.json'] != null
        ? readJsonOrNull(path.join(root, outDir, 'build-report.json'))
        : null,
    empty: Object.keys(files).length === 0 && !stateExists,
  };
}

function reportForm(report) {
  if (report == null || typeof report !== 'object') return null;
  const out = {};
  for (const key of REPORT_FIELDS) {
    if (!Object.hasOwn(report, key)) return null;
    out[key] = report[key];
  }
  out.coveredRoots = Array.isArray(report.coveredRoots)
    ? report.coveredRoots.length
    : null;
  out.relayEdges = Array.isArray(report.relayEdges)
    ? report.relayEdges.length
    : null;
  return JSON.stringify(out);
}

function stateForm(state) {
  if (state == null || typeof state !== 'object' || state.files == null)
    return null;
  const files = {};
  for (const rel of Object.keys(state.files).sort()) {
    const entry = state.files[rel] ?? {};
    files[rel] = PATH_DEPENDENT_GENERATED.has(rel)
      ? { kind: entry.kind ?? null }
      : {
          digest: entry.digest ?? null,
          size: entry.size ?? null,
          kind: entry.kind ?? null,
        };
  }
  return JSON.stringify({ version: state.version ?? null, files });
}

function sameAsFresh(ws, fresh) {
  const problems = [];
  const wsPaths = Object.keys(ws.files).sort();
  const freshPaths = Object.keys(fresh.files).sort();
  for (const rel of freshPaths)
    if (ws.files[rel] == null) problems.push(`missing ${rel}`);
  for (const rel of wsPaths)
    if (fresh.files[rel] == null) problems.push(`unexpected file ${rel}`);
  for (const rel of wsPaths) {
    if (fresh.files[rel] == null || PATH_DEPENDENT_GENERATED.has(rel)) continue;
    if (ws.files[rel] !== fresh.files[rel]) problems.push(`modified ${rel}`);
  }
  if (
    fresh.files['build-report.json'] != null &&
    ws.files['build-report.json'] != null
  ) {
    const form = reportForm(ws.report);
    if (form == null || form !== reportForm(fresh.report))
      problems.push('build-report.json differs from the fresh build report');
  }
  if (ws.stateExists !== fresh.stateExists)
    problems.push(
      ws.stateExists
        ? 'unexpected generation state'
        : 'missing generation state',
    );
  else if (ws.stateExists) {
    const form = stateForm(ws.state);
    if (form == null || form !== stateForm(fresh.state))
      problems.push('generation state differs from the fresh generation');
  }
  return problems;
}

function sameAsBaseline(ws, base) {
  if (base.empty || ws.stateDigest !== base.stateDigest) return false;
  const a = Object.keys(ws.files).sort();
  const b = Object.keys(base.files).sort();
  return (
    a.length === b.length &&
    a.every((rel, i) => rel === b[i] && ws.files[rel] === base.files[rel])
  );
}

function evaluateGenerated(check, ctx, observed) {
  const outDir = ctx.project.outDir.replace(/^\.\//, '').replace(/\/$/, '');
  const statePath = stateFileFor(outDir);
  const ws = readGeneration(ctx.workspaceDir, outDir, statePath);
  const base = readGeneration(ctx.baselineDir, outDir, statePath);
  const fresh = observed.compile?.ok
    ? readGeneration(ctx.scratchWorkspace, outDir, statePath)
    : null;
  if (ws.empty) {
    if (!base.empty)
      return result(
        'fail',
        'the baseline generation was deleted and not regenerated',
      );
    return check.mode === 'must-match'
      ? result('fail', 'never generated: no compiler output')
      : result('pass', null, {
          note: 'never generated (the baseline had no generation either)',
        });
  }
  const untouched = sameAsBaseline(ws, base);
  if (check.mode !== 'must-match' && untouched)
    return result('pass', null, { note: 'baseline generation untouched' });
  if (fresh == null)
    return result(
      'blocked',
      'fresh compilation failed; a changed generation cannot be compared',
    );
  const problems = sameAsFresh(ws, fresh);
  if (problems.length === 0)
    return result('pass', null, {
      note: 'fresh compiler generation',
      files: Object.keys(ws.files).length,
    });
  return result(
    'fail',
    `generated output is not compiler output: ${problems.slice(0, 8).join('; ')}`,
    problems,
  );
}

function evaluateTranscript(check, transcript) {
  if (transcript == null)
    return result(
      'unmeasured',
      'no normalized transcript was supplied by the runner',
    );
  const commands = transcript
    .filter((e) => e.type === 'command')
    .map((e) => e.command ?? '');
  const failures = [];
  for (const pattern of check.forbid ?? []) {
    const re = new RegExp(pattern);
    const hit = commands.find((c) => re.test(c));
    if (hit != null)
      failures.push(`forbidden command /${pattern}/ ran: ${hit.slice(0, 120)}`);
  }
  for (const pattern of check.require ?? []) {
    if (!commands.some((c) => new RegExp(pattern).test(c)))
      failures.push(`required command /${pattern}/ never ran`);
  }
  return failures.length > 0
    ? result('fail', failures.join('; '))
    : result('pass', null, { commands: commands.length });
}

function runHostBuild(check, ctx, options) {
  if (options.hostCommands !== true)
    return result('unmeasured', 'host commands disabled for this evaluation');
  const pm = ctx.environment.packageManager ?? 'npm';
  const child = spawnSync(pm, ['run', check.script ?? 'build'], {
    cwd: ctx.hostScratch,
    encoding: 'utf8',
    timeout: (check.timeoutSeconds ?? 300) * 1000,
    env: { ...process.env, CI: '1', NODE_ENV: 'production' },
  });
  return child.status === 0
    ? result('pass', null, { exit: 0 })
    : result(
        'fail',
        `${pm} run ${check.script ?? 'build'} exited ${child.status ?? child.signal}`,
        { tail: `${child.stdout}\n${child.stderr}`.slice(-1500) },
      );
}

function scopeContext(ctx) {
  const ignored = [
    ...ALWAYS_IGNORED,
    ...(ctx.permissions.harnessIgnored ?? []),
  ];
  const before = snapshotTree(ctx.baselineDir, { exclude: ignored });
  const after = snapshotTree(ctx.workspaceDir, { exclude: ignored });
  const diff = diffSnapshots(before, after);
  diff.symlinks = [...diff.added, ...diff.modified].filter((rel) =>
    after[rel].startsWith('symlink:'),
  );
  return diff;
}

function evaluateScopeDiff(check, ctx) {
  const diff = ctx.diff;
  const writable = compileGlobs(ctx.permissions.writable ?? []);
  const protectedGlobs = compileGlobs(ctx.permissions.protected ?? []);
  const violations = [];
  for (const rel of diff.symlinks ?? [])
    violations.push(`symbolic link written: ${rel}`);
  for (const rel of [...diff.added, ...diff.modified]) {
    if (protectedGlobs.match(rel) != null)
      violations.push(`protected path written: ${rel}`);
    else if (writable.match(rel) == null)
      violations.push(`write outside permitted files: ${rel}`);
  }
  for (const rel of diff.deleted) {
    if (
      protectedGlobs.match(rel) != null ||
      !ctx.permissions.allowDelete ||
      writable.match(rel) == null
    ) {
      violations.push(`deleted: ${rel}`);
    }
  }
  const changes =
    diff.added.length + diff.modified.length + diff.deleted.length;
  if (check.expectChanges === 'none' && changes > 0)
    violations.push(`expected no workspace change, found ${changes}`);
  if (check.expectChanges === 'some' && changes === 0)
    violations.push('expected at least one workspace change, found none');
  return violations.length > 0
    ? result('fail', violations.join('; '), diff)
    : result('pass', null, diff);
}

function evaluateUnchanged(check, ctx) {
  const before = snapshotTree(ctx.baselineDir, { exclude: ALWAYS_IGNORED });
  const after = snapshotTree(ctx.workspaceDir, { exclude: ALWAYS_IGNORED });
  const diff = diffSnapshots(before, after);
  const touched = [...diff.added, ...diff.modified, ...diff.deleted].filter(
    (rel) => matchesAny(check.paths, rel),
  );
  return touched.length > 0
    ? result('fail', `changed: ${touched.join(', ')}`)
    : result('pass');
}

function evaluateFileContains(check, ctx) {
  const text = readText(path.join(ctx.workspaceDir, check.path));
  if (check.exists === false)
    return text == null
      ? result('pass')
      : result('fail', `${check.path} must not exist`);
  if (text == null) return result('fail', `${check.path} does not exist`);
  const failures = [];
  for (const p of check.patterns ?? [])
    if (!new RegExp(p, 'm').test(text)) failures.push(`missing /${p}/`);
  for (const p of check.absent ?? [])
    if (new RegExp(p, 'm').test(text)) failures.push(`must not contain /${p}/`);
  return failures.length > 0
    ? result('fail', failures.join('; '))
    : result('pass');
}

function aggregate(statuses) {
  if (statuses.length === 0) return 'not-applicable';
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.includes('unmeasured')) return 'unmeasured';
  return 'pass';
}

// Every class name the compiler emitted (atomic and theme classes).
function compilerClasses(css) {
  const out = new Set();
  for (const m of css.matchAll(/\.((?:\\.|[\w-])+)/g))
    out.add(m[1].replace(/\\(.)/g, '$1'));
  return out;
}

// Final-state checks on the committed DOM: no inline style, no style sheet
// element, and no class the compiler did not emit (raw classes would bypass
// the design system through global CSS).
// The sandbox's structured snapshot of the committed DOM, as the node shape
// the selectors and the cascade use. Serialized markup is never re-parsed:
// raw-text elements serialize their text unescaped, so a re-parse could see
// elements that do not exist.
function committedTree(snapshot) {
  const root = { tag: '#root', attributes: {}, children: [], parent: null };
  const build = (items, parent, depth) => {
    if (!Array.isArray(items) || depth > 256)
      throw new Error('malformed committed DOM snapshot');
    for (const item of items) {
      if (typeof item?.x === 'string') {
        // Adjacent text nodes render as one run of text.
        const last = parent.children[parent.children.length - 1];
        if (last?.tag === '#text') last.text += item.x;
        else parent.children.push({ tag: '#text', text: item.x, parent });
        continue;
      }
      if (typeof item?.t !== 'string' || !Array.isArray(item.a))
        throw new Error('malformed committed DOM snapshot');
      const attributes = {};
      for (const pair of item.a) {
        if (
          !Array.isArray(pair) ||
          typeof pair[0] !== 'string' ||
          typeof pair[1] !== 'string'
        )
          throw new Error('malformed committed DOM snapshot');
        attributes[pair[0]] = pair[1];
      }
      const element = { tag: item.t, attributes, children: [], parent };
      parent.children.push(element);
      build(item.c, element, depth + 1);
    }
  };
  build(snapshot, root, 0);
  return root;
}

function committedDomViolations(snapshot, knownClasses) {
  let tree;
  try {
    tree = committedTree(snapshot);
  } catch (error) {
    return [`committed DOM is not readable: ${error.message}`];
  }
  const out = [];
  for (const el of elements(tree)) {
    if (Object.hasOwn(el.attributes, 'style'))
      out.push(`committed <${el.tag}> carries a style attribute`);
    if (el.tag === 'style' || el.tag === 'link')
      out.push(`committed <${el.tag}> element`);
    for (const cls of classList(el)) {
      if (!knownClasses.has(cls))
        out.push(`committed class "${cls}" was not emitted by the compiler`);
    }
  }
  return out;
}

function observeProject({
  ctx,
  project,
  checks,
  renders,
  needsCompile,
  needsDefinition,
  scratch,
  options,
}) {
  const trusted = options.trustedNodeModules ?? null;
  const outExclude = project.outDir
    ? [`${project.outDir.replace(/^\.\//, '').replace(/\/$/, '')}/**`]
    : [];
  prepareScratch(ctx.workspaceDir, ctx.scratchWorkspace, outExclude, trusted);
  const observed = { renders: {} };
  const loadDefinition = (dir) =>
    fs.existsSync(path.join(dir, project.definition))
      ? loadDefinitionData(dir, project.definition)
      : { error: `PMS_ORACLE_DEFINITION_MISSING: ${project.definition}` };
  const after = loadDefinition(ctx.scratchWorkspace);
  if (needsDefinition) {
    const baselineScratch = path.join(scratch, 'baseline');
    prepareScratch(ctx.baselineDir, baselineScratch, outExclude, trusted);
    const before = loadDefinition(baselineScratch);
    observed.vocabulary = {
      before:
        before.error != null
          ? { error: before.error }
          : flattenDefinition(before.data),
      after:
        after.error != null
          ? { error: after.error }
          : flattenDefinition(after.data),
    };
  }
  if (!needsCompile) return observed;
  const worker = runWorker(
    {
      workspaceDir: ctx.scratchWorkspace,
      project,
      definitionData: after.data ?? null,
      definitionError: after.error ?? null,
      tokenProbes: collectTokenExpectations(checks),
    },
    scratch,
    (options.workerTimeoutSeconds ?? 180) * 1000,
  );
  if (worker.error != null) return { ...observed, error: worker.error };
  Object.assign(observed, worker);
  if (!worker.compile?.ok) return observed;
  observed.tokenVars = {};
  observed.themeClasses = {};
  const probe = worker.probe;
  if (probe?.url != null) {
    const out = runSandbox(
      {
        mode: 'probe',
        workspaceDir: ctx.scratchWorkspace,
        overrides: { [probe.url]: probe.javascript },
        probeUrl: probe.url,
      },
      { timeoutMs: (options.renderTimeoutSeconds ?? 60) * 1000 },
    );
    if (!out.ok)
      return { ...observed, error: `vocabulary probe failed: ${out.error}` };
    const classes = JSON.parse(out.payload);
    observed.themeClasses = classes.themeClasses ?? {};
    const rules = parseCss(probe.css ?? '');
    probe.accepted.forEach((t, i) => {
      const own = String(classes.tokenClasses?.[`t${i}`] ?? '').split(/\s+/);
      let variable = null;
      for (const rule of rules) {
        for (const selector of rule.selectors) {
          const cls = selector.parts?.find((p) => p.type === 'class')?.name;
          const v = /^var\((--[\w-]+)\)$/.exec(
            rule.declarations[0]?.value ?? '',
          );
          if (cls != null && own.includes(cls) && v) variable = v[1];
        }
      }
      observed.tokenVars[t] = variable;
    });
  }
  for (const t of probe?.rejected ?? []) observed.tokenVars[t] = null;
  delete observed.probe;
  // All scenarios of one evaluation render in one sandbox process; each gets
  // its own DOM window and its own instances of workspace modules.
  const list = [...renders.values()];
  const knownClasses = compilerClasses(observed.css ?? '');
  if (list.length > 0) {
    const out = runSandbox(
      {
        mode: 'render',
        workspaceDir: ctx.scratchWorkspace,
        overrides: worker.overrides,
        themeClasses: observed.themeClasses,
        scenarios: list.map((r) => ({
          render: r.render,
          interactions: r.interactions,
        })),
      },
      { timeoutMs: (options.renderTimeoutSeconds ?? 120) * 1000 },
    );
    let results = null;
    if (out.ok) {
      try {
        results = JSON.parse(out.payload).scenarios;
      } catch (error) {
        out.error = `sandbox payload is not JSON: ${error.message}`;
      }
    }
    list.forEach((r, i) => {
      const scenario = results?.[i];
      if (scenario == null) {
        observed.renders[r.id] = {
          error: out.error ?? 'scenario missing from sandbox result',
          violations: CODE_GENERATION_ERROR.test(out.error ?? '')
            ? ['code generation from strings']
            : [],
        };
        return;
      }
      const violations = [...(scenario.violations ?? [])];
      if (scenario.error != null && CODE_GENERATION_ERROR.test(scenario.error))
        violations.push('code generation from strings');
      if (scenario.tree != null)
        violations.push(...committedDomViolations(scenario.tree, knownClasses));
      observed.renders[r.id] = {
        ...scenario,
        violations,
        error:
          scenario.error ??
          (scenario.tree == null ? 'nothing was committed' : null),
      };
    });
  }
  delete observed.overrides;
  return observed;
}

/**
 * @param {object} args
 * @param {object} args.task Parsed task definition.
 * @param {object} args.fixture Parsed fixture metadata.
 * @param {string} args.epoch Product/vocabulary epoch to evaluate against.
 * @param {string} args.baselineDir Materialized state the agent started from
 *   (including harness-applied concurrent events).
 * @param {string} args.workspaceDir Final workspace state.
 * @param {string|null} args.responseText Final agent message.
 * @param {Array|null} args.transcript Normalized events or null.
 * @param {object|null} args.observations Runner observations or null.
 */
export async function evaluateTask({
  task,
  fixture,
  epoch,
  baselineDir,
  workspaceDir,
  responseText = null,
  transcript = null,
  observations = null,
  scratchRoot = os.tmpdir(),
  options = {},
}) {
  const base = {
    schema: 'pms-eval-result/v1',
    taskId: task.id,
    split: task.split,
    workflow: task.workflow,
    caseType: task.caseType,
    epoch,
  };
  const expectation = task.expectations?.[epoch];
  if (expectation == null) {
    return {
      ...base,
      verdict: 'not-evaluable',
      reason: `task has no expectation for epoch ${epoch}`,
      checks: [],
      outcomes: {},
    };
  }
  const project = task.project ?? fixture.project ?? null;
  const scratch = fs.mkdtempSync(
    path.join(scratchRoot, `pms-oracle-${task.id}-`),
  );
  const ctx = {
    task,
    project,
    baselineDir,
    workspaceDir,
    permissions: task.permissions,
    environment: task.environment,
    scratchWorkspace: path.join(scratch, 'ws'),
    hostScratch: path.join(scratch, 'host'),
  };
  ctx.diff = scopeContext(ctx);
  const checks = expectation.checks;
  const needsCompile = checks.some((c) =>
    ['compile.project', 'render.styles', 'generated.consistent'].includes(
      c.kind,
    ),
  );
  const needsDefinition = checks.some((c) => c.kind === 'definition.diff');
  const renders = new Map();
  for (const c of checks.filter((c) => c.kind === 'render.styles')) {
    const key = renderKey(c);
    if (!renders.has(key)) {
      renders.set(key, {
        id: `r${renders.size}`,
        render: c.render,
        interactions: c.interactions ?? [],
      });
    }
    c.renderId = renders.get(key).id;
  }
  let observed = {};
  if ((needsCompile || needsDefinition) && project != null) {
    observed = observeProject({
      ctx,
      project,
      checks,
      renders,
      needsCompile,
      needsDefinition,
      scratch,
      options,
    });
    if (observed.css != null) observed.cssRules = parseCss(observed.css);
  }
  const reportExtraction = extractReport(responseText);

  const evaluated = [];
  for (const check of checks) {
    let r;
    try {
      if (
        observed.error != null &&
        [
          'compile.project',
          'render.styles',
          'generated.consistent',
          'definition.diff',
        ].includes(check.kind)
      ) {
        r = result('error', observed.error);
      } else {
        switch (check.kind) {
          case 'scope.diff':
            r = evaluateScopeDiff(check, ctx);
            break;
          case 'scope.unchanged':
            r = evaluateUnchanged(check, ctx);
            break;
          case 'files.contains':
            r = evaluateFileContains(check, ctx);
            break;
          case 'compile.project': {
            const c = observed.compile;
            if (c == null) r = result('error', 'compilation was not observed');
            else {
              const codes = c.diagnostics.map((d) => d.code);
              if (check.expect === 'ok') {
                r = c.ok
                  ? result('pass', null, { coveredModules: c.coveredModules })
                  : result(
                      'fail',
                      `diagnostics: ${codes.join(', ')}`,
                      c.diagnostics,
                    );
              } else {
                const missing = (check.diagnosticCodes ?? []).filter(
                  (code) => !codes.includes(code),
                );
                r =
                  !c.ok && missing.length === 0
                    ? result('pass', null, codes)
                    : result(
                        'fail',
                        c.ok
                          ? 'compilation unexpectedly succeeded'
                          : `missing diagnostics ${missing.join(', ')}`,
                        codes,
                      );
              }
            }
            break;
          }
          case 'render.styles':
            r = observed.compile?.ok
              ? evaluateRender(check, observed)
              : result('blocked', 'compilation failed; nothing was rendered');
            break;
          case 'generated.consistent':
            r = evaluateGenerated(check, ctx, observed);
            break;
          case 'definition.diff':
            r = evaluateDefinitionDiff(
              check,
              observed.vocabulary?.before,
              observed.vocabulary?.after,
            );
            break;
          case 'static.forbidden':
            r = evaluateForbidden(check, ctx, observed);
            break;
          case 'static.host-config':
            r = evaluateHostConfig(check, ctx);
            break;
          case 'static.package-json':
            r = evaluatePackageJson(check, ctx);
            break;
          case 'host.build':
            // Runs last (below): it executes agent-controlled scripts.
            r = null;
            break;
          case 'report.final':
            if (reportExtraction.report == null)
              r = result('fail', reportExtraction.error);
            else {
              const failures = checkReport(check, reportExtraction.report);
              r =
                failures.length > 0
                  ? result('fail', failures.join('; '))
                  : result('pass');
            }
            break;
          case 'transcript.commands':
            r = evaluateTranscript(check, transcript);
            break;
          case 'observation.runner': {
            const value = observations?.[check.observation];
            r =
              value === undefined
                ? result(
                    'unmeasured',
                    `runner did not supply observation ${check.observation}`,
                  )
                : JSON.stringify(value) === JSON.stringify(check.expect)
                  ? result('pass', null, value)
                  : result(
                      check.invalidatesRun ? 'error' : 'fail',
                      `observation ${check.observation} is ${JSON.stringify(value)}${check.invalidatesRun ? ' (harness precondition not met: run is invalid)' : ''}`,
                      value,
                    );
            break;
          }
          case 'visual.fidelity': {
            const value = observations?.[`visual:${check.id}`];
            r =
              value == null
                ? result(
                    'unmeasured',
                    'no visual fidelity measurement exists for this epoch; never counted as passed',
                  )
                : result(value === 'pass' ? 'pass' : 'fail', null, value);
            break;
          }
          default:
            r = result('error', `unknown check kind ${check.kind}`);
        }
      }
    } catch (error) {
      r = result('error', String(error?.stack ?? error).slice(0, 1500));
    }
    evaluated.push({
      id: check.id,
      kind: check.kind,
      class: check.class,
      required: check.required,
      ...r,
    });
  }
  // Host builds execute agent-controlled scripts, so they run after every
  // other observation, in their own copy, and can only decide their own check.
  for (const entry of evaluated.filter((e) => e.kind === 'host.build')) {
    const check = checks.find((c) => c.id === entry.id);
    let r;
    try {
      if (options.hostCommands === true)
        prepareScratch(
          workspaceDir,
          ctx.hostScratch,
          [],
          options.trustedNodeModules ?? null,
        );
      r = runHostBuild(check, ctx, options);
    } catch (error) {
      r = result('error', String(error?.stack ?? error).slice(0, 1500));
    }
    Object.assign(entry, r);
  }

  const outcomes = {};
  for (const cls of CHECK_CLASSES) {
    outcomes[cls] = aggregate(
      evaluated.filter((c) => c.class === cls).map((c) => c.status),
    );
  }
  const required = evaluated.filter((c) => c.required);
  let verdict = aggregate(required.map((c) => c.status));
  if (verdict === 'blocked') verdict = 'fail';
  if (verdict === 'not-applicable') verdict = 'error';
  if (!options.keepScratch)
    fs.rmSync(scratch, { recursive: true, force: true });
  return {
    ...base,
    classification: expectation.classification,
    intendedOutcome: expectation.intendedOutcome.kind,
    verdict,
    // Application success and correct diagnosis of a gap are scored apart.
    success: {
      application:
        expectation.intendedOutcome.kind === 'application-success' ||
        expectation.intendedOutcome.kind === 'integration-success'
          ? verdict === 'pass'
          : null,
      diagnosis: [
        'capability-gap-diagnosis',
        'vocabulary-gap-diagnosis',
        'conflict-diagnosis',
        'clarification',
        'refusal',
      ].includes(expectation.intendedOutcome.kind)
        ? verdict === 'pass'
        : null,
      report:
        expectation.intendedOutcome.kind === 'read-only-report'
          ? verdict === 'pass'
          : null,
    },
    outcomes,
    scope: ctx.diff,
    compile:
      observed.compile == null
        ? null
        : {
            ok: observed.compile.ok,
            diagnosticCodes: observed.compile.diagnostics.map((d) => d.code),
            compilerVersion: observed.compilerVersion ?? null,
          },
    report:
      reportExtraction.report == null
        ? { present: false, error: reportExtraction.error }
        : {
            present: true,
            outcome: reportExtraction.report.outcome,
            gaps: reportExtraction.report.gaps,
          },
    checks: evaluated,
  };
}
