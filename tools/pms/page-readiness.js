/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';

// Repository qualification only. A browser qualification reads an element only
// after it exists in the current document. If it never appears, the failure
// names the document's URL, HTTP status and body, not a TypeError (#143).

// How long a qualification waits for a valid document, then for its qualified
// elements to exist. This is a readiness bound only; it never relaxes the
// values read afterwards.
const QUALIFIED_ELEMENT_TIMEOUT_MS = 30000;
const BODY_EXCERPT_CHARS = 600;
const RENAVIGATION_INTERVAL_MS = 500;
// The document navigated itself during page.goto, such as a Fast Refresh
// full reload.
const SELF_NAVIGATION_ERROR =
  /net::ERR_ABORTED|Navigating frame was detached|Not attached to an active page/;

// Records the last main-frame document response, including reloads the page
// performs by itself, such as a Fast Refresh full reload.
function trackDocumentResponses(page) {
  const documents = { url: null, status: null };
  page.on('response', (response) => {
    if (
      response.request().isNavigationRequest() &&
      response.frame() === page.mainFrame()
    ) {
      documents.url = response.url();
      documents.status = response.status();
    }
  });
  return documents;
}

async function describeDocument(page, selectors) {
  let missing = selectors;
  let excerpt;
  try {
    ({ missing, excerpt } = await page.evaluate(
      (candidates, limit) => ({
        missing: candidates.filter(
          (selector) => document.querySelector(selector) == null,
        ),
        // A dev error page can render its text in a shadow root only.
        excerpt: (
          document.body?.innerText.trim() ||
          document.body?.outerHTML ||
          ''
        ).slice(0, limit),
      }),
      selectors,
      BODY_EXCERPT_CHARS,
    ));
  } catch (error) {
    excerpt = `<document unreadable: ${error.message}>`;
  }
  return { missing, excerpt };
}

function documentSummary(page, documents, excerpt) {
  return (
    `url ${page.url()}; HTTP status ${documents.status ?? 'unobserved'}` +
    (documents.url != null && documents.url !== page.url()
      ? ` (for ${documents.url})`
      : '') +
    `; body ${JSON.stringify(excerpt)}`
  );
}

async function missingElementsError(page, documents, selectors, cause) {
  const { missing, excerpt } = await describeDocument(page, selectors);
  const error = new Error(
    `Qualified element(s) missing: ${(missing.length > 0 ? missing : selectors).join(', ')}; ` +
      documentSummary(page, documents, excerpt),
    cause == null ? undefined : { cause },
  );
  error.code = 'PMS_QUALIFIED_ELEMENT_MISSING';
  return error;
}

// Opens a page the caller expects to be valid: its source is valid and the
// server already answered HTTP 200. A dev server recompiling can still serve
// one document with a 5xx status, or the document can reload itself; those are
// transient and the page is navigated again until it gets a 200 document. Any
// other status fails at once, and a 5xx that persists until the bound fails
// with the document's URL, status and body. Never use it where a failure is
// the expected outcome. Returns the re-navigations, for the report.
async function gotoQualified(
  page,
  documents,
  url,
  timeout = QUALIFIED_ELEMENT_TIMEOUT_MS,
) {
  const deadline = Date.now() + timeout;
  const transient = [];
  for (;;) {
    let status = null;
    try {
      status = (await page.goto(url))?.status() ?? null;
    } catch (error) {
      if (!SELF_NAVIGATION_ERROR.test(error.message)) throw error;
      transient.push(error.message.split('\n')[0]);
    }
    if (status === 200)
      return { url, renavigations: transient.length, transient };
    if (status != null && status < 500) {
      const { excerpt } = await describeDocument(page, []);
      throw qualifiedDocumentError(page, documents, excerpt, status, transient);
    }
    if (status != null) transient.push(status);
    if (Date.now() >= deadline) {
      const { excerpt } = await describeDocument(page, []);
      throw qualifiedDocumentError(page, documents, excerpt, status, transient);
    }
    await new Promise((resolve) =>
      setTimeout(resolve, RENAVIGATION_INTERVAL_MS),
    );
  }
}

function qualifiedDocumentError(page, documents, excerpt, status, transient) {
  const error = new Error(
    `Qualified document not served: last status ${status ?? 'none'} after ` +
      `${transient.length} re-navigation(s) ${JSON.stringify(transient)}; ` +
      documentSummary(page, documents, excerpt),
  );
  error.code = 'PMS_QUALIFIED_DOCUMENT_UNAVAILABLE';
  return error;
}

// Waits for every selector in `reads` ({ key: [selector, property] }), then
// returns { key: computed value }. An element removed between the wait and the
// read also fails explicitly.
async function readComputedStyles(
  page,
  documents,
  reads,
  timeout = QUALIFIED_ELEMENT_TIMEOUT_MS,
) {
  const selectors = [
    ...new Set(Object.values(reads).map(([selector]) => selector)),
  ];
  try {
    await Promise.all(
      selectors.map((selector) => page.waitForSelector(selector, { timeout })),
    );
  } catch (error) {
    throw await missingElementsError(page, documents, selectors, error);
  }
  const { values, missing } = await page.evaluate((entries) => {
    const values = {};
    const missing = [];
    for (const [key, [selector, property]] of entries) {
      const node = document.querySelector(selector);
      if (node == null) missing.push(selector);
      else values[key] = getComputedStyle(node)[property];
    }
    return { values, missing };
  }, Object.entries(reads));
  if (missing.length > 0)
    throw await missingElementsError(page, documents, [...new Set(missing)]);
  return values;
}

module.exports = {
  QUALIFIED_ELEMENT_TIMEOUT_MS,
  BODY_EXCERPT_CHARS,
  RENAVIGATION_INTERVAL_MS,
  trackDocumentResponses,
  gotoQualified,
  readComputedStyles,
};
