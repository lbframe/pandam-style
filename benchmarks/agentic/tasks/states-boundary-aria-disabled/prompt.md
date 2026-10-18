Accessibility review: the "Add to cart" button of sold-out products must stay
focusable. When `disabled` is true, render `aria-disabled="true"` instead of the
native `disabled` attribute (and neither attribute when enabled), while keeping
exactly the existing disabled appearance. Only change
`src/components/AddToCartButton.jsx`.
