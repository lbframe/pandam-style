import clsx from 'clsx';
import styles from './BookingCard.module.css';
import { Button } from './Button.jsx';

export function BookingCard({ nights, occupancy }) {
  const full = occupancy > 0.95;
  return (
    <section className={clsx(styles.card, full && styles.cardFull)}>
      <p className={styles.summary}>{nights} nights</p>
      <div className={styles.meter}>
        <div className={styles.meterFill} style={{ width: `${Math.round(occupancy * 100)}%` }} />
      </div>
      <Button variant={full ? 'secondary' : 'primary'}>Reserve</Button>
    </section>
  );
}
