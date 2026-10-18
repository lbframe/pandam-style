import { props, recipes } from '../../.pandamstyle/design.pandamstyle.js';
import { AddToCartButton } from './AddToCartButton.jsx';
import { StockBadge } from './StockBadge.jsx';

export function ProductCard({ product }) {
  const card = recipes.card({ elevation: 'flat' });
  return (
    <article data-testid={`product-card-${product.id}`} {...props(card.root)}>
      <header {...props(card.header)}>
        <h2 data-testid="product-title" {...props(card.title)}>
          {product.name}
        </h2>
        <StockBadge inStock={product.inStock} />
      </header>
      <p data-testid="product-description" {...props(card.body)}>
        {product.description}
      </p>
      <footer data-testid="product-footer" {...props(card.footer)}>
        <AddToCartButton disabled={!product.inStock} />
        <button type="button" data-testid="save-for-later" {...props(recipes.button({ tone: 'neutral', size: 'sm' }))}>
          Save for later
        </button>
      </footer>
    </article>
  );
}
