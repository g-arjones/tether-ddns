import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Rail } from './Rail';

const base = {
  active: 'overview' as const, onSelect: vi.fn(), domainCount: 3, hookCount: 2,
  online: true, collapsed: false, mobileOpen: false, onCloseMobile: vi.fn(),
};

describe('Rail', () => {
  it('renders the five nav items with counts', () => {
    render(<Rail {...base} />);
    expect(screen.getByRole('button', { name: /Overview/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Domains/ })).toHaveTextContent('3');
    expect(screen.getByRole('button', { name: /Hooks/ })).toHaveTextContent('2');
    expect(screen.getByRole('button', { name: /Logs/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Settings/ })).toBeInTheDocument();
  });

  it('marks the active view', () => {
    render(<Rail {...base} active="domains" />);
    expect(screen.getByRole('button', { name: /Domains/ })).toHaveClass('active');
  });

  it('calls onSelect when a nav item is clicked', () => {
    const onSelect = vi.fn();
    render(<Rail {...base} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Hooks/ }));
    expect(onSelect).toHaveBeenCalledWith('hooks');
  });

  it('shows offline dot when offline', () => {
    const { container } = render(<Rail {...base} online={false} />);
    expect(container.querySelector('.rail-status .dot.offline')).toBeTruthy();
  });

  it('renders a resize handle', () => {
    const { container } = render(<Rail {...base} />);
    expect(container.querySelector('.rail-resizer')).toBeTruthy();
  });

  it('persists a dragged width to localStorage on pointer drag', () => {
    const { container } = render(<Rail {...base} />);
    const resizer = container.querySelector('.rail-resizer') as HTMLElement;
    fireEvent.pointerDown(resizer, { clientX: 260 });
    fireEvent(document, new MouseEvent('pointermove', { clientX: 260 } as MouseEventInit));
    fireEvent(document, new MouseEvent('pointerup', {} as MouseEventInit));
    expect(localStorage.getItem('tether-rail-width')).toBe('260');
  });

  it('does not start a resize when collapsed', () => {
    localStorage.removeItem('tether-rail-width');
    const { container } = render(<Rail {...base} collapsed />);
    const resizer = container.querySelector('.rail-resizer') as HTMLElement;
    fireEvent.pointerDown(resizer, { clientX: 260 });
    fireEvent(document, new MouseEvent('pointermove', { clientX: 260 } as MouseEventInit));
    fireEvent(document, new MouseEvent('pointerup', {} as MouseEventInit));
    expect(localStorage.getItem('tether-rail-width')).toBeNull();
  });
});
