// Labels and short status lines for reader health. Kept as plain functions so pages and tests
// share one wording.

import type { ReaderActivity, ReaderHealthSummary, ReaderStatus } from "../../lib/nfc";

/** Below this the reader is likely to drop out (matches the backend). */
export const WEAK_SIGNAL_DBM = -80;

export const statusLabel: Record<ReaderStatus, string> = {
  working: "Working",
  online: "Online",
  weak_signal: "Weak signal",
  reader_fault: "NFC chip not responding",
  unreachable: "Unreachable",
  not_reporting: "Not reporting",
  never_connected: "Not connected yet",
  disabled: "Disabled",
};

export type Tone = "allowed" | "denied" | "pending" | "neutral";
export const statusTone: Record<ReaderStatus, Tone> = {
  working: "allowed",
  online: "allowed",
  weak_signal: "pending",
  reader_fault: "denied",
  unreachable: "denied",
  not_reporting: "denied",
  never_connected: "neutral",
  disabled: "neutral",
};

/** Statuses that belong in "Needs attention", most serious first. */
export const attentionOrder: ReaderStatus[] = ["unreachable", "not_reporting", "reader_fault", "weak_signal"];

/** "21 min", "2 h 5 min", "3 days". */
export function duration(ms: number) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}

export function clock(value: string, timeZone: string) {
  return new Date(value).toLocaleTimeString([], { timeZone, hour: "numeric", minute: "2-digit" });
}

export function signalQuality(rssi: number | null) {
  if (rssi === null) return null;
  if (rssi < WEAK_SIGNAL_DBM) return "Weak";
  if (rssi < -67) return "Fair";
  return "Good";
}

const reasons: Record<string, string> = {
  CARD_REVOKED: "card revoked",
  READER_DISABLED: "reader disabled",
  ENROLLMENT_CAPTURED: "card captured for setup",
  ENROLLMENT_WAITING: "setup in progress",
  UNKNOWN_CARD: "unknown card",
};
export function tapResult(tap: { allowed: boolean; reason: string }) {
  if (tap.allowed) return "Allowed";
  const reason = reasons[tap.reason] ?? tap.reason.toLowerCase().replace(/_/g, " ");
  return `Denied: ${reason}`;
}

/** The headline for a reader that needs attention. */
export function problemTitle(reader: Pick<ReaderHealthSummary, "status">) {
  switch (reader.status) {
    case "unreachable":
      return "Can't reach the gateway";
    case "not_reporting":
      return "No reports from the gateway";
    case "reader_fault":
      return "NFC chip not responding";
    case "weak_signal":
      return "Weak Wi-Fi signal";
    default:
      return statusLabel[reader.status];
  }
}

export function activityLine(item: ReaderActivity): { title: string; detail?: string } {
  const d = item.detail;
  switch (item.type) {
    case "tap":
      return {
        title: d.allowed ? "Tap allowed" : "Tap denied",
        detail: [d.last4 ? `Card ending ${String(d.last4)}` : null, d.allowed ? null : tapResult({ allowed: false, reason: String(d.reason ?? "") }).replace("Denied: ", "")]
          .filter(Boolean)
          .join(" · "),
      };
    case "unreachable":
      return { title: "Stopped answering the gateway" };
    case "reachable":
      return {
        title: "Back online",
        detail: typeof d.outageSeconds === "number" ? `Out ${duration(d.outageSeconds * 1000)}` : undefined,
      };
    case "address_changed":
      return { title: "Network address changed", detail: `${String(d.from)} → ${String(d.to)}` };
    case "firmware_changed":
      return { title: "Firmware changed", detail: `${String(d.from)} → ${String(d.to)}` };
    case "restarted":
      return { title: "Reader restarted" };
    case "weak_signal":
      return { title: "Weak Wi-Fi", detail: typeof d.rssi === "number" ? `${d.rssi} dBm` : undefined };
    case "reader_fault":
      return { title: "NFC chip stopped responding" };
    case "reader_ready":
      return { title: "NFC chip responding again" };
  }
}
