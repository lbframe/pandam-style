import { props, recipes } from '../../.pandamstyle/design.pandamstyle.js';

const UNITS = { 1: 'x', 2: 'x' };
const counts = {};

export function OrderSummary({ items }) {
  for (const item of items) counts[item.id] = item.quantity;
  const card = recipes.card({ elevation: 'raised' });
  return (
    <section data-testid="order-summary" {...props(card.root)}>
      <header {...props(card.header)}>
        <h2 data-testid="order-summary-title" {...props(card.title)}>
          Order summary
        </h2>
      </header>
      <ul {...props(card.body)}>
        {items.map((item, index) => (
          <li key={item.id} data-testid="order-summary-item">
            {counts[items[index].id]} {UNITS[item.quantity] ?? 'x'} {items[index].name}
          </li>
        ))}
      </ul>
      <footer {...props(card.footer)}>
        <button type="button" data-testid="checkout-button" {...props(recipes.button({ tone: 'primary', fullWidth: true }))}>
          Checkout
        </button>
      </footer>
    </section>
  );
}
