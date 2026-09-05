import { CheckCircle2, X } from 'lucide-react';

interface ToastProps {
  message: string | null;
  onClose: () => void;
}

export function Toast({ message, onClose }: ToastProps) {
  if (!message) return null;
  return (
    <div className="toast" role="status" aria-live="polite">
      <CheckCircle2 aria-hidden="true" />
      <span>{message}</span>
      <button className="icon-button icon-button--small" onClick={onClose} aria-label="Dismiss notification">
        <X aria-hidden="true" />
      </button>
    </div>
  );
}
