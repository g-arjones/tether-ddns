import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DomainModal, type DomainModalProps } from './DomainModal';
import { ApiError } from '../api';
import type { Provider } from '../types';

const providers: Provider[] = [
  { key: 'duckdns', display_name: 'DuckDNS', schema: {} },
];

describe('DomainModal', () => {
  const twoProviders: Provider[] = [
    { key: 'duckdns', display_name: 'DuckDNS', schema: { required: ['token'], properties: { token: { title: 'Token', format: 'password' } } } },
    { key: 'cloudflare', display_name: 'Cloudflare', schema: { required: ['api_token'], properties: { api_token: { title: 'API Token', format: 'password' } } } },
  ];
  const rejectWith = (fieldErrors: Record<string, string>) =>
    vi.fn(async () => { throw new ApiError('/api/domains -> 422', 422, fieldErrors); });
  const openAdd = (onSave: DomainModalProps['onSave'], list = twoProviders) =>
    render(<DomainModal open providers={list} editing={null} onClose={vi.fn()} onSave={onSave} />);

  it('shows server field errors on hostname, record type and provider config', async () => {
    openAdd(rejectWith({
      hostname: 'Required', 'provider_config.token': 'Required', record_type: "Input should be 'A' or 'AAAA'",
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Domain' }));
    expect(await screen.findAllByText('Required')).toHaveLength(2);
    expect(screen.getByLabelText('Hostname / FQDN')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Hostname / FQDN')).toHaveAttribute('aria-describedby', 'fHostname-help');
    expect(screen.getByLabelText('Token')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Record Type')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clears only the edited field error', async () => {
    openAdd(rejectWith({ hostname: 'Required', 'provider_config.token': 'Required' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Domain' }));
    await screen.findAllByText('Required');
    fireEvent.change(screen.getByLabelText('Hostname / FQDN'), { target: { value: 'h.example.com' } });
    expect(screen.getByLabelText('Hostname / FQDN')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText('Token')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 't' } });
    expect(screen.getByLabelText('Token')).not.toHaveAttribute('aria-invalid');
  });

  it('drops provider config errors when the provider changes', async () => {
    openAdd(rejectWith({ hostname: 'Required', 'provider_config.token': 'Required' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Domain' }));
    await screen.findAllByText('Required');
    fireEvent.change(screen.getByLabelText('DNS Provider'), { target: { value: 'cloudflare' } });
    expect(screen.getByLabelText('API Token')).not.toHaveAttribute('aria-invalid');
    expect(screen.getAllByText('Required')).toHaveLength(1);
    expect(screen.getByLabelText('Hostname / FQDN')).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows a form-level alert when no field is named', async () => {
    openAdd(vi.fn(async () => { throw new Error('boom'); }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Domain' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to save domain');
  });

  it('shows an error on the whole provider config as a form-level alert', async () => {
    openAdd(rejectWith({ provider_config: 'Invalid config' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Domain' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid config');
  });

  it('disables submit while saving', async () => {
    const onSave = vi.fn(() => new Promise<void>(() => undefined));
    openAdd(onSave);
    const button = screen.getByRole('button', { name: 'Add Domain' });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('keeps typed values and errors when providers are refetched', async () => {
    const onSave = rejectWith({ 'provider_config.token': 'Required' });
    const { rerender } = openAdd(onSave);
    fireEvent.change(screen.getByLabelText('Hostname / FQDN'), { target: { value: 'kept.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Domain' }));
    await screen.findByText('Required');
    rerender(<DomainModal open providers={[...twoProviders]} editing={null} onClose={vi.fn()} onSave={onSave} />);
    expect(screen.getByLabelText('Hostname / FQDN')).toHaveValue('kept.example.com');
    expect(screen.getByLabelText('Token')).toHaveAttribute('aria-invalid', 'true');
  });

  it('fills the default provider when providers arrive after opening', () => {
    const { rerender } = openAdd(vi.fn(), []);
    rerender(<DomainModal open providers={twoProviders} editing={null} onClose={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByLabelText('DNS Provider')).toHaveValue('duckdns');
  });
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

  // The overlay stays mounted while closed so the fade has something to animate,
  // which otherwise leaves the whole form in the tab order and the a11y tree.
  it('withdraws the closed form from the tab order and the a11y tree', () => {
    const { container, rerender } = render(<DomainModal
      open={false} providers={providers} editing={null}
      onClose={vi.fn()} onSave={vi.fn()} />);
    const overlay = container.querySelector('.modal-overlay');
    expect(overlay).toHaveAttribute('inert');
    expect(overlay).toHaveAttribute('aria-hidden', 'true');

    rerender(<DomainModal
      open providers={providers} editing={null}
      onClose={vi.fn()} onSave={vi.fn()} />);
    expect(overlay).not.toHaveAttribute('inert');
    expect(overlay).not.toHaveAttribute('aria-hidden');
  });
});
