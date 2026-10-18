import { props, recipes } from '../../.pandamstyle/design.pandamstyle.js';

export function PriceTag({ amount }) {
  return (
    <span data-testid="price-tag" {...props(recipes.chip({ emphasis: 'hot' }))}>
      from {amount} EUR
    </span>
  );
}
