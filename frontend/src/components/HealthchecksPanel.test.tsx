import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CheckStatus, HealthchecksProject, ProjectRuntime } from '../types';
import { HealthchecksPanel } from './HealthchecksPanel';

const NOW_MS = new Date(2026, 8, 25, 12, 0, 0).getTime();
const st = (name: string, s: CheckStatus['status']): CheckStatus => ({
  name, slug: name, status: s, last_ping: NOW_MS / 1000 - 60, next_ping: null, timeout: 60, schedule: null, tz: null, grace: 60,
});
const project = (over: Partial<HealthchecksProject> = {}): HealthchecksProject => ({
  id: 'p1', name: 'Homelab', base_url: 'https://healthchecks.io/', api_key: '********', poll_interval: 300,
  show_on_overview: true, fetched_at: 1,
  checks: [
    { key: 'a', name: 'Backup', slug: 'backup', visible: true },
    { key: 'b', name: 'SSL', slug: 'ssl', visible: true },
    { key: 'c', name: 'Hidden', slug: 'hidden', visible: false },
    { key: 'd', name: 'Old job', slug: 'old', visible: true },
  ],
  ...over,
});
const runtime: Record<string, ProjectRuntime> = {
  p1: { polled_at: 1, ok: true, error: null, offline: false, checks: { a: st('Backup', 'up'), b: st('SSL', 'down'), c: st('Hidden', 'up') } },
};

describe('HealthchecksPanel', () => {
  it('renders one row per shown project with badges for visible checks only', () => {
    const { container } = render(<HealthchecksPanel projects={[project()]} runtime={runtime} nowMs={NOW_MS} />);
    expect(screen.getByRole('heading', { name: 'Healthchecks' })).toBeInTheDocument();
    const badges = container.querySelectorAll('.hc-badge');
    expect(badges).toHaveLength(3);
    expect(container.querySelector('.hc-badge.hc-down')).toHaveTextContent('SSL');
    expect(container.querySelector('.hc-badge.hc-gone')).toHaveTextContent('Old job');
    expect(screen.queryByText('Hidden')).toBeNull();
    expect(container.querySelector('.hc-row .hc-sum')?.textContent).toBe('1 up · 1 down · 1 gone');
  });

  it('renders every badge stateless after a failed or offline poll', () => {
    const failed = { p1: { ...runtime.p1, ok: false, error: 'HTTP 503' } };
    const { container } = render(<HealthchecksPanel projects={[project()]} runtime={failed} nowMs={NOW_MS} />);
    expect(container.querySelectorAll('.hc-badge.hc-unknown')).toHaveLength(3);
    expect(screen.getByText('status unknown')).toBeInTheDocument();
  });

  it('renders stateless badges when the snapshot has no healthchecks field', () => {
    const { container } = render(<HealthchecksPanel projects={[project()]} runtime={undefined} nowMs={NOW_MS} />);
    expect(container.querySelectorAll('.hc-badge.hc-unknown')).toHaveLength(3);
  });

  it('is omitted when no project has visible checks on the Overview', () => {
    const { container } = render(
      <HealthchecksPanel
        projects={[project({ show_on_overview: false }), project({ id: 'p2', checks: [] })]}
        runtime={runtime}
        nowMs={NOW_MS}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('prefers the live upstream name over the fetched one', () => {
    const renamed = { p1: { ...runtime.p1, checks: { ...runtime.p1.checks, a: st('Nightly backup', 'up') } } };
    render(<HealthchecksPanel projects={[project()]} runtime={renamed} nowMs={NOW_MS} />);
    expect(screen.getByText('Nightly backup')).toBeInTheDocument();
  });
});
