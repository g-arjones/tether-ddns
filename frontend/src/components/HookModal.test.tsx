import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HookModal } from './HookModal';
import type { HookDef } from '../types';

const hooks: HookDef[] = [
  { key: 'log', display_name: 'Log Hook', events: ['ip_changed', 'reachability_changed'], schema: {} },
];

describe('HookModal', () => {
  it('toggles events and submits the selection', () => {
    const onSave = vi.fn();
    render(<HookModal
      open hooks={hooks} editing={null}
      onClose={vi.fn()} onSave={onSave} />);
    expect(screen.getByRole('heading', { name: 'Add Hook' })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('ip_changed'));
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
    expect((screen.getByLabelText('ip_changed') as HTMLInputElement).checked).toBe(true);
  });
});
