import type { Provider, HookDef, Settings, StateSnapshot, DomainConfig, HookConfig, AboutInfo, IncidentWindow, HeartbeatStatus, HealthchecksInput, HealthchecksProject } from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly fieldErrors: Record<string, string>;
  readonly detail?: string;

  constructor(message: string, status: number, fieldErrors: Record<string, string> = {}, detail?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fieldErrors = fieldErrors;
    this.detail = detail;
  }
}

// FastAPI 422 bodies are {detail: [{loc: [...], msg}]}; key each message by its field name.
async function fieldErrorsOf(res: Response): Promise<Record<string, string>> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (!Array.isArray(body.detail)) return {};
    const out: Record<string, string> = {};
    for (const entry of body.detail as { loc?: unknown[]; msg?: unknown }[]) {
      const key = entry.loc?.at(-1);
      if (key !== undefined && typeof entry.msg === 'string') out[String(key)] = entry.msg;
    }
    return out;
  } catch {
    return {};
  }
}

async function detailOf(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    return typeof body.detail === 'string' ? body.detail : undefined;
  } catch {
    return undefined;
  }
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = init ? await fetch(url, init) : await fetch(url);
  if (!res.ok) {
    const fieldErrors = res.status === 422 ? await fieldErrorsOf(res) : {};
    const detail = res.status === 422 ? undefined : await detailOf(res);
    throw new ApiError(`${url} -> ${res.status}`, res.status, fieldErrors, detail);
  }
  return res.json() as Promise<T>;
}
const jbody = (data: unknown): RequestInit => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});

export const getState = () => json<StateSnapshot>('/api/state');
export const getDomains = () => json<DomainConfig[]>('/api/domains');
export const getHooksConfig = () => json<HookConfig[]>('/api/hooks-config');
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
export const runHook = (id: string) => json<{ ran: number; skipped: string[] }>(`/api/hooks-config/${id}/run`, { method: 'POST' });
export const refresh = () => json('/api/refresh', { method: 'POST' });
export const getAbout = () => json<AboutInfo>('/api/about');
export const getIncidents = () => json<IncidentWindow>('/api/reachability/incidents');
export const pingHeartbeat = () => json<HeartbeatStatus>('/api/heartbeat/ping', { method: 'POST' });
export const getHealthchecks = () => json<HealthchecksProject[]>('/api/healthchecks');
export const createHealthchecks = (input: HealthchecksInput) => json<HealthchecksProject>('/api/healthchecks', jbody(input));
export const updateHealthchecks = (id: string, patch: Partial<HealthchecksInput>) =>
  json<HealthchecksProject>(`/api/healthchecks/${id}`, { ...jbody(patch), method: 'PUT' });
export const deleteHealthchecks = (id: string) => json(`/api/healthchecks/${id}`, { method: 'DELETE' });
export const fetchHealthchecks = (id: string) => json<HealthchecksProject>(`/api/healthchecks/${id}/fetch`, { method: 'POST' });
export const setCheckVisible = (id: string, key: string, visible: boolean) =>
  json<HealthchecksProject>(`/api/healthchecks/${id}/checks/${encodeURIComponent(key)}`, { ...jbody({ visible }), method: 'PUT' });
