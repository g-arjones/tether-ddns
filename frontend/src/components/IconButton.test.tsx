import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { IconButton } from './IconButton';
import { IconTrash } from './icons';

describe('IconButton', () => {
  it('always exposes an accessible name and a tooltip from one label', () => {
    render(<IconButton label="Delete" onClick={vi.fn()}><IconTrash /></IconButton>);
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button).toHaveAttribute('title', 'Delete');
    expect(button).toHaveAttribute('type', 'button');
  });

  it('defaults to the icon-btn chrome variant', () => {
    render(<IconButton label="Close" onClick={vi.fn()}><IconTrash /></IconButton>);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveClass('icon-btn');
  });

  it('renders the act variant with an optional danger modifier', () => {
    render(
      <IconButton label="Delete" variant="act" danger onClick={vi.fn()}><IconTrash /></IconButton>,
    );
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button).toHaveClass('act-btn');
    expect(button).toHaveClass('danger');
    expect(button).not.toHaveClass('icon-btn');
  });

  it('appends an extra className without dropping the variant', () => {
    render(
      <IconButton label="Refresh" className="spin" onClick={vi.fn()}><IconTrash /></IconButton>,
    );
    const button = screen.getByRole('button', { name: 'Refresh' });
    expect(button).toHaveClass('icon-btn');
    expect(button).toHaveClass('spin');
  });

  it('calls onClick', () => {
    const onClick = vi.fn();
    render(<IconButton label="Edit" onClick={onClick}><IconTrash /></IconButton>);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
