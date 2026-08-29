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

function humanTime(totalSeconds: number): string {
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
