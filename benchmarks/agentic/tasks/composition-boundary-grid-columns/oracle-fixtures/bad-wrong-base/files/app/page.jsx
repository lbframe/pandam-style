import { create, token, props, patterns } from '../.pandamstyle/design.pandamstyle.js';
import { services } from '../lib/services.js';
import { ServiceCard } from '../components/ServiceCard.jsx';

const styles = create({
  title: { fontSize: token('fontSizes.heading'), fontWeight: token('fontWeights.strong'), marginBottom: token('spacing.loose') },
});

export default function OverviewPage() {
  return (
    <section data-testid="overview">
      <h1 data-testid="overview-title" {...props(styles.title)}>
        Services
      </h1>
      <div data-testid="service-grid" {...props(patterns.grid({ columns: 6, gap: token('spacing.base') }))}>
        {services.map((service) => (
          <ServiceCard key={service.id} service={service} />
        ))}
      </div>
    </section>
  );
}
