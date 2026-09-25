import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type {
  DomainConfig,
  DomainState,
  HealthchecksProject,
  HookConfig,
  HookDef,
  Provider,
  Settings,
} from './types';
import { useLiveState } from './useLiveState';
import { ConnectionOverlay } from './components/ConnectionOverlay';
import { useDelayedFlag } from './useDelayedFlag';
import { useIncidents } from './useIncidents';
import { bucketByDay } from './utils';
import { Rail, type ViewKey } from './layout/Rail';
import { TopBar } from './layout/TopBar';
import { OverviewView } from './views/OverviewView';
import { DomainsView } from './views/DomainsView';
import { HooksView } from './views/HooksView';
import { HealthchecksView } from './views/HealthchecksView';
import { LogsView } from './views/LogsView';
import { SettingsView } from './views/SettingsView';
import { AboutView } from './views/AboutView';
import { DomainModal, type DomainFormValue } from './components/DomainModal';
import { HookModal, type HookFormValue } from './components/HookModal';
import { ProjectModal, type ProjectFormValue } from './components/ProjectModal';
import { IncidentModal } from './components/IncidentModal';
import { DAY_BARS } from './components/ReachabilityPanel';
import { Toasts, type ToastItem, type ToastKind } from './components/Toasts';
import './styles.css';

type Theme = 'dark' | 'light';

