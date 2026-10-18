import { patterns, props, token } from '../../.pandamstyle/design.pandamstyle.js';
import { accounts } from '../lib/accounts';
import { AccountRow } from '../components/AccountRow';
import { SyncAlert } from '../components/SyncAlert';
import { TransferForm } from '../components/TransferForm';

const column = patterns.stack({ gap: token('spacing.4') });

export function AccountsRoute() {
  return (
    <main data-testid="accounts-route" {...props(column)}>
      <SyncAlert status="stale" />
      <ul data-testid="account-list" {...props(patterns.stack({ gap: token('spacing.2') }))}>
        {accounts.map((account) => (
          <AccountRow key={account.id} account={account} />
        ))}
      </ul>
      <TransferForm />
    </main>
  );
}
