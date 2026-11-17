// Portal dialog with focus trapping, stacked-modal isolation and unsaved-change protection shared
// across member and staff forms.

import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

const modalStack: HTMLElement[] = [];
const originalInert = new Map<HTMLElement, boolean>();
/**
 * Only the top portal remains interactive; restore each element's original inert state after the
 * last dialog closes.
 */
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
    // Status messages (see Toast) stay announced, and can be dismissed, above an open dialog.
    if (!(element instanceof HTMLElement) || element.hasAttribute("data-live-region")) continue;
    if (!originalInert.has(element)) originalInert.set(element, element.inert);
    element.inert =
      element === top ? (originalInert.get(element) ?? false) : true;
  }
}
/**
 * Calculate the current visible tab stops each time, including controls added or removed by
 * conditional dialog content. A <details> summary is a tab stop; what a closed one holds is not.
 */
function focusable(dialog: HTMLElement) {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button,input,select,textarea,a[href],summary,iframe,[tabindex],[contenteditable="true"]',
    ),
  ).filter(
    (element) =>
      !element.matches(":disabled") &&
      element.tabIndex >= 0 &&
      !element.closest("[hidden],[inert],details:not([open]) > :not(summary)") &&
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
  /** Replaces the title heading with richer content; `title` still names the dialog. */
  header?: ReactNode;
  /** Extra class on the dialog card, for a panel with its own layout. */
  className?: string;
}

/**
 * Provide focus restoration/trapping and a common close path that can ask before discarding unsaved
 * changes.
 */
export function Modal({
  open,
  title,
  children,
  onClose,
  dirty = false,
  dismissible = true,
  width = "regular",
  header,
  className,
}: ModalProps) {
  const [confirmingClose, setConfirmingClose] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  // A field marked autoFocus takes focus while React commits, before the effect below runs, so
  // the control that had focus is also noted while the dialog renders open.
  const [opener, setOpener] = useState(() => (open ? document.activeElement : null));
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpener(document.activeElement);
  }
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
    // Return focus to the control that opened the dialog, even when autoFocus has moved it inside.
    const previousFocus = dialogRef.current?.contains(document.activeElement) ? opener : document.activeElement;
    modalStack.push(backdrop);
    syncModalBackground();
    // Start on Close unless a field in the dialog has already taken focus with autoFocus.
    if (!dialogRef.current?.contains(document.activeElement)) closeRef.current?.focus();
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
            aria-labelledby={header ? undefined : titleId}
            aria-label={header ? title : undefined}
            className={`modal-card modal-card--${width}${className ? ` ${className}` : ""}`}
            role="dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="modal-card__header">
              {header ?? <h2 id={titleId}>{title}</h2>}
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
