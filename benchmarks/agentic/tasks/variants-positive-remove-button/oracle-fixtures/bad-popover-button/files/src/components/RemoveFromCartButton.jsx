import { props, recipes } from '../../.pandamstyle/design.pandamstyle.js';

export function RemoveFromCartButton({ onRemove }) {
  return (
    <button popover="auto" type="button" data-testid="remove-from-cart" onClick={onRemove} {...props(recipes.button({ tone: 'danger', size: 'sm' }))}>
      Remove
    </button>
  );
}
