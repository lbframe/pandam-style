import { create, token, props, recipes } from '../.pandamstyle/design.pandamstyle.js';

const styles = create({
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: token('spacing.tight'),
    padding: token('spacing.loose'),
    borderRadius: token('radii.soft'),
    backgroundColor: token('colors.onStatus'),
    color: token('colors.ink'),
  },
  name: { fontWeight: token('fontWeights.strong'), fontSize: token('fontSizes.normal') },
  failing: { borderWidth: '1px', borderStyle: 'solid', borderColor: token('colors.failing') },
});

export function ServiceCard({ service }) {
  const health = service.healthy ? 'healthy' : 'failing';
  return (
    <article data-testid={`service-${service.id}`} {...props(styles.card, !service.healthy && styles.failing)}>
      <span {...props(styles.name)}>{service.name}</span>
      <span data-testid="service-health" {...props(recipes.pill({ health, muted: service.paused }))}>
        {service.healthy ? 'Healthy' : 'Failing'}
      </span>
    </article>
  );
}
