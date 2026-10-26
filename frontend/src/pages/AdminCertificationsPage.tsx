import { useState } from "react";
import { StaffCompliance } from "./StaffCompliance";
import { StaffPolicies } from "./StaffPolicies";
import { TrainingPage } from "./TrainingPage";
const sections = [
  { id: "compliance", label: "Compliance Search", component: StaffCompliance },
  { id: "waivers", label: "Waiver and Policy Management", component: StaffPolicies },
  {
    id: "training",
    label: "Certification Management",
    component: TrainingPage,
  },
] as const;
export function AdminCertificationsPage() {
  const [selected, setSelected] = useState<string>("compliance");
  const Content = sections.find(
    (section) => section.id === selected,
  )!.component;
  return (
    <section className="management-page">
      <h2>Certifications and waivers</h2>
      <p>
        Find compliance gaps, publish or retire waiver versions, and record
        verified training. Signed waiver history is preserved.
      </p>
      <nav
        className="management-tabs"
        aria-label="Certification and waiver tools"
      >
        {sections.map((section) => (
          <button
            key={section.id}
            aria-current={selected === section.id ? "page" : undefined}
            className={selected === section.id ? "is-selected" : ""}
            onClick={() => setSelected(section.id)}
          >
            {section.label}
          </button>
        ))}
      </nav>
      <Content />
    </section>
  );
}
