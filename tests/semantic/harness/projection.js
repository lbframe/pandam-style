/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';
const hasClass = (selector, name) =>
  [...selector.matchAll(/\.([\w-]+)/g)].some((match) => match[1] === name);

// Implementation-independent: operates only on the semantic adapter interface.
function cssValue(value, variables) {
  return value
    .replace(/var\((--[\w-]+)\)/g, (whole, name) =>
      variables[name] ? `token(${variables[name]})` : whole,
    )
    .replace(/^\.(\d+)$/, '0.$1');
}

function ruleProjection(rule, css) {
  const classes = [...rule.selector.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  const themeNames = [...new Set(classes.flatMap((c) => css.themes[c] ?? []))];
  const declarations = rule.declarations.map(([p, v]) => [
    css.variables[p] ? `token(${css.variables[p]})` : p,
    cssValue(v, css.variables),
  ]);
  if (
    rule.declarations.length &&
    rule.declarations.every(([p]) => p.startsWith('--')) &&
    new Set(rule.declarations.map(([p]) => p)).size === rule.declarations.length
  )
    declarations.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    selector: rule.selector.replace(/\.[\w-]+/g, (m) =>
      css.themes[m.slice(1)] ? '.' + css.themes[m.slice(1)].join('|') : '&',
    ),
    conditions: rule.conditions,
    declarations,
    themes: themeNames,
  };
}

function project(raw) {
  const css = raw.css;
  const projected = {
    accepted: raw.accepted,
    codes: raw.codes,
    diagnostics: raw.diagnostics.map(({ message: _message, ...rest }) => rest),
    // Full structured diagnostics are retained separately; prose is never authority.
    rules: css.rules.map((r) => ruleProjection(r, css)),
    manifest: raw.manifest,
    revisionId: raw.revisionId,
    current: raw.current,
    publication: raw.publication,
    counters: raw.counters,
    protocol: raw.agent
      ? {
          ...raw.agent,
          // Older cases refer to the same revision through a flat alias. Keep
          // that assertion on the test projection while the wire envelope
          // retains the frozen full RevisionIdentity.
          revisionId: raw.agent.revision?.revisionId ?? raw.agent.revisionId,
          timings: raw.agent.timings
            ? Object.fromEntries(
                Object.entries(raw.agent.timings).filter(
                  ([key]) => !key.endsWith('_ms') && !key.endsWith('Ms'),
                ),
              )
            : undefined,
        }
      : null,
    negativeResolutionCount: raw.negativeResolutionCount,
    publicationError: raw.publicationError,
    publicationDigests: raw.publicationDigests,
    ...(raw.browser ? { browser: raw.browser } : {}),
    ...(raw.runtimeGuard ? { runtimeGuard: raw.runtimeGuard } : {}),
  };
  if (raw.coverage) projected.coverage = raw.coverage;
  if (raw.forwarding)
    projected.forwarding = raw.forwarding.map(
      ({ source, bindings, issues }) => ({
        source,
        bindings: bindings
          .filter((b) =>
            ['create', 'token', 'props', 'recipes', 'themes'].includes(
              b.imported,
            ),
          )
          .map((b) => ({
            exported: b.exported,
            imported: b.imported,
            origin: b.modulePath,
            chain: b.chain,
            kind: b.kind,
          }))
          .sort((a, b) => a.exported.localeCompare(b.exported)),
        issues,
      }),
    );
  if (raw.runtime)
    projected.runtime = Object.fromEntries(
      Object.entries(raw.runtime).map(([name, value]) => [
        name,
        {
          keys: value.keys,
          // CSS order is preserved. Hashes are replaced only by their complete rules.
          rules: value.rules.map((r) => ruleProjection(r, css)),
          classOrder: value.classes.map((c) =>
            css.rules
              .filter((r) => hasClass(r.selector, c))
              .map((r) => ruleProjection(r, css)),
          ),
        },
      ]),
    );
  const ownerName = (owner) =>
    owner.startsWith('\u0000')
      ? 'design-system'
      : owner.includes('/project/')
        ? owner.split('/project/')[1]
        : owner;
  if (raw.ownership)
    projected.owners = Object.fromEntries(
      Object.entries(raw.ownership.ownership).map(([owner, classes]) => [
        ownerName(owner),
        classes.flatMap((c) =>
          css.rules
            .filter((r) => hasClass(r.selector, c))
            .map((r) => ruleProjection(r, css)),
        ),
      ]),
    );
  if (raw.ownership)
    projected.ruleOwners = css.rules.map((rule) => ({
      rule: ruleProjection(rule, css),
      owners: Object.entries(raw.ownership.ownership)
        .filter(([, classes]) =>
          classes.some((c) => hasClass(rule.selector, c)),
        )
        .map(([owner]) => ownerName(owner))
        .sort(),
    }));
  // Exact bytes compare separately; manifest path is the only project-root substitution.
  projected.artifactBytes = raw.artifactBytes;
  return projected;
}

function comparisonView(result) {
  const view = {
    accepted: result.accepted,
    codes: result.codes,
    diagnostics: result.diagnostics,
  };
  if (result.coverage) view.coverage = result.coverage;
  if (result.forwarding) view.forwarding = result.forwarding;
  if (result.accepted) {
    view.rules = result.rules;
    view.manifest = result.manifest;
    if (result.runtime) view.runtime = result.runtime;
    if (result.browser) view.browser = result.browser;
    if (result.runtimeGuard) view.runtimeGuard = result.runtimeGuard;
    view.artifactBytes = result.artifactBytes;
  }
  return view;
}

module.exports = { project, comparisonView, ruleProjection };
