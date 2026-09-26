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

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<Modal open title="Add Domain" onClose={onClose}><p>body</p></Modal>);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores other keys', () => {
    const onClose = vi.fn();
    render(<Modal open title="Add Domain" onClose={onClose}><p>body</p></Modal>);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('focuses the [data-autofocus] element on open', () => {
    const { rerender } = render(
      <Modal open={false} title="Confirm" onClose={vi.fn()}><button data-autofocus>Cancel</button></Modal>,
    );
    rerender(<Modal open title="Confirm" onClose={vi.fn()}><button data-autofocus>Cancel</button></Modal>);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('focuses the dialog itself when nothing asks for autofocus', () => {
    const { rerender } = render(<Modal open={false} title="Day" onClose={vi.fn()}><p>body</p></Modal>);
    rerender(<Modal open title="Day" onClose={vi.fn()}><p>body</p></Modal>);
    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it('returns focus to the opener on close', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { rerender } = render(<Modal open title="Day" onClose={vi.fn()}><p>body</p></Modal>);
    expect(opener).not.toHaveFocus();

    rerender(<Modal open={false} title="Day" onClose={vi.fn()}><p>body</p></Modal>);
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('does not throw when the opener is gone by the time it closes', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { rerender } = render(<Modal open title="Day" onClose={vi.fn()}><p>body</p></Modal>);
    opener.remove();

    expect(() => rerender(<Modal open={false} title="Day" onClose={vi.fn()}><p>body</p></Modal>)).not.toThrow();
    expect(opener).not.toHaveFocus();
  });
});
