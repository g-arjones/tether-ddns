export type ToastKind = 'success' | 'error' | 'info';

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
    return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>;
  }
  if (kind === 'error') {
    return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M15 9l-6 6M9 9l6 6" /></svg>;
  }
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>;
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
