import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import App from './App';
import * as api from './api';

vi.mock('./api');
vi.mock('./useLiveState', () => ({
  useLiveState: () => ({
    snapshot: { public_ipv4: '1.2.3.4', public_ipv6: null, online: true, domains: [] },
    logs: [],
    status: 'open',
    generation: 0,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getDomains).mockResolvedValue([
    { id: 'd1', hostname: 'home.example.com', provider: 'duckdns', record_type: 'A', enabled: true, provider_config: {} },
  ] as never);
  vi.mocked(api.getHooksConfig).mockResolvedValue([
    { id: 'h1', hook: 'log', events: ['ip_changed'], config: {} },
  ] as never);
  vi.mocked(api.getHealthchecks).mockResolvedValue([
    {
      id: 'p1', name: 'Homelab', base_url: 'https://healthchecks.io', api_key: '********',
      poll_interval: 60, show_on_overview: true, fetched_at: null, checks: [],
    },
  ] as never);
  vi.mocked(api.getSettings).mockResolvedValue({
    check_interval: 300, ip_source: 'ipify', update_on_startup: true,
    retry_on_failure: true, notify: true,
  } as never);
  vi.mocked(api.getProviders).mockResolvedValue([
    { key: 'duckdns', display_name: 'DuckDNS', schema: {} },
  ] as never);
  vi.mocked(api.getHooks).mockResolvedValue([
    { key: 'log', display_name: 'Log Event', events: [{ key: 'ip_changed', label: 'IP Changed' }], schema: {} },
  ] as never);
  vi.mocked(api.getIpSources).mockResolvedValue([] as never);
  vi.mocked(api.getIncidents).mockResolvedValue({
    monitoring_since: 0, rev: 0, incidents: [], ongoing: null,
  } as never);
});

// Closed modals stay mounted to fade out, so what they show after Cancel is what the user sees fade.
const cases = [
  { nav: /Domains/, title: 'Edit Domain', addTitle: 'Add Domain', field: 'Hostname / FQDN', stored: 'home.example.com' },
  { nav: /Healthchecks/, title: 'Edit project', addTitle: 'Add project', field: 'Name', stored: 'Homelab' },
] as const;

describe('App edit modals', () => {
  for (const c of cases) {
    it(`keeps "${c.title}" and its values while fading out after Cancel`, async () => {
      render(<App />);
      fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: c.nav }));
      fireEvent.click(await within(screen.getByRole('main')).findByRole('button', { name: 'Edit' }));
      const dialog = screen.getByRole('dialog', { name: c.title });
      fireEvent.change(within(dialog).getByLabelText(c.field), { target: { value: 'typed' } });

      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('dialog', { name: c.title })).toBeNull();
      const heading = screen.getByText(c.title, { selector: 'h3' });
      expect(screen.queryByText(c.addTitle, { selector: 'h3' })).toBeNull();
      const overlay = heading.closest('.modal-overlay') as HTMLElement;
      expect(within(overlay).getByLabelText(c.field)).toHaveValue('typed');
    });
  }

  it('keeps "Edit Hook" and its events while fading out after Cancel', async () => {
    render(<App />);
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: /Hooks/ }));
    fireEvent.click(await within(screen.getByRole('main')).findByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit Hook' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'IP Changed' }));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    const heading = screen.getByText('Edit Hook', { selector: 'h3' });
    const overlay = heading.closest('.modal-overlay') as HTMLElement;
    expect(within(overlay).getByText('IP Changed').closest('button')).not.toHaveClass('active');
  });

  it('reopening the same record after Cancel shows the stored values again', async () => {
    render(<App />);
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: /Domains/ }));
    const edit = await within(screen.getByRole('main')).findByRole('button', { name: 'Edit' });
    fireEvent.click(edit);
    const dialog = screen.getByRole('dialog', { name: 'Edit Domain' });
    fireEvent.change(within(dialog).getByLabelText('Hostname / FQDN'), { target: { value: 'typed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    fireEvent.click(edit);
    expect(within(screen.getByRole('dialog', { name: 'Edit Domain' })).getByLabelText('Hostname / FQDN'))
      .toHaveValue('home.example.com');
  });

  it('Add after an Edit opens an empty form', async () => {
    render(<App />);
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: /Domains/ }));
    fireEvent.click(await within(screen.getByRole('main')).findByRole('button', { name: 'Edit' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Edit Domain' })).getByRole('button', { name: 'Cancel' }));

    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'Add Domain' }));
    expect(within(screen.getByRole('dialog', { name: 'Add Domain' })).getByLabelText('Hostname / FQDN')).toHaveValue('');
  });
});
