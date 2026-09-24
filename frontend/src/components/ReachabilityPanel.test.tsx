import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ReachabilityPanel, DAY_BARS, QUORUM_BARS } from './ReachabilityPanel';
import type { Incident, IncidentWindow, Reachability } from '../types';
import { bucketByDay } from '../utils';

// Frozen at local noon; with a real clock an hour-old incident crossed midnight near 00:00 UTC.
const NOW_MS = new Date(2026, 7, 29, 12, 0, 0).getTime();
const NOW = NOW_MS / 1000;

const reach: Reachability = {
  since: NOW - 3600,
  rev: 1,
  ongoing: null,
  history: Array.from({ length: 30 }, (_, i) => ({ ts: i, successes: 3, total: 3 })),
  latest: [{ ip: '1.1.1.1', ok: true, latency_ms: 20 }],
};

const emptyWindow: IncidentWindow = {
  monitoring_since: NOW - 86400 * 10, rev: 1, incidents: [], ongoing: null,
};

const tenMinuteOutage: Incident = {
  start: NOW - 3600, end: NOW - 3000, severity: 'outage',
  min_successes: 0, total: 3, failed: ['1.1.1.1', '8.8.8.8', '9.9.9.9'],
};
const oneDayDegraded: Incident = {
  start: NOW - 3 * 86400, end: NOW - 2 * 86400, severity: 'degraded',
  min_successes: 1, total: 3, failed: ['8.8.8.8', '9.9.9.9'],
};

function legend(container: HTMLElement): Record<string, [string, string]> {
  const out: Record<string, [string, string]> = {};
  for (const item of container.querySelectorAll('.hl-item')) {
    out[item.querySelector('.hl-label')?.textContent ?? ''] = [
      item.querySelector('.hl-dur')?.textContent ?? '',
      item.querySelector('.hl-pct')?.textContent ?? '',
    ];
  }
  return out;
}

// App owns the strip now, so the panel is rendered against buckets it did not build.
function renderPanel(win: IncidentWindow | null, onSelectDay: (dayStart: number) => void = vi.fn()) {
  const buckets = bucketByDay(win?.incidents ?? [], win?.ongoing ?? null, NOW_MS, DAY_BARS);
  return {
    buckets,
    ...render(
      <ReachabilityPanel
        reachability={reach}
        incidentWindow={win}
        buckets={buckets}
        nowMs={NOW_MS}
        onSelectDay={onSelectDay}
      />),
  };
}

