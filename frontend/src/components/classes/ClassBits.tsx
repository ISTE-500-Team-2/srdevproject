import { GraduationCap } from "lucide-react";
import { classImage, dateParts, seatText, seatTone, seatsLeft } from "./classData";

export function DateRail({ value, faded = false }: { value: string; faded?: boolean }) {
  const { month, day, weekday } = dateParts(value);
  return (
    <span className={`date-rail${faded ? " date-rail--faded" : ""}`} aria-hidden="true">
      <b>{month}</b>
      <strong>{day}</strong>
      <small>{weekday}</small>
    </span>
  );
}

export function SeatMeter({
  capacity,
  enrolled,
  compact = false,
}: {
  capacity: number;
  enrolled: number;
  compact?: boolean;
}) {
  const tone = seatTone({ capacity, enrolled });
  const filled = capacity ? Math.min(100, Math.round((enrolled / capacity) * 100)) : 100;
  return (
    <div className={`seat-meter seat-meter--${tone}`}>
      <div className="seat-meter__text">
        <span>{compact ? `${enrolled}/${capacity}` : seatText({ capacity, enrolled })}</span>
        <span>{compact ? `${seatsLeft({ capacity, enrolled })} open` : `${enrolled}/${capacity}`}</span>
      </div>
      <div
        className="seat-meter__bar"
        role="meter"
        aria-label="Seats taken"
        aria-valuemin={0}
        aria-valuemax={capacity}
        aria-valuenow={enrolled}
        aria-valuetext={`${enrolled} of ${capacity} seats taken`}
      >
        <i style={{ width: `${filled}%` }} />
      </div>
    </div>
  );
}

export function ClassThumb({ certification }: { certification: string }) {
  const image = classImage(certification);
  if (!image)
    return (
      <span className="class-thumb class-thumb--icon" aria-hidden="true">
        <GraduationCap />
      </span>
    );
  return (
    <span className={`class-thumb${image.cutout ? " class-thumb--cutout" : ""}`} aria-hidden="true">
      <img src={image.src} alt="" loading="lazy" />
    </span>
  );
}
