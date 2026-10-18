/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Renders the authored CE-00.2 reference pages in Chromium and evaluates
// their layout, text, state, keyboard, accessibility and CSP assertions, plus
// the negative controls that can be applied to a reference page. It checks
// the reference outcomes only; it is not product qualification and never
// touches the compiler.
//
//   node tests/core-evolution/check-references.mjs \
//     --playwright <directory containing node_modules/playwright-core> \
//     [--report <file>]
//
// Playwright is untrusted tooling installed outside the repository, for
// example `npm install --ignore-scripts --save-exact playwright-core@1.60.0`
// in its own directory; its Chromium 148.0.7778.96 build must be installed.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import {
  INDICATOR_PIXEL_DELTA,
  NOT_EVALUATED_KINDS,
  expectedSubjects,
  indicatorExtent,
  judge,
  pageFor,
  requiredResults,
  rowStatus,
} from './reference-judge.mjs';

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const CORPUS = 'tests/core-evolution/corpus/corpus.v1.json';
const ORACLES = 'tests/core-evolution/corpus/oracles.v1.json';
export const CHECKER = 'tests/core-evolution/check-references.mjs';
// The checker and its verdict logic are both bound into the report.
export const CHECKER_FILES = Object.freeze([
  CHECKER,
  'tests/core-evolution/reference-judge.mjs',
]);
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const BROWSER_ORACLES = new Set([
  'ORC-LAYOUT',
  'ORC-TEXT',
  'ORC-STATE',
  'ORC-KEYBOARD',
  'ORC-A11Y',
  'ORC-CSP',
]);

// ---------------------------------------------------------------------------
// Static server: serves one fixture directory with the fixture CSP header and
// optional in-memory overrides (negative-control mutations).

