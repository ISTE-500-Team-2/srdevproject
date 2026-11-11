import type { Reservation } from "./contracts";
import { blockKind, localHour } from "./today";

const MINUTE = 60_000;
const HOUR = 3_600_000;
/** The backend keeps this much time free between two reservations of one machine (RESERVATION_COOLDOWN_MINUTES). */
export const COOLDOWN_MINUTES = 15;
/** Reservations start on the hour or half-hour and last whole hours. */
export const SLOT_MINUTES = 30;
export const MAX_HOURS = 24;

/** The block kinds on Today's timeline, plus a hold that is waiting for the member to pay online. */
export type ScheduleKind = "past" | "live" | "booked" | "conflict" | "hold";
export function scheduleKind(r: Reservation, now: number, live: boolean, down: boolean): ScheduleKind {
  const kind = blockKind(Date.parse(r.startTime), Date.parse(r.endTime), now, live, down);
  if (kind === "class") return "booked";
  return kind === "booked" && r.status === "pending" ? "hold" : kind;
}

export type StatusTone = "ok" | "warn" | "neutral" | "danger";
/** The status pill for a reservation in the list and the side panel. */
export function reservationStatus(r: Reservation, now: number, outOfService: boolean): { label: string; tone: StatusTone } {
  if (r.status === "cancelled") return { label: "Cancelled", tone: "neutral" };
  const start = Date.parse(r.startTime), end = Date.parse(r.endTime);
  if (end <= now) return r.status === "confirmed" ? { label: "Completed", tone: "neutral" } : { label: "Ended unpaid", tone: "neutral" };
  if (outOfService && r.resourceType !== "room") return { label: "Affected by outage", tone: "danger" };
  if (r.status === "pending") return { label: "Awaiting payment", tone: "warn" };
  if (start <= now) return { label: "In progress", tone: "ok" };
  if (r.status === "confirmed") return { label: "Confirmed", tone: "ok" };
  return { label: r.status.charAt(0).toUpperCase() + r.status.slice(1), tone: "neutral" };
}

/** Bookings paid through online checkout can't be moved by staff until payment is reconciled (backend rule). */
export const paidOnline = (r: Reservation) => r.payerId != null;
export const isActive = (r: Reservation) => r.status === "confirmed" || r.status === "pending";
export const isRoom = (r: Reservation) => r.resourceType === "room" || r.equipmentId === null;
export function canChange(r: Reservation, now: number) {
  return !isRoom(r) && isActive(r) && !paidOnline(r) && Date.parse(r.endTime) > now;
}

/** Whether [start, end) on one machine clears its other reservations and the gap the backend keeps between them. */
export function isFree(start: number, end: number, machineBookings: Reservation[], excludeId?: number) {
  const gap = COOLDOWN_MINUTES * MINUTE;
  return !machineBookings.some(
    (b) => b.id !== excludeId && isActive(b) && Date.parse(b.startTime) < end + gap && Date.parse(b.endTime) > start - gap,
  );
}

/** Start times offered for a day: every half hour from 6 AM to 11:30 PM that hasn't passed, and whether an hour fits there. */
export function startSlots(day: string, timeZone: string, now: number, machineBookings: Reservation[], excludeId?: number) {
  const slots: { at: number; free: boolean }[] = [];
  const end = localHour(day, 24, timeZone);
  for (let at = localHour(day, 6, timeZone); at < end; at += SLOT_MINUTES * MINUTE) {
    if (at <= now) continue;
    slots.push({ at, free: isFree(at, at + HOUR, machineBookings, excludeId) });
  }
  return slots;
}

/** Whole-hour lengths, 1 to 24, that fit from `start`. */
export function lengthsFrom(start: number, machineBookings: Reservation[], excludeId?: number) {
  const lengths: number[] = [];
  for (let hours = 1; hours <= MAX_HOURS && isFree(start, start + hours * HOUR, machineBookings, excludeId); hours++) lengths.push(hours);
  return lengths;
}

/** The half-hour under a point on a timeline that starts on a local hour. */
export function slotAt(fraction: number, window: { start: number; end: number }) {
  const step = SLOT_MINUTES * MINUTE;
  return window.start + Math.floor((Math.min(Math.max(fraction, 0), 0.9999) * (window.end - window.start)) / step) * step;
}

/** "Today, Wednesday, Nov 11" / "Tomorrow, Thursday, Nov 12" / "Friday, Nov 13". */
export function dayLabel(day: string, today: string, weekday: "long" | "short" = "long") {
  const date = new Date(`${day}T12:00:00Z`);
  const base = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday, month: "short", day: "numeric" }).format(date);
  const tomorrow = new Date(`${today}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  if (day === today) return `Today, ${base}`;
  if (day === tomorrow.toISOString().slice(0, 10)) return `Tomorrow, ${base}`;
  return base;
}

/** "3:00–4:00 PM", or with both meridiems when they differ. */
export function timeRange(start: number | string, end: number | string, timeZone: string) {
  const part = (at: number | string, meridiem: boolean) =>
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true })
      .formatToParts(new Date(at))
      .filter((p) => meridiem || (p.type !== "dayPeriod" && !(p.type === "literal" && p.value.trim() === "")))
      .map((p) => p.value)
      .join("")
      .replace(/\s+/g, " ")
      .trim();
  const meridiem = (at: number | string) =>
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: true }).formatToParts(new Date(at)).find((p) => p.type === "dayPeriod")?.value;
  return meridiem(start) === meridiem(end) ? `${part(start, false)}–${part(end, true)}` : `${part(start, true)}–${part(end, true)}`;
}

export const hoursLabel = (hours: number) => `${hours} ${hours === 1 ? "hour" : "hours"}`;
export const reservationHours = (r: Reservation) => Math.round((Date.parse(r.endTime) - Date.parse(r.startTime)) / HOUR);
/** The price the reservation was booked at, in cents, when it has one. */
export const bookedCents = (r: Reservation) => r.amountCents ?? r.priceSnapshot?.totalCents ?? null;
