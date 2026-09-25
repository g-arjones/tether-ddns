import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CheckStatus, HealthchecksProject, ProjectRuntime } from '../types';
import { ChecksTable } from './ChecksTable';

const NOW_MS = new Date(2026, 8, 25, 12, 0, 0).getTime();
const NOW_S = NOW_MS / 1000;
const st = (over: Partial<CheckStatus>): CheckStatus => ({
  name: 'x', slug: 'x', status: 'up', last_ping: null, next_ping: null, timeout: 86400, schedule: null, tz: null, grace: 3600, ...over,
});
const project: HealthchecksProject = {
  id: 'p1', name: 'Homelab', base_url: 'https://healthchecks.io/', api_key: '********', poll_interval: 120,
  show_on_overview: true, fetched_at: NOW_S - 3 * 86400,
  checks: [
    { key: 'ssl', name: 'SSL (hydrogen)', slug: 'ssl-hydrogen', visible: true },
    { key: 'check', name: 'Check', slug: 'check', visible: false },
    { key: 'old', name: 'Old job', slug: 'old-job', visible: true },
  ],
};
const runtime: ProjectRuntime = {
  polled_at: NOW_S - 14, ok: true, error: null, offline: false,
  checks: {
    ssl: st({ name: 'SSL (hydrogen)', slug: 'ssl-hydrogen', status: 'down', last_ping: NOW_S - 130 * 86400, grace: 93600 }),
    check: st({ name: 'Check', slug: 'check', timeout: null, schedule: '*-*-1 04:30:00', tz: 'UTC', grace: 10800, last_ping: NOW_S - 3 * 604800 }),
  },
};

describe('ChecksTable', () => {
  it('renders a row per fetched check with status, slug, period and last ping', () => {
    render(<ChecksTable project={project} runtime={runtime} nowMs={NOW_MS} onToggleCheck={vi.fn()} />);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    const ssl = within(rows[0]);
    expect(ssl.getByText('down', { selector: '.hc-pill' })).toHaveClass('hc-down');
    expect(ssl.getByText('ssl-hydrogen')).toBeInTheDocument();
    expect(ssl.getByText('1 day')).toBeInTheDocument();
    expect(ssl.getByText('1 day 2 hours')).toBeInTheDocument();
    expect(ssl.getByText('4 months ago')).toBeInTheDocument();
    expect(ssl.getByText('4mo ago')).toBeInTheDocument();
    const cron = within(rows[1]);
    expect(cron.getAllByText('*-*-1 04:30:00')[0]).toHaveClass('mono');
    expect(cron.getByText('3 weeks ago')).toBeInTheDocument();
  });

  it('marks a check missing from the last poll as gone', () => {
    render(<ChecksTable project={project} runtime={runtime} nowMs={NOW_MS} onToggleCheck={vi.fn()} />);
    const gone = screen.getAllByRole('row')[3];
    expect(gone).toHaveClass('hc-gone-row');
    expect(within(gone).getByText('Not in last poll — Fetch to remove')).toBeInTheDocument();
    expect(within(gone).getByText('gone', { selector: '.hc-pill' })).toHaveClass('hc-gone');
  });

  it('shows unknown but keeps the last good values after a failed poll', () => {
    render(<ChecksTable project={project} runtime={{ ...runtime, ok: false, error: 'HTTP 503' }} nowMs={NOW_MS} onToggleCheck={vi.fn()} />);
    const ssl = within(screen.getAllByRole('row')[1]);
    expect(ssl.getByText('unknown', { selector: '.hc-pill' })).toHaveClass('hc-unknown');
    expect(ssl.getByText('4 months ago')).toBeInTheDocument();
  });

  it('toggles a check on the Overview', () => {
    const onToggleCheck = vi.fn();
    render(<ChecksTable project={project} runtime={runtime} nowMs={NOW_MS} onToggleCheck={onToggleCheck} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show Check on Overview' }));
    expect(onToggleCheck).toHaveBeenCalledWith('check', true);
  });

  it('renders a placeholder row for an empty project', () => {
    render(<ChecksTable project={{ ...project, checks: [] }} runtime={runtime} nowMs={NOW_MS} onToggleCheck={vi.fn()} />);
    expect(screen.getByText('No checks in this project.')).toBeInTheDocument();
  });
});
