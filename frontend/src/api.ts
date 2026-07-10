import type { Provider, HookDef, Settings, StateSnapshot } from './types';

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = init ? await fetch(url, init) : await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json() as Promise<T>;
}
const jbody = (data: unknown): RequestInit => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});

export const getState = () => json<StateSnapshot>('/api/state');
export const getProviders = () => json<Provider[]>('/api/providers');
export const getHooks = () => json<HookDef[]>('/api/hooks');
export const getIpSources = () => json<{ key: string; display_name: string }[]>('/api/ip-sources');
export const getSettings = () => json<Settings>('/api/settings');
export const putSettings = (patch: Partial<Settings>) => json<Settings>('/api/settings', { ...jbody(patch), method: 'PUT' });
export const createDomain = (input: unknown) => json('/api/domains', jbody(input));
export const updateDomain = (id: string, input: unknown) => json(`/api/domains/${id}`, { ...jbody(input), method: 'PUT' });
export const deleteDomain = (id: string) => json(`/api/domains/${id}`, { method: 'DELETE' });
export const syncDomain = (id: string) => json(`/api/domains/${id}/sync`, { method: 'POST' });
export const createHook = (input: unknown) => json('/api/hooks-config', jbody(input));
export const updateHook = (id: string, input: unknown) => json(`/api/hooks-config/${id}`, { ...jbody(input), method: 'PUT' });
export const deleteHook = (id: string) => json(`/api/hooks-config/${id}`, { method: 'DELETE' });
export const refresh = () => json('/api/refresh', { method: 'POST' });
