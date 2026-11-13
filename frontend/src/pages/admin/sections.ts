import { EquipmentManagementPage } from "./EquipmentManagementPage";
import type { ComponentType } from "react";
import { adminNavGroups, type AdminNavSection, type AdminSectionPath } from "../../components/admin/adminNavigation";
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
import { ServiceNotices } from "./ServiceNotices";

/** A workspace section with the page it renders; its navigation data lives in components/admin/adminNavigation. */
export interface AdminSection extends AdminNavSection {
  component: ComponentType;
}

const pages: Record<AdminSectionPath, ComponentType> = {
  members: StaffUsers,
  certifications: AdminCertificationsPage,
  equipment: EquipmentManagementPage,
  reservations: StaffReservations,
  studios: StaffStudios,
  access: AccessManagementPage,
  "service-notices": ServiceNotices,
  plans: StaffPlans,
  payments: StaffPayments,
  analytics: AnalyticsDashboardPage,
  reports: ReportsPage,
  "change-log": ChangeLog,
};

export const adminGroups: { label: string; sections: AdminSection[] }[] = adminNavGroups.map((group) => ({
  label: group.label,
  sections: group.sections.map((section) => ({ ...section, component: pages[section.path] })),
}));

export const adminSections = adminGroups.flatMap((group) => group.sections);
