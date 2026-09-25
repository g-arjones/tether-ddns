import { useEffect, useState, type JSX, type ReactNode } from 'react';
import type { HeartbeatStatus } from '../types';
import { formatInterval, relStable } from '../utils';
import { StatCard, type StatTint } from './StatCard';
import { IconActivity } from './icons';

export interface HeartbeatCardProps {
  status: HeartbeatStatus | null;
  url: string | null;
  interval: number;
  onPing: () => Promise<void>;
}

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
  let tint: StatTint;
  let className: string | undefined;
  let subTitle: string | undefined;
  const cadence = (u: string) => (
    <>{`every ${formatInterval(interval)} · `}<span className="hb-mono">{hostOf(u)}</span></>
  );
  if (url === null) {
    value = 'Off'; sub = 'Set a URL in Settings'; tint = 'tint-muted'; className = 'hb-muted';
  } else if (status === null) {
    value = '—'; sub = cadence(url); tint = 'tint-muted';
  } else if (status.skipped) {
    value = 'Skipped'; sub = 'Link offline'; tint = 'tint-warn'; className = 'hb-muted';
  } else if (status.ok) {
    value = `${relStable(status.at, now)} ago`;
    sub = <><span className="hb-flag">OK</span>{' · '}{cadence(url)}</>;
    tint = 'tint-ok';
  } else {
    value = 'Failed';
    sub = <span className="hb-mono">{status.error}</span>;
    subTitle = status.error ?? undefined;
    tint = 'tint-err';
    className = 'hb-err';
  }

  return (
    <StatCard
      label="Heartbeat"
      value={value}
      sub={sub}
      subTitle={subTitle}
      tint={tint}
      className={className}
      icon={<IconActivity />}
      action={url === null ? undefined : { label: 'Ping now', onClick: ping, busy: pinging }}
    />
  );
}