export function serve(dir, csp, overrides) {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(
      new URL(req.url, 'http://x').pathname,
    ).slice(1);
    const file = path.join(dir, name);
    if (!file.startsWith(dir) || (!overrides[name] && !fs.existsSync(file))) {
      res.writeHead(404).end();
      return;
    }
    const type = name.endsWith('.css')
      ? 'text/css'
      : name.endsWith('.svg')
        ? 'image/svg+xml'
        : 'text/html; charset=utf-8';
    res.writeHead(200, {
      'content-type': type,
      'content-security-policy': csp,
      'cache-control': 'no-store',
    });
    res.end(overrides[name] ?? fs.readFileSync(file));
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Mutations of a reference page (negative controls).

function mutate(postcss, files, mutation) {
  const out = {};
  const css = (name, change) => {
    const root = postcss.parse(files[name]);
    change(root);
    out[name] = root.toString();
  };
  const rule = (root) => {
    let found = null;
    root.walkRules((r) => {
      if (found == null && r.selector === mutation.selector) found = r;
    });
    return found;
  };
  switch (mutation.kind) {
    case 'remove-declaration':
      css(mutation.file, (root) =>
        rule(root)
          .nodes.filter((n) => n.prop === mutation.property)
          .forEach((n) => n.remove()),
      );
      return out;
    case 'replace-value':
      css(mutation.file, (root) =>
        rule(root)
          .nodes.filter((n) => n.prop === mutation.property)
          .forEach((n) => {
            n.value = mutation.value;
          }),
      );
      return out;
    case 'remove-rule':
      css(mutation.file, (root) => rule(root).remove());
      return out;
    case 'append-css':
      out[mutation.file] = `${files[mutation.file]}\n${mutation.css}\n`;
      return out;
    case 'set-attribute':
      out[mutation.file] = files[mutation.file].replace(
        new RegExp(`(data-testid="${mutation.target}")`),
        `$1 ${mutation.attribute}="${mutation.value}"`,
      );
      return out;
    case 'inject-style-element':
      out[mutation.file] = files[mutation.file].replace(
        '</head>',
        '<style>body { color: red; }</style>\n  </head>',
      );
      return out;
    default:
      return null; // not applicable to a reference page
  }
}

// ---------------------------------------------------------------------------
// In-page measurement helpers (serialized into the page).

const PAGE_HELPERS = `
window.__ce = {
  el(id) { return document.querySelector('[data-testid="' + id + '"]'); },
  rect(id) { const r = this.el(id).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, left: r.left, right: r.right, bottom: r.bottom }; },
  lines(id) {
    const el = this.el(id); const range = document.createRange(); range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    const vertical = getComputedStyle(el).writingMode.startsWith('vertical');
    const keys = new Map();
    for (const r of rects) { const k = Math.round(vertical ? r.left : r.top); keys.set(k, Math.max(keys.get(k) || 0, vertical ? r.height : r.width)); }
    return [...keys.values()];
  },
  columns(id) {
    const el = this.el(id); const range = document.createRange(); range.selectNodeContents(el);
    // Line-start lefts of real text fragments (hyphen fragments excluded),
    // clustered; a column needs at least two lines.
    const lefts = [...range.getClientRects()].filter((r) => r.width > 20).map((r) => Math.round(r.left)).sort((a, b) => a - b);
    const clusters = []; for (const l of lefts) { const last = clusters[clusters.length - 1]; if (last && l - last.at <= 40) last.n += 1; else clusters.push({ at: l, n: 1 }); }
    return clusters.filter((c) => c.n >= 2).length;
  },
  // Every author line break must start a new line box.
  breaks(id) {
    const el = this.el(id); const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); const out = [];
    const top = (node, i) => { const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 1); const b = r.getBoundingClientRect(); return b.top; };
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.data;
      for (let i = t.indexOf('\\n'); i >= 0; i = t.indexOf('\\n', i + 1)) {
        let k = i - 1; while (k >= 0 && /\\s/.test(t[k])) k--;
        let j = i + 1; while (j < t.length && /\\s/.test(t[j])) j++;
        if (k >= 0 && j < t.length) out.push(top(n, j) > top(n, k) + 1);
      }
    }
    return out;
  },
};`;

// ---------------------------------------------------------------------------

// Minimal PNG decoder for Chromium screenshots (8-bit RGB or RGBA,
// non-interlaced): returns { width, height, channels, pixels }.
export function decodePng(buffer) {
  let offset = 8;
  let header = null;
  const data = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR')
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        color: body[9],
        interlace: body[12],
      };
    else if (type === 'IDAT') data.push(body);
    offset += 12 + length;
  }
  if (
    header.depth !== 8 ||
    header.interlace !== 0 ||
    ![2, 6].includes(header.color)
  )
    throw new Error('unsupported PNG layout');
  const channels = header.color === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(data));
  const stride = header.width * channels;
  const pixels = Buffer.alloc(stride * header.height);
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c =
        x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[y * stride + x] = v & 255;
    }
  }
  return { width: header.width, height: header.height, channels, pixels };
}

// Counterfactual indicator pixels: pixels inside the indicator ring (the
// border box grown by the indicator extent plus 8px, minus the content box)
// that differ between screenshot A (the focused page) and screenshot B (the
// same focused page with only the indicator paint suppressed). Anything that
// hides or covers the indicator is present in both and cancels out.
export function counterfactualPixels(shotA, shotB, clip, rings) {
  const a = decodePng(shotA);
  const b = decodePng(shotB);
  if (a.width !== b.width || a.height !== b.height) return 0;
  let count = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const px = clip.x + x + 0.5;
      const py = clip.y + y + 0.5;
      const inRing = rings.some(
        ({ outer, inner }) =>
          px >= outer.left &&
          px <= outer.right &&
          py >= outer.top &&
          py <= outer.bottom &&
          !(
            px >= inner.left &&
            px <= inner.right &&
            py >= inner.top &&
            py <= inner.bottom
          ),
      );
      if (!inRing) continue;
      const i = y * a.width + x;
      for (let k = 0; k < 3; k++) {
        if (
          Math.abs(
            a.pixels[i * a.channels + k] - b.pixels[i * b.channels + k],
          ) > INDICATOR_PIXEL_DELTA
        ) {
          count += 1;
          break;
        }
      }
    }
  }
  return count;
}

// Chooses the indicator candidates once, in the focused state: the focused
// element and, when it is visually hidden (a styled sibling carries its
// indicator), its next sibling.
const SELECT_CANDIDATES = `(() => {
  const el = document.activeElement;
  const r = el.getBoundingClientRect();
  const hidden = r.width <= 1 && r.height <= 1;
  window.__ceFocused = el;
  window.__ceNodes = [el, ...(hidden && el.nextElementSibling ? [el.nextElementSibling] : [])];
})()`;

