import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import App from './App';
import * as api from './api';

vi.mock('./api');
vi.mock('./useLiveState', () => ({
  useLiveState: () => ({
    snapshot: {
      public_ipv4: '1.2.3.4', public_ipv6: null, online: true,
      domains: [], settings: {
        check_interval: 300, ip_source: 'ipify', update_on_startup: true,
        retry_on_failure: true, notify: true,
      }, logs: [],
    },
    logs: [],
  }),
}));

describe('App run hook', () => {
  beforeEach(() => {
    vi.mocked(api.getDomains).mockResolvedValue([] as never);
    vi.mocked(api.getHooksConfig).mockResolvedValue([
      { id: 'h1', hook: 'log', events: ['ip_changed'], config: {} },
    ] as never);
    vi.mocked(api.getSettings).mockResolvedValue({
      check_interval: 300, ip_source: 'ipify', update_on_startup: true,
      retry_on_failure: true, notify: true,
    } as never);
    vi.mocked(api.getProviders).mockResolvedValue([] as never);
    vi.mocked(api.getHooks).mockResolvedValue([] as never);
    vi.mocked(api.getIpSources).mockResolvedValue([] as never);
    vi.mocked(api.runHook).mockResolvedValue({ ran: 2, skipped: [] });
  });

  it('calls runHook and shows a success toast', async () => {
    render(<App />);
    const btn = await screen.findByRole('button', { name: /run now/i });
    fireEvent.click(btn);
    await waitFor(() => expect(api.runHook).toHaveBeenCalledWith('h1'));
    await screen.findByText(/Ran 2 action/i);
  });
});
