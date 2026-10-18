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
});

if (typeof document !== 'undefined') {
  const tag = document.createElement('style');
  tag.textContent = '[data-failing] { border: 1px solid #e11d48; }';
  document.head.appendChild(tag);
}

export function ServiceCard({ service }) {
  const health = service.healthy ? 'healthy' : 'failing';
  return (
    <article data-testid={`service-${service.id}`} {...props(styles.card)}>
      <span {...props(styles.name)}>{service.name}</span>
      <span data-testid="service-health" {...props(recipes.pill({ health, muted: service.paused }))}>
        {service.healthy ? 'Healthy' : 'Failing'}
      </span>
    </article>
  );
}
