import type { LiveEquipment, Reservation } from "./contracts";
import type { ComplianceReport } from "./staffContracts";
import type { Rental, Studio } from "./studioContracts";

const HOUR = 3_600_000;
export function dayKey(now: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  return ["year", "month", "day"].map(key => parts.find(p => p.type === key)!.value).join("-");
}
export function formatTime(at: number | string, timeZone: string, meridiem = true) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(new Date(at));
  return parts.filter(p => meridiem || (p.type !== "dayPeriod" && p.type !== "literal")).map(p => p.value).join(meridiem ? "" : ":").replace(/\s+/g, " ");
}
// Resolve local wall time without depending on the host's time zone.
export function localHour(day: string, hour: number, timeZone: string) {
  const target = Date.parse(`${day}T00:00:00Z`) + hour * HOUR;
  let instant = target;
  for (let i = 0; i < 4; i++) {
    const p = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(instant);
    const get = (key: string) => Number(p.find(part => part.type === key)!.value);
    const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    instant += target - wall;
  }
  return instant;
}
export function equipmentBookings(bookings: Reservation[]) {
  return bookings.filter(b => b.equipmentId !== null && b.resourceType !== "room" && b.status !== "cancelled")
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}
export function timeWindow(now: number, timeZone: string, bookings: Reservation[]) {
  const day = dayKey(now, timeZone);
  // Shop hours by default, widened for early or late bookings but never past today.
  const dayStart = localHour(day, 0, timeZone), dayEnd = localHour(day, 24, timeZone);
  let start = localHour(day, 9, timeZone), end = localHour(day, 21, timeZone);
  for (const b of bookings) {
    // Round in local time, including zones whose offset is not a whole hour.
    const startAt = Date.parse(b.startTime), endAt = Date.parse(b.endTime);
    const minute = (at: number) => Number(new Intl.DateTimeFormat("en-US", { timeZone, minute: "numeric" }).format(at));
    const floor = (at: number) => at - minute(at) * 60000 - ((at % 60000) + 60000) % 60000;
    start = Math.max(dayStart, Math.min(start, floor(startAt)));
    end = Math.min(dayEnd, Math.max(end, floor(endAt) + (endAt === floor(endAt) ? 0 : HOUR)));
  }
  const ticks = [];
  for (let at = start; at <= end; at += 3 * HOUR) ticks.push({ fraction: (at - start) / (end - start), label: new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: true }).format(at) });
  const nowFraction = (now - start) / (end - start);
  return { start, end, windowHours: (end - start) / HOUR, ticks, nowFraction, nowInsideWindow: nowFraction >= 0 && nowFraction <= 1 };
}
export function shortName(name: string) {
  const words = name.trim().split(/\s+/);
  return words.length > 1 ? `${words[0]} ${words.at(-1)![0]}.` : words[0];
}
export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words[0]?.[0] ?? "") + (words.length > 1 ? words.at(-1)![0] : "");
}
export function tone(id: number) { return ((id % 5) + 5) % 5; }
export function blockKind(start: number, end: number, now: number, live: boolean, down: boolean, isClass = false) {
  if (end <= now) return "past";
  if (start <= now && live) return "live";
  if (down) return "conflict";
  return isClass ? "class" : "booked";
}
export function bookingBlock(b: Reservation, window: { start: number; end: number }, now: number, timeZone: string, live: boolean, down: boolean) {
  const start = Date.parse(b.startTime), end = Date.parse(b.endTime);
  const left = Math.max(start, window.start), right = Math.min(end, window.end);
  if (right <= left) return null;
  const kind = blockKind(start, end, now, live, down);
  const name = b.memberName ?? "";
  return { id: b.id, kind, left: (left - window.start) / (window.end - window.start), width: (right - left) / (window.end - window.start), text: shortName(name), label: `${name}, ${formatTime(start, timeZone)} to ${formatTime(end, timeZone)}${kind === "live" ? ", in use now" : kind === "conflict" ? ", affected by outage" : ""}` };
}
export function machineStatus(bookings: Reservation[], now: number, timeZone: string, live: boolean, down: boolean) {
  const current = bookings.find(b => Date.parse(b.startTime) <= now && Date.parse(b.endTime) > now);
  const next = [...bookings].sort((a,b) => Date.parse(a.startTime) - Date.parse(b.startTime)).find(b => Date.parse(b.startTime) > now);
  return {
    statusText: live ? current ? `In use until ${formatTime(current.endTime, timeZone)}` : "In use" : down ? "Out of service" : next ? `Open, next at ${formatTime(next.startTime, timeZone)}` : "Open",
    nextText: live && current ? `${shortName(current.memberName ?? "")} until ${formatTime(current.endTime, timeZone, false)}` : next ? `Next: ${shortName(next.memberName ?? "")} at ${formatTime(next.startTime, timeZone, false)}` : "Nothing else booked today",
  };
}
export function groupMachines(machines: LiveEquipment[]) {
  const types = [...new Set(machines.map(m => m.type))];
  return types.flatMap(type => { const group = machines.filter(m => m.type === type); return group.map((m, i) => ({ ...m, lastOfType: i === group.length - 1 })); });
}
/** Every active studio and whether it is rented, held (awaiting payment) or open today. Rental end dates are exclusive. */
export function studioOccupancy(studios: Studio[], day: string) {
  return studios.map(studio => {
    const today = studio.availability.filter(r => r.starts_on <= day && r.ends_on > day);
    const state: "rented" | "held" | "open" = today.some(r => r.status === "confirmed") ? "rented" : today.some(r => r.status === "pending") ? "held" : "open";
    return { id: studio.id, name: studio.name, size: studio.size, state };
  });
}
/** Same rule as the Studios page's "Payments to record" list. */
export function studioPaymentsToRecord(rentals: Rental[]) {
  return rentals.filter(r => (r.status === "pending" && r.payment_method === "manual") || ["refund_pending", "refund_failed"].includes(r.payment_status)).length;
}
export type NeedsYouItem = { id: string; icon: "waiver" | "payment" | "machine" | "training"; alert: boolean; title: string; detail: string; action: string; to: string };
export function needsYou(compliance: ComplianceReport, machines: LiveEquipment[], bookings: Reservation[], now: number, studioPayments = 0) {
  const items: NeedsYouItem[] = [];
  const waivers = compliance.summary.userCount - compliance.summary.waiverCompliantUsers;
  const training = compliance.summary.userCount - compliance.summary.certificationCompliantUsers;
  if (waivers) items.push({ id: "waivers", icon: "waiver", alert: true, title: `${waivers} ${waivers === 1 ? "member has" : "members have"} no current waiver`, detail: "Their tags won't open any reader until they sign.", action: "Review members", to: "/admin/certifications?section=compliance" });
  if (studioPayments) items.push({ id: "studio-payments", icon: "payment", alert: false, title: `${studioPayments} studio ${studioPayments === 1 ? "payment" : "payments"} to record`, detail: "Manual payments and refunds waiting for staff.", action: "Record payments", to: "/admin/studios" });
  for (const m of machines.filter(m => m.status !== "available")) {
    const count = equipmentBookings(bookings).filter(b => b.equipmentId === m.id && Date.parse(b.endTime) > now).length;
    items.push({ id: `machine-${m.id}`, icon: "machine", alert: true, title: `${m.name} is out of service`, detail: count ? `${count} ${count === 1 ? "booking" : "bookings"} today ${count === 1 ? "is" : "are"} affected.` : "No bookings affected today.", action: "Review equipment", to: `/admin/equipment/${m.id}` });
  }
  if (training) items.push({ id: "training", icon: "training", alert: false, title: `${training} ${training === 1 ? "member needs" : "members need"} training renewed`, detail: "They're locked out of the machines that need it.", action: "Open certifications", to: "/admin/certifications?section=certifications" });
  return items;
}
