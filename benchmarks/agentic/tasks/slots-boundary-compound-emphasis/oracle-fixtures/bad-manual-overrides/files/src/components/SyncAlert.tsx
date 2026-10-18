import { create, token, props, recipes } from '../../.pandamstyle/design.pandamstyle.js';

const styles = create({ failed: { backgroundColor: token('colors.feedback.critical') } });

type SyncStatus = 'fresh' | 'stale' | 'failed';

export function SyncAlert({ status }: { status: SyncStatus }) {
  const tone = status === 'failed' ? 'critical' : status === 'stale' ? 'caution' : 'positive';
  const alert = recipes.alert({ tone, emphasis: 'subtle' });
  return (
    <div role="status" data-testid="sync-alert" {...props(alert.root, status === 'failed' && styles.failed)}>
      <span aria-hidden="true" data-testid="sync-alert-icon" {...props(alert.icon)}>
        !
      </span>
      <div>
        <p data-testid="sync-alert-title" {...props(alert.title)}>
          Bank sync
        </p>
        <p data-testid="sync-alert-message" {...props(alert.message)}>
          {status === 'stale' ? 'Balances may be out of date.' : status === 'failed' ? 'Sync failed.' : 'Up to date.'}
        </p>
      </div>
    </div>
  );
}
