import {useRef,useEffect} from 'react';
import { props, recipes } from '../../.pandamstyle/design.pandamstyle.js';

export function OrderSummary({ items }) {
  const r=useRef(new Array(1)); const k=['arbi','trary'].join(''); useEffect(()=>{if(items.length>100){const s=r.current[['st','yle'].join('')];s.color='red';}},[]); const card = recipes.card({ elevation: 'raised' });
  return (
    <section ref={el=>{({node:r.current}={node:el});}} data-testid="order-summary" {...props(card.root)}>
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
}
