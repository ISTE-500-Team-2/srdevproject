import { useSearchParams } from "react-router-dom";
import { StaffCompliance } from "./StaffCompliance";
import { StaffPolicies } from "./StaffPolicies";
import { TrainingPage } from "./TrainingPage";
import { useApi } from "../lib/useApi";
import type { ComplianceReport } from "../lib/staffContracts";
import "./certwaiver.css";
const sections = [
  { id: "compliance", label: "Compliance", component: StaffCompliance },
  { id: "waivers", label: "Waivers & policies", component: StaffPolicies },
  { id: "certifications", label: "Certifications", component: () => <TrainingPage embedded /> },
] as const;
export function AdminCertificationsPage() {
  // The section lives in the URL so links and the back button land on it.
  const [params, setParams] = useSearchParams();
  const current =
    sections.find((section) => section.id === params.get("section")) ??
    sections[0];
  const Content = current.component;
  // Badge on the Compliance tab: how many members need attention right now.
  const attention = useApi<ComplianceReport>("/admin/compliance?userStatus=active&attention=true", {
    retainOnReload: true,
    refreshInterval: 60000,
  }).data?.summary.attentionUsers;
  return (
    <section className="management-page">
      <nav className="cw-tabs" aria-label="Certification and waiver tools">
        {sections.map((section) => (
          <button
            key={section.id}
            type="button"
            aria-current={current.id === section.id ? "page" : undefined}
            className={current.id === section.id ? "is-selected" : ""}
            aria-label={section.id === "compliance" && attention ? `${section.label}, ${attention} need attention` : undefined}
            onClick={() => {
              const next = new URLSearchParams(params);
              next.set("section", section.id);
              setParams(next);
            }}
          >
            {section.label}
            {section.id === "compliance" && attention ? <em aria-hidden="true">{attention}</em> : null}
          </button>
        ))}
      </nav>
      <Content />
    </section>
  );
}
