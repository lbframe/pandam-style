/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';

// Hand-authored semantic values. This file cannot load an implementation.
function canonicalVariables(value) {
  if (Array.isArray(value)) {
    const entries = value.map(canonicalVariables);
    if (
      entries.length &&
      entries.every(
        (v) =>
          Array.isArray(v) &&
          v.length === 2 &&
          typeof v[0] === 'string' &&
          (v[0].startsWith('token(') || v[0].startsWith('--')),
      ) &&
      new Set(entries.map((v) => v[0])).size === entries.length
    )
      entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return entries;
  }
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, canonicalVariables(v)]),
    );
  return value;
}
const check = (path, value, op = 'equal') => ({
  path,
  value: canonicalVariables(value),
  op,
});
const rule = (property, value, conditions = [], suffix = '') => ({
  conditions,
  declarations: [[property, value]],
  ...(suffix ? { selector: suffix + ':not(#\\#):not(#\\#)' } : {}),
});
const coverage = (files = ['src/page.js']) => [
  ...files.map((file) => ({ file, origin: 'root' })),
  { file: 'generated/design.pandamstyle.js', origin: 'closure:import' },
];
function accepted(rules = [], extra = []) {
  if (
    rules.some((r) => r.themes?.includes('dark')) &&
    !rules.some((r) => r.themes?.includes('base'))
  )
    rules = [baseTheme, ...rules];
  return [
    check('accepted', true),
    check('codes', []),
    ...rules.map((r) => check('runtime/result/rules', r, 'includes')),
    ...(rules.length
      ? [
          check('runtime/result/rules', rules.length, 'length'),
          check('runtime/result/keys', ['className']),
        ]
      : []),
    ...extra,
  ];
}
function rejected(code, extra = []) {
  const codes = Array.isArray(code) ? code : [code];
  return [
    check('accepted', false),
    check('codes', [...codes].sort()),
    ...extra,
  ];
}
const token = (id) => `token(${id})`;
const baselineTokens = [
  ['token(spacing.sm)', '8px'],
  ['token(spacing.md)', '16px'],
  ['token(spacing.lg)', '24px'],
  ['token(colors.ink)', '#112233'],
  ['token(colors.paper)', '#ffffff'],
  ['token(colors.text)', '#112233'],
  ['token(colors.surface)', '#ffffff'],
];
const baseTheme = { themes: ['base', 'light'], declarations: baselineTokens };
const darkTheme = {
  themes: ['dark'],
  declarations: [
    ['token(colors.surface)', '#112233'],
    ['token(colors.text)', '#ffffff'],
  ],
};
const recipeDefault = [
  rule('padding', token('spacing.md')),
  rule('color', token('colors.text')),
  rule('display', 'inline-flex'),
  rule('opacity', '0.5'),
];
const recipeSmallLoud = [
  rule('padding', token('spacing.sm')),
  rule('color', token('colors.text')),
  rule('display', 'inline-flex'),
  rule('opacity', '1'),
];
const refs = {
  api: 'docs/architecture/public-api-v0.1.md',
  abi: 'docs/architecture/generated-design-system-abi-v1.md',
  diagnostics: 'docs/architecture/diagnostics-protocol-v1.md',
  authority: 'docs/architecture/adr/0006-single-project-authority.md',
  provenance: 'docs/architecture/adr/0004-generated-import-model.md',
  deferred: 'docs/architecture/adr/0003-authoring-api.md',
};
module.exports = {
  check,
  rule,
  coverage,
  accepted,
  rejected,
  token,
  baseTheme,
  darkTheme,
  recipeDefault,
  recipeSmallLoud,
  refs,
};
