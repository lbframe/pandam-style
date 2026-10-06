/**
 * A dynamic import with a LITERAL local specifier is a normal local edge.
 *
 * The P0 decision is explicit: it is resolvable, so the coverage closure follows
 * it and the lazily loaded module is analysed. `lazy.js` therefore fails the
 * build on its own inline style.
 */
export function load() {
  return import('./lazy.js');
}
