import { props, recipes } from '../../.pandamstyle/design.pandamstyle.js';

export function RemoveFromCartButton({ onRemove }) {
  return (
    <span>
      <template>
        <button type="button" data-testid="remove-from-cart" onClick={onRemove}>
          Remove
        </button>
      </template>
      <button type="button" data-testid="remove-from-cart" {...props(recipes.button({ tone: 'danger', size: 'sm' }))}>
        Remove
      </button>
    </span>
  );
}
