import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { HookModal, type HookModalProps } from './HookModal';
import { ApiError } from '../api';
import type { HookDef } from '../types';

const hooks: HookDef[] = [
  {
    key: 'log', display_name: 'Log Hook',
    events: [
      { key: 'ip_changed', label: 'IP Changed' },
      { key: 'reachability_changed', label: 'Reachability Changed' },
    ],
    schema: {},
  },
];

describe('HookModal', () => {
  const twoHooks: HookDef[] = [
    {
      key: 'pushover', display_name: 'Pushover',
      events: [{ key: 'ip_changed', label: 'IP Changed' }],
      schema: { required: ['user'], properties: { user: { title: 'User Key', format: 'password' } } },
    },
    { key: 'log', display_name: 'Log Hook', events: [{ key: 'ip_changed', label: 'IP Changed' }], schema: {} },
  ];
  const rejectWith = (fieldErrors: Record<string, string>) =>
    vi.fn(async () => { throw new ApiError('/api/hooks-config -> 422', 422, fieldErrors); });
  const openAdd = (onSave: HookModalProps['onSave'], list = twoHooks) =>
    render(<HookModal open hooks={list} editing={null} onClose={vi.fn()} onSave={onSave} />);

  it('shows server errors on the hook, its events and its config', async () => {
    openAdd(rejectWith({ hook: 'Unknown hook', events: 'Unsupported event x', 'config.user': 'Required' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Hook' }));
    expect(await screen.findByText('Required')).toBeInTheDocument();
    expect(screen.getByLabelText('Hook')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('User Key')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('group', { name: 'Events' })).toHaveAttribute('aria-describedby', 'fEvents-help');
    expect(document.getElementById('fEvents-help')).toHaveTextContent('Unsupported event x');
  });

  it('clears the events error when an event is toggled', async () => {
    openAdd(rejectWith({ events: 'Unsupported event x' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Hook' }));
    await screen.findByText('Unsupported event x');
    fireEvent.click(screen.getByRole('button', { name: 'IP Changed' }));
    expect(screen.queryByText('Unsupported event x')).toBeNull();
  });

  it('drops hook and config errors when the hook type changes', async () => {
    openAdd(rejectWith({ hook: 'Unknown hook', 'config.user': 'Required' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Hook' }));
    await screen.findByText('Required');
    fireEvent.change(screen.getByLabelText('Hook'), { target: { value: 'log' } });
    expect(screen.queryByText('Required')).toBeNull();
    expect(screen.queryByText('Unknown hook')).toBeNull();
    expect(screen.getByLabelText('Hook')).not.toHaveAttribute('aria-invalid');
  });

  it('shows a form-level alert when no field is named', async () => {
    openAdd(vi.fn(async () => { throw new Error('boom'); }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Hook' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to save hook');
  });

  it('disables submit while saving', async () => {
    const onSave = vi.fn(() => new Promise<void>(() => undefined));
    openAdd(onSave);
    const button = screen.getByRole('button', { name: 'Add Hook' });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
  });

  it('keeps the selection and errors when hooks are refetched', async () => {
    const onSave = rejectWith({ 'config.user': 'Required' });
    const { rerender } = openAdd(onSave);
    fireEvent.click(screen.getByRole('button', { name: 'IP Changed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Hook' }));
    await screen.findByText('Required');
    rerender(<HookModal open hooks={[...twoHooks]} editing={null} onClose={vi.fn()} onSave={onSave} />);
    expect(screen.getByRole('button', { name: 'IP Changed' })).toHaveClass('active');
    expect(screen.getByLabelText('User Key')).toHaveAttribute('aria-invalid', 'true');
  });
  it('toggles events and submits the selection', () => {
    const onSave = vi.fn();
    render(<HookModal
      open hooks={hooks} editing={null}
      onClose={vi.fn()} onSave={onSave} />);
    expect(screen.getByRole('heading', { name: 'Add Hook' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'IP Changed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Hook' }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ hook: 'log', events: ['ip_changed'] }),
    );
  });

  it('prefills when editing an existing hook', () => {
    render(<HookModal
      open hooks={hooks}
      editing={{ id: 'h', hook: 'log', events: ['ip_changed'], config: {} }}
      onClose={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByText('Edit Hook')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'IP Changed' })).toHaveClass('active');
  });

  it('renders event labels and toggles by key', () => {
    const rfHooks: HookDef[] = [{
      key: 'router_firewall', display_name: 'Router Firewall (ZTE)',
      events: [{ key: 'ip_changed', label: 'IP Changed' }],
      schema: { properties: {} },
    }];
    const onSave = vi.fn();
    render(<HookModal
      open hooks={rfHooks} editing={null}
      onClose={vi.fn()} onSave={onSave} />);
    expect(screen.getByText('IP Changed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'IP Changed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Hook' }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ events: ['ip_changed'] }));
  });

  // The overlay stays mounted while closed so the fade has something to animate,
  // which otherwise leaves the whole form in the tab order and the a11y tree.
  it('withdraws the closed form from the tab order and the a11y tree', () => {
    const { container, rerender } = render(<HookModal
      open={false} hooks={hooks} editing={null}
      onClose={vi.fn()} onSave={vi.fn()} />);
    const overlay = container.querySelector('.modal-overlay');
    expect(overlay).toHaveAttribute('inert');
    expect(overlay).toHaveAttribute('aria-hidden', 'true');

    rerender(<HookModal
      open hooks={hooks} editing={null}
      onClose={vi.fn()} onSave={vi.fn()} />);
    expect(overlay).not.toHaveAttribute('inert');
    expect(overlay).not.toHaveAttribute('aria-hidden');
  });
});
