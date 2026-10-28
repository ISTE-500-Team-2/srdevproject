import { Navigate, useLocation } from "react-router-dom";
import type { AdminSection } from "./sections";
import { legacyAdminPath } from "./sections";
import { TodayPage } from "./TodayPage";

// Pages that already render their own top-level heading.
const ownHeading = new Set(["access", "reports", "studios"]);

/** One workspace section under /admin/<path>. */
export function AdminSectionPage({ section }: { section: AdminSection }) {
  const Content = section.component;
  return (
    <div className="admin-section management-page">
      {ownHeading.has(section.path) ? null : <h1 className="admin-title">{section.label}</h1>}
      <Content />
    </div>
  );
}

/** /admin itself: Today, unless an old ?tab= link needs to land on its section. */
export function AdminIndex() {
  const { search } = useLocation();
  const legacy = legacyAdminPath(search);
  return legacy ? <Navigate to={legacy} replace /> : <TodayPage />;
}
