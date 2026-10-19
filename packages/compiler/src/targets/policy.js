/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Design-system enhancement policies (definition field `enhancements`).
 *
 * Only the design-system author declares that an emitted feature is an
 * optional progressive enhancement, and must name its fallback policy. Page
 * source cannot reach this field: it lives in the definition.
 *
 * CE-01.1 fallback kinds:
 *   degrade            the engine ignores the construct; the author accepts
 *                      the degraded result. Reported as degraded, never as
 *                      equivalent.
 *   alternative-value  part of the schema; its CSS emission is deferred to
 *                      CE-01.2 (#45) because it changes CSS bytes and identity.
 *                      Refused until then.
 */

import { featureByKey } from './catalog';
import { Codes, diagnostic } from '../protocol/diagnostics';

export const FALLBACK_KINDS = Object.freeze(['degrade', 'alternative-value']);
const POLICY_KEYS = new Set(['feature', 'fallback']);
const FALLBACK_KEYS = new Set(['kind', 'note', 'property', 'value']);

function policyError(message, context) {
  return diagnostic({
    code: Codes.INVALID_ENHANCEMENT_POLICY,
    severity: 'error',
    phase: 'targets',
    message,
    source: null,
    rule: 'targets.enhancement.policy',
    context,
  });
}

/** Normalizes `definition.enhancements`. Returns `{ enhancements, diagnostics }`. */
export function normalizeEnhancements(value) {
  const diagnostics = [];
  if (value == null) return { enhancements: [], diagnostics };
  if (!Array.isArray(value)) {
    diagnostics.push(
      policyError('`enhancements` must be a list of policies.', {
        index: null,
      }),
    );
    return { enhancements: [], diagnostics };
  }
  const out = [];
  const seen = new Set();
  value.forEach((policy, index) => {
    if (policy == null || typeof policy !== 'object' || Array.isArray(policy)) {
      diagnostics.push(
        policyError(
          'An enhancement policy is an object `{ feature, fallback }`.',
          { index },
        ),
      );
      return;
    }
    const unknown = Object.keys(policy).filter((key) => !POLICY_KEYS.has(key));
    if (unknown.length > 0) {
      diagnostics.push(
        policyError(
          `Unknown enhancement policy field(s): ${unknown.join(', ')}.`,
          { index, fields: unknown },
        ),
      );
      return;
    }
    const record = featureByKey(policy.feature);
    if (record == null) {
      diagnostics.push(
        policyError(
          `"${String(policy.feature)}" is not a feature key of the PandamStyle catalog.`,
          {
            index,
            feature: policy.feature ?? null,
          },
        ),
      );
      return;
    }
    if (seen.has(policy.feature)) {
      diagnostics.push(
        policyError(`Feature ${policy.feature} has two enhancement policies.`, {
          index,
          feature: policy.feature,
        }),
      );
      return;
    }
    const fallback = policy.fallback;
    if (
      fallback == null ||
      typeof fallback !== 'object' ||
      Array.isArray(fallback)
    ) {
      diagnostics.push(
        policyError(
          `Enhancement ${policy.feature} must declare a fallback policy.`,
          { index, feature: policy.feature },
        ),
      );
      return;
    }
    const unknownFallback = Object.keys(fallback).filter(
      (key) => !FALLBACK_KEYS.has(key),
    );
    if (!FALLBACK_KINDS.includes(fallback.kind) || unknownFallback.length > 0) {
      diagnostics.push(
        policyError(
          `Fallback of ${policy.feature} must be one of ${FALLBACK_KINDS.join(', ')} with no other field.`,
          {
            index,
            feature: policy.feature,
            fallback,
            accepted: [...FALLBACK_KINDS],
          },
        ),
      );
      return;
    }
    if (fallback.kind === 'alternative-value') {
      diagnostics.push(
        policyError(
          `Fallback "alternative-value" for ${policy.feature} is not emitted yet: its CSS emission is deferred to CE-01.2 (#45). Use "degrade" or keep the feature required.`,
          { index, feature: policy.feature, fallback, deferredTo: 'CE-01.2' },
        ),
      );
      return;
    }
    if (fallback.note != null && typeof fallback.note !== 'string') {
      diagnostics.push(
        policyError(`Fallback note of ${policy.feature} must be a string.`, {
          index,
          feature: policy.feature,
        }),
      );
      return;
    }
    seen.add(policy.feature);
    out.push({
      feature: policy.feature,
      fallback: {
        kind: 'degrade',
        ...(fallback.note == null ? {} : { note: fallback.note }),
      },
    });
  });
  out.sort((a, b) =>
    a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0,
  );
  return { enhancements: out, diagnostics };
}
