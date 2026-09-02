import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HookModal } from './HookModal';
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
