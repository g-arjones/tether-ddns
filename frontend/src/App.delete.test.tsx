import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
    { id: 'd1', hostname: 'home.example.com', provider: 'duckdns', record_type: 'A', enabled: true },
  ] as never);
  vi.mocked(api.getHooksConfig).mockResolvedValue([
    { id: 'h1', hook: 'log', events: ['ip_changed'], config: {} },
  ] as never);
  vi.mocked(api.getHealthchecks).mockResolvedValue([
    {
      id: 'p1', name: 'Homelab', base_url: 'https://healthchecks.io', api_key: '****',
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
    { key: 'log', display_name: 'Log Event', events: [], schema: {} },
  ] as never);
  vi.mocked(api.getIpSources).mockResolvedValue([] as never);
  vi.mocked(api.getIncidents).mockResolvedValue({
    monitoring_since: 0, rev: 0, incidents: [], ongoing: null,
  } as never);
  vi.mocked(api.deleteDomain).mockResolvedValue({ ok: true } as never);
  vi.mocked(api.deleteHook).mockResolvedValue({ ok: true } as never);
  vi.mocked(api.deleteHealthchecks).mockResolvedValue({ ok: true } as never);
});

const cases = [
  { nav: /Domains/, kind: 'domain', noun: 'Domain', name: 'home.example.com', remove: () => api.deleteDomain, id: 'd1' },
  { nav: /Hooks/, kind: 'hook', noun: 'Hook', name: 'Log Event', remove: () => api.deleteHook, id: 'h1' },
  { nav: /Healthchecks/, kind: 'project', noun: 'Project', name: 'Homelab', remove: () => api.deleteHealthchecks, id: 'p1' },
] as const;

async function openConfirm(nav: RegExp, kind: string) {
  render(<App />);
  // Scoped to the rail: Overview panels may carry buttons that also match the regex.
  fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: nav }));
  fireEvent.click(await within(screen.getByRole('main')).findByRole('button', { name: 'Delete' }));
  return screen.getByRole('dialog', { name: `Delete ${kind}` });
}

describe('App delete confirmation', () => {
  for (const c of cases) {
    it(`asks before deleting a ${c.kind} and deletes on confirm`, async () => {
      const dialog = await openConfirm(c.nav, c.kind);
      expect(within(dialog).getByText(c.name)).toBeInTheDocument();
      expect(document.querySelector('.shell')).toHaveAttribute('inert');
      expect(c.remove()).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole('button', { name: `Delete ${c.kind}` }));
      await waitFor(() => expect(c.remove()).toHaveBeenCalledWith(c.id));
      await screen.findByText(`${c.noun} deleted`);
      expect(screen.queryByRole('dialog', { name: `Delete ${c.kind}` })).toBeNull();
    });

    it(`does not delete a ${c.kind} when cancelled`, async () => {
      const dialog = await openConfirm(c.nav, c.kind);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog', { name: `Delete ${c.kind}` })).toBeNull();
      expect(document.querySelector('.shell')).not.toHaveAttribute('inert');
      expect(c.remove()).not.toHaveBeenCalled();
    });
  }

  it('reports a failed hook delete', async () => {
    vi.mocked(api.deleteHook).mockRejectedValue(new Error('boom'));
    const dialog = await openConfirm(/Hooks/, 'hook');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete hook' }));
    await screen.findByText('Failed to delete hook');
  });

  it('reloads config after a failed delete so a stale row is not left undeletable', async () => {
    vi.mocked(api.deleteHook).mockRejectedValue(new Error('boom'));
    const dialog = await openConfirm(/Hooks/, 'hook');
    const callsBefore = vi.mocked(api.getHooksConfig).mock.calls.length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete hook' }));
    await screen.findByText('Failed to delete hook');
    await waitFor(() => {
      expect(vi.mocked(api.getHooksConfig).mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it('names the provider in the domain dialog', async () => {
    const dialog = await openConfirm(/Domains/, 'domain');
    expect(within(dialog).getByText('DuckDNS')).toBeInTheDocument();
  });
});
