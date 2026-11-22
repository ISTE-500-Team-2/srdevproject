// The section menu's entries and which one is on screen.

import { Bell, CreditCard, FileText, KeyRound, LifeBuoy, Phone, UserRound, Users, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";

export const SECTIONS: { id: string; label: string; Icon: LucideIcon }[] = [
  { id: "profile", label: "Profile", Icon: UserRound },
  { id: "contact", label: "Contact", Icon: Phone },
  { id: "sign-in", label: "Sign-in", Icon: KeyRound },
  { id: "billing", label: "Membership & billing", Icon: CreditCard },
  { id: "minors", label: "Minors", Icon: Users },
  { id: "notifications", label: "Notifications", Icon: Bell },
  { id: "documents", label: "Documents", Icon: FileText },
  { id: "help", label: "Help", Icon: LifeBuoy },
];

/** Highlights the section menu entry for whatever is on screen. */
export function useCurrentSection(sections: typeof SECTIONS) {
  const [current, setCurrent] = useState(sections[0]!.id);
  const ids = sections.map((s) => s.id).join(" ");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setCurrent(visible.target.id);
      },
      { rootMargin: "-20% 0px -60% 0px" },
    );
    for (const id of ids.split(" ")) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [ids]);
  return current;
}
