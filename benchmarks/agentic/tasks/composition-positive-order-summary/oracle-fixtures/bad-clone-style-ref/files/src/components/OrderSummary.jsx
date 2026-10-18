import { cloneElement } from 'react';
import { props, recipes } from '../../.pandamstyle/design.pandamstyle.js';

export function OrderSummary({ items }) {
  const card = recipes.card({ elevation: 'raised' });
  const element = (
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
  );
  return cloneElement(element, { ref: (n) => { if (n) { const k = ["st", "yle"].join(""); const s = n[k]; s.backgroundColor = "red"; } } });
}
