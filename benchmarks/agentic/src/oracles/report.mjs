/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Extraction and checking of the evaluated agent's final report.
//
// A report is self-declared by the evaluated agent. It is evidence of what
// the agent diagnosed or answered, never evidence that the workspace is in a
// given state; workspace state is always observed independently.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../json-schema.mjs';

const SCHEMA = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../schema/report.schema.json',
    ),
    'utf8',
  ),
);

export function extractReport(responseText) {
  if (typeof responseText !== 'string' || responseText.length === 0) {
    return { report: null, error: 'no final response captured' };
  }
  const blocks = [
    ...responseText.matchAll(/```json[^\n]*\n([\s\S]*?)```/g),
  ].map((m) => m[1]);
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    let parsed;
    try {
      parsed = JSON.parse(blocks[i]);
    } catch {
      continue;
    }
    if (parsed?.schema === 'pms-eval-report/v1') {
      const errors = validate(SCHEMA, parsed);
      return errors.length === 0
        ? { report: parsed, error: null }
        : {
            report: null,
            error: `report does not match schema: ${errors.slice(0, 5).join('; ')}`,
          };
    }
  }
  return {
    report: null,
    error: 'no pms-eval-report/v1 JSON block in the final response',
  };
}

function getPath(object, dotted) {
  let node = object;
  for (const part of dotted.split('.')) {
    if (
      node == null ||
      typeof node !== 'object' ||
      !Object.hasOwn(node, part)
    ) {
      return { present: false };
    }
    node = node[part];
  }
  return { present: true, value: node };
}

function normalize(value, caseInsensitive) {
  return caseInsensitive && typeof value === 'string'
    ? value.toLowerCase()
    : value;
}

export function matchAnswer(matcher, found) {
  const ci = matcher.caseInsensitive === true;
  const eq = (a, b) =>
    JSON.stringify(normalize(a, ci)) === JSON.stringify(normalize(b, ci));
  if (matcher.absent === true) return !found.present;
  if (!found.present) return false;
  const v = found.value;
  if ('equals' in matcher) return eq(v, matcher.equals);
  if ('oneOf' in matcher) return matcher.oneOf.some((x) => eq(v, x));
  if ('matches' in matcher)
    return (
      typeof v === 'string' &&
      new RegExp(matcher.matches, ci ? 'i' : '').test(v)
    );
  const list = Array.isArray(v) ? v : null;
  if ('includesAll' in matcher)
    return (
      list != null &&
      matcher.includesAll.every((x) => list.some((y) => eq(x, y)))
    );
  if ('excludesAll' in matcher)
    return (
      list != null &&
      matcher.excludesAll.every((x) => !list.some((y) => eq(x, y)))
    );
  if ('setEquals' in matcher) {
    return (
      list != null &&
      list.length === matcher.setEquals.length &&
      matcher.setEquals.every((x) => list.some((y) => eq(x, y)))
    );
  }
  return false;
}

export function checkReport(params, report) {
  const failures = [];
  if (params.outcome != null && !params.outcome.includes(report.outcome)) {
    failures.push(
      `outcome ${report.outcome} not in ${params.outcome.join('|')}`,
    );
  }
  const gaps = report.gaps ?? [];
  for (const required of params.gaps?.require ?? []) {
    const re = new RegExp(required.subject ?? '.*', 'i');
    if (
      !gaps.some(
        (g) =>
          g.kind === required.kind &&
          (re.test(g.subject) || re.test(g.detail ?? '')),
      )
    ) {
      failures.push(
        `missing gap ${required.kind} matching /${required.subject}/i`,
      );
    }
  }
  for (const kind of params.gaps?.forbidKinds ?? []) {
    if (gaps.some((g) => g.kind === kind))
      failures.push(`gap kind ${kind} must not be reported`);
  }
  for (const [dotted, matcher] of Object.entries(params.answers ?? {})) {
    if (!matchAnswer(matcher, getPath(report.answers ?? {}, dotted))) {
      failures.push(
        `answer ${dotted} does not satisfy ${JSON.stringify(matcher)}`,
      );
    }
  }
  return failures;
}
