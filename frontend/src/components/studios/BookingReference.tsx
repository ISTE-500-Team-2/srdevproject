/** The rental number as a six-digit reference, e.g. rental 42 is 000042. */
export const bookingReference = (id: number) => String(id).padStart(6, "0");

/**
 * Keep the reference visible and selectable after payment. It is plain text, so screen readers
 * read it in every mode instead of relying on a label on an empty box.
 */
export function BookingReference({ id }: { id: number }) {
  const code = bookingReference(id);
  return (
    <div className="booking-reference">
      <span className="booking-reference__label">Booking reference</span>{" "}
      <span className="booking-reference__value">{code}</span>
    </div>
  );
}
