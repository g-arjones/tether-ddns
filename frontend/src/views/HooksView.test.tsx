import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HooksView } from './HooksView';

const noop = vi.fn();

describe('HooksView', () => {
  it('shows the empty state with no hooks', () => {
    render(<HooksView hooks={[]} hookDefs={[]} onAdd={noop} onRun={noop} onEdit={noop} onDelete={noop} />);
    expect(screen.getByText('No hooks configured')).toBeInTheDocument();
  });
  it('renders a hook row with its events and fires run', () => {
    const onRun = vi.fn();
    render(
      <HooksView
        hooks={[{ id: 'h1', hook: 'log', events: ['ip_changed'], config: {} }]}
        hookDefs={[{ key: 'log', display_name: 'Log hook', events: [], schema: {} }]}
        onAdd={noop} onRun={onRun} onEdit={noop} onDelete={noop}
      />,
    );
    expect(screen.getByText('Log hook')).toBeInTheDocument();
    expect(screen.getByText('ip_changed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Run now/i }));
    expect(onRun).toHaveBeenCalledWith('h1');
  });
});
