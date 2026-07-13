import type { JSX } from 'react';

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

  const moonSvg = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );

  const sunSvg = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
    </svg>
  );

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <button className="icon-btn rail-toggle" type="button" title="Menu" aria-label="Toggle navigation" onClick={onToggleRail}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12h18M3 6h18M3 18h18" />
          </svg>
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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M23 4v6h-6M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
        <button className="icon-btn" type="button" title="Toggle theme" aria-label="Toggle theme" onClick={onToggleTheme}>
          {theme === 'dark' ? moonSvg : sunSvg}
        </button>
      </div>
    </header>
  );
}
