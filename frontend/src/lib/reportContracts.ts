/** The `/admin/reports` response, shared by the report and analytics screens. */
export type Report = {
  period: "daily" | "weekly" | "monthly";
  from: string;
  to: string;
  timeZone: string;
  generatedAt: string;
  notes: string[];
  revenue: {
    period: string;
    category: string;
    method: string;
    receipts: number;
    gross: string;
    refunds: string;
    net: string;
  }[];
  equipment: {
    id: number;
    name: string;
    bookedHours: number;
    bookedUtilizationPercent: number;
    reservations: number;
  }[];
  patterns: {
    id: number;
    name: string;
    weekday: number;
    hour: number;
    bookedHours: string;
  }[];
  classes: {
    id: number;
    title: string;
    capacity: number;
    enrolled: number;
    attended: number;
    filledPercent: string;
    status: string;
    startsAt: string;
  }[];
  rooms: {
    id: number;
    name: string;
    capacity: number;
    recordedCheckIns: number;
    distinctVisitors: number;
  }[];
  active: { activeUsers: number; approvedCheckIns: number };
  visitsByDay: { day: string; visits: number; people: number }[];
  checkedInToday: { userId: number; name: string; location: string; at: string; method: "nfc" | "portal" }[];
  checkedInTodayCount: number;
  compliance: {
    activeAccounts: number;
    restrictedAccounts: number;
    expiredTraining: number;
    activeMemberships: number;
    trainingWithoutExpiry: number;
    signaturesWithoutCopy: number;
    machinesWithoutTraining: string[];
  };
  live: {
    kind: string;
    resourceId: number | null;
    activeReaderLeases: number;
  }[];
  usage: { equipmentId: number; authorizedHours: string }[];
  memberships: {
    period: string;
    newMembers: number;
    activeMembers: number;
    expiringMembers: number;
    cancelledMembers: number;
  }[];
  notifications: {
    cohorts: Record<
      string,
      {
        eligible: number;
        on_time: number;
        onTimePercent: number | null;
        delivered: number;
        delivery_on_time: number;
        deliveryOnTimePercent: number | null;
        delivery_failed: number;
        failed: number;
        uncertain: number;
        pending: number;
      }
    >;
  };
};
