import { useEffect, useState, type JSX, type ReactNode } from 'react';
import type { HeartbeatStatus } from '../types';
import { formatInterval, relStable } from '../utils';
import { IconButton } from './IconButton';
import { IconActivity } from './icons';

export interface HeartbeatCardProps {
  status: HeartbeatStatus | null;
  url: string | null;
  interval: number;
  onPing: () => Promise<void>;
}

type Tone = 'muted' | 'neutral' | 'ok' | 'err';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function HeartbeatCard({ status, url, interval, onPing }: HeartbeatCardProps): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  const [pinging, setPinging] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const ping = () => {
    setPinging(true);
    void onPing().catch(() => undefined).finally(() => setPinging(false));
  };

  let value: string;
  let sub: ReactNode;
  let tone: Tone;
  let title: string | undefined;
  const cadence = (u: string) => (
    <>{`every ${formatInterval(interval)} · `}<span className="hb-host">{hostOf(u)}</span></>
  );
  if (url === null) {
    value = 'Off'; sub = 'Set a URL in Settings'; tone = 'muted';
  } else if (status === null) {
    value = '—'; sub = cadence(url); tone = 'neutral';
  } else if (status.skipped) {
    value = 'Skipped'; sub = 'Link offline'; tone = 'muted';
  } else if (status.ok) {
    value = `${relStable(status.at, now)} ago`;
    sub = <><span className="hb-flag">OK</span>{' · '}{cadence(url)}</>;
    tone = 'ok';
  } else {
    value = 'Failed';
    sub = <span className="hb-host">{status.error}</span>;
    title = status.error ?? undefined;
    tone = 'err';
  }

  return (
    <div className={`stat hb-${tone}`}>
      <div className="stat-top">
        <span className="stat-label">Heartbeat</span>
        {url !== null && (
          <IconButton
            variant="act"
            label="Ping now"
            onClick={ping}
            disabled={pinging}
            className={pinging ? 'spin' : undefined}
          >
            <IconActivity />
          </IconButton>
        )}
      </div>
      <div className="stat-value hb-value">{value}</div>
      <div className="stat-sub hb-sub" title={title}>{sub}</div>
    </div>
  );
}
