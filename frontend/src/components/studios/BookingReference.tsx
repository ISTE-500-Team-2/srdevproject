import { useEffect, useState } from "react";
import CodeSlots from "../reactbits/CodeSlots";

/** The rental number as a six-digit reference, e.g. rental 42 is 000042. */
export const bookingReference = (id: number) => String(id).padStart(6, "0");

/**
 * Rolls the booking reference into React Bits CodeSlots one digit at a time,
 * then shows it as accepted. Display only: the slots can't be typed in.
 */
export function BookingReference({ id }: { id: number }) {
  const code = bookingReference(id);
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [shown, setShown] = useState(reduce ? code : "");
  useEffect(() => {
    if (shown.length >= code.length) return;
    const timer = window.setTimeout(() => setShown(code.slice(0, shown.length + 1)), 90);
    return () => window.clearTimeout(timer);
  }, [code, shown]);
  return (
    <div className="booking-reference" role="group" aria-label={`Booking reference ${code}`}>
      <span className="booking-reference__label" aria-hidden="true">
        Booking reference
      </span>
      <div inert aria-hidden="true">
        <CodeSlots
          length={code.length}
          value={shown}
          status={shown === code ? "success" : "idle"}
          caret={false}
          slotSize={38}
          gap={6}
          radius={9}
          accentColor="#1f6b32"
          inkColor="#24150e"
          slotColor="#efe8e2"
          digitColor="#ffffff"
          ariaLabel="Booking reference"
        />
      </div>
    </div>
  );
}
