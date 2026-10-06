/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The small structured error shape shared by runtime selection and composition.
 * Compiler diagnostics stay in @pandamstyle/compiler.
 */
export class PmsSelectionError extends Error {
  constructor({
    code,
    message = code,
    rule = null,
    context = {},
    expected = null,
    candidates = [],
    repair = null,
  }) {
    super(`${code}: ${message}`);
    this.name = 'PmsSelectionError';
    this.schemaVersion = 1;
    this.code = code;
    this.severity = 'error';
    this.phase = 'runtime-selection';
    this.rule = rule;
    this.context = context;
    this.expected = expected;
    this.candidates = candidates;
    this.candidatesTotal = candidates.length;
    this.candidatesTruncated = false;
    this.repair = repair ?? {
      kind: 'unknown',
      applicable: false,
      target: null,
      expected: null,
      reason: 'Runtime selection cannot authorize a source repair.',
    };
    this.autofix = null;
    this.source = null;
    this.role = null;
    this.revision = null;
    this.diagnostic = {
      schemaVersion: this.schemaVersion,
      code: this.code,
      severity: this.severity,
      phase: this.phase,
      rule: this.rule,
      context: this.context,
      expected: this.expected,
      candidates: this.candidates,
      candidatesTotal: this.candidatesTotal,
      candidatesTruncated: this.candidatesTruncated,
      repair: this.repair,
      autofix: this.autofix,
      source: this.source,
      role: this.role,
      revision: this.revision,
      message,
    };
  }
}

export function selectionError(
  code,
  message,
  rule,
  context = {},
  expected = null,
) {
  return new PmsSelectionError({ code, message, rule, context, expected });
}