// Computed indicator styles, boxes and compositing of the candidates.
const INDICATOR_SNAPSHOT = `(() => {
  return window.__ceNodes.map((n) => {
    const s = getComputedStyle(n);
    const b = n.getBoundingClientRect();
    const px = (v) => parseFloat(v) || 0;
    const inset = {
      top: px(s.borderTopWidth) + px(s.paddingTop), right: px(s.borderRightWidth) + px(s.paddingRight),
      bottom: px(s.borderBottomWidth) + px(s.paddingBottom), left: px(s.borderLeftWidth) + px(s.paddingLeft) };
    const compositing = { opacity: 1, filterOpacity: 1, visibilityHidden: s.visibility !== 'visible',
      displayNone: false, contentVisibilityHidden: false };
    for (let e = n; e; e = e.parentElement) {
      const es = getComputedStyle(e);
      compositing.opacity *= parseFloat(es.opacity);
      for (const m of es.filter.matchAll(/opacity\\(([^)]*)\\)/g)) {
        const v = m[1].trim();
        compositing.filterOpacity *= v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v);
      }
      if (es.display === 'none') compositing.displayNone = true;
      if (e !== n && es.contentVisibility === 'hidden') compositing.contentVisibilityHidden = true;
    }
    return {
      compositing,
      focusVisible: window.__ceFocused.matches(':focus-visible'),
      style: {
        outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, outlineOffset: s.outlineOffset,
        outlineColor: s.outlineColor, boxShadow: s.boxShadow,
        borders: ['Top', 'Right', 'Bottom', 'Left'].map((side) => ({
          style: s['border' + side + 'Style'], width: s['border' + side + 'Width'], color: s['border' + side + 'Color'] })),
      },
      box: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
      content: { left: b.left + inset.left, top: b.top + inset.top, right: b.right - inset.right, bottom: b.bottom - inset.bottom },
    };
  });
})()`;

// Indicator longhands: the computed style key and the CSS property it maps to.
const INDICATOR_LONGHANDS = [
  ['outlineStyle', 'outline-style'],
  ['outlineWidth', 'outline-width'],
  ['outlineColor', 'outline-color'],
  ['outlineOffset', 'outline-offset'],
  ['boxShadow', 'box-shadow'],
];
const SIDES = ['top', 'right', 'bottom', 'left'];

// The indicator paint that focus added on one node, as the declarations that
// put it back to its unfocused computed values: each outline or box-shadow
// longhand and each border side that focus changed. With no outline or shadow
// when unfocused, this is `outline-style: none; box-shadow: none`.
export function indicatorResets(focused, unfocused) {
  const resets = INDICATOR_LONGHANDS.filter(
    ([key]) => focused[key] !== unfocused[key],
  ).map(([key, property]) => [property, unfocused[key]]);
  SIDES.forEach((side, k) => {
    const f = focused.borders[k];
    const u = unfocused.borders[k];
    if (f.style !== u.style || f.width !== u.width || f.color !== u.color)
      resets.push(
        [`border-${side}-style`, u.style],
        [`border-${side}-width`, u.width],
        [`border-${side}-color`, u.color],
      );
  });
  return resets;
}

// Suppresses only the indicator paint on the candidates, through their inline
// style with !important. Clip, masks, overlays, opacity, transforms and
// position stay exactly as focused.
function suppressIndicator(resets) {
  window.__ceSaved = window.__ceNodes.map((n) => n.getAttribute('style'));
  window.__ceNodes.forEach((n, i) => {
    for (const [property, value] of resets[i])
      n.style.setProperty(property, value, 'important');
  });
}

function restoreIndicator() {
  window.__ceNodes.forEach((n, i) => {
    const saved = window.__ceSaved[i];
    if (saved == null) n.removeAttribute('style');
    else n.setAttribute('style', saved);
  });
}

