/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import { propertyCategory } from '../design-system/policy/properties.js';

export const DIAGNOSTICS_RESULT_KIND = 'pandamstyle-diagnostics-result';
export const DIAGNOSTICS_RESULT_SCHEMA_VERSION = 1;
export const COMPILER_ABI_VERSION = 1;

function portablePath(value, rootDir) {
  if (typeof value !== 'string' || rootDir == null || !path.isAbsolute(value))
    return value;
  return path.relative(rootDir, value).split(path.sep).join('/');
}

function sourceOf(diagnostic, rootDir) {
  const source = diagnostic?.source;
  const location = diagnostic?.location ?? source ?? {};
  const rawFile =
    location?.file ??
    diagnostic?.context?.from ??
    diagnostic?.context?.file ??
    null;
  const file = portablePath(rawFile, rootDir);
  const rawLabel =
    typeof source === 'string' ? source : (source?.label ?? null);
  const sourceLabel =
    typeof rawLabel === 'string'
      ? rawLabel.replace(/ \((page|design-system|generated)\)$/, '')
      : null;
  return {
    source: {
      file,
      line: location?.line ?? null,
      column: location?.column ?? null,
      endLine: location?.endLine ?? null,
      endColumn: location?.endColumn ?? null,
      label: sourceLabel === rawFile ? null : sourceLabel,
    },
    role: location?.role ?? source?.role ?? null,
  };
}

function normalizeContext(value, rootDir, key = null) {
  if (Array.isArray(value))
    return value.map((entry) => normalizeContext(entry, rootDir));
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        normalizeContext(child, rootDir, childKey),
      ]),
    );
  }
  if (['file', 'from', 'to', 'source'].includes(key))
    return portablePath(value, rootDir);
  return value;
}

function repairOf(diagnostic, expected) {
  const context = diagnostic?.context ?? {};
  if (
    ['PMS_UNKNOWN_PATTERN', 'PMS_INVALID_PATTERN_PARAMETER'].includes(
      diagnostic?.code,
    )
  ) {
    return {
      kind:
        diagnostic.code === 'PMS_UNKNOWN_PATTERN'
          ? 'use-declared-pattern'
          : 'use-pattern-parameter-domain',
      applicable: true,
      target: {
        patternId: context.patternId ?? null,
        parameter: context.parameter ?? null,
      },
      expected,
      reason: null,
    };
  }
  if (diagnostic?.code === 'PMS_TOKEN_NOT_PUBLIC') {
    return {
      kind: 'replace-with-token',
      applicable: true,
      target: { property: context.property ?? null },
      expected: {
        category: expected.category,
        visibility: 'public',
      },
      reason: null,
    };
  }

  const repair = diagnostic?.repair;
  const applicable = repair?.applicable === true;
  const repairExpected = repair?.expected ?? expected;
  return {
    kind:
      diagnostic?.code === 'PMS_FORBIDDEN_VALUE'
        ? 'replace-with-token'
        : (repair?.kind ?? 'unknown'),
    applicable,
    target:
      repair?.target ??
      (context.property != null ? { property: context.property } : null),
    expected: {
      ...repairExpected,
      ...(expected.domain == null ? {} : { domain: expected.domain }),
      ...(repairExpected?.category == null && expected.category != null
        ? { category: expected.category }
        : {}),
    },
    reason: applicable
      ? null
      : (repair?.reason ?? 'no safe structured repair is available'),
  };
}

