import { props, recipes } from '../../.pandamstyle/design.pandamstyle.js';

export function AddToCartButton({ disabled = false }) {
  return (
    <button
      type="button"
      data-testid="add-to-cart"
      disabled={disabled}
      onMouseDown={(e) => { e.currentTarget.style.transform = 'translateY(1px)'; }}
      onMouseUp={(e) => { e.currentTarget.style.transform = ''; }}
      {...props(recipes.button({ tone: 'primary', size: 'md' }))}
    >
      Add to cart
    </button>
  );
}
