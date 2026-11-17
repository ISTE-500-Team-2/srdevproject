import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import "./InfoTip.css";

/**
 * A small circled "i" that explains the thing beside it. Hover or focus shows the note;
 * a tap pins it open on touch screens; Escape or a tap elsewhere closes it.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <span className="info-tip" ref={root} data-open={open || undefined}>
      <button
        type="button"
        className="info-tip__button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={id}
        onClick={() => setOpen((was) => !was)}
      >
        <span aria-hidden="true">i</span>
      </button>
      <span className="info-tip__note" role="tooltip" id={id}>
        {children}
      </span>
    </span>
  );
}
