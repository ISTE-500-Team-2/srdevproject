// Portals a dismissible notice above page content; message lifetime is controlled by the caller.

import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';
import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';

interface ToastProps {
  message: string | null;
  onClose: () => void;
  /** "done" confirms something worked; "notice" says something changed that needs a look; "problem" says it didn't work. */
  tone?: 'done' | 'notice' | 'problem';
}

export function Toast({ message, onClose, tone = 'done' }: ToastProps) {
  // Screen readers reliably announce only text that changes inside a live region already on the
  // page, so the empty region stays mounted with its page, and a message that arrives together
  // with the page waits a moment for the region to register first.
  const [ready, setReady] = useState(!message);
  useEffect(() => {
    if (ready) return;
    const timer = window.setTimeout(() => setReady(true), 100);
    return () => window.clearTimeout(timer);
  }, [ready]);
  const shown = Boolean(message && ready);
  const problem = tone === 'problem';
  const content = (
    <>
      {problem ? <TriangleAlert aria-hidden="true" /> : tone === 'notice' ? <Info aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
      <span>{message}</span>
      <button className="icon-button icon-button--small" onClick={onClose} aria-label="Dismiss notification">
        <X aria-hidden="true" />
      </button>
    </>
  );
  return createPortal(
    <>
      <div role="status" aria-live="polite" data-live-region="">
        {shown && !problem ? <div className="toast">{content}</div> : null}
      </div>
      {/* A problem is an alert, which screen readers announce at once as soon as it is added. */}
      {shown && problem ? (
        <div className="toast toast--problem" role="alert" aria-live="assertive" data-live-region="">
          {content}
        </div>
      ) : null}
    </>,
    document.body,
  );
}
