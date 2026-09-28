/** Reached only through `import('./lazy.js')`; still covered, still refused. */
export function Lazy() {
  return <div style={{ padding: '17px' }}>lazy</div>;
}
