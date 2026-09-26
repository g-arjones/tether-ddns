import { useEffect, useId, useRef, type JSX, type ReactNode } from 'react';
import { IconButton } from './IconButton';
import { IconClose } from './icons';

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

// The overlay stays mounted while closed so the fade has something to animate;
// `inert` + `aria-hidden` are what keep the closed form out of the tab order.
export function Modal({ open, title, onClose, children, footer }: ModalProps): JSX.Element {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    (dialog?.querySelector<HTMLElement>('[data-autofocus]') ?? dialog)?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  return (
    <div
      className={`modal-overlay${open ? ' open' : ''}`}
      inert={!open}
      aria-hidden={open ? undefined : true}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h3 id={titleId}>{title}</h3>
          <IconButton label="Close" onClick={onClose}><IconClose /></IconButton>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}
