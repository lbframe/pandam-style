import { props, recipes } from '../../.pandamstyle/design.pandamstyle.js';

export function RemoveFromCartButton({ onRemove }) {
  return (
    <button type="button" data-testid="remove-from-cart" onClick={(e) => { if (e.button === 0) onRemove?.(); }} {...props(recipes.button({ tone: 'danger', size: 'sm' }))}>
      Remove
    </button>
  );
}
