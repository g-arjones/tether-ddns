import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReachabilityPanel } from './ReachabilityPanel';
import type { Reachability } from '../types';

const reach: Reachability = {
  since: 0, rev: 0, ongoing: null,
  // 50 records: 49 with 3/3, 1 with 0/3 = 147 successes / 150 checks = 98.0%
  // Failed record in the middle to keep last record online
  history: [
    ...Array.from({ length: 25 }, (_, i) => ({ ts: i, successes: 3, total: 3 })),
    { ts: 25, successes: 0, total: 3 },
    ...Array.from({ length: 24 }, (_, i) => ({ ts: 26 + i, successes: 3, total: 3 })),
  ],
  latest: [
    { ip: '1.1.1.1', ok: true, latency_ms: 11.2 },
    { ip: '8.8.8.8', ok: false, latency_ms: null },
  ],
};

describe('ReachabilityPanel', () => {
  it('renders uptime percentage', () => {
    render(<ReachabilityPanel reachability={reach} />);
    expect(screen.getByText('98.0%')).toBeInTheDocument();
  });
  it('renders resolver rows with latency and timeout', () => {
    render(<ReachabilityPanel reachability={reach} />);
    expect(screen.getByText('1.1.1.1')).toBeInTheDocument();
    expect(screen.getByText('11 ms')).toBeInTheDocument();
    expect(screen.getByText('timeout')).toBeInTheDocument();
  });
  it('caps quorum bars at QUORUM_BARS', () => {
    const { container } = render(<ReachabilityPanel reachability={reach} />);
    expect(container.querySelectorAll('.quorum span').length).toBe(24);
  });
  it('handles zero checks with a dash', () => {
    render(<ReachabilityPanel reachability={{ ...reach, rev: 0, ongoing: null, history: [], latest: [] }} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
  it('shows "up" when the latest check is online', () => {
    render(<ReachabilityPanel reachability={reach} />);
    expect(screen.getByText(/up \d/)).toBeInTheDocument();
  });
  it('shows "down" when the latest check is offline', () => {
    const offline: Reachability = {
      ...reach,
      history: Array.from({ length: 30 }, (_, i) => ({ ts: i, successes: 0, total: 3 })),
    };
    render(<ReachabilityPanel reachability={offline} />);
    expect(screen.getByText(/down \d/)).toBeInTheDocument();
  });
});
