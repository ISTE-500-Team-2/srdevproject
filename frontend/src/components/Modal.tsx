import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

interface ModalProps {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  width?: 'compact' | 'regular';
}

export function Modal({ open, title, children, onClose, width = 'regular' }: ModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.body.classList.add('modal-open');
    window.addEventListener('keydown', handleKey);
    return () => {
      document.body.classList.remove('modal-open');
      window.removeEventListener('keydown', handleKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-modal="true"
        aria-labelledby="modal-title"
        className={`modal-card modal-card--${width}`}
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-card__header">
          <h2 id="modal-title">{title}</h2>
          <button ref={closeRef} className="icon-button" onClick={onClose} aria-label="Close dialog">
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="modal-card__body">{children}</div>
      </section>
    </div>
  );
}
