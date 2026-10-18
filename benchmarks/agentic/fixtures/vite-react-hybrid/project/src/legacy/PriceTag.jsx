import styles from './PriceTag.module.css';

export function PriceTag({ amount }) {
  return (
    <span className={styles.tag} data-testid="price-tag">
      from {amount} EUR
    </span>
  );
}
