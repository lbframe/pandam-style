import { create, token, props, recipes } from '../../.pandamstyle/design.pandamstyle.js';

const styles = create({
  hintError: { color: token('colors.feedback.critical') },
});

export function TransferForm({ amountError = null }: { amountError?: string | null }) {
  const field = recipes.field({ size: 'regular' });
  return (
    <form data-testid="transfer-form">
      <label data-testid="amount-field" {...props(field.root)}>
        <span {...props(field.label)}>Amount</span>
        <input
          data-testid="amount-input"
          name="amount"
          inputMode="decimal"
          aria-invalid={amountError != null}
          {...props(field.input)}
        />
        <span data-testid="amount-hint" {...props(field.hint, amountError != null && styles.hintError)}>
          {amountError ?? 'Transfers settle in one business day.'}
        </span>
      </label>
    </form>
  );
}
