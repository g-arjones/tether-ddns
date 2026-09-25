import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HealthchecksProject } from '../types';
import { HealthchecksView } from './HealthchecksView';

const NOW_MS = new Date(2026, 8, 25, 12, 0, 0).getTime();
const project: HealthchecksProject = {
  id: 'p1', name: 'Homelab', base_url: 'https://healthchecks.io/', api_key: '********', poll_interval: 300,
  show_on_overview: true, fetched_at: null, checks: [{ key: 'a', name: 'Backup', slug: 'backup', visible: true }],
};
const props = () => ({
  runtime: undefined, nowMs: NOW_MS, onAdd: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(),
  onFetch: vi.fn(async () => undefined), onToggleOverview: vi.fn(), onToggleCheck: vi.fn(),
});

describe('HealthchecksView', () => {
  it('shows an empty state and an Add project button', () => {
    const p = props();
    render(<HealthchecksView projects={[]} {...p} />);
    expect(screen.getByText('No projects yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }));
    expect(p.onAdd).toHaveBeenCalledOnce();
  });

  it('lists projects and routes card actions with the project id', async () => {
    const p = props();
    render(<HealthchecksView projects={[project]} {...p} />);
    expect(screen.getByText('1 project')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(p.onEdit).toHaveBeenCalledWith(project);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(p.onDelete).toHaveBeenCalledWith('p1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show on Overview' }));
    expect(p.onToggleOverview).toHaveBeenCalledWith('p1', false);
    fireEvent.click(screen.getByRole('button', { name: 'Fetch checks' }));
    expect(p.onFetch).toHaveBeenCalledWith('p1');
    fireEvent.click(screen.getByRole('button', { name: 'Expand Homelab' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show Backup on Overview' }));
    expect(p.onToggleCheck).toHaveBeenCalledWith('p1', 'a', false);
  });
});
