import { create, props, recipes } from '../../.pandamstyle/design.pandamstyle.js';

const masks = create({ clipped: { clipPath: 'inset(50%)' } });
export function OrderSummary({ items }) {
  const card = recipes.card({ elevation: 'raised' });
  return (
    <div {...props(masks.clipped)}>
    <section data-testid="order-summary" {...props(card.root)}>
      <header {...props(card.header)}>
        <h2 data-testid="order-summary-title" {...props(card.title)}>
          Order summary
        </h2>
      </header>
      <ul {...props(card.body)}>
        {items.map((item) => (
          <li key={item.id} data-testid="order-summary-item">
            {item.quantity} x {item.name}
          </li>
        ))}
      </ul>
      <footer {...props(card.footer)}>
        <button type="button" data-testid="checkout-button" {...props(recipes.button({ tone: 'primary', fullWidth: true }))}>
          Checkout
        </button>
      </footer>
    </section>
    </div>
  );
}
