import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getProviders } from './api';

describe('api', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('getProviders fetches /api/providers and returns json', async () => {
    const data = [{ key: 'duckdns', display_name: 'DuckDNS', schema: {} }];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => data })));
    const result = await getProviders();
    expect(fetch).toHaveBeenCalledWith('/api/providers');
    expect(result[0].key).toBe('duckdns');
  });
});
