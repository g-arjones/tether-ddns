import type { JSX } from 'react';
import type { Reachability } from '../types';
import { formatUptime } from '../utils';

export const QUORUM_BARS = 24;
export const QUORUM = 2;
// Full-scale of the latency bar; healthy public-resolver DNS round-trips run
// tens of ms, so anything at/over MAX_LAT_MS pins the bar full.
const MAX_LAT_MS = 120;
// Above this a resolver is flagged "slow" (amber) rather than healthy (accent).
const SLOW_LAT_MS = 80;

export interface ReachabilityPanelProps { reachability: Reachability; }

export function ReachabilityPanel({ reachability: r }: ReachabilityPanelProps): JSX.Element {
  const bars = r.history.slice(-QUORUM_BARS);
  const last = bars.length ? bars[bars.length - 1] : null;
  const online = last ? last.successes >= QUORUM : true;
  const pct = r.checks ? ((r.online / r.checks) * 100).toFixed(1) + '%' : '—';
  return (
    <>
      <div className="reach-head">
        <div className="reach-uptime">
          <span className={`up-val${online ? '' : ' down'}`}>{pct}</span>
          <span className="up-sub">{r.online}/{r.checks} checks · up {formatUptime(r.started_at)}</span>
        </div>
        <span className={`reach-badge ${online ? 'up' : 'down'}`}><span className="rb-dot" />{online ? 'Online' : 'Offline'}</span>
      </div>
      <div className="quorum">
        {Array.from({ length: QUORUM_BARS }, (_, i) => {
          const h = bars[i - (QUORUM_BARS - bars.length)];
          if (!h) return <span key={i} style={{ height: '14%' }} />;
          const cls = h.successes < QUORUM ? 'down' : (h.successes < h.total ? 'degraded' : '');
          const live = i === QUORUM_BARS - 1 ? ' live' : '';
          const height = Math.max(14, Math.round((h.successes / h.total) * 100));
          return <span key={i} className={`${cls}${live}`} style={{ height: `${height}%` }} title={`${h.successes}/${h.total} ok`} />;
        })}
      </div>
      <div className="quorum-scale"><span>{QUORUM_BARS} checks ago</span><span>now</span></div>
      <div className="resolvers">
        {r.latest.map((x) => {
          if (!x.ok || x.latency_ms == null) {
            return (
              <div className="res-row" key={x.ip}>
                <span className="res-ip">{x.ip}</span>
                <div className="res-track"><div className="res-fill" style={{ width: '0%' }} /></div>
                <span className="res-lat timeout">timeout</span>
              </div>
            );
          }
          const w = Math.min(100, (x.latency_ms / MAX_LAT_MS) * 100);
          const slow = x.latency_ms > SLOW_LAT_MS ? ' slow' : '';
          return (
            <div className="res-row" key={x.ip}>
              <span className="res-ip">{x.ip}</span>
              <div className="res-track"><div className={`res-fill${slow}`} style={{ width: `${w}%` }} /></div>
              <span className="res-lat">{Math.round(x.latency_ms)} ms</span>
            </div>
          );
        })}
      </div>
    </>
  );
}
