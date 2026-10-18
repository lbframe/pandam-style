import { create, token, props, recipes, themes } from '../../.pandamstyle/design.pandamstyle.js';

const styles = create({
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: token('spacing.s2'),
    padding: token('spacing.s4'),
    borderRadius: token('radii.card'),
    backgroundColor: token('colors.surface.card'),
    color: token('colors.text.strong'),
  },
});

export function DestinationCard({ name, hot = false }) {
  return (
    <article data-testid="destination-card" {...props(themes.default, styles.card)}>
      <h2>{name}</h2>
      <span data-testid="destination-chip" {...props(recipes.chip({ emphasis: hot ? 'hot' : 'normal' }))}>
        {hot ? 'Trending' : 'Popular'}
      </span>
    </article>
  );
}