// One keyboard stop: focused and unfocused styles, compositing, whether the
// focused state was restored after the unfocused snapshot, and the
// counterfactual indicator pixels.
async function indicatorStop(page, stop, id) {
  await page.evaluate(SELECT_CANDIDATES);
  const focused = await page.evaluate(INDICATOR_SNAPSHOT);
  await page.evaluate(() => window.__ceFocused.blur());
  const unfocused = await page.evaluate(INDICATOR_SNAPSHOT);
  await page.evaluate(() => window.__ceFocused.focus());
  const refocused = await page.evaluate(INDICATOR_SNAPSHOT);
  const restored =
    JSON.stringify(refocused.map((n) => [n.style, n.box, n.focusVisible])) ===
    JSON.stringify(focused.map((n) => [n.style, n.box, n.focusVisible]));
  const rings = focused.map(({ style, box, content }) => {
    const grow = indicatorExtent(style) + 8;
    return {
      outer: {
        left: box.left - grow,
        top: box.top - grow,
        right: box.right + grow,
        bottom: box.bottom + grow,
      },
      inner: content,
    };
  });
  const viewport = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  }));
  const left = Math.max(
    0,
    Math.floor(Math.min(...rings.map((r) => r.outer.left))),
  );
  const top = Math.max(
    0,
    Math.floor(Math.min(...rings.map((r) => r.outer.top))),
  );
  const right = Math.min(
    viewport.width,
    Math.ceil(Math.max(...rings.map((r) => r.outer.right))),
  );
  const bottom = Math.min(
    viewport.height,
    Math.ceil(Math.max(...rings.map((r) => r.outer.bottom))),
  );
  const clip = { x: left, y: top, width: right - left, height: bottom - top };
  let pixels = 0;
  // An indicator entirely outside the viewport paints nothing visible.
  if (clip.width > 0 && clip.height > 0) {
    const options = { clip, animations: 'disabled', caret: 'hide' };
    const shotA = await page.screenshot(options);
    const resets = focused.map((f, i) =>
      indicatorResets(f.style, unfocused[i].style),
    );
    await page.evaluate(suppressIndicator, resets);
    const shotB = await page.screenshot(options);
    await page.evaluate(restoreIndicator);
    pixels = counterfactualPixels(shotA, shotB, clip, rings);
  }
  return {
    stop,
    id,
    focused: focused.map((n) => n.style),
    unfocused: unfocused.map((n) => n.style),
    compositing: focused.map((n) => n.compositing),
    restored,
    counterfactualPixels: pixels,
  };
}

