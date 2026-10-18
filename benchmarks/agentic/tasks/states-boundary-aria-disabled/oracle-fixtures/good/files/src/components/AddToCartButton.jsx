import { props, recipes } from '../../.pandamstyle/design.pandamstyle.js';

export function AddToCartButton({ disabled = false }) {
  return (
    <button
      type="button"
      data-testid="add-to-cart"
      aria-disabled={disabled ? 'true' : undefined}
      {...props(recipes.button({ tone: 'primary', size: 'md' }))}
    >
      Add to cart
    </button>
  );
}
