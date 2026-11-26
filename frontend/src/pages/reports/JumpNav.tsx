import { useEffect, useState } from "react";
import { jumpToSection } from "../../lib/sectionJump";

const SECTIONS = [
  ["reports-revenue", "Revenue"],
  ["reports-records", "Records"],
  ["reports-members", "Members"],
  ["reports-reminders", "Reminder emails"],
  ["reports-equipment", "Equipment"],
  ["reports-classes", "Classes"],
  ["reports-rooms", "Rooms"],
] as const;

/** Stays in view while scrolling and marks the section on screen. */
export function JumpNav({ warnings }: { warnings: number }) {
  const [active, setActive] = useState<string>(SECTIONS[0][0]);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const visible = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) visible.set(entry.target.id, entry.isIntersecting);
        const first = SECTIONS.find(([id]) => visible.get(id));
        if (first) setActive(first[0]);
      },
      // The band just under the sticky bar decides which section is "current".
      { rootMargin: "-120px 0px -60% 0px" },
    );
    for (const [id] of SECTIONS) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, []);
  return (
    <nav className="reports-jump" aria-label="Report sections">
      {SECTIONS.map(([id, label]) => (
        <button
          key={id}
          type="button"
          aria-label={id === "reports-records" && warnings ? `${label}, ${warnings} to check` : undefined}
          aria-current={active === id ? "location" : undefined}
          onClick={() => {
            setActive(id);
            jumpToSection(id);
          }}
        >
          {label}
          {id === "reports-records" && warnings ? <em aria-hidden="true">{warnings}</em> : null}
        </button>
      ))}
    </nav>
  );
}
