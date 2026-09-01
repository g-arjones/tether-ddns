import type { JSX, PointerEvent as ReactPointerEvent } from 'react';
import { IconDashboard, IconGlobe, IconHook, IconLogs, IconSettings, IconInfo } from '../components/icons';

export type ViewKey = 'overview' | 'domains' | 'hooks' | 'logs' | 'settings' | 'about';

const RAIL_MIN = 190;
const RAIL_MAX = 380;

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

function startResize(e: ReactPointerEvent<HTMLDivElement>, collapsed: boolean): void {
  if (collapsed) return;
  e.preventDefault();
  const root = document.documentElement;
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'col-resize';
  let lastW: number | null = null;
  const move = (ev: PointerEvent) => {
    lastW = Math.min(RAIL_MAX, Math.max(RAIL_MIN, ev.clientX));
    root.style.setProperty('--rail-w', `${lastW}px`);
  };
  const up = () => {
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    if (lastW != null) {
      try {
        localStorage.setItem('tether-rail-width', String(lastW));
      } catch {
        /* ignore */
      }
    }
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

export function Rail(props: RailProps): JSX.Element {
  const { active, onSelect, domainCount, hookCount, online, mobileOpen, collapsed } = props;
  const items: NavDef[] = [
    { key: 'overview', label: 'Overview', icon: <IconDashboard /> },
    { key: 'domains', label: 'Domains', count: domainCount, icon: <IconGlobe /> },
    { key: 'hooks', label: 'Hooks', count: hookCount, icon: <IconHook /> },
    { key: 'logs', label: 'Logs', icon: <IconLogs /> },
    { key: 'settings', label: 'Settings', icon: <IconSettings /> },
    { key: 'about', label: 'About', icon: <IconInfo /> },
  ];
  return (
    <aside className={`rail${mobileOpen ? ' open' : ''}`}>
      <div className="brand">
        <div className="logo">
          <IconGlobe />
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
      <div
        className="rail-resizer"
        title="Drag to resize"
        onPointerDown={(e) => startResize(e, collapsed)}
      />
    </aside>
  );
}
