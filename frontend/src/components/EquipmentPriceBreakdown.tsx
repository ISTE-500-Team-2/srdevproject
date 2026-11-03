import type { EquipmentPrice } from '../lib/contracts';
import { cents } from '../lib/display';

export function EquipmentPriceBreakdown({ price }: { price: EquipmentPrice | null | undefined }) {
  if (!price) return null;
  return <section className="panel" aria-label="Booking price breakdown">
    <h3>Booking price</h3>
    <dl>
      <div><dt>Equipment · {price.hours} {price.hours === 1 ? 'hour' : 'hours'} × {cents(price.hourlyRateCents)}</dt><dd>{cents(price.equipmentCents)}</dd></div>
      <div><dt>Training fee per booking</dt><dd>{cents(price.trainingFeeCents)}</dd></div>
      <div><dt><strong>Total</strong></dt><dd><strong>{cents(price.totalCents)}</strong></dd></div>
    </dl>
    <p>The flat fee applies to every booking, including when certified. Payment is recorded at the front desk; confirming does not charge a card.</p>
  </section>;
}
