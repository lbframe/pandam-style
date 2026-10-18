import { create, token, props } from '../../.pandamstyle/design.pandamstyle.js';

const styles = create({
  button: { backgroundColor: token('colors.action.danger'), color: token('colors.text.inverse'), fontSize: token('fontSizes.sm') },
});

export function RemoveFromCartButton({ onRemove }) {
  return (
    <button type="button" data-testid="remove-from-cart" onClick={onRemove} {...props(styles.button)}>
      Remove
    </button>
  );
}
