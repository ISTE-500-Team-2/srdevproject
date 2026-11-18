// In-page section menus (account settings, reports): scroll to a section and take keyboard focus
// along, so Tab and a screen reader carry on from that section instead of staying in the menu.

/**
 * Scrolls section `id` to the top, smoothly unless the person prefers reduced motion, and
 * focuses its heading (`${id}-title`, which needs tabIndex={-1}).
 */
export function jumpToSection(id: string) {
  const section = document.getElementById(id);
  if (!section) return;
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  section.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
  (document.getElementById(`${id}-title`) ?? section).focus({ preventScroll: true });
}
