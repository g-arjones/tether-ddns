import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HealthchecksProject, ProjectRuntime } from '../types';
import { ProjectCard } from './ProjectCard';

const NOW_MS = new Date(2026, 8, 25, 12, 0, 0).getTime();
const NOW_S = NOW_MS / 1000;
const project: HealthchecksProject = {
  id: 'p1', name: 'Homelab', base_url: 'https://hc.example.lan/', api_key: '********', poll_interval: 120,
  show_on_overview: true, fetched_at: NOW_S - 3 * 86400,
  checks: [{ key: 'a', name: 'Backup', slug: 'backup', visible: true }],
};
const ok: ProjectRuntime = {
  polled_at: NOW_S - 14, ok: true, error: null, offline: false,
  checks: { a: { name: 'Backup', slug: 'backup', status: 'up', last_ping: null, next_ping: null, timeout: 60, schedule: null, tz: null, grace: 60 } },
};
const handlers = () => ({
  onToggleOverview: vi.fn(), onToggleCheck: vi.fn(), onFetch: vi.fn(async () => undefined), onEdit: vi.fn(), onDelete: vi.fn(),
});

describe('ProjectCard', () => {
  it('shows the summary and facts, collapsed by default', () => {
    render(<ProjectCard project={project} runtime={ok} nowMs={NOW_MS} {...handlers()} />);
    expect(screen.getByText('Homelab')).toBeInTheDocument();
    expect(screen.getByText('1 up · 1 check', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('hc.example.lan')).toBeInTheDocument();
    expect(screen.getByText('2 min')).toBeInTheDocument();
    expect(screen.getByText('14s ago')).toBeInTheDocument();
    expect(screen.getByText('3d ago')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('expands into the checks table', () => {
    render(<ProjectCard project={project} runtime={ok} nowMs={NOW_MS} {...handlers()} />);
    const chevron = screen.getByRole('button', { name: 'Expand Homelab' });
    expect(chevron).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(chevron);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse Homelab' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('wires the Overview switch, edit and delete', () => {
    const h = handlers();
    render(<ProjectCard project={project} runtime={ok} nowMs={NOW_MS} {...h} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show on Overview' }));
    expect(h.onToggleOverview).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(h.onEdit).toHaveBeenCalledOnce();
    expect(h.onDelete).toHaveBeenCalledOnce();
  });

  it('spins the fetch button until the fetch settles', async () => {
    let settle: () => void = () => undefined;
    const h = { ...handlers(), onFetch: vi.fn(() => new Promise<void>((resolve) => { settle = resolve; })) };
    render(<ProjectCard project={project} runtime={ok} nowMs={NOW_MS} {...h} />);
    const button = screen.getByRole('button', { name: 'Fetch checks' });
    fireEvent.click(button);
    expect(h.onFetch).toHaveBeenCalledOnce();
    expect(button).toBeDisabled();
    expect(button).toHaveClass('spin');
    settle();
    await waitFor(() => expect(button).not.toBeDisabled());
  });

  it('shows the failed-poll banner', () => {
    render(<ProjectCard project={project} runtime={{ ...ok, ok: false, error: '401 Unauthorized — API key invalid or revoked' }} nowMs={NOW_MS} {...handlers()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Last poll failed: 401 Unauthorized — API key invalid or revoked');
    expect(screen.getByText('1 check · status unknown')).toBeInTheDocument();
  });

  it('shows the offline banner instead of a stale error', () => {
    render(<ProjectCard project={project} runtime={{ ...ok, ok: false, error: 'HTTP 503', offline: true }} nowMs={NOW_MS} {...handlers()} />);
    expect(screen.getByText('System is offline — polling paused.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
