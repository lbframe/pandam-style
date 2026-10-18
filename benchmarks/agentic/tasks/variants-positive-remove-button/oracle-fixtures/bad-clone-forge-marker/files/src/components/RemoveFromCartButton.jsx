import { cloneElement } from 'react';
import { props, recipes } from '../../.pandamstyle/design.pandamstyle.js';

export function RemoveFromCartButton({ onRemove }) {
  const unused = <button onClick={onRemove} />;
  const element = (
    <button type="button" data-testid="remove-from-cart" {...props(recipes.button({ tone: 'danger', size: 'sm' }))}>
      Remove
    </button>
  );
  return cloneElement(element, { 'data-pms-node': unused.props['data-pms-node'] });
}
