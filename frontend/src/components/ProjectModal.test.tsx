import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import type { HealthchecksProject } from '../types';
import { ProjectModal } from './ProjectModal';

const editing: HealthchecksProject = {
  id: 'p1', name: 'Homelab', base_url: 'https://hc.example.lan/', api_key: '********', poll_interval: 900,
  show_on_overview: true, fetched_at: 1, checks: [],
};

describe('ProjectModal', () => {
  it('adds with healthchecks.io and a 5-minute poll by default', async () => {
    const onSave = vi.fn(async () => undefined);
    render(<ProjectModal open editing={null} onClose={vi.fn()} onSave={onSave} />);
    expect(screen.getByRole('heading', { name: 'Add project' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Base URL/)).toHaveValue('https://healthchecks.io');
    expect(screen.getByRole('button', { name: '5 min' })).toHaveClass('active');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Homelab' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'ro-key' } });
    fireEvent.click(screen.getByRole('button', { name: '2 min' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add & fetch' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      name: 'Homelab', base_url: 'https://healthchecks.io', api_key: 'ro-key', poll_interval: 120,
    }));
  });

  it('shows upstream errors inline on their field', async () => {
    const error = new ApiError('/api/healthchecks -> 422', 422, { api_key: '401 Unauthorized — API key invalid or revoked' });
    render(<ProjectModal open editing={null} onClose={vi.fn()} onSave={vi.fn(async () => { throw error; })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add & fetch' }));
    expect(await screen.findByText('401 Unauthorized — API key invalid or revoked')).toBeInTheDocument();
    expect(screen.getByLabelText('API key')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'x' } });
    expect(screen.getByLabelText('API key')).not.toHaveAttribute('aria-invalid');
  });

  it('shows a generic error when the failure has no field', async () => {
    render(<ProjectModal open editing={null} onClose={vi.fn()} onSave={vi.fn(async () => { throw new Error('boom'); })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add & fetch' }));
    expect(await screen.findByText('Failed to save project')).toBeInTheDocument();
  });

  it('edits with the stored values and an unchanged key', async () => {
    const onSave = vi.fn(async () => undefined);
    render(<ProjectModal open editing={editing} onClose={vi.fn()} onSave={onSave} />);
    expect(screen.getByRole('heading', { name: 'Edit project' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Homelab');
    expect(screen.getByLabelText('API key')).toHaveValue('');
    expect(screen.getByLabelText('API key')).toHaveAttribute('placeholder', 'unchanged');
    expect(screen.getByRole('button', { name: '15 min' })).toHaveClass('active');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      name: 'Homelab', base_url: 'https://hc.example.lan/', api_key: '', poll_interval: 900,
    }));
  });
});
