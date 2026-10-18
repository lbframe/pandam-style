import { props, recipes } from '../../.pandamstyle/design.pandamstyle.js';

export function RemoveFromCartButton({ onRemove }) {
  return (
    <span onClick={onRemove}>
    <button type="button" data-testid="remove-from-cart" {...props(recipes.button({ tone: 'danger', size: 'sm' }))}>
      Remove
    </button>
    </span>
  );
}
