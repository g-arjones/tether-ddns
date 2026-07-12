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
import { Rail, type ViewKey } from './layout/Rail';
import { TopBar } from './layout/TopBar';
import { OverviewView } from './views/OverviewView';
import { DomainsView } from './views/DomainsView';
import { HooksView } from './views/HooksView';
import { LogsView } from './views/LogsView';
import { SettingsView } from './views/SettingsView';
import { DomainModal, type DomainFormValue } from './components/DomainModal';
import { HookModal, type HookFormValue } from './components/HookModal';
import { Toasts, type ToastItem, type ToastKind } from './components/Toasts';
import './styles.css';

type Theme = 'dark' | 'light';

const TITLES: Record<ViewKey, { title: string; sub: string }> = {
  overview: { title: 'Overview', sub: 'Live status of your dynamic DNS records' },
  domains: { title: 'Domains', sub: 'Manage your DNS records' },
  hooks: { title: 'Hooks', sub: 'React to lifecycle events' },
  logs: { title: 'Logs', sub: 'Live application log' },
  settings: { title: 'Settings', sub: 'Scheduling, behavior, and IP source' },
};

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem('tether-theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* ignore */
  }
  return 'dark';
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

  const [activeView, setActiveView] = useState<ViewKey>('overview');
  const [railMobileOpen, setRailMobileOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('tether-rail-collapsed') === '1';
    } catch {
      return false;
    }
  });

  const [domainModalOpen, setDomainModalOpen] = useState(false);
  const [editingDomain, setEditingDomain] = useState<DomainConfig | null>(null);
  const [hookModalOpen, setHookModalOpen] = useState(false);
  const [editingHook, setEditingHook] = useState<HookConfig | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('tether-theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  // Restore a previously dragged rail width once on mount.
  useEffect(() => {
    try {
      const w = localStorage.getItem('tether-rail-width');
      if (w) {
        const clamped = Math.min(380, Math.max(190, parseInt(w, 10)));
        document.documentElement.style.setProperty('--rail-w', `${clamped}px`);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Reflect collapse state on <html> and persist it.
  useEffect(() => {
    document.documentElement.classList.toggle('rail-collapsed', railCollapsed);
    try {
      localStorage.setItem('tether-rail-collapsed', railCollapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [railCollapsed]);

  const toggleRail = useCallback(() => {
    if (window.matchMedia('(max-width: 860px)').matches) {
      setRailMobileOpen((v) => !v);
    } else {
      setRailCollapsed((v) => !v);
    }
  }, []);

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
        pushToast('Settings saved', 'success');
      } catch {
        pushToast('Failed to save settings', 'error');
      }
    },
    [pushToast],
  );

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  const { title, sub } = TITLES[activeView];

  return (
    <>
      <div className="shell">
        <Rail
          active={activeView}
          onSelect={setActiveView}
          domainCount={domains.length}
          hookCount={hooks.length}
          online={snapshot?.online ?? false}
          collapsed={railCollapsed}
          mobileOpen={railMobileOpen}
          onCloseMobile={() => setRailMobileOpen(false)}
        />
        <div className={`rail-scrim${railMobileOpen ? ' open' : ''}`} onClick={() => setRailMobileOpen(false)} />
        <div className="content">
          <TopBar
            title={title}
            subtitle={sub}
            ipv4={snapshot?.public_ipv4 ?? null}
            ipv6={snapshot?.public_ipv6 ?? null}
            online={snapshot?.online ?? false}
            refreshing={refreshing}
            theme={theme}
            onRefresh={handleRefresh}
            onToggleTheme={toggleTheme}
            onToggleRail={toggleRail}
          />
          <main className="page">
            {activeView === 'overview' && (
              <OverviewView snapshot={snapshot} domains={domains} settings={settings} />
            )}
            {activeView === 'domains' && (
              <DomainsView
                domains={domains}
                runtimeById={runtimeById}
                onAdd={() => {
                  setEditingDomain(null);
                  setDomainModalOpen(true);
                }}
                onSync={handleSync}
                onEdit={(id) => {
                  setEditingDomain(domains.find((x) => x.id === id) ?? null);
                  setDomainModalOpen(true);
                }}
                onDelete={handleDelete}
                onToggle={handleToggle}
              />
            )}
            {activeView === 'hooks' && (
              <HooksView
                hooks={hooks}
                hookDefs={hookDefs}
                onAdd={() => {
                  setEditingHook(null);
                  setHookModalOpen(true);
                }}
                onRun={handleRunHook}
                onEdit={(hook) => {
                  setEditingHook(hook);
                  setHookModalOpen(true);
                }}
                onDelete={async (id) => {
                  await api.deleteHook(id);
                  await loadConfig();
                }}
              />
            )}
            {activeView === 'logs' && <LogsView logs={logs} />}
            {activeView === 'settings' && (
              <SettingsView settings={settings} ipSources={ipSources} onSave={handleSaveSettings} />
            )}
          </main>
        </div>
      </div>

      <DomainModal
        open={domainModalOpen}
        providers={providers}
        editing={editingDomain}
        onClose={() => {
          setDomainModalOpen(false);
          setEditingDomain(null);
        }}
        onSave={handleSaveDomain}
      />

      <HookModal
        open={hookModalOpen}
        hooks={hookDefs}
        editing={editingHook}
        onClose={() => {
          setHookModalOpen(false);
          setEditingHook(null);
        }}
        onSave={handleSaveHook}
      />

      <Toasts toasts={toasts} />
    </>
  );
}
