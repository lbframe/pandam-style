Next migration batch: move `PriceTag` (`src/legacy/PriceTag.jsx` and its CSS
module) to PandamStyle without changing how it looks.

- New component: `src/ui/PriceTag.jsx`, same export and props, keep the test id.
- Update `src/Portal.jsx` to use it, then delete the two legacy files.
- Use the existing design-system vocabulary only.
