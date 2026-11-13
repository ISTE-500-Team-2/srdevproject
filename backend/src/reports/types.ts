import type { membershipTrends } from "../membershipReports.js";
import type { CheckInOrigin } from "../models/checkInOrigin.js";
import type { notificationMetrics } from "../notifications/store.js";

export type ReportPeriod = "daily" | "weekly" | "monthly";
/** Validated report request: inclusive local dates in the facility time zone. */
export interface ReportRequest {
  from: string;
  to: string;
  period: ReportPeriod;
}

// node-postgres returns int/float columns as numbers and numeric/bigint/text as strings.
export interface RevenueRow {
  period: string;
  category: string;
  method: string;
  receipts: number;
  gross: string;
  refunds: string;
  net: string;
}
export interface EquipmentUtilizationRow {
  id: number;
  name: string;
  bookedHours: number;
  reservations: number;
  windowHours: string;
  bookedUtilizationPercent: number;
}
export interface UsagePatternRow {
  id: number;
  name: string;
  weekday: number;
  hour: number;
  bookedHours: string;
}
export interface ClassFillRow {
  id: number;
  title: string;
  capacity: number;
  status: string;
  startsAt: Date;
  room: string;
  enrolled: number;
  attended: number;
  filledPercent: string;
}
export interface RoomVisitRow {
  id: number;
  name: string;
  capacity: number | null;
  recordedCheckIns: number;
  distinctVisitors: number;
}
export interface ActiveSummary {
  activeUsers: number;
  approvedCheckIns: number;
}
export interface ComplianceSummary {
  activeAccounts: number;
  restrictedAccounts: number;
  expiredTraining: number;
  trainingWithoutExpiry: number;
  activeMemberships: number;
  signaturesWithoutCopy: number;
  machinesWithoutTraining: string[];
}
export interface LiveLeaseRow {
  kind: string;
  resourceId: number | null;
  activeReaderLeases: number;
}
export interface AuthorizedUsageRow {
  equipmentId: number | null;
  authorizedHours: string;
}
export interface VisitDayRow {
  day: string;
  visits: number;
  people: number;
}
export interface CheckedInPerson {
  userId: number;
  name: string;
  location: string;
  at: Date;
  method: CheckInOrigin;
}

export interface ReportData {
  from: string;
  to: string;
  timeZone: string;
  period: ReportPeriod;
  generatedAt: string;
  revenue: RevenueRow[];
  equipment: EquipmentUtilizationRow[];
  patterns: UsagePatternRow[];
  classes: ClassFillRow[];
  rooms: RoomVisitRow[];
  active: ActiveSummary;
  compliance: ComplianceSummary;
  live: LiveLeaseRow[];
  usage: AuthorizedUsageRow[];
  visitsByDay: VisitDayRow[];
  checkedInToday: CheckedInPerson[];
  checkedInTodayCount: number;
  memberships: Awaited<ReturnType<typeof membershipTrends>>;
  notifications: Awaited<ReturnType<typeof notificationMetrics>>;
  notes: string[];
}
