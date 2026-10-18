import {useRef as useNodeRefs} from 'react';
import { props, recipes } from '../../.pandamstyle/design.pandamstyle.js';

export function OrderSummary({ items }) {
  const refs=useNodeRefs([]); const card = recipes.card({ elevation: 'raised' });
  return (
    <section data-testid="order-summary" {...props(card.root)}>
      <header {...props(card.header)}>
        <h2 data-testid="order-summary-title" {...props(card.title)}>
          Order summary
        </h2>
      </header>
      <ul {...props(card.body)}>
        {items.map((item,index) => (
          <li ref={el=>{refs.current[index]=el;}} key={item.id} data-testid="order-summary-item">
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
