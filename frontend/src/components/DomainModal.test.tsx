import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DomainModal } from './DomainModal';
import type { Provider } from '../types';

const providers: Provider[] = [
  { key: 'duckdns', display_name: 'DuckDNS', schema: {} },
];

describe('DomainModal', () => {
  it('renders the add form and submits entered values', () => {
    const onSave = vi.fn();
    render(<DomainModal
      open providers={providers} editing={null}
      onClose={vi.fn()} onSave={onSave} />);
    expect(screen.getByRole('heading', { name: 'Add Domain' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Hostname / FQDN'), {
      target: { value: 'home.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add Domain' }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: 'home.example.com', provider: 'duckdns' }),
    );
  });

  it('prefills fields when editing', () => {
    render(<DomainModal
      open providers={providers}
      editing={{
        id: 'a', hostname: 'edit.example.com', provider: 'duckdns',
        record_type: 'A', enabled: true, provider_config: {},
      }}
      onClose={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByText('Edit Domain')).toBeInTheDocument();
    expect(screen.getByDisplayValue('edit.example.com')).toBeInTheDocument();
  });

  it('shows the selected provider class-docstring blurb', () => {
    const withDesc: Provider[] = [
      { key: 'duckdns', display_name: 'DuckDNS', schema: { description: 'DuckDNS provider config.' } },
    ];
    render(<DomainModal
      open providers={withDesc} editing={null}
      onClose={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByText('DuckDNS provider config.')).toBeInTheDocument();
  });

  it('offers only A and AAAA record type options', () => {
    render(<DomainModal
      open providers={providers} editing={null}
      onClose={vi.fn()} onSave={vi.fn()} />);
    const select = screen.getByLabelText('Record Type') as HTMLSelectElement;
    const options = Array.from(select.options).map((opt) => ({ value: opt.value, label: opt.textContent }));
    expect(options).toHaveLength(2);
    expect(options[0]).toEqual({ value: 'A', label: 'A (IPv4)' });
    expect(options[1]).toEqual({ value: 'AAAA', label: 'AAAA (IPv6)' });
  });
});
