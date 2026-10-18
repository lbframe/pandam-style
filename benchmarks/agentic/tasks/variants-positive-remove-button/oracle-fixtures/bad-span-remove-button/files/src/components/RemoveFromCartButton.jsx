import { props, recipes } from '../../.pandamstyle/design.pandamstyle.js';

export function RemoveFromCartButton({ onRemove }) {
  return (
    <span data-testid="remove-from-cart" onClick={onRemove} {...props(recipes.button({ tone: 'danger', size: 'sm' }))}>
      Remove
    </span>
  );
}