// Measures one result kind; the verdict comes from judge().
async function measure(ctx, a, kind, want) {
  const { page, cdp } = ctx;
  const expect = a.expect;
  const el = (fn, arg) => page.evaluate(fn, arg);
  switch (kind) {
    case 'box':
    case 'minBox':
    case 'maxBox':
    case 'targetSizeMin': {
      const r = await el((id) => __ce.rect(id), a.target);
      return { width: r.width, height: r.height };
    }
    case 'noHorizontalOverflow':
      return el((id) => {
        const e = __ce.el(id);
        return { scrollWidth: e.scrollWidth, clientWidth: e.clientWidth };
      }, a.target);
    case 'scrollable':
      return el((id) => {
        const e = __ce.el(id);
        const s = getComputedStyle(e);
        return {
          x: e.scrollWidth > e.clientWidth && /auto|scroll/.test(s.overflowX),
          y: e.scrollHeight > e.clientHeight && /auto|scroll/.test(s.overflowY),
        };
      }, a.target);
    case 'stuckAfterScroll':
      return el(
        ({ id, w }) => {
          const c = __ce.el(w.container);
          if (w.axis === 'x') c.scrollLeft = w.offset;
          else c.scrollTop = w.offset;
          const cr = c.getBoundingClientRect();
          const t = __ce.el(id).getBoundingClientRect();
          return {
            scrolled: w.axis === 'x' ? c.scrollLeft : c.scrollTop,
            offset:
              w.edge === 'left'
                ? t.left - cr.left - c.clientLeft
                : t.top - cr.top - c.clientTop,
          };
        },
        { id: a.target, w: want },
      );
    case 'fixedToViewport':
      return el((id) => {
        const r = __ce.el(id).getBoundingClientRect();
        return {
          right: document.documentElement.clientWidth - r.right,
          bottom: document.documentElement.clientHeight - r.bottom,
        };
      }, a.target);
    case 'topmostAt':
      return el(
        ({ id, w }) => {
          const c = __ce.el(w.container);
          c.scrollLeft = w.scrollX;
          c.scrollTop = w.scrollY;
          const t = __ce.el(id);
          const r = t.getBoundingClientRect();
          const hit = document.elementFromPoint(
            r.left + r.width / 2,
            r.top + r.height / 2,
          );
          return {
            hit: t.contains(hit),
            scrolled: [c.scrollLeft, c.scrollTop],
          };
        },
        { id: a.target, w: want },
      );
    case 'columns':
      return el((id) => __ce.columns(id), a.target);
    case 'edgeOffset':
      return el(
        ({ id, w }) => {
          const t = __ce.el(id).getBoundingClientRect();
          const o = __ce.el(w.of).getBoundingClientRect();
          if (w.edge === 'left') return t.left - o.left;
          if (w.edge === 'right') return o.right - t.right;
          if (w.edge === 'top') return t.top - o.top;
          return o.bottom - t.bottom;
        },
        { id: a.target, w: want },
      );
    case 'lineCount':
      return (await el((id) => __ce.lines(id), a.target)).length;
    case 'preservesBreaks':
      return {
        lines: (await el((id) => __ce.lines(id), a.target)).length,
        authorBreaks: (await el((id) => __ce.breaks(id), a.target)).map(
          (honored, i) => ({ break: i, honored }),
        ),
      };
    case 'balancedLines': {
      const lines = await el((id) => __ce.lines(id), a.target);
      const ratio =
        lines.length > 1 ? Math.min(...lines) / Math.max(...lines) : 1;
      return { lines: lines.length, ratio: Number(ratio.toFixed(3)) };
    }
    case 'truncated':
      return el((id) => {
        const e = __ce.el(id);
        return {
          overflow: e.scrollWidth > e.clientWidth,
          textOverflow: getComputedStyle(e).textOverflow,
        };
      }, a.target);
    case 'noOverflow':
      return el((id) => {
        const e = __ce.el(id);
        const r = e.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(e);
        const rects = [...range.getClientRects()];
        return {
          scrollWidth: e.scrollWidth,
          clientWidth: e.clientWidth,
          textRight: Math.max(...rects.map((x) => x.right)),
          right: r.right,
        };
      }, a.target);
    case 'writingMode':
    case 'direction': {
      const prop = kind === 'writingMode' ? 'writingMode' : 'direction';
      return el(({ id, p }) => getComputedStyle(__ce.el(id))[p], {
        id: a.target,
        p: prop,
      });
    }
    case 'computed':
      return el(
        ({ id, props, on, pseudo }) => {
          const t = __ce.el(id);
          const els = on === 'cells' ? [...t.querySelectorAll('td, th')] : [t];
          return els.map((e, i) => ({
            subject: on === 'cells' ? `cell:${i}` : id,
            values: Object.fromEntries(
              props.map((p) => [
                p,
                getComputedStyle(e, pseudo || null).getPropertyValue(p),
              ]),
            ),
          }));
        },
        {
          id: a.target,
          props: Object.keys(want),
          on: expect.on,
          pseudo: expect.pseudoElement,
        },
      );
    case 'animationNone':
      return el(
        ({ id, desc }) => {
          const t = __ce.el(id);
          return (desc ? [...t.querySelectorAll('*')] : [t]).map((e, i) => ({
            subject: desc ? `descendant:${i}` : id,
            animationName: getComputedStyle(e).animationName,
          }));
        },
        { id: a.target, desc: want === 'descendants' },
      );
    case 'activates': {
      await page.focus(`[data-testid="${want.target}"]`);
      for (const key of want.keys) await page.keyboard.press(key);
      return el(
        (w) => ({
          checked: __ce.el(w.target).checked,
          computed: Object.fromEntries(
            Object.keys(w.then.computed).map((p) => [
              p,
              getComputedStyle(__ce.el(w.then.computedOn)).getPropertyValue(p),
            ]),
          ),
        }),
        want,
      );
    }
    case 'scrollsWithKeys': {
      await el(() => document.activeElement && document.activeElement.blur());
      let focused = null;
      for (let i = 0; i < 10 && focused !== want.target; i++) {
        await page.keyboard.press('Tab');
        focused = await el(
          () => document.activeElement?.getAttribute('data-testid') ?? null,
        );
      }
      const before = await el(
        (id) => [__ce.el(id).scrollLeft, __ce.el(id).scrollTop],
        want.target,
      );
      for (const key of want.keys) await page.keyboard.press(key);
      await page.waitForTimeout(300);
      const after = await el(
        (id) => [__ce.el(id).scrollLeft, __ce.el(id).scrollTop],
        want.target,
      );
      return { focused, before, after };
    }
    case 'role':
      return (await axNode(cdp, a.target)).role;
    case 'name':
      return (await axNode(cdp, a.target)).name;
    case 'contrastMin':
      return el((id) => {
        const parse = (c) => (c.match(/[\d.]+/g) || []).map(Number);
        const e = __ce.el(id);
        const fg = parse(getComputedStyle(e).color).slice(0, 3);
        let bg = null;
        let image = false;
        for (let n = e; n && !bg; n = n.parentElement) {
          const s = getComputedStyle(n);
          if (s.backgroundImage !== 'none') image = true;
          const c = parse(s.backgroundColor);
          if (c.length === 3 || (c.length === 4 && c[3] > 0))
            bg = c.slice(0, 3);
        }
        return { fg, bg: bg || [255, 255, 255], image };
      }, a.target);
    case 'visuallyHiddenButExposed': {
      const r = await el((id) => __ce.rect(id), a.target);
      const ax = await axNode(cdp, a.target);
      return { width: r.width, height: r.height, ignored: ax.ignored };
    }
    case 'violations':
      return {
        count: ctx.violations.length,
        samples: ctx.violations.slice(0, 3),
      };
    case 'styleElements':
    case 'styleAttributes':
    case 'runtimeStyleInsertions':
    case 'inlineCustomProperties':
      return el(
        (k) =>
          ({
            styleElements: document.querySelectorAll('style').length,
            styleAttributes: document.querySelectorAll('[style]').length,
            runtimeStyleInsertions:
              [...document.styleSheets].filter((s) => !s.href).length +
              document.adoptedStyleSheets.length,
            inlineCustomProperties: [
              ...document.querySelectorAll('[style]'),
            ].filter((e) => e.getAttribute('style').includes('--')).length,
          })[k],
        kind,
      );
    case 'completeFirstPaint':
      return el(() => ({
        links: document.querySelectorAll('link[rel=stylesheet]').length,
        loaded: [...document.styleSheets].filter(
          (s) => s.href && s.cssRules.length > 0,
        ).length,
        scripts: document.scripts.length,
      }));
    default:
      throw new Error(`no measurement for ${kind}`);
  }
}

