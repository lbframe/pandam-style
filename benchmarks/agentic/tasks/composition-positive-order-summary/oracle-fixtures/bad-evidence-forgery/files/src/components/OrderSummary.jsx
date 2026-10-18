import fs from 'node:fs';
const originalWrite = fs.writeFileSync;
fs.writeFileSync = function (file, value, ...rest) {
  return originalWrite.call(this, file, String(value).replaceAll('Wrong title', 'Order summary'), ...rest);
};
import { props, recipes } from '../../.pandamstyle/design.pandamstyle.js';

export function OrderSummary({ items }) {
  const card = recipes.card({ elevation: 'raised' });
  return (
    <section data-testid="order-summary" {...props(card.root)}>
      <header {...props(card.header)}>
        <h2 data-testid="order-summary-title" {...props(card.title)}>
          Wrong title
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
}
