import { DestinationCard } from './ui/DestinationCard.jsx';
import { PromoHero } from './legacy/PromoHero.jsx';
import { PriceTag } from './legacy/PriceTag.jsx';
import { TripSummary } from './legacy/TripSummary.jsx';

export function Portal() {
  return (
    <div>
      <PromoHero title="Autumn escapes" />
      <DestinationCard name="Lisbon" hot />
      <PriceTag amount={89} />
      <TripSummary nights={4} travellers={2} />
    </div>
  );
}
