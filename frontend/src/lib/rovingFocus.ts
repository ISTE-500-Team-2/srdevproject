// Arrow-key movement for button groups that screen readers announce as tabs, radio buttons or a
// menu: those roles tell people to move with the arrow keys, so the keys have to work.

import type { KeyboardEvent } from "react";

const steps: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * Put on the role="tablist", role="radiogroup" or role="menu" element. The arrow keys, Home and
 * End move focus to another enabled tab, radio button or menu item. Tabs and radio buttons are
 * also chosen as focus arrives (a click), like native radio buttons; pass `choose: false` for a
 * menu. Give the chosen tab or radio tabIndex 0 and the others -1, so Tab enters the group once.
 */
export function onArrowKeys(event: KeyboardEvent<HTMLElement>, { choose = true } = {}) {
  const step = steps[event.key];
  if (step === undefined && event.key !== "Home" && event.key !== "End") return;
  const options = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"],[role="radio"],[role="menuitem"]'),
  ).filter((option) => !option.disabled);
  const from = options.indexOf(event.target as HTMLButtonElement);
  if (from < 0) return;
  const to =
    event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (from + step! + options.length) % options.length;
  event.preventDefault();
  options[to]!.focus();
  if (choose && to !== from) options[to]!.click();
}
