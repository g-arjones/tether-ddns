import { describe, expect, it, test } from 'vitest';
import {
  deriveHue, providerColor, formatUptime, formatCountdown, relStable,
  bucketByDay, uptimeStats, formatDuration,
} from './utils';
import type { Incident } from './types';

describe('deriveHue', () => {
  it('is deterministic and in range', () => {
    const a = deriveHue('cloudflare');
    expect(a).toBe(deriveHue('cloudflare'));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(360);
  });
  it('differs across keys', () => {
    expect(deriveHue('cloudflare')).not.toBe(deriveHue('duckdns'));
  });
});

describe('providerColor', () => {
  it('wraps the hue in hsl', () => {
    expect(providerColor('duckdns')).toBe(`hsl(${deriveHue('duckdns')} 65% 55%)`);
  });
});

describe('formatUptime', () => {
  it('formats months and days', () => {
    const now = 10_000 + (2 * 30 * 24 * 3600 + 5 * 24 * 3600) * 1000;
    expect(formatUptime(10, now)).toBe('2mo 5d');
    expect(formatUptime(10, now - 5 * 24 * 3600 * 1000)).toBe('2mo');
  });
  it('formats days and hours', () => {
    const now = 10_000 + (2 * 24 * 3600 + 5 * 3600) * 1000;
    expect(formatUptime(10, now)).toBe('2d 5h');
    expect(formatUptime(10, now - 5 * 3600 * 1000)).toBe('2d');
  });
  it('formats hours and minutes', () => {
    const now = 10_000 + (3 * 3600 + 14 * 60) * 1000;
    expect(formatUptime(10, now)).toBe('3h 14m');
    expect(formatUptime(10, now - 14 * 60 * 1000)).toBe('3h');
  });
  it('formats minutes and seconds', () => {
    expect(formatUptime(0, 5 * 60 * 1000 + 7 * 1000)).toBe('5m 7s');
    expect(formatUptime(0, 5 * 60 * 1000)).toBe('5m');
  });
  it('formats seconds only', () => {
    expect(formatUptime(0, 45 * 1000)).toBe('45s');
  });
});

describe('formatCountdown', () => {
  it('returns dash when null', () => {
    expect(formatCountdown(null)).toBe('—');
  });
  it('formats m:ss', () => {
    expect(formatCountdown(125, 0)).toBe('2:05');
  });
  it('clamps past zero to 0:00', () => {
    expect(formatCountdown(0, 10_000)).toBe('0:00');
  });
});

describe('relStable', () => {
  it('returns dash when null', () => {
    expect(relStable(null)).toBe('—');
  });
  it('formats elapsed since change', () => {
    const now = (2 * 3600 + 14 * 60) * 1000;
    expect(relStable(0, now)).toBe('2h 14m');
  });
});

const DAY = 86400;
// 2026-08-29T12:00:00 local time, expressed in ms.
const NOW_MS = new Date(2026, 7, 29, 12, 0, 0).getTime();
const NOW = NOW_MS / 1000;

function incident(start: number, end: number | null, severity: 'degraded' | 'outage'): Incident {
  return { start, end, severity, min_successes: 0, total: 3, failed: ['1.1.1.1'] };
}

test('bucketByDay returns one bucket per day, oldest first', () => {
  const buckets = bucketByDay([], null, NOW_MS, 30);
  expect(buckets).toHaveLength(30);
  expect(buckets[0].start).toBeLessThan(buckets[29].start);
});

test('bucketByDay marks a day with no incidents healthy', () => {
  const buckets = bucketByDay([], null, NOW_MS, 30);
  expect(buckets.every((b) => b.worst === 'healthy')).toBe(true);
});

test('bucketByDay attributes an incident to its day', () => {
  const buckets = bucketByDay([incident(NOW - 3600, NOW - 3000, 'outage')], null, NOW_MS, 30);
  const today = buckets[29];
  expect(today.worst).toBe('outage');
  expect(today.incidents).toHaveLength(1);
  expect(today.offlineSeconds).toBe(600);
});

test('bucketByDay clips an incident that crosses midnight into both days', () => {
  const midnight = new Date(2026, 7, 29, 0, 0, 0).getTime() / 1000;
  const buckets = bucketByDay(
    [incident(midnight - 1140, midnight + 900, 'outage')], null, NOW_MS, 30);
  expect(buckets[28].worst).toBe('outage');
  expect(buckets[28].offlineSeconds).toBe(1140);
  expect(buckets[29].worst).toBe('outage');
  expect(buckets[29].offlineSeconds).toBe(900);
});

test('bucketByDay treats an ongoing incident as running to now', () => {
  const buckets = bucketByDay([], incident(NOW - 300, null, 'outage'), NOW_MS, 30);
  expect(buckets[29].offlineSeconds).toBe(300);
});

test('bucketByDay observes today only up to now', () => {
  const buckets = bucketByDay([], null, NOW_MS, 30);
  expect(buckets[29].end).toBe(new Date(2026, 7, 30, 0, 0, 0).getTime() / 1000);
  expect(buckets[29].observedEnd).toBe(NOW);
  expect(buckets[28].observedEnd).toBe(buckets[28].end);
});

test('bucketByDay ranks outage above degraded on the same day', () => {
  const buckets = bucketByDay(
    [incident(NOW - 7200, NOW - 7000, 'degraded'), incident(NOW - 3600, NOW - 3400, 'outage')],
    null, NOW_MS, 30);
  expect(buckets[29].worst).toBe('outage');
});

test('bucketByDay uses local midnight boundaries across a DST change', () => {
  const buckets = bucketByDay([], null, NOW_MS, 30);
  for (const b of buckets) {
    const span = b.end - b.start;
    expect(span === DAY || span === DAY - 3600 || span === DAY + 3600).toBe(true);
  }
});

test('uptimeStats reports 100% for a clean window', () => {
  const stats = uptimeStats([], null, 0, NOW_MS, 30);
  expect(stats.pct).toBe(100);
  expect(stats.offlineSeconds).toBe(0);
});

test('uptimeStats excludes degraded time from downtime', () => {
  const stats = uptimeStats([incident(NOW - 3600, NOW - 3000, 'degraded')], null, 0, NOW_MS, 30);
  expect(stats.offlineSeconds).toBe(0);
  expect(stats.degradedSeconds).toBe(600);
  expect(stats.pct).toBe(100);
});

test('uptimeStats clamps the denominator to first observation', () => {
  const stats = uptimeStats([], null, NOW - DAY, NOW_MS, 30);
  expect(stats.observedSeconds).toBeCloseTo(DAY, 3);
});

test('uptimeStats counts an ongoing outage up to now', () => {
  const stats = uptimeStats([], incident(NOW - 600, null, 'outage'), NOW - DAY, NOW_MS, 30);
  expect(stats.offlineSeconds).toBe(600);
});

test('uptimeStats ignores incident time before first observation', () => {
  const stats = uptimeStats(
    [incident(NOW - 2 * DAY, NOW - 2 * DAY + 600, 'outage')], null, NOW - DAY, NOW_MS, 30);
  expect(stats.offlineSeconds).toBe(0);
});

test('formatDuration renders hours, minutes and seconds', () => {
  expect(formatDuration(45)).toBe('45s');
  expect(formatDuration(600)).toBe('10m');
  expect(formatDuration(3660)).toBe('1h 1m');
  expect(formatDuration(16080)).toBe('4h 28m');
});
