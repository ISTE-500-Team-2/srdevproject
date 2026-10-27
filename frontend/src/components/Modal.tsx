import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

const modalStack: HTMLElement[] = [];
const originalInert = new Map<HTMLElement, boolean>();
function syncModalBackground() {
  const top = modalStack.at(-1);
  if (!top) {
    for (const [element, inert] of originalInert) element.inert = inert;
    originalInert.clear();
    document.body.classList.remove("modal-open");
    return;
  }
  document.body.classList.add("modal-open");
  for (const element of Array.from(document.body.children)) {
    if (!(element instanceof HTMLElement)) continue;
    if (!originalInert.has(element)) originalInert.set(element, element.inert);
    element.inert =
      element === top ? (originalInert.get(element) ?? false) : true;
  }
}
function focusable(dialog: HTMLElement) {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button,input,select,textarea,a[href],[tabindex],[contenteditable="true"]',
    ),
  ).filter(
    (element) =>
      !element.matches(":disabled") &&
      element.tabIndex >= 0 &&
      !element.closest("[hidden],[inert]") &&
      getComputedStyle(element).display !== "none" &&
      getComputedStyle(element).visibility !== "hidden",
  );
}

interface ModalProps {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  /** "panel" slides in from the right, keeping the page behind it visible. */
  width?: "compact" | "regular" | "panel";
}

export function Modal({
  open,
  title,
  children,
  onClose,
  width = "regular",
}: ModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const backdrop = backdropRef.current!;
    const previousFocus = document.activeElement;
    modalStack.push(backdrop);
    syncModalBackground();
    closeRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (modalStack.at(-1) !== backdrop) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
      }
      if (event.key === "Tab" && dialogRef.current) {
        const items = focusable(dialogRef.current);
        const first = items[0] ?? dialogRef.current;
        const last = items.at(-1) ?? first;
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            !dialogRef.current.contains(document.activeElement))
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            !dialogRef.current.contains(document.activeElement))
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const containFocus = (event: FocusEvent) => {
      if (
        modalStack.at(-1) === backdrop &&
        dialogRef.current &&
        !dialogRef.current.contains(event.target as Node)
      )
        (focusable(dialogRef.current)[0] ?? dialogRef.current).focus();
    };
    window.addEventListener("keydown", handleKey);
    document.addEventListener("focusin", containFocus);
    return () => {
      window.removeEventListener("keydown", handleKey);
      document.removeEventListener("focusin", containFocus);
      modalStack.splice(modalStack.indexOf(backdrop), 1);
      syncModalBackground();
      if (
        previousFocus instanceof HTMLElement &&
        previousFocus.isConnected &&
        !previousFocus.closest("[inert]")
      )
        previousFocus.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      ref={backdropRef}
      className={`modal-backdrop modal-backdrop--${width}`}
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        className={`modal-card modal-card--${width}`}
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-card__header">
          <h2 id={titleId}>{title}</h2>
          <button
            ref={closeRef}
            className="icon-button"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="modal-card__body">{children}</div>
      </section>
    </div>,
    document.body,
  );
}
