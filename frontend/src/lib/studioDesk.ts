import type { Rental, Studio } from "./studioContracts";
import { addDays, bookable, dateOnly } from "./studioDisplay";

/** Rentals that wait on staff: desk payments, refunds owed, card refunds to retry. */
export const needsStaff = (r: Rental) =>
  (r.status === "pending" && r.payment_method === "manual") ||
  ["refund_pending", "refund_failed"].includes(r.payment_status);

export type DeskTaskKind = "collect" | "refund" | "card";
export type DeskTask = { rental: Rental; kind: DeskTaskKind };

/** The Needs you queue: desk payments by hold deadline first, then refunds, then card retries. */
export function deskTasks(rentals: Rental[]): DeskTask[] {
  const order: Record<DeskTaskKind, number> = { collect: 0, refund: 1, card: 2 };
  return rentals
    .filter(needsStaff)
    .map((rental): DeskTask => ({
      rental,
      kind:
        rental.status === "pending" && rental.payment_method === "manual"
          ? "collect"
          : rental.payment_method === "stripe_test"
            ? "card"
            : "refund",
    }))
    .sort(
      (a, b) =>
        order[a.kind] - order[b.kind] ||
        a.rental.hold_until.localeCompare(b.rental.hold_until) ||
        a.rental.id - b.rental.id,
    );
}

export const memberName = (r?: Rental) => r?.member_name?.trim() || r?.email || "A member";

/** Whole days from a to b (both YYYY-MM-DD). */
export const daysBetween = (a: string, b: string) =>
  Math.round(
    (Date.parse(dateOnly(b) + "T00:00:00Z") - Date.parse(dateOnly(a) + "T00:00:00Z")) / 864e5,
  );

export type Slot = Studio["availability"][number];
export type StudioState = "rented" | "held" | "open" | "off";

/** Where a studio stands today. Rental end dates are exclusive. */
export function studioNow(s: Studio, today: string) {
  const slots = [...s.availability].sort((a, b) => a.starts_on.localeCompare(b.starts_on));
  const current = slots.find((r) => dateOnly(r.starts_on) <= today && dateOnly(r.ends_on) > today);
  const next = slots.find((r) => dateOnly(r.starts_on) > today);
  // First day nothing is held or booked, following back-to-back rentals.
  let freeFrom = today;
  for (const r of slots)
    if (dateOnly(r.starts_on) <= freeFrom && dateOnly(r.ends_on) > freeFrom) freeFrom = dateOnly(r.ends_on);
  const state: StudioState = current
    ? current.status === "confirmed" ? "rented" : "held"
    : bookable(s) ? "open" : "off";
  return { state, current, next, freeFrom };
}

/** The staff rental behind an availability slot, for the member's name. */
export const rentalFor = (studio: Studio, slot: Slot, rentals: Rental[]) =>
  rentals.find(
    (r) =>
      r.studio_id === studio.id &&
      dateOnly(r.starts_on) === dateOnly(slot.starts_on) &&
      ["pending", "confirmed"].includes(r.status),
  );

export type Bar = { slot: Slot; from: number; to: number; clipped: boolean };

/** Rentals overlapping [start, start + days), as day offsets clipped to the window. */
export function timelineBars(s: Studio, start: string, days: number): Bar[] {
  const end = addDays(start, days);
  return s.availability
    .filter((r) => dateOnly(r.starts_on) < end && dateOnly(r.ends_on) > start)
    .sort((a, b) => a.starts_on.localeCompare(b.starts_on))
    .map((slot) => ({
      slot,
      from: Math.max(0, daysBetween(start, slot.starts_on)),
      to: Math.min(days, daysBetween(start, slot.ends_on)),
      clipped: dateOnly(slot.starts_on) < start,
    }));
}

/** Free stretches between bars that are still ahead of today, as [from, to) offsets. */
export function openGaps(bars: Bar[], days: number, todayOffset: number) {
  const gaps: { from: number; to: number }[] = [];
  let cursor = Math.max(0, todayOffset);
  for (const bar of bars) {
    if (bar.from > cursor) gaps.push({ from: cursor, to: bar.from });
    cursor = Math.max(cursor, bar.to);
  }
  if (cursor < days) gaps.push({ from: cursor, to: days });
  return gaps;
}

/** The first of each month inside the window, as day offsets. */
export function monthStarts(start: string, days: number) {
  const marks: { offset: number; date: string }[] = [];
  let date = start.slice(0, 8) + "01";
  for (let i = 0; i < 6; i++) {
    const [y, m] = date.split("-").map(Number);
    date = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    const offset = daysBetween(start, date);
    if (offset >= days) break;
    if (offset > 0) marks.push({ offset, date });
  }
  return marks;
}

/** Counts for the page summary line. */
export function studioSummary(studios: Studio[], today: string) {
  const states = studios.map((s) => studioNow(s, today).state);
  return {
    rented: states.filter((s) => s === "rented").length,
    open: states.filter((s) => s === "open").length,
    held: studios.flatMap((s) => s.availability).filter((r) => r.status === "pending" && dateOnly(r.ends_on) > today).length,
    off: states.filter((s) => s === "off").length,
  };
}
