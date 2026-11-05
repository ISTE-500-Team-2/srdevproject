import type { EquipmentPrice } from '../lib/contracts';
import './EquipmentPriceBreakdown.css';
import { cents } from '../lib/display';

export function EquipmentPriceBreakdown({ price }: { price: EquipmentPrice | null | undefined }) {
  if (!price) return null;
  return <section className="equipment-price" aria-label="Booking price breakdown">
    <h3>Booking price</h3>
    <dl>
      <div><dt>Equipment · {price.hours} {price.hours === 1 ? 'hour' : 'hours'} × {cents(price.hourlyRateCents)}</dt><dd>{cents(price.equipmentCents)}</dd></div>
      {!!price.trainingFeeCents && <div><dt>Training fee</dt><dd>{cents(price.trainingFeeCents)}</dd></div>}
      <div className="equipment-price__total"><dt><strong>Total</strong></dt><dd><strong>{cents(price.totalCents)}</strong></dd></div>
    </dl>
    <p>Equipment is billed by the hour. Required training is paid separately when you register for a class.</p>
  </section>;
}
