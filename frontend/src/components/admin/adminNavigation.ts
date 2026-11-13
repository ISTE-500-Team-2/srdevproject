import {
  CalendarRange,
  ChartLine,
  DoorOpen,
  FileChartColumn,
  History,
  Wrench,
  Layers,
  Megaphone,
  Nfc,
  Receipt,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { PageWidth } from "./pageWidth";

/** A workspace section as the sidebar and old links see it; the page it renders lives in pages/admin/sections. */
export interface AdminNavSection {
  /** URL segment under /admin. */
  path: string;
  label: string;
  icon: LucideIcon;
  /** The old ?tab= value, so bookmarked workspace links keep working. */
  legacyTab: string;
  /** How wide the page may grow; pages that vary by view (equipment) declare it themselves. */
  width?: PageWidth;
}

const navGroups = [
  {
    label: "People",
    sections: [
      { path: "members", label: "Members", icon: Users, legacyTab: "members", width: "wide" },
      {
        path: "certifications",
        label: "Certifications & waivers",
        icon: ShieldCheck,
        legacyTab: "adminCertWaiver",
      },
    ],
  },
  {
    label: "Operations",
    sections: [
      { path: "equipment", label: "Equipment", icon: Wrench, legacyTab: "equipment" },
      { path: "reservations", label: "Reservations", icon: CalendarRange, legacyTab: "reservations", width: "wide" },
      { path: "studios", label: "Studios", icon: DoorOpen, legacyTab: "studios" },
      { path: "access", label: "Reader access", icon: Nfc, legacyTab: "access" },
      { path: "service-notices", label: "Service notices", icon: Megaphone, legacyTab: "service-notices" },
    ],
  },
  {
    label: "Billing",
    sections: [
      { path: "plans", label: "Plans", icon: Layers, legacyTab: "plans" },
      { path: "payments", label: "Payments", icon: Receipt, legacyTab: "payments" },
    ],
  },
  {
    label: "Records",
    sections: [
      { path: "analytics", label: "Analytics", icon: ChartLine, legacyTab: "analytics", width: "wide" },
      { path: "reports", label: "Reports", icon: FileChartColumn, legacyTab: "reports", width: "wide" },
      { path: "change-log", label: "Change log", icon: History, legacyTab: "audit" },
    ],
  },
] as const satisfies readonly { label: string; sections: readonly AdminNavSection[] }[];

/** Every section's URL segment, so the page map in pages/admin/sections must cover each one. */
export type AdminSectionPath = (typeof navGroups)[number]["sections"][number]["path"];

/** The sidebar's groups, in order. */
export const adminNavGroups: readonly { label: string; sections: readonly (AdminNavSection & { path: AdminSectionPath })[] }[] = navGroups;

const adminNavSections = adminNavGroups.flatMap((group) => group.sections);

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
  const section = adminNavSections.find((item) => item.legacyTab === tab);
  if (!section) return "/admin";
  params.delete("tab");
  const rest = params.toString();
  return `/admin/${section.path}${rest ? `?${rest}` : ""}`;
}
