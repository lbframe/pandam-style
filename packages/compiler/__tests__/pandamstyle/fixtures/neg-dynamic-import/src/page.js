/**
 * A dynamic request that is not a static string.
 *
 * P0 has no static resolution for a computed specifier, so the module it will
 * load is unknown and therefore unanalysed. That is a coverage gap, reported as
 * such: `import(...)` and `require(...)` are never ignored silently.
 */
export function load(name) {
  return import(`./panels/${name}`);
}
