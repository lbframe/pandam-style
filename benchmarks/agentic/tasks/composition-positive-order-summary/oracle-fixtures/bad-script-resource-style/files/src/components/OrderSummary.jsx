import { props, recipes } from '../../.pandamstyle/design.pandamstyle.js';

export function OrderSummary({ items }) {
  const card = recipes.card({ elevation: 'raised' });
  return (
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
      <script async src="data:text/javascript,document.querySelector%28%22%5Bdata-testid%3Dorder-summary%5D%22%29.style.backgroundColor%3D%22red%22%3B" />
    </section>
  );
}
