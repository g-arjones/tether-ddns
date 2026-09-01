import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { IncidentModal } from './IncidentModal';
import type { DayBucket } from '../utils';
import type { Incident } from '../types';

const DAY_START = new Date(2026, 7, 29, 0, 0, 0).getTime() / 1000;
const DAY_END = new Date(2026, 7, 30, 0, 0, 0).getTime() / 1000;

function inc(startOffset: number, endOffset: number | null, severity: 'degraded' | 'outage'): Incident {
  return {
    start: DAY_START + startOffset,
    end: endOffset === null ? null : DAY_START + endOffset,
    severity,
    min_successes: severity === 'outage' ? 0 : 2,
    total: 3,
    failed: severity === 'outage' ? ['1.1.1.1', '8.8.8.8'] : ['8.8.8.8'],
  };
}

function bucket(incidents: Incident[]): DayBucket {
  return {
    start: DAY_START, end: DAY_END, observedEnd: DAY_END, worst: 'outage', incidents,
    offlineSeconds: 16080, degradedSeconds: 1020,
  };
}

describe('IncidentModal', () => {
  test('renders the day heading and summary', () => {
    const { container } = render(
      <IncidentModal bucket={bucket([inc(3600, 5000, 'outage')])} onClose={vi.fn()} />);
    // Heading format is locale-dependent; assert only that it names the day.
    expect(container.querySelector('.modal-head h3')?.textContent).toMatch(/29/);
    expect(screen.getByText('4h 28m')).toBeTruthy();
  });

  test('renders a severity tag for each incident', () => {
    render(<IncidentModal
      bucket={bucket([inc(3600, 5000, 'outage'), inc(40000, 41020, 'degraded')])}
      onClose={vi.fn()} />);
    expect(screen.getByText('outage')).toBeTruthy();
    expect(screen.getByText('degraded')).toBeTruthy();
  });

  test('renders an ongoing incident as running to now', () => {
    render(<IncidentModal bucket={bucket([inc(3600, null, 'outage')])} onClose={vi.fn()} />);
    expect(screen.getByText(/→ now/)).toBeTruthy();
    expect(screen.queryByText('ongoing')).toBeNull();
  });

  test('notes an incident inherited from the previous day', () => {
    const carried: Incident = { ...inc(0, 5000, 'outage'), start: DAY_START - 1140 };
    render(<IncidentModal bucket={bucket([carried])} onClose={vi.fn()} />);
    expect(screen.getByText(/previous day/)).toBeTruthy();
  });

  test('lists the resolvers that failed', () => {
    render(<IncidentModal bucket={bucket([inc(3600, 5000, 'outage')])} onClose={vi.fn()} />);
    expect(screen.getByText('1.1.1.1')).toBeTruthy();
    expect(screen.getByText('8.8.8.8')).toBeTruthy();
  });

  test('shows an empty state for a clean day', () => {
    const clean: DayBucket = {
      start: DAY_START, end: DAY_END, observedEnd: DAY_END, worst: 'healthy', incidents: [],
      offlineSeconds: 0, degradedSeconds: 0,
    };
    render(<IncidentModal bucket={clean} onClose={vi.fn()} />);
    expect(screen.getByText(/No incidents/)).toBeTruthy();
  });

  test('renders nothing open when the bucket is null', () => {
    const { container } = render(<IncidentModal bucket={null} onClose={vi.fn()} />);
    expect(container.querySelector('.modal-overlay.open')).toBeNull();
  });

  test('rates a partial day against the hours observed so far, not a full day', () => {
    const partial: DayBucket = {
      start: DAY_START, end: DAY_END, observedEnd: DAY_START + 43200, worst: 'outage',
      incidents: [inc(3600, 7200, 'outage')], offlineSeconds: 3600, degradedSeconds: 0,
    };
    render(<IncidentModal bucket={partial} onClose={vi.fn()} />);
    expect(screen.getByText('91.7%')).toBeTruthy();
  });

  test('marks the unobserved tail of a partial day on the timeline', () => {
    const partial: DayBucket = {
      start: DAY_START, end: DAY_END, observedEnd: DAY_START + 43200, worst: 'healthy',
      incidents: [], offlineSeconds: 0, degradedSeconds: 0,
    };
    const { container } = render(<IncidentModal bucket={partial} onClose={vi.fn()} />);
    const future = container.querySelector<HTMLElement>('.inc-track b.future');
    expect(future?.style.left).toBe('50%');
    expect(future?.style.width).toBe('50%');
  });

  test('marks no unobserved tail on a completed day', () => {
    const { container } = render(<IncidentModal bucket={bucket([])} onClose={vi.fn()} />);
    expect(container.querySelector('.inc-track b.future')).toBeNull();
  });
});
