import { create, token, props } from '../../.pandamstyle/design.pandamstyle.js';

const styles = create({
  banner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: token('spacing.md'),
    marginBottom: token('spacing.lg'),
    borderRadius: token('radii.md'),
    backgroundColor: token('colors.surface.subtle'),
    color: token('colors.text.primary'),
  },
  text: {
    fontSize: token('fontSizes.base'),
  },
});

export function PromoBanner() {
  return (
    <aside data-testid="promo-banner" {...props(styles.banner)}>
      <p {...props(styles.text)}>Free shipping on orders over 50 EUR.</p>
    </aside>
  );
}
