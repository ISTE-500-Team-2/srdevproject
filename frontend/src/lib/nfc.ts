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
  kind: "building" | "room" | "equipment";
  resourceId: number;
  resourceName: string;
  enabled: boolean;
  online: boolean;
  lastSeenAt: string | null;
  revision: number;
};
export type ReaderSetup = {
  configured: boolean;
  timeZone: string;
  readers: AccessReader[];
};
export type AccessResource = {
  id: number;
  kind: "building" | "room" | "equipment";
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
