import { create, token, props } from '../../.pandamstyle/design.pandamstyle.js';

const styles = create({
  summary: { display: 'flex', justifyContent: 'space-between', padding: token('spacing.s4'), borderTopColor: token('colors.text.strong'), borderWidth: '1px', borderStyle: 'solid' },
  label: { fontSize: token('fontSizes.md'), color: token('colors.text.strong') },
});

export function TripSummary({ nights, travellers }) {
  return (
    <aside data-testid="trip-summary" {...props(styles.summary)}>
      <span {...props(styles.label)}>{nights} nights</span>
      <span {...props(styles.label)}>{travellers} travellers</span>
    </aside>
  );
}
