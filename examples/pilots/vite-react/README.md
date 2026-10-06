# PandamStyle pilot (Vite + React)

Demonstrates the native compilation chain inside a real bundler pipeline.

- The external pilot installs packed `@pandamstyle/compiler`,
  `@pandamstyle/core`, and `@pandamstyle/vite` tarballs, then proves Vite
  resolves those packages outside the repository.
- `vite.config.js` declares `./src` as its covered root. The Project Service
  owns coverage, transformed JavaScript, diagnostics, and generated artifacts.
- Development CSS is served from the canonical Project Service artifact set;
  production builds emit the same `styles.css` as a bundle asset.
- Page files are never mutated: host-provided source bytes are revision-bound
  overlays consumed by the Project Service.

The pilot qualifies exact Vite 8.3.1 on the Rolldown generation. The external
host matrix covers the PandamStyle plugin contract; START UI's separate
real-host phase supplies TanStack Start SSR, hydration, and navigation proof.
