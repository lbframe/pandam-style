/**
 * PandamStyle — référence de token (ARC-06 : TokenRef de l'IR).
 * Marqueur produit uniquement par `token(path)` ; une chaîne `var(--x)`
 * ou un cast ne crée pas cette preuve.
 */

const TOKEN_REF = Symbol.for('pandamstyle.tokenRef');

export function token(path) {
  if (typeof path !== 'string' || path === '') {
    throw new Error('token(path) attend un chemin complet, ex. spacing.md');
  }
  return Object.freeze({ [TOKEN_REF]: path });
}

export function isTokenRef(value) {
  return (
    value !== null && typeof value === 'object' && TOKEN_REF in value === true
  );
}

export function tokenRefPath(value) {
  return value[TOKEN_REF];
}
