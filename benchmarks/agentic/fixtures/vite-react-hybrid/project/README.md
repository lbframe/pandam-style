# Travel portal

Vite + React. Migration to PandamStyle is in progress:

- `src/ui/` is covered by PandamStyle (`design/system.mjs`, generated module
  in `.pandamstyle/`, never edited by hand).
- `src/legacy/` still uses CSS Modules and `legacy-tokens.css`.
- Migrate one component family per batch and keep visible output identical.
- Keep `data-testid` attributes.
