// Browser card/reader/setup contracts contain display metadata, not reader secrets or complete
// stored card identities.

export type NfcCard = {
  id: number;
  label: string;
  active: boolean;
  revision: number;
  last4: string | null;
  assignedAt: string;
  assignedBy: string | null;
  lastUsedAt: string | null;
  lastReader: string | null;
};
export type AccessReader = {
  id: string;
  name: string;
  kind: "building" | "room" | "equipment" | "studio";
  resourceId: number;
  resourceName: string;
  enabled: boolean;
  online: boolean;
  lastSeenAt: string | null;
  revision: number;
};
export type ReaderSetup = {
  configured: boolean;
  /** Whether this account may add, change or turn on readers (admins only); anyone here may turn one off. */
  canConfigure: boolean;
  timeZone: string;
  readers: AccessReader[];
};
export type ReaderStatus =
  | "disabled"
  | "never_connected"
  | "not_reporting"
  | "unreachable"
  | "reader_fault"
  | "weak_signal"
  | "working"
  | "online";
export type DoorState = "locked" | "checking" | "approved" | "denied" | "issue";
/** The gateway's latest view of a reader; fields it could not observe are null. */
export type ReaderHealthReport = {
  reachable: boolean;
  ready: boolean | null;
  doorState: DoorState | null;
  rssi: number | null;
  address: string | null;
  firmware: string | null;
  uptimeMs: number | null;
  lastContactMs: number | null;
};
export type HealthSegment = { state: "ok" | "degraded" | "down" | "unknown"; start: string; end: string };
export type ReaderHealthSummary = {
  id: string;
  name: string;
  status: ReaderStatus;
  since: string | null;
  health: ReaderHealthReport | null;
  lastReport: string | null;
  lastSeenAt: string | null;
  lastTap: { at: string; allowed: boolean; reason: string } | null;
  day: { segments: HealthSegment[]; dropouts: number; downMinutes: number };
};
export type ReaderHealthBoard = {
  generatedAt: string;
  readers: ReaderHealthSummary[];
  gateway: { lastHeartbeatAt: string | null; reporting: number; reachable: number; total: number };
};
export type ReaderActivity = {
  type:
    | "tap"
    | "unreachable"
    | "reachable"
    | "address_changed"
    | "firmware_changed"
    | "restarted"
    | "weak_signal"
    | "reader_fault"
    | "reader_ready";
  at: string;
  detail: Record<string, unknown>;
};
export type ReaderHealthDetail = ReaderHealthSummary & {
  signal: { at: string; rssi: number | null }[];
  activity: ReaderActivity[];
  /** The reader's own last report while reachable. */
  lastKnown: { at: string; ready: boolean | null; rssi: number | null; address: string | null; firmware: string | null } | null;
};
/** A reader's light from its latest current report; null when unknown or unreachable. */
export type ReaderDoor = { doorState: DoorState | null; reportedAt: string | null };
export type AccessResource = {
  id: number;
  kind: "building" | "room" | "equipment" | "studio";
  name: string;
};
export type CardAssignment = {
  id: number;
  userId: number;
  memberName: string;
  label: string;
  active: boolean;
  assignedAt: string;
};
export type CardScan = {
  id: string;
  readerId: string;
  userId: number | null;
  purpose: "assign" | "lookup";
  expiresAt: string;
  /** Milliseconds left when the server answered. Count down from this: a browser with a wrong clock misreads expiresAt. */
  expiresInMs?: number;
  status: "waiting" | "captured" | "completed" | "expired" | "cancelled";
  last4?: string;
  assignments?: CardAssignment[];
};
export const uidHelp =
  "Find the card ID in your NFC reader’s diagnostic output. Enter 8, 14 or 20 hexadecimal characters (0–9, A–F); spaces, colons and hyphens are allowed. Example: 04:A1:B2:C3:D4:E5:F6.";
export function facilityTime(value: string, timeZone: string) {
  return new Date(value).toLocaleString([], {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  });
}
