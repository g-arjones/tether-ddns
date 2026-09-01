import type { JSX } from 'react';
import { IconMoon, IconSun, IconMenu, IconRefresh } from '../components/icons';

export interface TopBarProps {
  title: string;
  subtitle: string;
  ipv4: string | null;
  ipv6: string | null;
  online: boolean;
  refreshing: boolean;
  theme: 'dark' | 'light';
  onRefresh: () => void;
  onToggleTheme: () => void;
  onToggleRail: () => void;
}

export function TopBar(props: TopBarProps): JSX.Element {
  const { title, subtitle, ipv4, ipv6, online, refreshing, theme, onRefresh, onToggleTheme, onToggleRail } = props;

  const moonSvg = <IconMoon />;

  const sunSvg = <IconSun />;

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <button className="icon-btn rail-toggle" type="button" title="Menu" aria-label="Toggle navigation" onClick={onToggleRail}>
          <IconMenu />
        </button>
        <div className="page-title">
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        <div className="topbar-spacer" />
        <div className={`ip-pill${online ? '' : ' offline'}`} title="Detected public IP addresses">
          <span className="seg" title="Detected public IPv4">
            <span className="dot" />
            <span className="k">IPv4</span>
            <span className="v">{ipv4 ?? '—'}</span>
          </span>
          <span className="seg ip-v6" title="Detected public IPv6">
            <span className="k">IPv6</span>
            <span className="v">{ipv6 ?? '—'}</span>
          </span>
        </div>
        <button className={`icon-btn${refreshing ? ' spin' : ''}`} type="button" title="Refresh all" aria-label="Refresh all" onClick={onRefresh}>
          <IconRefresh />
        </button>
        <button className="icon-btn" type="button" title="Toggle theme" aria-label="Toggle theme" onClick={onToggleTheme}>
          {theme === 'dark' ? moonSvg : sunSvg}
        </button>
      </div>
    </header>
  );
}
