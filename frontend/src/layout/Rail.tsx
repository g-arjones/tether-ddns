import type { JSX } from 'react';

export type ViewKey = 'overview' | 'domains' | 'hooks' | 'logs' | 'settings';

export interface RailProps {
  active: ViewKey;
  onSelect: (view: ViewKey) => void;
  domainCount: number;
  hookCount: number;
  online: boolean;
  collapsed: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

interface NavDef { key: ViewKey; label: string; icon: JSX.Element; count?: number; }

export function Rail(props: RailProps): JSX.Element {
  const { active, onSelect, domainCount, hookCount, online, mobileOpen } = props;
  const items: NavDef[] = [
    { key: 'overview', label: 'Overview', icon: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="9" /><rect x="14" y="3" width="7" height="5" /><rect x="14" y="12" width="7" height="9" /><rect x="3" y="16" width="7" height="5" /></svg>) },
    { key: 'domains', label: 'Domains', count: domainCount, icon: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z" /></svg>) },
    { key: 'hooks', label: 'Hooks', count: hookCount, icon: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 10a10 10 0 0 1 10 10" /><path d="M4 16a4 4 0 0 1 4 4" /><circle cx="5" cy="19" r="1" /><path d="m12 10 4-4a2.83 2.83 0 0 1 4 4l-4 4" /><path d="m14 8 3 3" /><path d="m9 15 3 3" /></svg>) },
    { key: 'logs', label: 'Logs', icon: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16v16H4z" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>) },
    { key: 'settings', label: 'Settings', icon: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>) },
  ];
  return (
    <aside className={`rail${mobileOpen ? ' open' : ''}`}>
      <div className="brand">
        <div className="logo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z" /><path d="M2 12h20" /><path d="M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z" /></svg>
        </div>
        <div className="brand-text"><h1>Tether</h1><p>Self-hosted DDNS</p></div>
      </div>
      <nav className="nav">
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            className={`nav-item${active === it.key ? ' active' : ''}`}
            title={it.label}
            onClick={() => onSelect(it.key)}
          >
            {it.icon}
            <span className="nav-label">{it.label}</span>
            {it.count !== undefined && <span className="nav-count">{it.count}</span>}
          </button>
        ))}
      </nav>
      <div className="rail-foot">
        <div className="rail-status">
          <span className={`dot${online ? '' : ' offline'}`} />
          <span>{online ? 'Online' : 'Offline'}</span>
        </div>
      </div>
    </aside>
  );
}
