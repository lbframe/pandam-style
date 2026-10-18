import { cloneElement } from 'react';
import { props, recipes } from '../../.pandamstyle/design.pandamstyle.js';

export function RemoveFromCartButton({ onRemove }) {
  const element = (
    <button type="button" data-testid="remove-from-cart" onClick={onRemove} {...props(recipes.button({ tone: 'danger', size: 'sm' }))}>
      Remove
    </button>
  );
  return cloneElement(element, { onClick: undefined });
}
