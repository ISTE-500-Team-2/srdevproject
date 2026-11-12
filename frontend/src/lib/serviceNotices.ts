import { dayKey } from "./today";

export interface ServiceNotice {
  id: number;
  source: "reader" | "staff";
  readerId: string | null;
  summary: string;
  openedAt: string;
  resolvedAt: string | null;
  /** Emails queued for the notice (active accounts, not opted out); not a delivery count. Null when it predates counting. */
  recipients: number | null;
  /** What members were told when it was fixed. */
  resolution: string | null;
  openedBy: string | null;
  resolvedBy: string | null;
  /** Null when the reader was removed. */
  readerName: string | null;
  readerLastSeenAt: string | null;
  /** Times this reader dropped out in the last 24 hours, this one included. */
  recentDrops: number | null;
}
export interface ServiceNoticePage {
  open: ServiceNotice[];
  items: ServiceNotice[];
  nextOffset: number | null;
  total: number | null;
}

/** A reader that drops out this often in a day has a problem worth chasing, even though each drop clears itself. */
export const FLAKY_READER_DROPS = 3;

/** What a reader notice is about: the reader's name, or the stored sentence if the reader is gone. */
export function readerLabel(notice: ServiceNotice) {
  return notice.readerName ?? notice.summary.replace(/ has stopped reporting in\.$/, "");
}

/** "<1 min", "42 min", "2 h 05 min", "3 days 4 h". */
export function durationLabel(ms: number) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours} h ${String(rest).padStart(2, "0")} min` : `${hours} h`;
  }
  const days = Math.floor(hours / 24),
    restHours = hours % 24;
  return `${days} ${days === 1 ? "day" : "days"}${restHours ? ` ${restHours} h` : ""}`;
}

/** How long a notice was (or, while open, has been) open. */
export const openFor = (notice: ServiceNotice, now = Date.now()) =>
  (notice.resolvedAt ? Date.parse(notice.resolvedAt) : now) - Date.parse(notice.openedAt);

/**
 * A row of the history table: an announcement, or one reader's drop-outs on one
 * facility day. Readers that drop out and reconnect over and over would otherwise
 * fill the table with identical rows.
 */
export type HistoryRow =
  | { kind: "staff"; key: string; notice: ServiceNotice }
  | { kind: "reader"; key: string; readerId: string; label: string; drops: ServiceNotice[] };

/**
 * Groups a newest-first page of past notices. A reader's drops on the same facility
 * day share one row, even when other readers or announcements fall between them;
 * rows keep the order of their newest notice.
 */
export function historyRows(items: ServiceNotice[], timeZone: string): HistoryRow[] {
  const rows: HistoryRow[] = [];
  const groups = new Map<string, Extract<HistoryRow, { kind: "reader" }>>();
  for (const notice of items) {
    if (notice.source === "staff" || !notice.readerId) {
      rows.push({ kind: "staff", key: `staff-${notice.id}`, notice });
      continue;
    }
    const group = `${notice.readerId}\u0000${dayKey(Date.parse(notice.openedAt), timeZone)}`;
    const existing = groups.get(group);
    if (existing) {
      existing.drops.push(notice);
      continue;
    }
    const row: Extract<HistoryRow, { kind: "reader" }> = {
      kind: "reader",
      key: `reader-${notice.id}`,
      readerId: notice.readerId,
      label: readerLabel(notice),
      drops: [notice],
    };
    groups.set(group, row);
    rows.push(row);
  }
  return rows;
}

/** Total time a group of drops was offline. */
export const totalDown = (drops: ServiceNotice[]) => drops.reduce((sum, drop) => sum + openFor(drop), 0);

/** "Nov 5" in the facility's time zone. */
export function monthDay(at: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(new Date(at));
}

export const people = (count: number, noun: "member" | "staff" | "person") =>
  noun === "staff" ? `${count} staff` : `${count} ${count === 1 ? noun : noun === "person" ? "people" : "members"}`;
