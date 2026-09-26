import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmModal } from './ConfirmModal';

function setup(busy = false) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const { rerender } = render(
    <ConfirmModal open={false} title="Delete hook" confirmLabel="Delete hook"
      onConfirm={onConfirm} onCancel={onCancel}>body text</ConfirmModal>,
  );
  rerender(
    <ConfirmModal open title="Delete hook" confirmLabel="Delete hook" busy={busy}
      onConfirm={onConfirm} onCancel={onCancel}>body text</ConfirmModal>,
  );
  return { onConfirm, onCancel };
}

describe('ConfirmModal', () => {
  it('renders the title, message and confirm label, and focuses Cancel', () => {
    setup();
    expect(screen.getByRole('dialog', { name: 'Delete hook' })).toBeInTheDocument();
    expect(screen.getByText('body text')).toHaveClass('confirm-msg');
    expect(screen.getByRole('button', { name: 'Delete hook' })).toHaveClass('btn-danger');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('wires Cancel and Confirm to their callbacks', () => {
    const { onConfirm, onCancel } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Delete hook' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cancels on Escape', () => {
    const { onCancel } = setup();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('locks both buttons and ignores Escape and Close while busy', () => {
    const { onCancel } = setup(true);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete hook' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onCancel).not.toHaveBeenCalled();
  });
});
