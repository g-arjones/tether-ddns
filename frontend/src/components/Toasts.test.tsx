import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Toasts } from './Toasts';

describe('Toasts', () => {
  it('renders each toast message', () => {
    render(<Toasts toasts={[
      { id: '1', message: 'Saved', kind: 'success' },
      { id: '2', message: 'Boom', kind: 'error' },
      { id: '3', message: 'Heads up', kind: 'info' },
    ]} />);
    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(screen.getByText('Boom')).toBeInTheDocument();
    expect(screen.getByText('Heads up')).toBeInTheDocument();
  });

  it('renders nothing when there are no toasts', () => {
    const { container } = render(<Toasts toasts={[]} />);
    expect(container.querySelector('.toast')).toBeNull();
  });
});
