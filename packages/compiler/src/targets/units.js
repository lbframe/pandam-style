/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The CSS units the compiler recognizes, each with its BCD statement: the one
 * unit table. Target extraction resolves `{ kind: 'unit' }` features through
 * it, and property policy (CE-02.2) derives the units a numeric literal or
 * token may use from it, by the BCD path's `css.types.<type>` prefix.
 */

// Units with their own BCD statement. Units absent here are unrecognized.
export const UNIT_PATHS = Object.freeze({
  ...Object.fromEntries(
    ['cqw', 'cqh', 'cqi', 'cqb', 'cqmin', 'cqmax'].map((u) => [
      u,
      'css.types.length.container_query_length_units',
    ]),
  ),
  ...Object.fromEntries(
    ['dvh', 'dvw', 'dvi', 'dvb', 'dvmin', 'dvmax'].map((u) => [
      u,
      'css.types.length.viewport_percentage_units_dynamic',
    ]),
  ),
  ...Object.fromEntries(
    ['lvh', 'lvw', 'lvi', 'lvb', 'lvmin', 'lvmax'].map((u) => [
      u,
      'css.types.length.viewport_percentage_units_large',
    ]),
  ),
  ...Object.fromEntries(
    ['svh', 'svw', 'svi', 'svb', 'svmin', 'svmax'].map((u) => [
      u,
      'css.types.length.viewport_percentage_units_small',
    ]),
  ),
  ...Object.fromEntries(
    [
      'cap',
      'ch',
      'em',
      'ex',
      'ic',
      'lh',
      'rcap',
      'rch',
      'rem',
      'rex',
      'ric',
      'rlh',
      'vb',
      'vh',
      'vi',
      'vmax',
      'vmin',
      'vw',
    ].map((u) => [u, `css.types.length.${u}`]),
  ),
  q: 'css.types.length.Q',
  ...Object.fromEntries(
    ['px', 'cm', 'mm', 'in', 'pt', 'pc'].map((u) => [u, 'css.types.length']),
  ),
  ...Object.fromEntries(
    ['deg', 'grad', 'rad', 'turn'].map((u) => [u, `css.types.angle.${u}`]),
  ),
  s: 'css.types.time',
  ms: 'css.types.time',
  fr: 'css.types.flex',
  ...Object.fromEntries(
    ['dpcm', 'dpi', 'dppx', 'x'].map((u) => [u, `css.types.resolution.${u}`]),
  ),
});

/**
 * The units of a CSS dimension type (`length`, `time`, `angle`, `flex`,
 * `resolution`), from the BCD path prefix `css.types.<type>`, sorted.
 */
export function unitsOfType(type) {
  const prefix = `css.types.${type}`;
  return Object.freeze(
    Object.keys(UNIT_PATHS)
      .filter((unit) => {
        const path = UNIT_PATHS[unit];
        return path === prefix || path.startsWith(`${prefix}.`);
      })
      .sort(),
  );
}
