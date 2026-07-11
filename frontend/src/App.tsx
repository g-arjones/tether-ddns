import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type {
  DomainConfig,
  DomainState,
  HookConfig,
  HookDef,
  Provider,
  Settings,
} from './types';
import { useLiveState } from './useLiveState';
import { DomainCard } from './components/DomainCard';
import { DomainModal, type DomainFormValue } from './components/DomainModal';
import { HookModal, type HookFormValue } from './components/HookModal';
import { LogViewer } from './components/LogViewer';
import { Toasts, type ToastItem, type ToastKind } from './components/Toasts';
import './styles.css';

type Theme = 'dark' | 'light';

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem('tether-theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* ignore */
  }
  return 'dark';
}

const EMPTY_RUNTIME: DomainState = { id: '', status: 'pending', ip: null, updated: null, message: '' };

export function formatInterval(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
}

export default function App() {
  const { snapshot, logs } = useLiveState();

  const [providers, setProviders] = useState<Provider[]>([]);
  const [hookDefs, setHookDefs] = useState<HookDef[]>([]);
  const [ipSources, setIpSources] = useState<{ key: string; display_name: string }[]>([]);
  const [domains, setDomains] = useState<DomainConfig[]>([]);
  const [hooks, setHooks] = useState<HookConfig[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);

  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const [domainModalOpen, setDomainModalOpen] = useState(false);
  const [editingDomain, setEditingDomain] = useState<DomainConfig | null>(null);
  const [hookModalOpen, setHookModalOpen] = useState(false);
  const [editingHook, setEditingHook] = useState<HookConfig | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('tether-theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const pushToast = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = Math.random().toString(36).slice(2, 9);
    setToasts((prev) => [...prev, { id, message, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3200);
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const [d, h, s] = await Promise.all([api.getDomains(), api.getHooksConfig(), api.getSettings()]);
      setDomains(d);
      setHooks(h);
      setSettings(s);
    } catch {
      /* backend may be unavailable during dev */
    }
  }, []);

  useEffect(() => {
    void Promise.all([
      api.getProviders().then(setProviders).catch(() => undefined),
      api.getHooks().then(setHookDefs).catch(() => undefined),
      api.getIpSources().then(setIpSources).catch(() => undefined),
    ]);
    void loadConfig();
  }, [loadConfig]);

  const runtimeById = useMemo(() => {
    const map = new Map<string, DomainState>();
    for (const d of snapshot?.domains ?? []) map.set(d.id, d);
    return map;
  }, [snapshot]);

  const stats = useMemo(() => {
    const total = domains.length;
    let synced = 0;
    let pending = 0;
    for (const d of domains) {
      const rt = runtimeById.get(d.id);
      const status = d.enabled ? rt?.status ?? 'pending' : 'paused';
      if (status === 'synced') synced += 1;
      else if (status === 'pending' || status === 'error') pending += 1;
    }
    const providerCount = new Set(domains.map((d) => d.provider)).size;
    return { total, synced, pending, providerCount };
  }, [domains, runtimeById]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await api.refresh();
      pushToast('Refresh requested', 'info');
    } catch {
      pushToast('Refresh failed', 'error');
    } finally {
      setRefreshing(false);
    }
  }, [pushToast]);

  const handleSaveDomain = useCallback(
    async (value: DomainFormValue) => {
      if (!value.hostname.trim()) {
        pushToast('Please enter a hostname', 'error');
        return;
      }
      try {
        if (editingDomain) await api.updateDomain(editingDomain.id, value);
        else await api.createDomain(value);
        pushToast(`Saved ${value.hostname}`, 'success');
        setDomainModalOpen(false);
        setEditingDomain(null);
        await loadConfig();
      } catch {
        pushToast('Failed to save domain', 'error');
      }
    },
    [editingDomain, loadConfig, pushToast],
  );

  const handleSync = useCallback(
    async (id: string) => {
      try {
        await api.syncDomain(id);
        pushToast('Sync requested', 'info');
      } catch {
        pushToast('Sync failed', 'error');
      }
    },
    [pushToast],
  );

  const handleRunHook = useCallback(
    async (id: string) => {
      try {
        const res = await api.runHook(id);
        if (res.ran > 0) {
          pushToast(`Ran ${res.ran} action${res.ran === 1 ? '' : 's'}`, 'success');
        } else {
          pushToast('Nothing to run (no enabled events or IP unknown)', 'info');
        }
      } catch {
        pushToast('Run failed', 'error');
      }
    },
    [pushToast],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      const d = domains.find((x) => x.id === id);
      if (d && !window.confirm(`Remove "${d.hostname}"?`)) return;
      try {
        await api.deleteDomain(id);
        pushToast('Domain removed', 'info');
        await loadConfig();
      } catch {
        pushToast('Failed to remove domain', 'error');
      }
    },
    [domains, loadConfig, pushToast],
  );

  const handleToggle = useCallback(
    async (id: string) => {
      const d = domains.find((x) => x.id === id);
      if (!d) return;
      try {
        await api.updateDomain(id, { ...d, enabled: !d.enabled });
        await loadConfig();
      } catch {
        pushToast('Failed to update domain', 'error');
      }
    },
    [domains, loadConfig, pushToast],
  );

  const handleSaveHook = useCallback(
    async (value: HookFormValue) => {
      try {
        if (editingHook) await api.updateHook(editingHook.id, value);
        else await api.createHook(value);
        pushToast('Hook saved', 'success');
        setHookModalOpen(false);
        setEditingHook(null);
        await loadConfig();
      } catch {
        pushToast('Failed to save hook', 'error');
      }
    },
    [editingHook, loadConfig, pushToast],
  );

  const handleSaveSettings = useCallback(
    async (patch: Partial<Settings>) => {
      try {
        const next = await api.putSettings(patch);
        setSettings(next);
        setSettingsOpen(false);
        pushToast('Settings saved', 'success');
      } catch {
        pushToast('Failed to save settings', 'error');
      }
    },
    [pushToast],
  );

  const hookLabel = (key: string) => hookDefs.find((h) => h.key === key)?.display_name ?? key;

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <div className="logo">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z" /><path d="M2 12h20" /><path d="M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z" />
              </svg>
            </div>
            <div className="brand-text">
              <h1>Tether</h1>
              <p>Self-hosted dynamic DNS</p>
            </div>
          </div>

          <div className="topbar-spacer" />

          <div className="ip-pill" title="Detected public IPv4">
            <span className={`dot${snapshot && !snapshot.online ? ' offline' : ''}`} />
            <span className="label">IPv4</span>
            <span className="val">{snapshot?.public_ipv4 ?? 'N/A'}</span>
          </div>
          <div className="ip-pill" title="Detected public IPv6">
            <span className={`dot${snapshot && !snapshot.online ? ' offline' : ''}`} />
            <span className="label">IPv6</span>
            <span className="val">{snapshot?.public_ipv6 ?? 'N/A'}</span>
          </div>

          <button type="button" className={`icon-btn${refreshing ? ' spin' : ''}`} title="Refresh all" onClick={handleRefresh}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 4v6h-6M1 20v-6h6" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>
          </button>

          <button type="button" className="icon-btn" title="Settings" onClick={() => setSettingsOpen(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
          </button>

          <button type="button" className="icon-btn" title="Toggle theme" onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}>
            {theme === 'dark' ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5" /><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" /></svg>
            )}
          </button>
        </div>
      </header>

      <main className="app">
        <section className="stats">
          <div className="stat">
            <div className="stat-top">
              <span className="stat-label">Total Domains</span>
              <span className="stat-ico tint-accent">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z" /></svg>
              </span>
            </div>
            <div className="stat-value">{stats.total}</div>
            <div className="stat-sub">Across {stats.providerCount} providers</div>
          </div>
          <div className="stat">
            <div className="stat-top">
              <span className="stat-label">Synced</span>
              <span className="stat-ico tint-ok">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><path d="M22 4 12 14.01l-3-3" /></svg>
              </span>
            </div>
            <div className="stat-value">{stats.synced}</div>
            <div className="stat-sub">Records up to date</div>
          </div>
          <div className="stat">
            <div className="stat-top">
              <span className="stat-label">Needs Update</span>
              <span className="stat-ico tint-warn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></svg>
              </span>
            </div>
            <div className="stat-value">{stats.pending}</div>
            <div className="stat-sub">Pending or errored</div>
          </div>
          <div className="stat">
            <div className="stat-top">
              <span className="stat-label">Update Interval</span>
              <span className="stat-ico tint-accent">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>
              </span>
            </div>
            <div className="stat-value">{settings ? formatInterval(settings.check_interval) : '—'}</div>
            <div className="stat-sub">Check for IP changes</div>
          </div>
        </section>

        <div className="section-head">
          <h2>Your Domains</h2>
          <span className="count-badge">{stats.total} {stats.total === 1 ? 'record' : 'records'}</span>
          <div className="spacer" />
          <button type="button" className="btn btn-primary" onClick={() => { setEditingDomain(null); setDomainModalOpen(true); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
            Add Domain
          </button>
        </div>

        <div className="domain-grid">
          {domains.length === 0 ? (
            <div className="empty">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z" /></svg>
              <h3>No domains yet</h3>
              <p>Add your first domain to get started.</p>
            </div>
          ) : (
            domains.map((d) => (
              <DomainCard
                key={d.id}
                domain={d}
                runtime={runtimeById.get(d.id) ?? { ...EMPTY_RUNTIME, id: d.id }}
                onSync={handleSync}
                onEdit={(id) => { setEditingDomain(domains.find((x) => x.id === id) ?? null); setDomainModalOpen(true); }}
                onDelete={handleDelete}
                onToggle={handleToggle}
              />
            ))
          )}
        </div>

        <div className="section-head">
          <h2>Hooks</h2>
          <span className="count-badge">{hooks.length} {hooks.length === 1 ? 'hook' : 'hooks'}</span>
          <div className="spacer" />
          <button type="button" className="btn btn-primary" onClick={() => { setEditingHook(null); setHookModalOpen(true); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
            Add Hook
          </button>
        </div>

        <div className="hook-list">
          {hooks.length === 0 ? (
            <div className="empty">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 10a10 10 0 0 1 10 10" /><path d="M4 16a4 4 0 0 1 4 4" /><circle cx="5" cy="19" r="1" /><path d="m12 10 4-4a2.83 2.83 0 0 1 4 4l-4 4" /><path d="m14 8 3 3" /><path d="m9 15 3 3" /></svg>
              <h3>No hooks configured</h3>
              <p>Add your first hook to react to IP changes.</p>
            </div>
          ) : (
            hooks.map((h) => (
              <div className="hook-row" key={h.id}>
                <div>
                  <div className="hook-name">{hookLabel(h.hook)}</div>
                  <div className="hook-events">{h.events.join(', ') || 'no events'}</div>
                </div>
                <div className="spacer" />
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleRunHook(h.id)}>Run now</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setEditingHook(h); setHookModalOpen(true); }}>Edit</button>
                <button type="button" className="btn btn-danger btn-sm" onClick={async () => { await api.deleteHook(h.id); await loadConfig(); }}>Delete</button>
              </div>
            ))
          )}
        </div>

        <div className="section-head" style={{ marginTop: 24 }}>
          <h2>Logs</h2>
        </div>
        <LogViewer logs={logs} />
      </main>

      <DomainModal
        open={domainModalOpen}
        providers={providers}
        editing={editingDomain}
        onClose={() => { setDomainModalOpen(false); setEditingDomain(null); }}
        onSave={handleSaveDomain}
      />

      <HookModal
        open={hookModalOpen}
        hooks={hookDefs}
        editing={editingHook}
        onClose={() => { setHookModalOpen(false); setEditingHook(null); }}
        onSave={handleSaveHook}
      />

      <SettingsModal
        open={settingsOpen}
        settings={settings}
        ipSources={ipSources}
        onClose={() => setSettingsOpen(false)}
        onSave={handleSaveSettings}
      />

      <Toasts toasts={toasts} />
    </>
  );
}

