import { useEffect, useState, type JSX } from 'react';
import type { DomainState } from '../types';
import { formatCountdown } from '../utils';
import { HealthBar } from './HealthBar';

export interface RecordHealthPanelProps {
  domains: DomainState[];
  enabledById: Record<string, boolean>;
  nextCheckAt: number | null;
  checkInterval: number;
}

const ORDER: [string, string, string][] = [
  ['synced', 'Synced', 'var(--ok)'],
  ['pending', 'Pending', 'var(--warn)'],
  ['error', 'Error', 'var(--err)'],
  ['paused', 'Paused', 'var(--muted-status)'],
];

export function RecordHealthPanel(p: RecordHealthPanelProps): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const counts: Record<string, number> = { synced: 0, pending: 0, error: 0, paused: 0 };
  for (const d of p.domains) {
    let s = p.enabledById[d.id] === false ? 'paused' : d.status;
    if (s === 'updating') s = 'pending';
    counts[s in counts ? s : 'pending'] += 1;
  }
  const n = p.domains.length;
  const segments = ORDER.map(([k, label, color]) => ({
    key: k, label, color, value: counts[k], title: `${counts[k]} ${k}`, legend: counts[k],
  }));
  const remain = p.nextCheckAt == null ? 0 : Math.max(0, p.nextCheckAt - now / 1000);
  const fillPct = p.checkInterval ? Math.min(100, (remain / p.checkInterval) * 100) : 0;

  return (
    <div className="panel">
      <div className="panel-head"><h4>Record health</h4><span className="sub">{n} {n === 1 ? 'domain' : 'domains'}</span></div>
      <HealthBar segments={segments} />
      <div className="panel-divider" />
      <div className="next-check">
        <div className="nc-top"><span className="nc-label">Next check</span><span className="nc-time">{formatCountdown(p.nextCheckAt, now)}</span></div>
        <div className="nc-track"><div className="nc-fill" style={{ width: `${fillPct}%` }} /></div>
      </div>
    </div>
  );
}
