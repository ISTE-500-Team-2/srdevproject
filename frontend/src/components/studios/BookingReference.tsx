/** The rental number as a six-digit reference, e.g. rental 42 is 000042. */
export const bookingReference = (id: number) => String(id).padStart(6, "0");

/** Keep the reference visible and selectable after payment. */
export function BookingReference({ id }: { id: number }) {
  const code = bookingReference(id);
  return (
    <div className="booking-reference" role="group" aria-label={`Booking reference ${code}`}>
      <span className="booking-reference__label" aria-hidden="true">
        Booking reference
      </span>
      <span className="booking-reference__value" aria-hidden="true">{code}</span>
    </div>
  );
}
