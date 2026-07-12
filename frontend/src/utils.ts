export function formatInterval(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
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

function hms(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function formatUptime(startedAt: number, now: number = Date.now()): string {
  return hms(now / 1000 - startedAt);
}

export function relStable(changedAt: number | null, now: number = Date.now()): string {
  if (changedAt == null) return '—';
  return hms(now / 1000 - changedAt);
}

export function formatCountdown(nextCheckAt: number | null, now: number = Date.now()): string {
  if (nextCheckAt == null) return '—';
  const remain = Math.max(0, Math.round(nextCheckAt - now / 1000));
  const m = Math.floor(remain / 60);
  const s = remain % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
