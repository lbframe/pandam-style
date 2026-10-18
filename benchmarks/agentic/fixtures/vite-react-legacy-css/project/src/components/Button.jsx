import clsx from 'clsx';
import styles from './Button.module.css';

export function Button({ variant = 'primary', children, ...rest }) {
  return (
    <button type="button" className={clsx(styles.button, styles[variant])} {...rest}>
      {children}
    </button>
  );
}
