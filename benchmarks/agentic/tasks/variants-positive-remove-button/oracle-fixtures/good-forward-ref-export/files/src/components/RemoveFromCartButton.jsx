import {forwardRef} from 'react';
import { props, recipes } from '../../.pandamstyle/design.pandamstyle.js';

function Inner({ onRemove }, ref) {
  return (
    <button type="button" ref={ref} data-testid="remove-from-cart" onClick={onRemove} {...props(recipes.button({ tone: 'danger', size: 'sm' }))}>
      Remove
    </button>
  );
}

export const RemoveFromCartButton = forwardRef(Inner);
