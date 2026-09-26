import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import App from './App';
import * as api from './api';

// Mock every request but keep the real ApiError class and pure helpers.
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  const keep = new Set(['ApiError']);
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [name, keep.has(name) ? value : vi.fn()]),
  );
});
vi.mock('./useLiveState', () => ({
  useLiveState: () => ({
    snapshot: { public_ipv4: '1.2.3.4', public_ipv6: null, online: true, domains: [] },
    logs: [],
    status: 'open',
    generation: 0,
  }),
}));

const DOMAIN = { id: 'd1', hostname: 'home.example.com', provider: 'duckdns', record_type: 'A', enabled: true, provider_config: {} };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getDomains).mockResolvedValue([DOMAIN] as never);
  vi.mocked(api.getHooksConfig).mockResolvedValue([] as never);
  vi.mocked(api.getHealthchecks).mockResolvedValue([] as never);
  vi.mocked(api.getSettings).mockResolvedValue({
    check_interval: 300, ip_source: 'ipify', update_on_startup: true,
    retry_on_failure: true, notify: true, heartbeat_url: null, heartbeat_interval: 300,
  } as never);
  vi.mocked(api.getProviders).mockResolvedValue([
    { key: 'duckdns', display_name: 'DuckDNS', schema: { required: ['token'], properties: { token: { title: 'Token', format: 'password' } } } },
  ] as never);
  vi.mocked(api.getHooks).mockResolvedValue([] as never);
  vi.mocked(api.getIpSources).mockResolvedValue([] as never);
  vi.mocked(api.getIncidents).mockResolvedValue({ monitoring_since: 0, rev: 0, incidents: [], ongoing: null } as never);
});

async function openDomains() {
  render(<App />);
  fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: /Domains/ }));
  await within(screen.getByRole('main')).findByRole('checkbox');
}

describe('App form validation', () => {
  it('shows domain save errors inline, keeps the modal open and skips the error toast', async () => {
    vi.mocked(api.createDomain).mockRejectedValue(
      new api.ApiError('/api/domains -> 422', 422, { 'provider_config.token': 'Required' }));
    await openDomains();
    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'Add Domain' }));
    const dialog = screen.getByRole('dialog', { name: 'Add Domain' });
    fireEvent.change(within(dialog).getByLabelText('Hostname / FQDN'), { target: { value: 'new.example.com' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Domain' }));
    expect(await within(dialog).findByText('Required')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Add Domain' })).toBeInTheDocument();
    expect(screen.queryByText('Failed to save domain')).toBeNull();
  });

  it('lets the server judge an empty hostname', async () => {
    vi.mocked(api.createDomain).mockRejectedValue(
      new api.ApiError('/api/domains -> 422', 422, { hostname: 'Required' }));
    await openDomains();
    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'Add Domain' }));
    const dialog = screen.getByRole('dialog', { name: 'Add Domain' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Domain' }));
    await waitFor(() => expect(api.createDomain).toHaveBeenCalledWith(expect.objectContaining({ hostname: '' })));
    expect(await within(dialog).findByText('Required')).toBeInTheDocument();
    expect(screen.queryByText('Please enter a hostname')).toBeNull();
  });

  it('names the domain when a toggle is rejected as invalid', async () => {
    vi.mocked(api.updateDomain).mockRejectedValue(
      new api.ApiError('/api/domains/d1 -> 422', 422, { 'provider_config.token': 'Required' }));
    await openDomains();
    fireEvent.click(within(screen.getByRole('main')).getByRole('checkbox'));
    expect(await screen.findByText('home.example.com: fix its provider config first')).toBeInTheDocument();
  });

  it('keeps the generic message for other toggle failures', async () => {
    vi.mocked(api.updateDomain).mockRejectedValue(new Error('boom'));
    await openDomains();
    fireEvent.click(within(screen.getByRole('main')).getByRole('checkbox'));
    expect(await screen.findByText('Failed to update domain')).toBeInTheDocument();
  });
});