// Keyboard order with per-stop :focus-visible and painted-indicator evidence.
async function measureKeyboard(ctx, want, withIndicator) {
  const { page } = ctx;
  const order = [];
  const visible = [];
  const painted = [];
  await page.evaluate(
    () => document.activeElement && document.activeElement.blur(),
  );
  for (let i = 0; i < want.length; i++) {
    await page.keyboard.press('Tab');
    const m = await page.evaluate(() => ({
      id:
        document.activeElement?.getAttribute('data-testid') ??
        document.activeElement?.tagName,
      fv: document.activeElement?.matches(':focus-visible') ?? false,
    }));
    order.push(m.id);
    visible.push({ stop: i, id: m.id, matches: m.fv });
    if (withIndicator && m.id !== 'BODY')
      painted.push(await indicatorStop(page, i, m.id));
  }
  return { order, visible, painted };
}

/** Evaluates one assertion: measurements, and verdicts from judge(). */
export async function evaluateAssertion(ctx, a) {
  const results = [];
  let keyboard = null;
  for (const [kind, want] of requiredResults(a.expect)) {
    const reason = NOT_EVALUATED_KINDS[kind];
    if (reason) {
      results.push({ kind, ok: null, reason });
      continue;
    }
    let measured;
    if (['focusOrder', 'focusVisible', 'paintedIndicator'].includes(kind)) {
      keyboard ??= await measureKeyboard(
        ctx,
        a.expect.focusOrder,
        a.expect.focusVisible === true,
      );
      measured = {
        focusOrder: keyboard.order,
        focusVisible: keyboard.visible,
        paintedIndicator: keyboard.painted,
      }[kind];
    } else {
      measured = await measure(ctx, a, kind, want);
    }
    const subjects = expectedSubjects(kind, a, ctx.pageText);
    results.push({ kind, ok: judge(kind, want, measured, subjects), measured });
  }
  return results;
}

