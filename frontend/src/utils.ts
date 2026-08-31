import type { Incident } from './types';

export type DaySeverity = 'healthy' | 'degraded' | 'outage';

export interface DayBucket {
  start: number;
  end: number;
  worst: DaySeverity;
  incidents: Incident[];
  offlineSeconds: number;
  degradedSeconds: number;
}

export interface UptimeStats {
  pct: number;
  offlineSeconds: number;
  degradedSeconds: number;
  observedSeconds: number;
}

export function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${seconds / 3600} hr`;
}

export function deriveHue(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

export function providerColor(key: string): string {
  return `hsl(${deriveHue(key)} 65% 55%)`;
}

function overlap(inc: Incident, from: number, to: number, nowSec: number): number {
  const start = Math.max(inc.start, from);
  const end = Math.min(inc.end ?? nowSec, to);
  return Math.max(0, end - start);
}

export function bucketByDay(
  incidents: Incident[],
  ongoing: Incident | null,
  nowMs: number = Date.now(),
  days: number = 30,
): DayBucket[] {
  const nowSec = nowMs / 1000;
  const all = ongoing ? [...incidents, ongoing] : incidents;
  const midnight = new Date(nowMs);
  midnight.setHours(0, 0, 0, 0);
  const buckets: DayBucket[] = [];

  for (let back = days - 1; back >= 0; back -= 1) {
    const from = new Date(midnight);
    from.setDate(from.getDate() - back);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    const start = from.getTime() / 1000;
    const end = to.getTime() / 1000;

    const hits: Incident[] = [];
    let offlineSeconds = 0;
    let degradedSeconds = 0;
    for (const inc of all) {
      const seconds = overlap(inc, start, end, nowSec);
      if (seconds <= 0) continue;
      hits.push(inc);
      if (inc.severity === 'outage') offlineSeconds += seconds;
      else degradedSeconds += seconds;
    }
    const worst: DaySeverity = offlineSeconds > 0
      ? 'outage'
      : (degradedSeconds > 0 ? 'degraded' : 'healthy');
    buckets.push({ start, end, worst, incidents: hits, offlineSeconds, degradedSeconds });
  }
  return buckets;
}

export function uptimeStats(
  incidents: Incident[],
  ongoing: Incident | null,
  monitoringSince: number,
  nowMs: number = Date.now(),
  days: number = 30,
): UptimeStats {
  const nowSec = nowMs / 1000;
  const windowStart = Math.max(monitoringSince, nowSec - days * 86400);
  const observedSeconds = Math.max(0, nowSec - windowStart);
  const all = ongoing ? [...incidents, ongoing] : incidents;

  let offlineSeconds = 0;
  let degradedSeconds = 0;
  for (const inc of all) {
    const seconds = overlap(inc, windowStart, nowSec, nowSec);
    if (inc.severity === 'outage') offlineSeconds += seconds;
    else degradedSeconds += seconds;
  }
  const pct = observedSeconds > 0
    ? ((observedSeconds - offlineSeconds) / observedSeconds) * 100
    : 100;
  return { pct, offlineSeconds, degradedSeconds, observedSeconds };
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 && m < 5 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

export function humanTime(totalSeconds: number): string {
  const months = Math.floor(totalSeconds / (3600 * 24 * 30));
  const days = Math.floor((totalSeconds % (3600 * 24 * 30)) / (3600 * 24));
  const hours = Math.floor((totalSeconds % (3600 * 24)) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (months > 0) {
    if (days > 0) return `${months}mo ${days}d`;
    return `${months}mo`;
  }
  if (days > 0) {
    if (hours > 0) return `${days}d ${hours}h`;
    return `${days}d`;
  }
  if (hours > 0) {
    if (minutes > 0) return `${hours}h ${minutes}m`;
    return `${hours}h`;
  }
  if (minutes > 0) {
    if (seconds > 0) return `${minutes}m ${seconds}s`;
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

export function formatUptime(startedAt: number, now: number = Date.now()): string {
  return humanTime(now / 1000 - startedAt);
}

export function relStable(changedAt: number | null, now: number = Date.now()): string {
  if (changedAt == null) return '—';
  return humanTime(now / 1000 - changedAt);
}

export function formatCountdown(nextCheckAt: number | null, now: number = Date.now()): string {
  if (nextCheckAt == null) return '—';
  const remain = Math.max(0, Math.round(nextCheckAt - now / 1000));
  const m = Math.floor(remain / 60);
  const s = remain % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
