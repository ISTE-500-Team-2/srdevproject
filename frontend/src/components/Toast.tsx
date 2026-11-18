// Portals a dismissible notice above page content; message lifetime is controlled by the caller.

import { createPortal } from 'react-dom';
import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';

interface ToastProps {
  message: string | null;
  onClose: () => void;
  /** "done" confirms something worked; "notice" says something changed that needs a look; "problem" says it didn't work. */
  tone?: 'done' | 'notice' | 'problem';
}

export function Toast({ message, onClose, tone = 'done' }: ToastProps) {
  if (!message) return null;
  return createPortal(
    <div className={tone === 'problem' ? 'toast toast--problem' : 'toast'} role={tone === 'problem' ? 'alert' : 'status'} aria-live={tone === 'problem' ? 'assertive' : 'polite'}>
      {tone === 'problem' ? <TriangleAlert aria-hidden="true" /> : tone === 'notice' ? <Info aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
      <span>{message}</span>
      <button className="icon-button icon-button--small" onClick={onClose} aria-label="Dismiss notification">
        <X aria-hidden="true" />
      </button>
    </div>,
    document.body,
  );
}
