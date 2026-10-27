import { timeOnly } from "../../lib/display";

export type ClassRecord = {
  id: number;
  title: string;
  certificationId: number;
  certificationName: string;
  instructorId: number;
  instructor: string;
  capacity: number;
  enrolled: number;
  status: string;
  revision: number;
  roomId: number;
  roomName: string;
  startsAt: string;
  endsAt: string;
  myStatus: string | null;
};
export type RosterPerson = { userId: number; name: string; email: string; status: string };
export type MemberRoster = { items: { name: string }[]; capacity: number; enrolled: number; seatsAvailable: number };
export type Room = { id: number; name: string; location: string; capacity: number | null; status: string };
export type Course = { id: number; name: string; validityDays: number | null };
/** Attendance choices a manager has made but not saved yet, per class. */
export type AttendanceDraft = { statuses: Record<number, "attended" | "no_show">; note: string };
/** Values used to open the schedule form, e.g. when scheduling a class again. */
export type ScheduleSeed = Partial<{
  title: string;
  certificationId: number;
  instructorId: number;
  roomId: number;
  capacity: number;
  start: string;
  end: string;
}>;

export const isCancelled = (c: ClassRecord) => c.status === "cancelled";
export const hasStarted = (c: ClassRecord, now = Date.now()) => new Date(c.startsAt).getTime() <= now;
export const seatsLeft = (c: { capacity: number; enrolled: number }) => Math.max(0, c.capacity - c.enrolled);
export const byStart = (a: ClassRecord, b: ClassRecord) => a.startsAt.localeCompare(b.startsAt);

export function dateParts(value: string) {
  const date = new Date(value);
  return {
    month: date.toLocaleDateString("en-US", { month: "short" }).toUpperCase(),
    day: String(date.getDate()).padStart(2, "0"),
    weekday: date.toLocaleDateString("en-US", { weekday: "short" }),
  };
}
export const timeRange = (c: ClassRecord) => `${timeOnly(c.startsAt)} – ${timeOnly(c.endsAt)}`;
export const longDate = (value: string) =>
  new Date(value).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
export const monthLabel = (value: string) =>
  new Date(value).toLocaleDateString("en-US", { month: "long", year: "numeric" });
export function seatText(c: { capacity: number; enrolled: number }) {
  const left = seatsLeft(c);
  return left === 0 ? "Full" : `${left} ${left === 1 ? "seat" : "seats"} left`;
}
/** "hot" once one or two seats remain, so the bar warns without shouting. */
export const seatTone = (c: { capacity: number; enrolled: number }) =>
  seatsLeft(c) === 0 ? "full" : seatsLeft(c) <= 2 ? "hot" : "open";

/** Photos for classes, matched on the certification name. Cut-outs sit on a tinted tile. */
export function classImage(certification: string): { src: string; cutout: boolean } | null {
  const name = certification.toLowerCase();
  if (name.includes("laser")) return { src: "/assets/laser-class.webp", cutout: false };
  if (name.includes("print")) return { src: "/assets/printing-class.webp", cutout: false };
  if (name.includes("cnc")) return { src: "/assets/cnc-machine.webp", cutout: true };
  if (name.includes("wood") || name.includes("lathe") || name.includes("turning"))
    return { src: "/assets/wood-lathe.webp", cutout: true };
  return null;
}

export function enrollmentLabel(status: string) {
  return (
    { enrolled: "Registered", attended: "Attended", no_show: "No show", cancelled: "Withdrew" }[status] ?? status
  );
}
