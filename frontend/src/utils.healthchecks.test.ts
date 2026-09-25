import { describe, expect, it } from 'vitest';
import type { CheckStatus, HealthcheckRef, ProjectRuntime } from './types';
import { ago, checkDisplayStatus, hostOf, humanDuration, projectSummary } from './utils';

const NOW_MS = new Date(2026, 8, 25, 12, 0, 0).getTime();
const status = (s: CheckStatus['status']): CheckStatus => ({
  name: 'x', slug: 'x', status: s, last_ping: null, next_ping: null, timeout: 60, schedule: null, tz: null, grace: 60,
});
const rt = (over: Partial<ProjectRuntime> = {}): ProjectRuntime => ({
  polled_at: 1, ok: true, error: null, offline: false, checks: { a: status('up'), b: status('down') }, ...over,
});
const ref = (key: string): HealthcheckRef => ({ key, name: key, slug: key, visible: true });

describe('checkDisplayStatus', () => {
  it('is unknown without a runtime or before the first poll', () => {
    expect(checkDisplayStatus(undefined, 'a')).toBe('unknown');
    expect(checkDisplayStatus(rt({ polled_at: null }), 'a')).toBe('unknown');
  });
  it('is unknown while offline or after a failed poll, even with stale checks', () => {
    expect(checkDisplayStatus(rt({ offline: true }), 'a')).toBe('unknown');
    expect(checkDisplayStatus(rt({ ok: false, error: 'HTTP 503' }), 'a')).toBe('unknown');
  });
  it('is gone when a fetched key is missing from a good poll', () => {
    expect(checkDisplayStatus(rt(), 'zzz')).toBe('gone');
  });
  it('passes the upstream status through otherwise', () => {
    expect(checkDisplayStatus(rt(), 'a')).toBe('up');
    expect(checkDisplayStatus(rt(), 'b')).toBe('down');
  });
});

describe('projectSummary', () => {
  it('counts in a fixed order and labels grace as late', () => {
    const runtime = rt({ checks: { a: status('up'), b: status('grace'), c: status('down'), d: status('up') } });
    const { unknown, parts } = projectSummary([ref('a'), ref('b'), ref('c'), ref('d'), ref('e')], runtime);
    expect(unknown).toBe(false);
    expect(parts.map((p) => `${p.n} ${p.label}`)).toEqual(['2 up', '1 late', '1 down', '1 gone']);
  });
  it('reports unknown for the whole project when the poll is not good', () => {
    expect(projectSummary([ref('a')], rt({ offline: true }))).toEqual({ unknown: true, parts: [] });
  });
});

describe('humanDuration', () => {
  it.each([
    [60, '1 minute'], [600, '10 minutes'], [10800, '3 hours'], [93600, '1 day 2 hours'],
    [604800, '1 week'], [1209600, '2 weeks'], [5184000, '60 days'], [0, '0 seconds'],
  ])('formats %i s as %s', (seconds, text) => {
    expect(humanDuration(seconds)).toBe(text);
  });
});

describe('ago', () => {
  const at = (secondsAgo: number) => NOW_MS / 1000 - secondsAgo;
  it('renders the largest unit, long and short', () => {
    expect(ago(at(14), NOW_MS)).toBe('14 seconds ago');
    expect(ago(at(11 * 3600), NOW_MS)).toBe('11 hours ago');
    expect(ago(at(3 * 604800), NOW_MS)).toBe('3 weeks ago');
    expect(ago(at(130 * 86400), NOW_MS)).toBe('4 months ago');
    expect(ago(at(130 * 86400), NOW_MS, true)).toBe('4mo ago');
    expect(ago(at(1), NOW_MS)).toBe('1 second ago');
    expect(ago(at(0), NOW_MS, true)).toBe('0s ago');
  });
  it('renders a dash for never', () => {
    expect(ago(null, NOW_MS)).toBe('—');
  });
});

describe('hostOf', () => {
  it('returns the host, or the input when it is not a URL', () => {
    expect(hostOf('https://hc.example.lan:8000/sub/')).toBe('hc.example.lan:8000');
    expect(hostOf('not a url')).toBe('not a url');
  });
});
