import styles from './PromoHero.module.css';

export function PromoHero({ title }) {
  return (
    <section className={styles.hero} data-testid="promo-hero">
      <h1 className={styles.title} data-testid="promo-title">
        {title}
      </h1>
      <p className={styles.lead} data-testid="promo-lead">
        Hand-picked stays for long weekends.
      </p>
    </section>
  );
}
