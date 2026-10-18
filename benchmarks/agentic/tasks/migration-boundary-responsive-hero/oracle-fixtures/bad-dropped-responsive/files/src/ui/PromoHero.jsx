import { create, token, props } from '../../.pandamstyle/design.pandamstyle.js';

const styles = create({
  hero: {
    display: 'flex',
    flexDirection: 'column',
    gap: token('spacing.s3'),
    padding: token('spacing.s4'),
    borderRadius: token('radii.card'),
    backgroundColor: token('colors.surface.muted'),
    color: token('colors.text.strong'),
  },
  title: { fontSize: token('fontSizes.xl'), fontWeight: token('fontWeights.bold') },
  lead: { fontSize: token('fontSizes.md') },
});

export function PromoHero({ title }) {
  return (
    <section data-testid="promo-hero" {...props(styles.hero)}>
      <h1 data-testid="promo-title" {...props(styles.title)}>
        {title}
      </h1>
      <p data-testid="promo-lead" {...props(styles.lead)}>
        Hand-picked stays for long weekends.
      </p>
    </section>
  );
}
