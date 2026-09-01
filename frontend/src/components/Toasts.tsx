export type ToastKind = 'success' | 'error' | 'info';

import { IconSuccess, IconError, IconInfo } from './icons';

export interface ToastItem {
  id: string;
  message: string;
  kind: ToastKind;
}

export interface ToastsProps {
  toasts: ToastItem[];
}

const TINT: Record<ToastKind, string> = {
  success: 'tint-ok',
  error: 'tint-err',
  info: 'tint-accent',
};

function Icon({ kind }: { kind: ToastKind }) {
  if (kind === 'success') {
    return <IconSuccess strokeWidth={2.5} />;
  }
  if (kind === 'error') {
    return <IconError strokeWidth={2.5} />;
  }
  return <IconInfo strokeWidth={2.5} />;
}

export function Toasts({ toasts }: ToastsProps) {
  return (
    <div className="toast-wrap">
      {toasts.map((t) => (
        <div className="toast" key={t.id}>
          <span className={`t-ico ${TINT[t.kind]}`}><Icon kind={t.kind} /></span>
          <span className="t-msg">{t.message}</span>
        </div>
      ))}
    </div>
  );
}
