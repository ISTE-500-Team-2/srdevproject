import { useSearchParams } from "react-router-dom";
import { StaffCompliance } from "./StaffCompliance";
import { StaffPolicies } from "./StaffPolicies";
import { TrainingPage } from "./TrainingPage";
const sections = [
  { id: "compliance", label: "Compliance", component: StaffCompliance },
  { id: "waivers", label: "Waivers & policies", component: StaffPolicies },
  { id: "certifications", label: "Certifications", component: TrainingPage },
] as const;
export function AdminCertificationsPage() {
  // The section lives in the URL so links and the back button land on it.
  const [params, setParams] = useSearchParams();
  const current =
    sections.find((section) => section.id === params.get("section")) ??
    sections[0];
  const Content = current.component;
  return (
    <section className="management-page">
      <div>
        <h2>Certifications &amp; waivers</h2>
        <p>Check who is compliant, publish waivers, and record training.</p>
      </div>
      <nav className="segmented" aria-label="Certification and waiver tools">
        {sections.map((section) => (
          <button
            key={section.id}
            type="button"
            aria-current={current.id === section.id ? "page" : undefined}
            className={current.id === section.id ? "is-selected" : ""}
            onClick={() => {
              const next = new URLSearchParams(params);
              next.set("section", section.id);
              setParams(next);
            }}
          >
            {section.label}
          </button>
        ))}
      </nav>
      <Content />
    </section>
  );
}
