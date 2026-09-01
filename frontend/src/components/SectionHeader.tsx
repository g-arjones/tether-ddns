import type { JSX, ReactNode } from 'react';

export interface SectionHeaderProps {
  title: string;
  count?: { n: number; noun: string };
  action?: ReactNode;
}

export function SectionHeader({ title, count, action }: SectionHeaderProps): JSX.Element {
  return (
    <div className="section-head">
      <h3>{title}</h3>
      {count ? (
        <span className="count-badge">{count.n} {count.noun}{count.n === 1 ? '' : 's'}</span>
      ) : null}
      {action ? <div className="spacer"></div> : null}
      {action}
    </div>
  );
}