function candidatesOf(diagnostic, revision, candidateLimit) {
  const raw = Array.isArray(diagnostic?.candidates)
    ? diagnostic.candidates
    : [];
  const limit = Number.isInteger(candidateLimit)
    ? Math.max(0, candidateLimit)
    : 32;
  // Protocol v1 retains its frozen compact presentation order. The canonical
  // domain and paginated candidateTokens query retain declaration order.
  const ordered = [...raw].sort((left, right) => {
    const a = typeof left === 'string' ? left : (left?.tokenId ?? '');
    const b = typeof right === 'string' ? right : (right?.tokenId ?? '');
    return a.localeCompare(b);
  });
  const candidates = ordered.slice(0, limit).map((candidate) => {
    if (candidate != null && typeof candidate === 'object') return candidate;
    return {
      tokenId: String(candidate),
      category: diagnostic?.expected?.category ?? null,
    };
  });
  const total = Number.isInteger(diagnostic?.candidatesTotal)
    ? diagnostic.candidatesTotal
    : raw.length;
  return {
    candidates,
    candidatesTotal: total,
    candidatesTruncated: candidates.length < total,
    candidatesQuery: {
      method: 'candidateTokens',
      category: diagnostic?.expected?.category ?? null,
      offset: 0,
      limit,
      revision,
    },
  };
}

export function protocolDiagnostic(diagnostic, revision, options = {}) {
  const context = normalizeContext(diagnostic?.context ?? {}, options.rootDir);
  const contextualCategory =
    typeof context.expected === 'string'
      ? context.expected
      : (context.expected?.category ?? null);
  const expected = {
    category:
      diagnostic?.expected?.category ??
      context.category ??
      contextualCategory ??
      propertyCategory(context.property) ??
      null,
    visibility: ['PMS_TOKEN_NOT_PUBLIC', 'PMS_FORBIDDEN_VALUE'].includes(
      diagnostic?.code,
    )
      ? 'public'
      : (diagnostic?.expected?.visibility ?? context.visibility ?? null),
    static:
      diagnostic?.expected?.static ??
      context.static ??
      (diagnostic?.code === 'PMS_FORBIDDEN_VALUE' ? true : null),
    domain:
      diagnostic?.expected?.domain ??
      diagnostic?.expected?.admitted ??
      context.domain ??
      context.admitted ??
      null,
  };
  // Vocabulary is supplied by the revision's canonical snapshot. Diagnostic
  // history provides observed facts and repair operations, never a catalog.
  if (typeof options.repairDomain === 'function') {
    const tokenCodes = [
      'PMS_UNKNOWN_TOKEN',
      'PMS_INVALID_TOKEN_CATEGORY',
      'PMS_TOKEN_NOT_PUBLIC',
      'PMS_FORBIDDEN_VALUE',
    ];
    if (expected.category != null && tokenCodes.includes(diagnostic?.code)) {
      const domain =
        options.repairDomain({ kind: 'token', category: expected.category }) ??
        [];
      diagnostic = {
        ...diagnostic,
        expected: { ...diagnostic.expected, category: expected.category },
        candidates: domain.slice(
          0,
          Number.isInteger(options.candidateLimit)
            ? Math.max(0, options.candidateLimit)
            : 32,
        ),
        candidatesTotal: domain.length,
      };
    } else if (diagnostic?.code === 'PMS_UNKNOWN_CONDITION') {
      const domain =
        options.repairDomain({
          kind: context.themeName == null ? 'condition' : 'theme',
        }) ?? [];
      expected.domain = domain;
      if (context.admitted != null) context.admitted = domain;
    } else if (
      ['PMS_INVALID_VARIANT_KEY', 'PMS_INVALID_VARIANT_VALUE'].includes(
        diagnostic?.code,
      )
    ) {
      const recipe = options.repairDomain({
        kind: 'recipe',
        recipeId: context.recipeId,
      });
      const domain =
        diagnostic.code === 'PMS_INVALID_VARIANT_VALUE'
          ? (recipe?.values?.[context.axis ?? context.key] ?? [])
          : (recipe?.axes ?? []);
      expected.domain = domain;
      if (context.admitted != null) context.admitted = domain;
    }
  }
  const source = sourceOf(diagnostic, options.rootDir);
  const coverage = normalizeContext(diagnostic?.file ?? null, options.rootDir);
  const candidates = candidatesOf(diagnostic, revision, options.candidateLimit);
  return {
    schemaVersion: DIAGNOSTICS_RESULT_SCHEMA_VERSION,
    code: diagnostic?.code ?? null,
    severity: diagnostic?.severity ?? 'error',
    phase: diagnostic?.phase ?? null,
    rule: diagnostic?.rule ?? null,
    message: diagnostic?.message ?? '',
    source: source.source == null ? null : Object.freeze(source.source),
    location: source.source,
    role: source.role,
    context,
    expected,
    ...candidates,
    repair: repairOf(diagnostic, expected),
    autofix: null,
    affectedRegion: {
      file: source.source.file,
      namespace: context.namespace ?? null,
      property: context.property ?? null,
      conditionPath: context.conditionPath ?? [],
    },
    coverage: {
      analysed: coverage?.analysed === true,
      origin: coverage?.origin ?? null,
      failed: coverage?.failed === true,
    },
    revision,
  };
}

