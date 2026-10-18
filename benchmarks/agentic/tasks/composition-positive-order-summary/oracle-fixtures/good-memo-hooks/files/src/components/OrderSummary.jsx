import { useCallback, useMemo } from 'react';
import { props, recipes } from '../../.pandamstyle/design.pandamstyle.js';

export function OrderSummary({ items }) {
  const visible = useMemo(() => items.filter((i) => i.quantity > 0), [items]);
  const label = useCallback((i) => `${i.quantity} x ${i.name}`, []);
  const card = recipes.card({ elevation: 'raised' });
  return (
    <section data-testid="order-summary" {...props(card.root)}>
      <header {...props(card.header)}>
        <h2 data-testid="order-summary-title" {...props(card.title)}>
          Order summary
        </h2>
      </header>
      <ul {...props(card.body)}>
        {visible.map((item) => (
          <li key={item.id} data-testid="order-summary-item">
            {label(item)}
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
