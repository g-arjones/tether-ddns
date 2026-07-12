import type { JSX } from 'react';

export interface StatCardProps {
  label: string; value: string | number; sub: string;
  tint: 'tint-accent' | 'tint-ok' | 'tint-warn' | 'tint-err';
  icon: JSX.Element;
}

export function StatCard({ label, value, sub, tint, icon }: StatCardProps): JSX.Element {
  return (
    <div className="stat">
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        <span className={`stat-ico ${tint}`}>{icon}</span>
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-sub">{sub}</div>
    </div>
  );
}
