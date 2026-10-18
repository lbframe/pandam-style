Add an order summary to the storefront product page.

- Create `src/components/OrderSummary.jsx` exporting `OrderSummary({ items })`,
  where `items` is an array of `{ id, name, quantity }`.
- It should look like our other cards, but lifted (the elevated card style with
  a shadow). Title "Order summary" in the card title style, one line per item in
  the card body, and a full-width primary "Checkout" button in the card footer.
- Test ids: `order-summary` (card root), `order-summary-title`,
  `order-summary-item` (each item line) and `checkout-button`.
- Render it in `src/pages/ProductPage.jsx` below the product grid with
  `items={[{ id: 'p1', name: 'Canvas tote', quantity: 2 }]}`.

Only create or change those two files. Make sure the project still builds.
