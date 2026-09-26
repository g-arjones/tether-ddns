import type { JSX, ReactNode } from 'react';
import { Modal } from './Modal';

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}

export function ConfirmModal({
  open, title, confirmLabel, busy = false, onConfirm, onCancel, children,
}: ConfirmModalProps): JSX.Element {
  const footer = (
    <>
      <button type="button" className="btn btn-ghost" data-autofocus disabled={busy} onClick={onCancel}>
        Cancel
      </button>
      <button type="button" className="btn btn-danger" disabled={busy} onClick={onConfirm}>
        {confirmLabel}
      </button>
    </>
  );
  // A delete in flight cannot be abandoned halfway.
  const close = busy ? () => undefined : onCancel;
  return (
    <Modal open={open} title={title} onClose={close} footer={footer}>
      <p className="confirm-msg">{children}</p>
    </Modal>
  );
}
