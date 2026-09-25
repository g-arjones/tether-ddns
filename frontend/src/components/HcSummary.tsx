import { Fragment, type JSX, type ReactNode } from 'react';
import type { HealthcheckRef, ProjectRuntime } from '../types';
import { projectSummary } from '../utils';

export interface HcSummaryProps {
  refs: HealthcheckRef[];
  runtime: ProjectRuntime | undefined;
  withTotal?: boolean;
}

export function HcSummary({ refs, runtime, withTotal = false }: HcSummaryProps): JSX.Element {
  const { unknown, parts } = projectSummary(refs, runtime);
  const total = `${refs.length} check${refs.length === 1 ? '' : 's'}`;
  const items: { key: string; node: ReactNode }[] = [];
  if (unknown) {
    if (withTotal) items.push({ key: 'total', node: total });
    items.push({ key: 'unknown', node: 'status unknown' });
  } else {
    for (const part of parts) {
      const text = `${part.n} ${part.label}`;
      const loud = part.status === 'down' || part.status === 'grace';
      items.push({ key: part.status, node: loud ? <b className={`hc-s-${part.status}`}>{text}</b> : text });
    }
    if (withTotal) items.push({ key: 'total', node: total });
  }
  return (
    <span className="hc-sum">
      {items.map((item, i) => (
        <Fragment key={item.key}>{i > 0 ? ' · ' : null}{item.node}</Fragment>
      ))}
    </span>
  );
}
