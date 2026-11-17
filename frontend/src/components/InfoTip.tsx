import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import "./InfoTip.css";

/**
 * A small circled "i" that explains the thing beside it. Hover or focus shows the note;
 * a tap pins it open on touch screens; Escape or a tap elsewhere closes it. Escape also
 * hides a note shown by hover or focus until both have left the badge (WCAG 1.4.13).
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const shown = open || ((hovered || focused) && !dismissed);
  useEffect(() => {
    if (!shown) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      setDismissed(true);
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [shown]);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  return (
    <span
      className="info-tip"
      ref={root}
      data-open={open || undefined}
      data-dismissed={dismissed || undefined}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => {
        setHovered(false);
        if (!focused) setDismissed(false);
      }}
    >
      <button
        type="button"
        className="info-tip__button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={id}
        onClick={() => {
          setOpen((was) => !was);
          setDismissed(false);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          if (!hovered) setDismissed(false);
        }}
      >
        <span aria-hidden="true">i</span>
      </button>
      <span className="info-tip__note" role="tooltip" id={id}>
        {children}
      </span>
    </span>
  );
}
