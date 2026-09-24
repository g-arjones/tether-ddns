import type { JSX } from 'react';
import type { IncidentWindow, Reachability } from '../types';
import {
  formatDuration, humanTime, uptimeStats, type DayBucket,
} from '../utils';
import { HealthBar, type HealthSegment } from './HealthBar';

export const QUORUM_BARS = 24;
export const QUORUM = 2;
export const DAY_BARS = 30;
const MAX_LAT_MS = 120;
const SLOW_LAT_MS = 80;
const THIRTY_DAYS = DAY_BARS * 86400;

const SEVERITIES = [
  ['healthy', 'Healthy', 'var(--ok)'],
  ['degraded', 'Degraded', 'var(--warn)'],
  ['outage', 'Outage', 'var(--err)'],
] as const;

// Never let a non-zero share round to 0.0% or a non-full share round to 100.0%.
function formatPct(p: number): string {
  if (p > 0 && p < 0.1) return '<0.1%';
  if (p > 99.9 && p < 100) return '>99.9%';
  return `${p.toFixed(1)}%`;
}

export interface ReachabilityPanelProps {
  reachability: Reachability;
  incidentWindow: IncidentWindow | null;
  buckets: DayBucket[];
  nowMs: number;
  onSelectDay: (dayStart: number) => void;
}

function dayLabel(bucket: DayBucket): string {
  const date = new Date(bucket.start * 1000).toLocaleDateString(undefined, {
    day: 'numeric', month: 'long',
  });
  if (bucket.worst === 'healthy') return `${date}, no incidents`;
  return `${date}, ${bucket.worst}, ${formatDuration(
    bucket.worst === 'outage' ? bucket.offlineSeconds : bucket.degradedSeconds)}`;
}

export function ReachabilityPanel(
  { reachability: r, incidentWindow, buckets, nowMs, onSelectDay }: ReachabilityPanelProps,
): JSX.Element {
  const incidents = incidentWindow?.incidents ?? [];
  const ongoing = incidentWindow?.ongoing ?? r.ongoing;
  const monitoringSince = incidentWindow?.monitoring_since ?? 0;

  const bars = r.history.slice(-QUORUM_BARS);
  const last = bars.length ? bars[bars.length - 1] : null;
  const online = last ? last.successes >= QUORUM : true;

  const stats = uptimeStats(incidents, ongoing, monitoringSince, nowMs, DAY_BARS);
  const partial = stats.observedSeconds < THIRTY_DAYS - 1;

  const seconds = {
    healthy: Math.max(0, stats.observedSeconds - stats.offlineSeconds - stats.degradedSeconds),
    degraded: stats.degradedSeconds,
    outage: stats.offlineSeconds,
  };
  const segments: HealthSegment[] = SEVERITIES.map(([key, label, color]) => {
    const s = seconds[key];
    const pct = formatPct(stats.observedSeconds > 0 ? (s / stats.observedSeconds) * 100 : 0);
    const dur = humanTime(s);
    return {
      key, label, color, value: s,
      title: `${label} · ${dur} (${pct})`,
      legend: <><span className="hl-dur">{dur}</span><span className="hl-pct">{pct}</span></>,
    };
  });

  return (
    <>
      <div className="reach-head">
        <div className="reach-uptime">
          <span className={`up-val${online ? '' : ' down'}`}>{stats.pct.toFixed(1)}%</span>
          <span className="up-sub">
            {partial ? `${humanTime(stats.observedSeconds)} observed` : `${DAY_BARS}d observed`}
          </span>
        </div>
        <span className={`reach-badge ${online ? 'up' : 'down'}`}><span className="rb-dot" />{online ? 'Online' : 'Offline'}</span>
      </div>

      <HealthBar segments={segments} />

      <div className="panel-divider" />

      <div className="reach-label">Live · last {QUORUM_BARS} checks</div>
      <div className="quorum">
        {Array.from({ length: QUORUM_BARS }, (_, i) => {
          const h = bars[i - (QUORUM_BARS - bars.length)];
          if (!h) return <span key={i} className="blank" />;
          const cls = h.successes < QUORUM ? 'down' : (h.successes < h.total ? 'degraded' : '');
          const live = i === QUORUM_BARS - 1 ? ' live' : '';
          return <span key={i} className={`${cls}${live}`} title={`${h.successes}/${h.total} ok`} />;
        })}
      </div>
      <div className="quorum-scale"><span>{QUORUM_BARS} checks ago</span><span>now</span></div>

      <div className="panel-divider" />

      <div className="reach-label">History · {DAY_BARS} days</div>
      <div className="day-strip">
        {buckets.map((b) => (
          <button
            key={b.start}
            type="button"
            className={b.worst}
            aria-label={dayLabel(b)}
            title={dayLabel(b)}
            onClick={() => onSelectDay(b.start)}
          />
        ))}
      </div>
      <div className="quorum-scale">
        <span>{new Date(buckets[0].start * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
        <span>today</span>
      </div>

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
