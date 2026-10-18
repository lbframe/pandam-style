Next migration batch: move `PromoHero` (`src/legacy/PromoHero.jsx` and its CSS
module, including its responsive padding) to PandamStyle with identical
visuals at every viewport width.

- New component: `src/ui/PromoHero.jsx`, same export, props and test ids.
- Update `src/Portal.jsx`, then delete the two legacy files.
- Use the existing design-system vocabulary only.
