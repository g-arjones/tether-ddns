import type { JSX } from 'react';
import type { StateSnapshot, Settings, DomainConfig } from '../types';
import { StatCard } from '../components/StatCard';
import { IpReadoutPanel } from '../components/IpReadoutPanel';
import { ReachabilityPanel } from '../components/ReachabilityPanel';
import { RecordHealthPanel } from '../components/RecordHealthPanel';
import { formatInterval } from '../utils';

export interface OverviewViewProps {
  snapshot: StateSnapshot | null;
  domains: DomainConfig[];
  settings: Settings | null;
}

export function OverviewView({ snapshot, domains, settings }: OverviewViewProps): JSX.Element {
  // Null-safe defaults
  const reachability = snapshot?.reachability ?? { started_at: 0, checks: 0, online: 0, history: [], latest: [] };
  const ipv4 = snapshot?.public_ipv4 ?? null;
  const ipv6 = snapshot?.public_ipv6 ?? null;
  const ipv4ChangedAt = snapshot?.ipv4_changed_at ?? null;
  const ipv6ChangedAt = snapshot?.ipv6_changed_at ?? null;
  const ipSource = snapshot?.settings?.ip_source ?? settings?.ip_source ?? '';
  const nextCheckAt = snapshot?.next_check_at ?? null;
  const checkInterval = settings?.check_interval ?? 0;
  const runtimeDomains = snapshot?.domains ?? [];

  // Build enabledById from domains config
  const enabledById: Record<string, boolean> = {};
  for (const d of domains) {
    enabledById[d.id] = d.enabled;
  }

  // Compute stats
  const total = domains.length;
  const providers = new Set(domains.map((d) => d.provider)).size;

  let synced = 0;
  let needsUpdate = 0;
  for (const d of domains) {
    const runtime = runtimeDomains.find((r) => r.id === d.id);
    if (runtime?.status === 'synced') synced += 1;
    if (runtime?.status === 'pending' || runtime?.status === 'error') needsUpdate += 1;
  }

  const intervalStr = checkInterval ? formatInterval(checkInterval) : '—';

  // Icons from mockup
  const globeIcon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z" />
    </svg>
  );

  const checkIcon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <path d="M22 4 12 14.01l-3-3" />
    </svg>
  );

  const warnIcon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );

  const clockIcon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  );

  return (
    <>
      <div className="stats">
        <StatCard label="Total Domains" value={total} sub={`Across ${providers} ${providers === 1 ? 'provider' : 'providers'}`} tint="tint-accent" icon={globeIcon} />
        <StatCard label="Synced" value={synced} sub="Records up to date" tint="tint-ok" icon={checkIcon} />
        <StatCard label="Needs Update" value={needsUpdate} sub="Pending or errored" tint={needsUpdate > 0 ? 'tint-warn' : 'tint-ok'} icon={warnIcon} />
        <StatCard label="Update Interval" value={intervalStr} sub="Check for IP changes" tint="tint-accent" icon={clockIcon} />
      </div>
      <div className="ov-grid">
        <div>
          <IpReadoutPanel ipv4={ipv4} ipv6={ipv6} ipv4ChangedAt={ipv4ChangedAt} ipv6ChangedAt={ipv6ChangedAt} ipSource={ipSource} />
          <div className="panel" style={{ marginTop: '16px' }}>
            <ReachabilityPanel reachability={reachability} />
          </div>
        </div>
        <RecordHealthPanel domains={runtimeDomains} enabledById={enabledById} nextCheckAt={nextCheckAt} checkInterval={checkInterval} />
      </div>
    </>
  );
}
