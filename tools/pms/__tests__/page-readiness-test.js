/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  QUALIFIED_ELEMENT_TIMEOUT_MS,
  BODY_EXCERPT_CHARS,
  RENAVIGATION_INTERVAL_MS,
  trackDocumentResponses,
  gotoQualified,
  readComputedStyles,
} = require('../page-readiness');

const ROOT = path.resolve(__dirname, '../../..');

// A page whose evaluate() runs the real page-context function against a small
// DOM. Elements can appear late or disappear, as during a dev-server reload.
function fakePage({ url = 'http://localhost:3000/', body = '' } = {}) {
  const nodes = new Map();
  const page = new EventEmitter();
  const mainFrame = { name: 'main' };
  Object.assign(page, {
    nodes,
    body,
    waits: [],
    mainFrame: () => mainFrame,
    url: () => url,
    // Each goto takes the next planned outcome (the last one repeats): an
    // HTTP status, or an Error thrown by the navigation.
    plan: [200],
    gotos: 0,
    async goto(target) {
      const outcome = page.plan[Math.min(page.gotos++, page.plan.length - 1)];
      if (outcome instanceof Error) throw outcome;
      response(page, { url: target, status: outcome });
      return { status: () => outcome };
    },
    async waitForSelector(selector, { timeout }) {
      page.waits.push({ selector, timeout });
      const started = Date.now();
      while (!nodes.has(selector)) {
        if (Date.now() - started > timeout)
          throw Object.assign(
            new Error(`Waiting for selector \`${selector}\` failed`),
            { name: 'TimeoutError' },
          );
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      page.afterWait?.(selector);
    },
    async evaluate(fn, ...args) {
      if (page.evaluateError) throw page.evaluateError;
      const previous = [globalThis.document, globalThis.getComputedStyle];
      globalThis.document = {
        querySelector: (selector) => nodes.get(selector) ?? null,
        body: {
          innerText: page.body,
          outerHTML: `<body>${page.body}${page.shadowHost ?? ''}</body>`,
        },
      };
      globalThis.getComputedStyle = (node) => {
        if (node == null)
          throw new TypeError(
            "Failed to execute 'getComputedStyle' on 'Window': parameter 1 is not of type 'Element'.",
          );
        return node.style;
      };
      try {
        return fn(...args);
      } finally {
        [globalThis.document, globalThis.getComputedStyle] = previous;
      }
    },
  });
  return page;
}

function response(page, { url, status, navigation = true, frame }) {
  page.emit('response', {
    url: () => url,
    status: () => status,
    request: () => ({ isNavigationRequest: () => navigation }),
    frame: () => frame ?? page.mainFrame(),
  });
}

const READS = {
  padding: ['#server-style', 'padding'],
  opacity: ['#client-style', 'opacity'],
};

test('the readiness bound is one named constant used by every wait', async () => {
  expect(QUALIFIED_ELEMENT_TIMEOUT_MS).toBe(30000);
  const page = fakePage();
  page.nodes.set('#server-style', { style: { padding: '16px' } });
  page.nodes.set('#client-style', { style: { opacity: '0.5' } });
  await readComputedStyles(page, trackDocumentResponses(page), READS);
  expect(page.waits).toEqual([
    { selector: '#server-style', timeout: QUALIFIED_ELEMENT_TIMEOUT_MS },
    { selector: '#client-style', timeout: QUALIFIED_ELEMENT_TIMEOUT_MS },
  ]);
});

test('elements that appear after navigation are read once they exist, with unchanged values', async () => {
  const page = fakePage();
  const documents = trackDocumentResponses(page);
  setTimeout(() => {
    page.nodes.set('#server-style', { style: { padding: '16px' } });
  }, 20);
  setTimeout(() => {
    page.nodes.set('#client-style', { style: { opacity: '0.5' } });
  }, 40);
  // The pre-#143 read, run at the same moment, fails on the absent element.
  await expect(
    page.evaluate(
      () => getComputedStyle(document.querySelector('#server-style')).padding,
    ),
  ).rejects.toThrow(TypeError);
  await expect(readComputedStyles(page, documents, READS)).resolves.toEqual({
    padding: '16px',
    opacity: '0.5',
  });
});

test('an element that never appears fails with URL, HTTP status and body excerpt', async () => {
  const page = fakePage({
    body: 'Internal Server Error: Unexpected end of JSON input',
  });
  const documents = trackDocumentResponses(page);
  response(page, { url: 'http://localhost:3000/', status: 500 });
  page.nodes.set('#server-style', { style: { padding: '16px' } });
  const failure = readComputedStyles(page, documents, READS, 30);
  await expect(failure).rejects.toMatchObject({
    code: 'PMS_QUALIFIED_ELEMENT_MISSING',
  });
  const error = await failure.catch((value) => value);
  expect(error).not.toBeInstanceOf(TypeError);
  expect(error.message).toContain('missing: #client-style;');
  expect(error.message).not.toContain('#server-style');
  expect(error.message).toContain('url http://localhost:3000/');
  expect(error.message).toContain('HTTP status 500');
  expect(error.message).toContain('Unexpected end of JSON input');
  expect(error.cause.name).toBe('TimeoutError');
});

test('an element removed between the wait and the read fails explicitly', async () => {
  const page = fakePage({ body: 'reloading' });
  const documents = trackDocumentResponses(page);
  response(page, { url: 'http://localhost:3000/', status: 200 });
  page.nodes.set('#server-style', { style: { padding: '16px' } });
  page.nodes.set('#client-style', { style: { opacity: '0.5' } });
  let waited = 0;
  page.afterWait = () => {
    if (++waited === 2) page.nodes.delete('#server-style');
  };
  await expect(readComputedStyles(page, documents, READS)).rejects.toThrow(
    /missing: #server-style; url http:\/\/localhost:3000\/; HTTP status 200; body "reloading"/,
  );
});

test('the body excerpt is bounded and an unreadable document still fails explicitly', async () => {
  const page = fakePage({ body: 'x'.repeat(BODY_EXCERPT_CHARS * 4) });
  const documents = trackDocumentResponses(page);
  const long = await readComputedStyles(page, documents, READS, 10).catch(
    (error) => error,
  );
  expect(long.message).toContain('HTTP status unobserved');
  expect(long.message).toContain(`"${'x'.repeat(BODY_EXCERPT_CHARS)}"`);
  expect(long.message).not.toContain('x'.repeat(BODY_EXCERPT_CHARS + 1));

  page.evaluateError = new Error('Execution context was destroyed');
  const unreadable = await readComputedStyles(page, documents, READS, 10).catch(
    (error) => error,
  );
  expect(unreadable.code).toBe('PMS_QUALIFIED_ELEMENT_MISSING');
  expect(unreadable.message).toContain(
    'missing: #server-style, #client-style;',
  );
  expect(unreadable.message).toContain(
    'document unreadable: Execution context was destroyed',
  );
});

test('a blank body text falls back to the body markup, as on a Next dev error page', async () => {
  const page = fakePage({ body: '\n' });
  page.shadowHost =
    '<nextjs-portal></nextjs-portal><script id="__NEXT_DATA__">';
  const error = await readComputedStyles(
    page,
    trackDocumentResponses(page),
    READS,
    10,
  ).catch((value) => value);
  expect(error.message).toContain('body "<body>\\n<nextjs-portal>');
});

test('a transient 5xx document or self-navigation is navigated again until a 200 document', async () => {
  const page = fakePage();
  const documents = trackDocumentResponses(page);
  page.plan = [
    500,
    new Error('net::ERR_ABORTED at http://localhost:3000/\n    at navigate'),
    503,
    200,
  ];
  await expect(
    gotoQualified(page, documents, 'http://localhost:3000/'),
  ).resolves.toEqual({
    url: 'http://localhost:3000/',
    renavigations: 3,
    transient: [500, 'net::ERR_ABORTED at http://localhost:3000/', 503],
  });
  expect(page.gotos).toBe(4);
  expect(documents.status).toBe(200);
});

test('a valid document on the first navigation records no re-navigation', async () => {
  const page = fakePage();
  await expect(
    gotoQualified(page, trackDocumentResponses(page), 'http://localhost:3000/'),
  ).resolves.toEqual({
    url: 'http://localhost:3000/',
    renavigations: 0,
    transient: [],
  });
  expect(page.gotos).toBe(1);
});

test('a 500 that persists until the bound fails with URL, status and body excerpt', async () => {
  const page = fakePage({
    body: 'Internal Server Error: Unexpected end of JSON input',
  });
  const documents = trackDocumentResponses(page);
  page.plan = [500];
  const started = Date.now();
  const error = await gotoQualified(
    page,
    documents,
    'http://localhost:3000/',
    RENAVIGATION_INTERVAL_MS + 100,
  ).catch((value) => value);
  expect(Date.now() - started).toBeGreaterThanOrEqual(RENAVIGATION_INTERVAL_MS);
  expect(error.code).toBe('PMS_QUALIFIED_DOCUMENT_UNAVAILABLE');
  expect(error.message).toContain('last status 500');
  expect(error.message).toContain('url http://localhost:3000/');
  expect(error.message).toContain('HTTP status 500');
  expect(error.message).toContain('Unexpected end of JSON input');
  expect(page.gotos).toBeGreaterThan(1);
});

test('a non-transient status fails at once without re-navigation', async () => {
  const page = fakePage({ body: 'This page could not be found.' });
  page.plan = [404, 200];
  const error = await gotoQualified(
    page,
    trackDocumentResponses(page),
    'http://localhost:3000/',
  ).catch((value) => value);
  expect(error.code).toBe('PMS_QUALIFIED_DOCUMENT_UNAVAILABLE');
  expect(error.message).toContain('last status 404 after 0 re-navigation(s)');
  expect(error.message).toContain('HTTP status 404');
  expect(page.gotos).toBe(1);
});

test('a navigation error other than a self-navigation is not retried', async () => {
  const page = fakePage();
  page.plan = [
    new Error('net::ERR_CONNECTION_REFUSED at http://localhost:3000/'),
  ];
  await expect(
    gotoQualified(page, trackDocumentResponses(page), 'http://localhost:3000/'),
  ).rejects.toThrow('net::ERR_CONNECTION_REFUSED');
  expect(page.gotos).toBe(1);
});

test('only main-frame document responses set the observed status, including reloads', () => {
  const page = fakePage({ url: 'http://localhost:3000/' });
  const documents = trackDocumentResponses(page);
  response(page, { url: 'http://localhost:3000/', status: 500 });
  response(page, {
    url: 'http://localhost:3000/app.css',
    status: 404,
    navigation: false,
  });
  response(page, {
    url: 'http://localhost:3000/frame',
    status: 404,
    frame: { name: 'child' },
  });
  expect(documents).toEqual({ url: 'http://localhost:3000/', status: 500 });
  response(page, { url: 'http://localhost:3000/', status: 200 });
  expect(documents).toEqual({ url: 'http://localhost:3000/', status: 200 });
});

test('the Next qualification opens every styled page through gotoQualified', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'tools/pms/qualify-next.mjs'),
    'utf8',
  );
  expect(source).not.toMatch(/page\.goto\(/);
  expect(source.match(/await openQualified\(/g)).toHaveLength(7);
});

test('the Next qualification never dereferences a queried element without a check', () => {
  // The class from #143: a page-context read of an element that may not
  // exist yet. Reads go through readComputedStyles or a null-safe access.
  for (const file of [
    'tools/pms/qualify-next.mjs',
    'tools/pms/qualify-next-semantic-dev.mjs',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    expect({
      file,
      unchecked: source.match(
        /document\.(?:querySelector|getElementById)\([^()]*\)\s*\.|getComputedStyle\(\s*document\.(?!documentElement)/g,
      ),
    }).toEqual({ file, unchecked: null });
  }
});
