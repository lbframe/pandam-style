import {createElement,useEffect,useRef,useState} from 'react'; import {createPortal} from 'react-dom';
import { props, recipes } from '../../.pandamstyle/design.pandamstyle.js';

export function OrderSummary({ items }) {
  const [markup,setMarkup]=useState('');
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
        <button type="button" onClick={()=>setMarkup('<span style="color:red">Raw styles</span>')} data-testid="checkout-button" {...props(recipes.button({ tone: 'primary', fullWidth: true }))}>
          Checkout
        </button>
      </footer>
    {createElement('div',{dangerouslySetInnerHTML:{__html:markup}})}</section>
  );
}
