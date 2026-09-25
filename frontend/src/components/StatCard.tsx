import type { JSX, ReactNode } from 'react';

export type StatTint = 'tint-accent' | 'tint-ok' | 'tint-warn' | 'tint-err' | 'tint-muted';

export interface StatCardAction {
  label: string;
  onClick: () => void;
  busy?: boolean;
}

export interface StatCardProps {
  label: string; value: string | number; sub: ReactNode;
  tint: StatTint;
  icon: JSX.Element;
  subTitle?: string;
  className?: string;
  // Renders the tinted icon itself as the button, so an actionable card keeps the same geometry.
  action?: StatCardAction;
}

export function StatCard(
  { label, value, sub, tint, icon, subTitle, className, action }: StatCardProps,
): JSX.Element {
  const ico = `stat-ico ${tint}`;
  return (
    <div className={className ? `stat ${className}` : 'stat'}>
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        {action ? (
          <button
            type="button"
            className={`${ico} stat-ico-btn${action.busy ? ' spin' : ''}`}
            title={action.label}
            aria-label={action.label}
            onClick={action.onClick}
            disabled={action.busy}
          >
            {icon}
          </button>
        ) : (
          <span className={ico}>{icon}</span>
        )}
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-sub" title={subTitle}><span className="stat-sub-text">{sub}</span></div>
    </div>
  );
}
