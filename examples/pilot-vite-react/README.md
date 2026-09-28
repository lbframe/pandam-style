# PandamStyle pilot (Vite + React)

Demonstrates the native compilation chain inside a real bundler pipeline.

- The app installs `@pandamstyle/compiler` from a **local `npm pack` tarball**,
  not from a workspace alias, so missing exports cannot be masked.
- `vite.config.js` declares the covered root (`./src/pages`); coverage comes
  from the declared roots and their local import closure, not from a textual
  import filter.
- The production CSS is emitted as a first-class asset and injected into
  `index.html` before the first render.
- Page files are never mutated: the compiler lowers them in memory.

This batch does **not** certify SSR, hydration, TanStack Start, or advanced HMR.
