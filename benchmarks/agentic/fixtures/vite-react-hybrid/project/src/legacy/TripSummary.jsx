import styles from './TripSummary.module.css';

export function TripSummary({ nights, travellers }) {
  return (
    <aside className={styles.summary} data-testid="trip-summary">
      <span className={styles.label}>{nights} nights</span>
      <span className={styles.label}>{travellers} travellers</span>
    </aside>
  );
}
