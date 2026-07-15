import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OverviewView } from './OverviewView';
import type { StateSnapshot } from '../types';

vi.useFakeTimers();

const snapshot: StateSnapshot = {
  public_ipv4: '203.0.113.5', public_ipv6: null,
  ipv4_changed_at: 0, ipv6_changed_at: null,
  online: true, next_check_at: null,
  reachability: { started_at: 0, since: 0, checks: 10, online: 10, history: [], latest: [] },
  domains: [{ id: 'a', status: 'synced', ip: '203.0.113.5', updated: 1, message: '' }],
  settings: { check_interval: 300, ip_source: 'ipify', update_on_startup: true, retry_on_failure: true, notify: true },
  logs: [],
};

describe('OverviewView', () => {
  it('renders stat cards and both overview panels', () => {
    render(
      <OverviewView
        snapshot={snapshot}
        domains={[{ id: 'a', hostname: 'h', provider: 'duckdns', record_type: 'A', enabled: true }]}
        settings={snapshot.settings ?? null}
      />,
    );
    expect(screen.getByText('Total Domains')).toBeInTheDocument();
    expect(screen.getByText('Public IP')).toBeInTheDocument();
    expect(screen.getByText('Record health')).toBeInTheDocument();
  });

  it('renders safely with a null snapshot', () => {
    render(<OverviewView snapshot={null} domains={[]} settings={null} />);
    expect(screen.getByText('Total Domains')).toBeInTheDocument();
  });
});
