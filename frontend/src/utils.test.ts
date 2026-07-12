import { describe, expect, it } from 'vitest';
import {
  deriveHue, providerColor, formatUptime, formatCountdown, relStable,
} from './utils';

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
  it('formats hours and minutes', () => {
    const now = 10_000 + (3 * 3600 + 14 * 60) * 1000;
    expect(formatUptime(10, now)).toBe('3h 14m');
  });
  it('formats minutes only', () => {
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
