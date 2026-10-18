import {createElement,useEffect,useRef,useState} from 'react'; import {createPortal} from 'react-dom';
import { props, recipes } from '../../.pandamstyle/design.pandamstyle.js';

export function OrderSummary({ items }) {
  const ref=useRef(null);const [ready,setReady]=useState(false);useEffect(()=>setReady(true),[]);
 const card = recipes.card({ elevation: 'raised' });
  return (
    <section data-testid="order-summary" {...props(card.root)}>
      <header {...props(card.header)}>
        <h2 data-testid="order-summary-title" {...props(card.title)}>
          Order summary
        </h2>
      </header>
      <ul ref={ref} {...props(card.body)} />{ready ? createPortal(<>
        {items.map((item) => (
          <li key={item.id} data-testid="order-summary-item">
            {item.quantity} x {item.name}
          </li>
        ))}
      </>,ref.current) : null}
      <footer {...props(card.footer)}>
        <button type="button" data-testid="checkout-button" {...props(recipes.button({ tone: 'primary', fullWidth: true }))}>
          Checkout
        </button>
      </footer>
    </section>
  );
}
