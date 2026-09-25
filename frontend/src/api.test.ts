import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError, getProviders, pingHeartbeat, putSettings } from './api';

describe('api', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('getProviders fetches /api/providers and returns json', async () => {
    const data = [{ key: 'duckdns', display_name: 'DuckDNS', schema: {} }];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => data })));
    const result = await getProviders();
    expect(fetch).toHaveBeenCalledWith('/api/providers');
    expect(result[0].key).toBe('duckdns');
  });

  it('maps a 422 detail list to fieldErrors keyed by the last loc part', async () => {
    const detail = [{ loc: ['body', 'heartbeat_url'], msg: 'Input should be a valid URL', type: 'url_parsing' }];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 422, json: async () => ({ detail }) })));
    const err = await putSettings({ heartbeat_url: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).fieldErrors).toEqual({ heartbeat_url: 'Input should be a valid URL' });
    expect((err as ApiError).message).toBe('/api/settings -> 422');
  });

  it('keeps fieldErrors empty for non-422 failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const err = await putSettings({ notify: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).fieldErrors).toEqual({});
    expect((err as ApiError).message).toBe('/api/settings -> 500');
  });

  it('tolerates a 422 body that is not a detail list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 422, json: async () => { throw new Error('not json'); } })));
    const err = await putSettings({ notify: true }).catch((e: unknown) => e);
    expect((err as ApiError).fieldErrors).toEqual({});
  });

  it('pingHeartbeat POSTs to /api/heartbeat/ping', async () => {
    const status = { at: 1, ok: true, skipped: false, error: null };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => status })));
    expect(await pingHeartbeat()).toEqual(status);
    expect(fetch).toHaveBeenCalledWith('/api/heartbeat/ping', { method: 'POST' });
  });
});
