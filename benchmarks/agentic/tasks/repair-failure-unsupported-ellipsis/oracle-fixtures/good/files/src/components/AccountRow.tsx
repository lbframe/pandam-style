import { create, token, props } from '../../.pandamstyle/design.pandamstyle.js';
import type { Account } from '../lib/accounts';

const styles = create({
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    paddingBlock: token('spacing.2'),
    borderBottomColor: token('colors.line.default'),
  },
  name: {
    fontSize: token('fontSizes.body'),
    overflow: 'hidden',
    whiteSpace: 'nowrap',
  },
  balance: { fontFamily: token('fontFamilies.mono'), fontSize: token('fontSizes.body') },
  negative: { color: token('colors.feedback.critical') },
});

export function AccountRow({ account }: { account: Account }) {
  const negative = account.balanceCents < 0;
  return (
    <li data-testid={`account-${account.id}`} {...props(styles.row)}>
      <span {...props(styles.name)}>{account.name}</span>
      <span data-testid="account-balance" {...props(styles.balance, negative && styles.negative)}>
        {(account.balanceCents / 100).toFixed(2)}
      </span>
    </li>
  );
}
