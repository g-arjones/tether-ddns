import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { ReachabilityPanel, DAY_BARS } from './ReachabilityPanel';
import type { IncidentWindow, Reachability } from '../types';

const NOW = Date.now() / 1000;

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

describe('ReachabilityPanel', () => {
  test('renders one bar per day in the history strip', () => {
    const { container } = render(
      <ReachabilityPanel reachability={reach} incidentWindow={emptyWindow} />);
    expect(container.querySelectorAll('.day-strip button')).toHaveLength(DAY_BARS);
  });

  test('day bars are buttons with descriptive labels', () => {
    const { container } = render(
      <ReachabilityPanel reachability={reach} incidentWindow={emptyWindow} />);
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
    const { container } = render(
      <ReachabilityPanel reachability={reach} incidentWindow={withOutage} />);
    expect(container.querySelectorAll('.day-strip button.outage')).toHaveLength(1);
  });

  test('opens the modal when a day bar is clicked', () => {
    const { container } = render(
      <ReachabilityPanel reachability={reach} incidentWindow={emptyWindow} />);
    const bars = container.querySelectorAll('.day-strip button');
    fireEvent.click(bars[bars.length - 1]);
    expect(container.querySelector('.modal-overlay.open')).not.toBeNull();
  });

  test('renders the clamped uptime percentage', () => {
    render(<ReachabilityPanel reachability={reach} incidentWindow={emptyWindow} />);
    expect(screen.getByText('100.0%')).toBeTruthy();
  });

  test('notes the observed span while under thirty days', () => {
    render(<ReachabilityPanel reachability={reach} incidentWindow={emptyWindow} />);
    expect(screen.getByText(/10d observed/)).toBeTruthy();
  });

  test('live strip bars are constant height', () => {
    const { container } = render(
      <ReachabilityPanel reachability={reach} incidentWindow={emptyWindow} />);
    for (const bar of container.querySelectorAll('.quorum span')) {
      expect((bar as HTMLElement).style.height).toBe('');
    }
  });

  test('renders without an incident window', () => {
    const { container } = render(
      <ReachabilityPanel reachability={reach} incidentWindow={null} />);
    expect(container.querySelectorAll('.day-strip button')).toHaveLength(DAY_BARS);
  });
});
