import { props, recipes } from '../../.pandamstyle/design.pandamstyle.js';

export function StockBadge({ inStock, lowStock = false }) {
  const status = !inStock ? 'danger' : lowStock ? 'danger' : 'success';
  return (
    <span data-testid="stock-badge" {...props(recipes.badge({ status }))}>
      {!inStock ? 'Sold out' : lowStock ? 'Low stock' : 'In stock'}
    </span>
  );
}