describe('ReachabilityPanel', () => {
  beforeEach(() => {
    // Only Date is faked so React Testing Library's own scheduling stays real.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('renders one bar per day in the history strip', () => {
    const { container } = renderPanel(emptyWindow);
    expect(container.querySelectorAll('.day-strip button')).toHaveLength(DAY_BARS);
  });

  test('day bars are buttons with descriptive labels', () => {
    const { container } = renderPanel(emptyWindow);
    const first = container.querySelector('.day-strip button');
    expect(first?.getAttribute('aria-label')).toMatch(/no incidents/i);
  });

  test('marks a day with an outage', () => {
    const withOutage: IncidentWindow = {
      ...emptyWindow,
      incidents: [{
        start: NOW - 3600, end: NOW - 3000, severity: 'outage',
        min_successes: 0, total: 3, failed: ['1.1.1.1'],
      }],
    };
    const { container } = renderPanel(withOutage);
    expect(container.querySelectorAll('.day-strip button.outage')).toHaveLength(1);
  });

  // F1: ReachabilityPanel no longer owns the incident modal's open state; it just
  // reports which day was clicked and lets App render the modal. It reports the
  // day's start rather than the bucket so App stores identity, not derived state.
  test('reports the clicked day by its start timestamp instead of opening its own modal', () => {
    const onSelectDay = vi.fn();
    const { container, buckets } = renderPanel(emptyWindow, onSelectDay);
    const bars = container.querySelectorAll('.day-strip button');
    fireEvent.click(bars[bars.length - 1]);
    expect(onSelectDay).toHaveBeenCalledTimes(1);
    expect(onSelectDay).toHaveBeenCalledWith(buckets[DAY_BARS - 1].start);
    expect(container.querySelector('.modal-overlay')).toBeNull();
  });

  test('renders the clamped uptime percentage', () => {
    const { container } = renderPanel(emptyWindow);
    expect(container.querySelector('.up-val')?.textContent).toBe('100.0%');
  });

  test('notes the observed span while under thirty days', () => {
    renderPanel(emptyWindow);
    expect(screen.getByText(/10d observed/)).toBeTruthy();
  });

  test('live strip bars are constant height', () => {
    const { container } = renderPanel(emptyWindow);
    const bars = container.querySelectorAll('.quorum span');
    expect(bars).toHaveLength(QUORUM_BARS);
    for (const bar of bars) {
      expect((bar as HTMLElement).style.height).toBe('');
    }
  });

  test('renders without an incident window', () => {
    const { container } = renderPanel(null);
    expect(container.querySelectorAll('.day-strip button')).toHaveLength(DAY_BARS);
  });

  test('breaks the observed window into healthy, degraded and outage time', () => {
    const { container } = renderPanel({ ...emptyWindow, incidents: [oneDayDegraded, tenMinuteOutage] });
    expect(legend(container)).toEqual({
      Healthy: ['8d 23h', '89.9%'],
      Degraded: ['1d', '10.0%'],
      Outage: ['10m', '<0.1%'],
    });
  });

  test('never rounds a tiny outage away from the healthy share', () => {
    const { container } = renderPanel({ ...emptyWindow, incidents: [tenMinuteOutage] });
    expect(legend(container).Healthy).toEqual(['9d 23h', '>99.9%']);
  });

  test('shows an all-healthy window with empty degraded and outage entries', () => {
    const { container } = renderPanel(emptyWindow);
    expect(legend(container)).toEqual({
      Healthy: ['10d', '100.0%'],
      Degraded: ['0s', '0.0%'],
      Outage: ['0s', '0.0%'],
    });
  });

  test('gives each drawn health segment a human-readable tooltip', () => {
    const { container } = renderPanel({ ...emptyWindow, incidents: [tenMinuteOutage] });
    const titles = [...container.querySelectorAll<HTMLElement>('.health-bar span')].map((s) => s.title);
    expect(titles).toEqual(['Healthy · 9d 23h (>99.9%)', 'Outage · 10m (<0.1%)']);
  });

  test('keeps the subtitle to the observed span only', () => {
    const { container } = renderPanel({ ...emptyWindow, incidents: [oneDayDegraded] });
    expect(container.querySelector('.up-sub')?.textContent).toBe('10d observed');
  });

  test('labels a full window as thirty days observed', () => {
    const { container } = renderPanel({ ...emptyWindow, monitoring_since: NOW - 40 * 86400 });
    expect(container.querySelector('.up-sub')?.textContent).toBe('30d observed');
  });

  // F1: humanTime rolls a full 30-day span over to `1mo`, which contradicted the `30d observed` subtitle.
  test('labels the full-window healthy segment in days, not months', () => {
    const { container } = renderPanel({ ...emptyWindow, monitoring_since: NOW - 40 * 86400 });
    expect(legend(container).Healthy).toEqual(['30d', '100.0%']);
  });

  // F2: the headline must use the same guard as the legend so a tiny outage can't read 100.0%.
  test('guards the headline percentage against rounding up to 100%', () => {
    const { container } = renderPanel({ ...emptyWindow, incidents: [tenMinuteOutage] });
    expect(container.querySelector('.up-val')?.textContent).toBe('>99.9%');
  });

  // F3: a space between duration and percentage keeps `.hl-count` legible for screen readers/copy-paste.
  test('separates the segment duration and percentage with a space', () => {
    const { container } = renderPanel(emptyWindow);
    expect(legend(container).Healthy).toEqual(['10d', '100.0%']);
    const healthy = [...container.querySelectorAll('.hl-item')]
      .find((item) => item.querySelector('.hl-label')?.textContent === 'Healthy');
    expect(healthy?.querySelector('.hl-count')?.textContent).toBe('10d 100.0%');
  });

  // F5: an ongoing incident has `end: null` and must still count toward the observed window.
  test('counts an ongoing outage in the legend', () => {
    const ongoingOutage: Incident = {
      start: NOW - 600, end: null, severity: 'outage', min_successes: 0, total: 3, failed: ['1.1.1.1'],
    };
    const { container } = renderPanel({ ...emptyWindow, ongoing: ongoingOutage });
    expect(legend(container).Outage).toEqual(['10m', '<0.1%']);
  });

  // F5: monitoring_since === now means a zero-length observed window; must not divide by zero.
  test('renders a zero-observed window without dividing by zero', () => {
    const { container } = renderPanel({ ...emptyWindow, monitoring_since: NOW });
    expect(legend(container)).toEqual({
      Healthy: ['0s', '0.0%'],
      Degraded: ['0s', '0.0%'],
      Outage: ['0s', '0.0%'],
    });
    const spans = container.querySelectorAll('.health-bar span');
    expect(spans).toHaveLength(1);
    expect(spans[0].hasAttribute('title')).toBe(false);
  });
});