interface SettingsModalProps {
  open: boolean;
  settings: Settings | null;
  ipSources: { key: string; display_name: string }[];
  onClose: () => void;
  onSave: (patch: Partial<Settings>) => void;
}

function SettingsModal({ open, settings, ipSources, onClose, onSave }: SettingsModalProps) {
  const [interval, setIntervalMinutes] = useState(5);
  const [ipSource, setIpSource] = useState('');
  const [updateOnStartup, setUpdateOnStartup] = useState(true);
  const [notify, setNotify] = useState(true);
  const [retry, setRetry] = useState(true);

  useEffect(() => {
    if (settings) {
      setIntervalMinutes(Math.max(1, Math.round(settings.check_interval / 60)));
      setIpSource(settings.ip_source);
      setUpdateOnStartup(settings.update_on_startup);
      setNotify(settings.notify);
      setRetry(settings.retry_on_failure);
    }
  }, [settings, open]);

  const chips = [1, 5, 15, 30, 60];

  return (
    <div className={`modal-overlay${open ? ' open' : ''}`} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="modal-head">
          <h3>Settings</h3>
          <button type="button" className="icon-btn" style={{ width: 34, height: 34 }} onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="settings-group">
            <div className="sg-title">Update Frequency</div>
            <div className="field">
              <label>Check for IP changes every</label>
              <div className="chips">
                {chips.map((c) => (
                  <button type="button" key={c} className={`chip${interval === c ? ' active' : ''}`} onClick={() => setIntervalMinutes(c)}>
                    {c < 60 ? `${c} min` : '1 hour'}
                  </button>
                ))}
              </div>
            </div>

            <div className="divider" />
            <div className="sg-title">IP Detection</div>
            <div className="field">
              <label htmlFor="sIpSource">Public IP source</label>
              <select id="sIpSource" value={ipSource} onChange={(e) => setIpSource(e.target.value)}>
                {ipSources.map((s) => (
                  <option key={s.key} value={s.key}>{s.display_name}</option>
                ))}
              </select>
            </div>

            <div className="divider" />
            <div className="sg-title">Behavior</div>
            <div className="switch-row">
              <div className="sr-text"><div className="t">Update on startup</div><div className="d">Force a sync when the service launches</div></div>
              <label className="switch"><input type="checkbox" checked={updateOnStartup} onChange={(e) => setUpdateOnStartup(e.target.checked)} /><span className="slider" /></label>
            </div>
            <div className="switch-row">
              <div className="sr-text"><div className="t">Notifications</div><div className="d">Notify on IP change and update failures</div></div>
              <label className="switch"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /><span className="slider" /></label>
            </div>
            <div className="switch-row">
              <div className="sr-text"><div className="t">Retry on failure</div><div className="d">Auto-retry failed updates with backoff</div></div>
              <label className="switch"><input type="checkbox" checked={retry} onChange={(e) => setRetry(e.target.checked)} /><span className="slider" /></label>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onSave({
              check_interval: interval * 60,
              ip_source: ipSource,
              update_on_startup: updateOnStartup,
              notify,
              retry_on_failure: retry,
            })}
          >
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}
