import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

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
  /** Use the close callback for footer buttons that must respect draft protection. */
  children: ReactNode | ((requestClose: () => void) => ReactNode);
  onClose: () => void;
  dirty?: boolean;
  dismissible?: boolean;
  /** "panel" slides in from the right, keeping the page behind it visible. */
  width?: "compact" | "regular" | "panel" | "navigation";
}

export function Modal({
  open,
  title,
  children,
  onClose,
  dirty = false,
  dismissible = true,
  width = "regular",
}: ModalProps) {
  const [confirmingClose, setConfirmingClose] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  const requestClose = () => {
    if (!dismissible) return;
    if (dirty) setConfirmingClose(true);
    else onClose();
  };
  useEffect(() => {
    onCloseRef.current = requestClose;
  });
  useEffect(() => {
    if (!open) setConfirmingClose(false);
  }, [open]);

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

  return (
    <>
      {createPortal(
        <div
          ref={backdropRef}
          className={`modal-backdrop modal-backdrop--${width}`}
          role="presentation"
          onMouseDown={requestClose}
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
                type="button"
                onClick={requestClose}
                disabled={!dismissible}
                aria-label="Close dialog"
              >
                <X aria-hidden="true" />
              </button>
            </header>
            <div className="modal-card__body">{typeof children === "function" ? children(requestClose) : children}</div>
          </section>
        </div>,
        document.body,
      )}
      {confirmingClose ? (
        <Modal open width="compact" title="Discard unsaved changes?" dismissible={dismissible} onClose={() => setConfirmingClose(false)}>
          <p>Your changes haven't been saved. Keep editing to retain your draft.</p>
          <div className="management-actions">
            <button type="button" className="button button--primary" disabled={!dismissible} onClick={() => setConfirmingClose(false)}>Keep editing</button>
            <button type="button" className="button button--quiet" disabled={!dismissible} onClick={() => { setConfirmingClose(false); onClose(); }}>Discard changes</button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
