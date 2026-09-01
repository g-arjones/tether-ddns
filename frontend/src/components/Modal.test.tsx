import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Modal } from './Modal';

describe('Modal', () => {
  it('withdraws the closed dialog from the tab order and the a11y tree', () => {
    const { container, rerender } = render(
      <Modal open={false} title="Add Domain" onClose={vi.fn()}><p>body</p></Modal>,
    );
    const overlay = container.querySelector('.modal-overlay');
    expect(overlay).toHaveAttribute('inert');
    expect(overlay).toHaveAttribute('aria-hidden', 'true');
    expect(overlay).not.toHaveClass('open');

    rerender(<Modal open title="Add Domain" onClose={vi.fn()}><p>body</p></Modal>);
    expect(overlay).not.toHaveAttribute('inert');
    expect(overlay).not.toHaveAttribute('aria-hidden');
    expect(overlay).toHaveClass('open');
  });

  it('labels the dialog with its own title', () => {
    render(<Modal open title="Add Hook" onClose={vi.fn()}><p>body</p></Modal>);
    const dialog = screen.getByRole('dialog', { name: 'Add Hook' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('closes on a backdrop click but not on a body click', () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal open title="Add Domain" onClose={onClose}><p>body</p></Modal>,
    );
    fireEvent.click(screen.getByText('body'));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(container.querySelector('.modal-overlay')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes from the close button', () => {
    const onClose = vi.fn();
    render(<Modal open title="Add Domain" onClose={onClose}><p>body</p></Modal>);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('omits the footer element entirely when no footer is given', () => {
    const { container, rerender } = render(
      <Modal open title="Day" onClose={vi.fn()}><p>body</p></Modal>,
    );
    expect(container.querySelector('.modal-foot')).toBeNull();

    rerender(
      <Modal open title="Day" onClose={vi.fn()} footer={<button>Save</button>}><p>body</p></Modal>,
    );
    expect(container.querySelector('.modal-foot')).not.toBeNull();
  });
});