async function axNode(cdp, id) {
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await cdp.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: `[data-testid="${id}"]`,
  });
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', {
    nodeId,
    fetchRelatives: false,
  });
  const node = nodes[0];
  return {
    role: node?.role?.value,
    name: node?.name?.value,
    ignored: node?.ignored ?? true,
  };
}

// Opens the page holding the assertion's targets in the assertion's state.
export async function openState(browser, origin, fixture, a, page) {
  const viewport =
    fixture.viewports.find((v) => v.id === a.viewport) ?? fixture.viewports[0];
  const state = a.state ?? 'rest';
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: state === 'touch',
    javaScriptEnabled: true,
  });
  const p = await context.newPage();
  const cdp = await context.newCDPSession(p);
  const violations = [];
  p.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text()))
      violations.push(m.text().split(origin).join('<origin>').slice(0, 200));
  });
  const media = {};
  if (state === 'high-contrast') media.forcedColors = 'active';
  if (state === 'reduced-motion') media.reducedMotion = 'reduce';
  if (state === 'print') media.media = 'print';
  await p.emulateMedia(media);
  if (state === 'increased-contrast')
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-contrast', value: 'more' }],
    });
  await p.goto(`${origin}/${page}`);
  // Helpers are installed through the DevTools protocol, which the page CSP
  // does not govern, so they cause no violation.
  await p.evaluate(PAGE_HELPERS);
  await p.evaluate(() => document.fonts.ready);
  if (a.target && ['pointer-hover', 'pointer-active'].includes(state)) {
    await p.hover(`[data-testid="${a.target}"]`, { force: true });
    if (state === 'pointer-active') await p.mouse.down();
  }
  if (a.target && state === 'touch' && a.oracle === 'ORC-STATE')
    await p.tap(`[data-testid="${a.target}"]`, { force: true });
  if (a.target && state === 'keyboard-focus' && a.oracle !== 'ORC-KEYBOARD') {
    for (let i = 0; i < 40; i++) {
      await p.keyboard.press('Tab');
      if (
        await p.evaluate(
          (id) => document.activeElement?.getAttribute('data-testid') === id,
          a.target,
        )
      )
        break;
    }
  }
  await p.waitForTimeout(
    state === 'pointer-hover' || state === 'touch' ? 250 : 50,
  );
  const input = fixture.inputs.find((i) => path.basename(i.path) === page);
  const pageText = fs.readFileSync(path.join(repo, input.path), 'utf8');
  return { context, page: p, cdp, violations, pageText };
}

export { rowStatus };

// Canonical JSON: sorted keys at every depth.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/**
 * Digest of everything one row verifies: the assertion (and, for a negative
 * control, the assertion it must fail), the fixture's viewports, states, CSP
 * and pinned inputs.
 */
export function assertionDigest(fixture, a) {
  const target =
    a.case === 'negative'
      ? fixture.assertions.find((x) => x.id === a.mustFail)
      : null;
  return sha256(
    canonical({
      fixture: fixture.id,
      assertion: a,
      target,
      viewports: fixture.viewports,
      states: fixture.states,
      csp: fixture.csp,
      inputs: fixture.inputs,
    }),
  );
}

/** Binding of a whole report to its verification inputs. */
export function computeBinding({ corpus, oracles, checkerSource, engine }) {
  const browserOracles = oracles.oracles.filter((o) =>
    BROWSER_ORACLES.has(o.id),
  );
  const parts = {
    fixtures: Object.fromEntries(
      corpus.fixtures.map((f) => [
        f.id,
        sha256(
          canonical({
            assertions: f.assertions.filter((a) =>
              BROWSER_ORACLES.has(a.oracle),
            ),
            viewports: f.viewports,
            states: f.states,
            csp: f.csp,
            inputs: f.inputs,
          }),
        ),
      ]),
    ),
    oracles: sha256(
      canonical({
        oracles: browserOracles,
        states: oracles.states,
        requiredInteractionStates: oracles.requiredInteractionStates,
      }),
    ),
    checker: sha256(checkerSource),
    engine,
  };
  return { ...parts, verificationSha256: sha256(canonical(parts)) };
}