export function buildDiagnosticsResult({
  legacy,
  revision,
  designSystem,
  abiVersion = COMPILER_ABI_VERSION,
  candidateLimit,
  artifactRevision = null,
  artifactDigest = null,
  associationRevision = null,
  rootDir = null,
  repairDomain = null,
}) {
  const diagnostics = (legacy?.diagnostics ?? []).map((diagnostic) =>
    protocolDiagnostic(diagnostic, revision, {
      candidateLimit,
      rootDir,
      repairDomain,
    }),
  );
  const mode = legacy?.mutation?.mode ?? 'full-discovery';
  const fullDiscovery = legacy?.incremental?.fullDiscovery === true;
  const discovery = fullDiscovery
    ? 'full-discovery'
    : mode === 'watcher'
      ? 'watcher'
      : 'verified-explicit';
  const evidence = fullDiscovery
    ? 'filesystem-scan'
    : mode === 'watcher'
      ? 'watcher-journal'
      : 'host-reported-set';
  const affectedEntries = legacy?.coverage?.affectedEntries ?? [];
  const affectedTotal =
    legacy?.coverage?.affectedCount ?? affectedEntries.length;
  const hasCoverageGap = (legacy?.diagnostics ?? []).some(
    (diagnostic) => diagnostic?.code === 'PMS_COVERAGE_GAP',
  );
  const published = legacy?.generation?.published === true;
  const origin = artifactRevision ?? (published ? revision : null);

  return {
    documentKind: DIAGNOSTICS_RESULT_KIND,
    schemaVersion: DIAGNOSTICS_RESULT_SCHEMA_VERSION,
    revision,
    designSystem,
    abiVersion,
    ok: legacy?.ok === true,
    completeness: {
      status:
        legacy == null ? 'unknown' : hasCoverageGap ? 'partial' : 'complete',
      scope: 'declared-project',
      discovery,
      evidence,
      resyncRequired: hasCoverageGap,
    },
    diagnostics,
    diagnosticsTotal: diagnostics.length,
    diagnosticsTruncated: false,
    affected: {
      entries: affectedEntries.map((entry) => ({
        file: portablePath(entry.file, rootDir),
        role: entry.role ?? null,
      })),
      total: affectedTotal,
      truncated: affectedTotal > affectedEntries.length,
    },
    generation: {
      published,
      generationId: legacy?.generation?.generationId ?? null,
      artifactRevision: origin,
      artifactDigest: published ? artifactDigest : null,
      associationRevision: published ? (associationRevision ?? revision) : null,
    },
    milestones: {
      diagnosticsReady: legacy?.timings?.diagnosticsReady === true,
      generationReady: legacy?.timings?.generationReady === true,
      generationCommitted: legacy?.timings?.generationCommitted === true,
      auditReportReady: legacy?.timings?.auditReportReady === true,
    },
    audit: {
      requested: legacy?.audit?.requested === true,
      materialized: legacy?.audit?.ready === true,
      document: legacy?.audit?.document ?? null,
    },
    incremental: {
      fullFallback: legacy?.incremental?.fullFallback === true,
      reason: legacy?.incremental?.fullFallbackReason ?? null,
    },
  };
}
