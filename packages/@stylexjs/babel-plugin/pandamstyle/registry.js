/**
 * PandamStyle — registre canonique (ARC-07/ARC-08, D-03/D-04).
 * Sémantique des tokens portée de @pandacss/token-dictionary
 * (chakra-ui/panda @ 1a310482, packages/token-dictionary) : identité par chemin
 * `categorie.segment`, références entre tokens, vues par thème.
 * Émission Panda remplacée : le registre produit des entrées pour le moteur
 * du fork (defineVars/createTheme), pas de CSS propre.
 */

import { createHash } from 'crypto';
import { diagnostic, PmsError, Codes } from './diagnostics';

function canonicalize(value) {
  if (Array.isArray(value)) {
    // Ordre sémantique conservé (axisOrder, chemins de cycle…)
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = canonicalize(value[k]);
    }
    return out;
  }
  return value;
}

export function registryDigest(registryPayload) {
  const json = JSON.stringify(canonicalize(registryPayload));
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

function flattenTokens(category, node, prefix, out, diagnostics, source) {
  for (const key of Object.keys(node)) {
    if (key === '') {
      diagnostics.push(
        diagnostic({
          code: Codes.UNKNOWN_TOKEN,
          phase: 'registry',
          message: `Segment de chemin de token vide dans ${category}.`,
          source,
        }),
      );
      continue;
    }
    const path = prefix === '' ? key : `${prefix}.${key}`;
    const entry = node[key];
    if (
      entry !== null &&
      typeof entry === 'object' &&
      (typeof entry.value === 'string' ||
        typeof entry.value === 'number' ||
        typeof entry.ref === 'string')
    ) {
      const tokenId = `${category}.${path}`;
      if (out[tokenId] != null) {
        diagnostics.push(
          diagnostic({
            code: Codes.DUPLICATE_TOKEN,
            phase: 'registry',
            message: `Identifiant de token dupliqué : ${tokenId}.`,
            source,
            context: { tokenId },
          }),
        );
        continue;
      }
      out[tokenId] = {
        tokenId,
        category,
        path,
        visibility: entry.visibility === 'private' ? 'private' : 'public',
        value: entry.value != null ? String(entry.value) : null,
        ref: typeof entry.ref === 'string' ? entry.ref : null,
      };
    } else if (entry !== null && typeof entry === 'object') {
      flattenTokens(category, entry, path, out, diagnostics, source);
    } else {
      diagnostics.push(
        diagnostic({
          code: Codes.FORBIDDEN_VALUE,
          phase: 'registry',
          message: `Définition de token invalide à ${category}.${path}.`,
          source,
          context: { tokenId: `${category}.${path}` },
        }),
      );
    }
  }
}

export function buildRegistry(definition) {
  const diagnostics = [];
  const { systemId, tokens = {}, themes = {}, conditions = {}, recipes = {} } =
    definition;
  const tokensOut = {};

  for (const category of Object.keys(tokens)) {
    flattenTokens(
      category,
      tokens[category],
      '',
      tokensOut,
      diagnostics,
      definition.__source ?? 'design-system',
    );
  }

  // Résolution des références + cycles (ARC-08). Pas de fallback silencieux.
  const resolved = {};
  const visiting = [];
  const resolveToken = (tokenId) => {
    if (resolved[tokenId]) return resolved[tokenId];
    const t = tokensOut[tokenId];
    if (t == null) {
      throw new PmsError([
        diagnostic({
          code: Codes.UNKNOWN_TOKEN,
          phase: 'registry',
          message: `Référence de token inconnue : ${tokenId}.`,
          context: { tokenId, visiting: [...visiting] },
        }),
      ]);
    }
    if (visiting.includes(tokenId)) {
      throw new PmsError([
        diagnostic({
          code: Codes.TOKEN_CYCLE,
          phase: 'registry',
          message: `Cycle de références de tokens : ${[
            ...visiting.slice(visiting.indexOf(tokenId)),
            tokenId,
          ].join(' -> ')}.`,
          context: { cycle: [...visiting, tokenId] },
        }),
      ]);
    }
    visiting.push(tokenId);
    let value = t.value;
    if (t.ref != null) {
      const target = tokensOut[t.ref];
      if (target == null) {
        throw new PmsError([
          diagnostic({
            code: Codes.UNKNOWN_TOKEN,
            phase: 'registry',
            message: `Le token ${tokenId} référence ${t.ref}, absent du registre.`,
            context: { tokenId, missingRef: t.ref },
          }),
        ]);
      }
      if (target.category !== t.category) {
        throw new PmsError([
          diagnostic({
            code: Codes.INVALID_TOKEN_CATEGORY,
            phase: 'registry',
            message: `Le token ${tokenId} (${t.category}) référence ${t.ref} (${target.category}).`,
            context: { tokenId, ref: t.ref, expected: t.category, actual: target.category },
          }),
        ]);
      }
      value = resolveToken(t.ref);
    }
    visiting.pop();
    resolved[tokenId] = value;
    return value;
  };
  for (const tokenId of Object.keys(tokensOut)) {
    resolveToken(tokenId);
  }

  // Thèmes : base complète + surcharges partielles (D-04). Référence inconnue
  // dans une surcharge = erreur, jamais de fallback.
  const themeDefs = {};
  for (const themeName of Object.keys(themes)) {
    themeDefs[themeName] = {};
    const overrides = themes[themeName]?.tokens ?? {};
    const flat = {};
    for (const category of Object.keys(overrides)) {
      flattenTokens(
        category,
        overrides[category],
        '',
        flat,
        diagnostics,
        `theme:${themeName}`,
      );
    }
    for (const tokenId of Object.keys(flat)) {
      const base = tokensOut[tokenId];
      if (base == null) {
        throw new PmsError([
          diagnostic({
            code: Codes.UNKNOWN_TOKEN,
            phase: 'registry',
            message: `La surcharge ${themeName}/${tokenId} ne correspond à aucun token.`,
            context: { themeName, tokenId },
          }),
        ]);
      }
      const o = flat[tokenId];
      if (o.ref != null) {
        if (tokensOut[o.ref] == null) {
          throw new PmsError([
            diagnostic({
              code: Codes.UNKNOWN_TOKEN,
              phase: 'registry',
              message: `La surcharge ${themeName}/${tokenId} référence ${o.ref}, absent.`,
              context: { themeName, tokenId, missingRef: o.ref },
            }),
          ]);
        }
        resolved[tokenId] = resolved[tokenId]; // identité conservée
        themeDefs[themeName][tokenId] = resolveToken(o.ref);
      } else if (o.value != null) {
        themeDefs[themeName][tokenId] = o.value;
      }
    }
  }

  // Conditions : nom -> définition canonique, sous-ensemble P0 (D-14).
  const conds = {};
  for (const name of Object.keys(conditions)) {
    const c = conditions[name];
    const def = typeof c === 'string' ? c : c?.selector ?? c?.atRule;
    if (typeof def !== 'string' || def === '') {
      diagnostics.push(
        diagnostic({
          code: Codes.UNKNOWN_CONDITION,
          phase: 'registry',
          message: `Condition ${name} sans définition.`,
          context: { condition: name },
        }),
      );
      continue;
    }
    conds[name] = { name, definition: def };
  }

  // Recipes : base + axes + défauts ; axisOrder = ordre de déclaration (ARC-10).
  const recs = {};
  for (const recipeId of Object.keys(recipes)) {
    const r = recipes[recipeId];
    const unsupported = ['slots', 'compoundVariants', 'jsx'].filter(
      (k) => r[k] != null && (Array.isArray(r[k]) ? r[k].length : true),
    );
    if (unsupported.length > 0) {
      throw new PmsError([
        diagnostic({
          code: Codes.UNSUPPORTED_FEATURE,
          phase: 'registry',
          message: `Recipe ${recipeId} : capacité non livrée en P0 (${unsupported.join(', ')}).`,
          context: { recipeId, unsupported },
        }),
      ]);
    }
    const axisOrder = Object.keys(r.variants ?? {});
    recs[recipeId] = {
      recipeId,
      base: r.base ?? {},
      variants: r.variants ?? {},
      defaultVariants: r.defaultVariants ?? {},
      axisOrder,
      visibility: r.visibility === 'private' ? 'private' : 'public',
    };
  }

  const payload = { systemId, tokens: tokensOut, resolved, themeDefs, conds, recs };
  return {
    systemId,
    tokens: tokensOut,
    resolvedValues: resolved,
    themes: themeDefs,
    conditions: conds,
    recipes: recs,
    diagnostics,
    registryDigest: registryDigest(payload),
  };
}
