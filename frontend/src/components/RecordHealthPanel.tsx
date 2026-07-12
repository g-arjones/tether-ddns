import { useEffect, useState, type JSX } from 'react';
import type { DomainState } from '../types';
import { formatCountdown } from '../utils';

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
  const segs = ORDER.filter(([k]) => counts[k] > 0);
  const remain = p.nextCheckAt == null ? 0 : Math.max(0, p.nextCheckAt - now / 1000);
  const fillPct = p.checkInterval ? Math.min(100, (remain / p.checkInterval) * 100) : 0;

  return (
    <div className="panel">
      <div className="panel-head"><h4>Record health</h4><span className="sub">{n} {n === 1 ? 'domain' : 'domains'}</span></div>
      <div className="health-bar">
        {segs.length ? segs.map(([k, , c]) => (
          <span key={k} style={{ flex: counts[k], background: c }} title={`${counts[k]} ${k}`} />
        )) : <span style={{ flex: 1, background: 'var(--surface-2)' }} />}
      </div>
      <div className="health-legend">
        {ORDER.map(([k, label, c]) => (
          <div className="hl-item" key={k}>
            <span className="hl-dot" style={{ background: c }} />
            <span className="hl-label">{label}</span>
            <span className="hl-count">{counts[k]}</span>
          </div>
        ))}
      </div>
      <div className="panel-divider" />
      <div className="next-check">
        <div className="nc-top"><span className="nc-label">Next check</span><span className="nc-time">{formatCountdown(p.nextCheckAt, now)}</span></div>
        <div className="nc-track"><div className="nc-fill" style={{ width: `${fillPct}%` }} /></div>
      </div>
    </div>
  );
}
