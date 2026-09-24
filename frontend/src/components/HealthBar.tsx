import type { JSX, ReactNode } from 'react';

export interface HealthSegment {
  key: string;
  label: string;
  color: string;
  value: number;
  title: string;
  legend: ReactNode;
}

export interface HealthBarProps {
  segments: HealthSegment[];
}

export function HealthBar({ segments }: HealthBarProps): JSX.Element {
  const drawn = segments.filter((s) => s.value > 0);
  return (
    <>
      <div className="health-bar">
        {drawn.length ? drawn.map((s) => (
          <span key={s.key} style={{ flex: s.value, background: s.color }} title={s.title} />
        )) : <span style={{ flex: 1, background: 'var(--surface-2)' }} />}
      </div>
      <div className="health-legend">
        {segments.map((s) => (
          <div className="hl-item" key={s.key}>
            <span className="hl-dot" style={{ background: s.color }} />
            <span className="hl-label">{s.label}</span>
            <span className="hl-count">{s.legend}</span>
          </div>
        ))}
      </div>
    </>
  );
}
