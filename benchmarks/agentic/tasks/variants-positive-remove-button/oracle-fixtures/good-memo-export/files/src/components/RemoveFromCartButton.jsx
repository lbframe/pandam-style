import {memo} from 'react';
import { props, recipes } from '../../.pandamstyle/design.pandamstyle.js';

function Inner({ onRemove }) {
  return (
    <button type="button" data-testid="remove-from-cart" onClick={onRemove} {...props(recipes.button({ tone: 'danger', size: 'sm' }))}>
      Remove
    </button>
  );
}

export const RemoveFromCartButton = memo(Inner);
