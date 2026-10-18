Design approved a new warning status (ticket DS-212):

1. Add a public semantic token `colors.status.warning` that refers to the
   existing amber color.
2. Add a `warning` value to the badge recipe's `status` axis, using that token
   as background (same structure as the other statuses).
3. Products now carry an optional `lowStock` flag. In `StockBadge`, show
   "Low stock" with the warning status when a product is in stock and
   `lowStock` is true; keep the existing behavior otherwise.

You may edit `design.pandamstyle.config.js`, `src/components/StockBadge.jsx` and
`src/components/ProductCard.jsx`. Do not change any other vocabulary.
