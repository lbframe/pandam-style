Install PandamStyle (Alpha 1) in this Next.js site, which uses Turbopack for
both development and production builds.

- Future PandamStyle components will live in `components/ui/`.
- Create the definition at `design.pandamstyle.config.mjs` with
  `systemId: 'docs@1'` and no vocabulary yet.
- `npm run dev` and `npm run build` must remain the entry points and must go
  through the qualified PandamStyle Turbopack commands.
- Do not change existing styling or pages.
