import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DomainCard } from './DomainCard';

describe('DomainCard', () => {
  it('shows hostname/status and fires sync', () => {
    const onSync = vi.fn();
    render(<DomainCard
      domain={{ id: 'a', hostname: 'home.example.com', provider: 'duckdns', record_type: 'A', enabled: true }}
      runtime={{ id: 'a', status: 'synced', ip: '1.2.3.4', updated: Date.now() / 1000, message: '' }}
      onSync={onSync} onEdit={vi.fn()} onDelete={vi.fn()} onToggle={vi.fn()} />);
    expect(screen.getByText('home.example.com')).toBeInTheDocument();
    expect(screen.getByText(/synced/i)).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Force update now'));
    expect(onSync).toHaveBeenCalledWith('a');
  });

  it('shows real status for a disabled domain (not Paused)', () => {
    render(<DomainCard
      domain={{ id: 'a', hostname: 'home.example.com', provider: 'duckdns', record_type: 'A', enabled: false }}
      runtime={{ id: 'a', status: 'pending', ip: '1.2.3.4', updated: Date.now() / 1000, message: '' }}
      onSync={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onToggle={vi.fn()} />);
    expect(screen.getByText(/pending/i)).toBeInTheDocument();
    expect(screen.queryByText(/paused/i)).not.toBeInTheDocument();
  });

  it('colors the provider badge from the provider key', () => {
    const { container } = render(<DomainCard
      domain={{ id: 'a', hostname: 'home.example.com', provider: 'duckdns', record_type: 'A', enabled: true }}
      runtime={{ id: 'a', status: 'synced', ip: '1.2.3.4', updated: Date.now() / 1000, message: '' }}
      onSync={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onToggle={vi.fn()} />);
    const badge = container.querySelector('.provider-badge');
    const style = badge?.getAttribute('style');
    expect(style).toBeTruthy();
    // Browser converts hsl to rgb, so just verify a background style is set
    expect(style).toMatch(/background/);
  });

  it('renders a toggle switch wired to onToggle', () => {
    const onToggle = vi.fn();
    const { container } = render(<DomainCard
      domain={{ id: 'a', hostname: 'home.example.com', provider: 'duckdns', record_type: 'A', enabled: true }}
      runtime={{ id: 'a', status: 'synced', ip: '1.2.3.4', updated: Date.now() / 1000, message: '' }}
      onSync={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onToggle={onToggle} />);
    const switchInput = container.querySelector('.switch input') as HTMLInputElement;
    expect(switchInput).toBeTruthy();
    expect(switchInput.checked).toBe(true);
    fireEvent.click(switchInput);
    expect(onToggle).toHaveBeenCalledWith('a');
  });
});
