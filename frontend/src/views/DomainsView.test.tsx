import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DomainsView } from './DomainsView';

const noop = vi.fn();
const handlers = { onSync: noop, onEdit: noop, onDelete: noop, onToggle: noop };

describe('DomainsView', () => {
  it('shows the empty state with no domains', () => {
    render(<DomainsView domains={[]} runtimeById={new Map()} onAdd={noop} {...handlers} />);
    expect(screen.getByText('No domains yet')).toBeInTheDocument();
  });
  it('renders a card per domain and fires onAdd', () => {
    const onAdd = vi.fn();
    render(
      <DomainsView
        domains={[{ id: 'a', hostname: 'home.example.com', provider: 'duckdns', record_type: 'A', enabled: true }]}
        runtimeById={new Map()}
        onAdd={onAdd}
        {...handlers}
      />,
    );
    expect(screen.getByText('home.example.com')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add Domain/ }));
    expect(onAdd).toHaveBeenCalled();
  });
});
