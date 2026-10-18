import { create, token, props, patterns } from '../../.pandamstyle/design.pandamstyle.js';
import { products } from '../data/products.js';
import { ProductCard } from '../components/ProductCard.jsx';
import { PromoBanner } from '../components/PromoBanner.jsx';

const styles = create({
  heading: {
    fontSize: token('fontSizes.lg'),
    fontWeight: token('fontWeights.bold'),
    marginBottom: token('spacing.md'),
  },
});

const page = patterns.box({ padding: { base: token('spacing.md'), wide: token('spacing.xl') } });
const grid = patterns.grid({ columns: { base: 1, wide: 3 }, gap: token('spacing.lg') });

export function ProductPage() {
  return (
    <main data-testid="product-page" {...props(page)}>
      <h1 data-testid="page-heading" {...props(styles.heading)}>
        Featured products
      </h1>
      <PromoBanner />
      <section data-testid="product-grid" {...props(grid)}>
        {products.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
      </section>
    </main>
  );
}
