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
});
