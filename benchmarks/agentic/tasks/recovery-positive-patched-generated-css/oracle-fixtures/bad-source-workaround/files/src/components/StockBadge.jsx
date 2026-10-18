import { props, recipes } from '../../.pandamstyle/design.pandamstyle.js';

export function StockBadge({ inStock }) {
  const status = inStock ? 'success' : 'neutral';
  return (
    <span data-testid="stock-badge" {...props(recipes.badge({ status }))}>
      {inStock ? 'In stock' : 'Sold out'}
    </span>
  );
}
