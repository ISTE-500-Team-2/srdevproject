import { EquipmentManagementPage } from "./EquipmentManagementPage";
import type { ComponentType } from "react";
import {
  CalendarRange,
  ChartLine,
  DoorOpen,
  FileChartColumn,
  History,
  Wrench,
  Layers,
  Nfc,
  Receipt,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import { AnalyticsDashboardPage } from "../AnalyticsDashboardPage";
import { AdminCertificationsPage } from "../AdminCertificationsPage";
import { AccessManagementPage } from "../AccessManagementPage";
import { ReportsPage } from "../ReportsPage";
import { StaffPayments } from "../StaffPayments";
import { StaffPlans } from "../StaffPlans";
import { StaffReservations } from "../StaffReservations";
import { StaffStudios } from "../StaffStudios";
import { StaffUsers } from "../StaffUsers";
import { ChangeLog } from "./ChangeLog";

export interface AdminSection {
  /** URL segment under /admin. */
  path: string;
  label: string;
  icon: LucideIcon;
  component: ComponentType;
  /** The old ?tab= value, so bookmarked workspace links keep working. */
  legacyTab: string;
}

export const adminGroups: { label: string; sections: AdminSection[] }[] = [
  {
    label: "People",
    sections: [
      { path: "members", label: "Members", icon: Users, component: StaffUsers, legacyTab: "members" },
      {
        path: "certifications",
        label: "Certifications & waivers",
        icon: ShieldCheck,
        component: AdminCertificationsPage,
        legacyTab: "adminCertWaiver",
      },
    ],
  },
  {
    label: "Operations",
    sections: [
      { path: "equipment", label: "Equipment", icon: Wrench, component: EquipmentManagementPage, legacyTab: "equipment" },
      { path: "reservations", label: "Reservations", icon: CalendarRange, component: StaffReservations, legacyTab: "reservations" },
      { path: "studios", label: "Studios", icon: DoorOpen, component: StaffStudios, legacyTab: "studios" },
      { path: "access", label: "Reader access", icon: Nfc, component: AccessManagementPage, legacyTab: "access" },
    ],
  },
  {
    label: "Billing",
    sections: [
      { path: "plans", label: "Plans", icon: Layers, component: StaffPlans, legacyTab: "plans" },
      { path: "payments", label: "Payments", icon: Receipt, component: StaffPayments, legacyTab: "payments" },
    ],
  },
  {
    label: "Records",
    sections: [
      { path: "analytics", label: "Analytics", icon: ChartLine, component: AnalyticsDashboardPage, legacyTab: "analytics" },
      { path: "reports", label: "Reports", icon: FileChartColumn, component: ReportsPage, legacyTab: "reports" },
      { path: "change-log", label: "Change log", icon: History, component: ChangeLog, legacyTab: "audit" },
    ],
  },
];

export const adminSections = adminGroups.flatMap((group) => group.sections);

// Compliance, Policies and Training were folded into Certifications & waivers;
// their old tab links land on the matching section of that page.
const foldedTabs: Record<string, string> = {
  compliance: "compliance",
  policies: "waivers",
  training: "certifications",
};

/** Where an old /admin?tab=… link should go now, or null when it isn't one. */
export function legacyAdminPath(search: string): string | null {
  const params = new URLSearchParams(search);
  const tab = params.get("tab");
  if (!tab) return null;
  const folded = foldedTabs[tab];
  if (folded) return `/admin/certifications?section=${folded}`;
  const section = adminSections.find((item) => item.legacyTab === tab);
  if (!section) return "/admin";
  params.delete("tab");
  const rest = params.toString();
  return `/admin/${section.path}${rest ? `?${rest}` : ""}`;
}