const TITLES: Record<ViewKey, { title: string; sub: string }> = {
  overview: { title: 'Overview', sub: 'Live status of your dynamic DNS records' },
  domains: { title: 'Domains', sub: 'Manage your DNS records' },
  hooks: { title: 'Hooks', sub: 'React to lifecycle events' },
  healthchecks: { title: 'Healthchecks', sub: 'Check status from healthchecks.io projects' },
  logs: { title: 'Logs', sub: 'Live application log' },
  settings: { title: 'Settings', sub: 'Scheduling, behavior, and IP source' },
  about: { title: 'About', sub: 'Version & tech stack' },
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
  const { snapshot, logs, status, generation } = useLiveState();
  const disconnected = useDelayedFlag(status !== 'open', 1500);

  const [providers, setProviders] = useState<Provider[]>([]);
  const [hookDefs, setHookDefs] = useState<HookDef[]>([]);
  const [ipSources, setIpSources] = useState<{ key: string; display_name: string }[]>([]);
  const [domains, setDomains] = useState<DomainConfig[]>([]);
  const [hooks, setHooks] = useState<HookConfig[]>([]);
  const [projects, setProjects] = useState<HealthchecksProject[]>([]);
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
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<HealthchecksProject | null>(null);
  const [selectedDayStart, setSelectedDayStart] = useState<number | null>(null);

  const incidentWindow = useIncidents(snapshot?.reachability?.rev ?? 0, generation);
  // Derived every render, never stored: a day's observed span grows in real time,
  // so a bucket captured when the modal opened would freeze its timeline and uptime.
  const nowMs = Date.now();
  const dayBuckets = bucketByDay(
    incidentWindow?.incidents ?? [],
    incidentWindow?.ongoing ?? snapshot?.reachability?.ongoing ?? null,
    nowMs,
    DAY_BARS,
  );
  const selectedDay = dayBuckets.find((b) => b.start === selectedDayStart) ?? null;

  // aria-modal on any open modal claims the rest of the app is inert to assistive
  // tech, so the shell must actually become inert whenever one is open.
  const anyModalOpen = domainModalOpen || hookModalOpen || projectModalOpen || selectedDay !== null;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    // Tints the iOS status bar to match the app background.
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
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
      const [d, h, s, p] = await Promise.all([
        api.getDomains(), api.getHooksConfig(), api.getSettings(), api.getHealthchecks(),
      ]);
      setDomains(d);
      setHooks(h);
      setSettings(s);
      setProjects(p);
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
  }, [loadConfig, generation]);

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

  const handlePing = useCallback(async () => {
    try {
      await api.pingHeartbeat();
    } catch {
      pushToast('Ping request failed', 'error');
    }
  }, [pushToast]);

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
        return next;
      } catch (err) {
        pushToast('Failed to save settings', 'error');
        throw err;
      }
    },
    [pushToast],
  );

  // Rejects on failure so ProjectModal can render the field errors inline.
  const handleSaveProject = useCallback(
    async (value: ProjectFormValue) => {
      if (editingProject) await api.updateHealthchecks(editingProject.id, value);
      else await api.createHealthchecks(value);
      pushToast(`Saved ${value.name}`, 'success');
      setProjectModalOpen(false);
      setEditingProject(null);
      await loadConfig();
    },
    [editingProject, loadConfig, pushToast],
  );

  const handleFetchProject = useCallback(
    async (id: string) => {
      try {
        await api.fetchHealthchecks(id);
        pushToast('Checks fetched', 'success');
        await loadConfig();
      } catch (err) {
        const detail = err instanceof api.ApiError ? err.detail : undefined;
        pushToast(detail ? `Fetch failed: ${detail}` : 'Fetch failed', 'error');
      }
    },
    [loadConfig, pushToast],
  );

  const handleDeleteProject = useCallback(
    async (id: string) => {
      const p = projects.find((x) => x.id === id);
      if (p && !window.confirm(`Remove "${p.name}"?`)) return;
      try {
        await api.deleteHealthchecks(id);
        pushToast('Project removed', 'info');
        await loadConfig();
      } catch {
        pushToast('Failed to remove project', 'error');
      }
    },
    [projects, loadConfig, pushToast],
  );

  const handleToggleProjectOverview = useCallback(
    async (id: string, next: boolean) => {
      try {
        await api.updateHealthchecks(id, { show_on_overview: next });
        await loadConfig();
      } catch {
        pushToast('Failed to update project', 'error');
      }
    },
    [loadConfig, pushToast],
  );

  const handleToggleCheck = useCallback(
    async (id: string, key: string, visible: boolean) => {
      try {
        await api.setCheckVisible(id, key, visible);
        await loadConfig();
      } catch {
        pushToast('Failed to update check', 'error');
      }
    },
    [loadConfig, pushToast],
  );

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  const { title, sub } = TITLES[activeView];

  return (
    <>
      <div className="shell" inert={disconnected || anyModalOpen}>
        <Rail
          active={activeView}
          onSelect={setActiveView}
          domainCount={domains.length}
          hookCount={hooks.length}
          healthchecksCount={projects.length}
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
              <OverviewView
                snapshot={snapshot}
                domains={domains}
                projects={projects}
                settings={settings}
                incidentWindow={incidentWindow}
                dayBuckets={dayBuckets}
                nowMs={nowMs}
                onSelectDay={setSelectedDayStart}
                onPing={handlePing}
              />
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
            {activeView === 'healthchecks' && (
              <HealthchecksView
                projects={projects}
                runtime={snapshot?.healthchecks}
                nowMs={nowMs}
                onAdd={() => {
                  setEditingProject(null);
                  setProjectModalOpen(true);
                }}
                onEdit={(project) => {
                  setEditingProject(project);
                  setProjectModalOpen(true);
                }}
                onDelete={handleDeleteProject}
                onFetch={handleFetchProject}
                onToggleOverview={handleToggleProjectOverview}
                onToggleCheck={handleToggleCheck}
              />
            )}
            {activeView === 'logs' && <LogsView logs={logs} />}
            {activeView === 'settings' && (
              <SettingsView settings={settings} ipSources={ipSources} onSave={handleSaveSettings} />
            )}
            {activeView === 'about' && <AboutView />}
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

      <ProjectModal
        open={projectModalOpen}
        editing={editingProject}
        onClose={() => {
          setProjectModalOpen(false);
          setEditingProject(null);
        }}
        onSave={handleSaveProject}
      />

      <IncidentModal
        bucket={selectedDay}
        nowMs={nowMs}
        onClose={() => setSelectedDayStart(null)}
      />

      <Toasts toasts={toasts} />
      <ConnectionOverlay status={status} visible={disconnected} />
    </>
  );
}