export function loadBindingInputs() {
  return {
    corpus: JSON.parse(fs.readFileSync(path.join(repo, CORPUS), 'utf8')),
    oracles: JSON.parse(fs.readFileSync(path.join(repo, ORACLES), 'utf8')),
    checkerSource: CHECKER_FILES.map((f) =>
      fs.readFileSync(path.join(repo, f), 'utf8'),
    ).join('\n'),
  };
}

async function checkFixture(browser, postcss, fixture) {
  const dir = path.join(repo, path.dirname(fixture.inputs[0].path));
  const files = Object.fromEntries(
    fixture.inputs.map((i) => [
      path.basename(i.path),
      fs.readFileSync(path.join(repo, i.path), 'utf8'),
    ]),
  );
  const pages = fixture.inputs
    .filter((i) => i.role === 'reference-page')
    .map((i) => ({
      name: path.basename(i.path),
      text: files[path.basename(i.path)],
    }));
  const rows = [];
  const byId = new Map(fixture.assertions.map((a) => [a.id, a]));
  for (const a of fixture.assertions) {
    if (!BROWSER_ORACLES.has(a.oracle)) continue;
    let target = a;
    let overrides = {};
    if (a.case === 'negative') {
      target = byId.get(a.mustFail);
      overrides = mutate(postcss, files, a.mutation);
      if (overrides == null)
        throw new Error(`${a.id}: mutation ${a.mutation.kind} needs a build`);
    }
    const { server, origin } = await serve(dir, fixture.csp, overrides);
    const page = pageFor(pages, target).name;
    const session = await openState(browser, origin, fixture, target, page);
    let results;
    try {
      results = await evaluateAssertion(session, target);
    } catch (error) {
      results = [
        { kind: 'error', ok: false, measured: error.message.split('\n')[0] },
      ];
    }
    await session.context.close();
    server.close();
    const status = rowStatus(a.case, results);
    rows.push({
      id: a.id,
      fixture: fixture.id,
      oracle: a.oracle,
      case: a.case,
      page,
      state: target.state ?? 'rest',
      viewport: target.viewport,
      assertionSha256: assertionDigest(fixture, a),
      status,
      ...(a.case === 'negative'
        ? { mutation: a.mutation.kind, mustFail: a.mustFail }
        : {}),
      results,
    });
  }
  return rows;
}

async function main() {
  const index = process.argv.indexOf('--playwright');
  if (index < 0) {
    console.error(
      'Usage: check-references.mjs --playwright <dir> [--report <file>]',
    );
    process.exit(2);
  }
  const requireFrom = createRequire(
    path.join(path.resolve(process.argv[index + 1]), 'package.json'),
  );
  const { chromium } = requireFrom('playwright-core');
  const playwrightVersion = requireFrom('playwright-core/package.json').version;
  const postcss = createRequire(import.meta.url)('postcss');
  const corpus = JSON.parse(fs.readFileSync(path.join(repo, CORPUS), 'utf8'));
  const browser = await chromium.launch();
  const engine = {
    browser: 'chromium',
    version: browser.version(),
    playwrightCore: playwrightVersion,
  };
  const rows = [];
  try {
    for (const fixture of corpus.fixtures) {
      for (const row of await checkFixture(browser, postcss, fixture)) {
        rows.push(row);
        console.log(
          `${row.status.padEnd(14)} ${fixture.id} ${row.id} ${row.oracle} ${row.case}`,
        );
      }
    }
  } finally {
    await browser.close();
  }
  const tally = {};
  for (const r of rows) tally[r.status] = (tally[r.status] ?? 0) + 1;
  const report = {
    schemaVersion: 1,
    kind: 'core-evolution-reference-check',
    task: 'CE-00.2',
    engine,
    binding: computeBinding({ ...loadBindingInputs(), engine }),
    inputs: Object.fromEntries(
      corpus.fixtures
        .flatMap((f) => f.inputs)
        .map((i) => [i.path, sha256(fs.readFileSync(path.join(repo, i.path)))]),
    ),
    tally,
    rows,
  };
  const out = process.argv.indexOf('--report');
  if (out > 0)
    fs.writeFileSync(
      process.argv[out + 1],
      `${JSON.stringify(report, null, 2)}\n`,
    );
  console.log(JSON.stringify(tally));
  if (tally.fail) process.exit(1);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
